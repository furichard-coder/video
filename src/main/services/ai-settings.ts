import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AiAccountProfile,
  AiAccountSaveInput,
  AiSettingsSnapshot,
  GeminiReviewSettingsUpdate,
} from "../../shared/domain";
import { finalizePartialOutput } from "./atomic-output";
import { findCodexExecutableSync } from "./codex-cli-provider";

export const DEFAULT_AI_ACCOUNT_ID = "openai-default";
export const DEFAULT_VISION_MODEL = "gpt-5.6-terra";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";
export const GEMINI_REVIEW_CREDENTIAL_ID = "gemini-publish-review";
export const DEFAULT_GEMINI_REVIEW_MODEL = "gemini-2.5-flash";

interface StoredAccount {
  id: string;
  name: string;
  provider: "OPENAI";
  visionModel: string;
  transcriptionModel: string;
  updatedAt: string;
}

interface SettingsFile {
  schemaVersion: 1;
  activeAccountId: string;
  accounts: StoredAccount[];
  geminiReview?: { enabled: boolean; model: string };
}

interface CredentialFile {
  schemaVersion: 1;
  encryptedKeys: Record<string, string>;
}

export interface CredentialProtector {
  isAvailable(): boolean;
  protect(value: string): string;
  unprotect(value: string): string;
}

function defaultAccount(): StoredAccount {
  return {
    id: DEFAULT_AI_ACCOUNT_ID,
    name: "OpenAI API（預設帳號）",
    provider: "OPENAI",
    visionModel: DEFAULT_VISION_MODEL,
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    updatedAt: new Date().toISOString(),
  };
}

function assertModel(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$/.test(normalized)) throw new Error(`${label}格式無效。`);
  return normalized;
}

function normalizeName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) throw new Error("AI 帳號名稱必須介於 1 到 80 個字元。");
  return normalized;
}

function looksLikeSettings(value: unknown): value is SettingsFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SettingsFile>;
  return (
    candidate.schemaVersion === 1 && typeof candidate.activeAccountId === "string" && Array.isArray(candidate.accounts)
  );
}

function looksLikeCredentials(value: unknown): value is CredentialFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CredentialFile>;
  return (
    candidate.schemaVersion === 1 && Boolean(candidate.encryptedKeys) && typeof candidate.encryptedKeys === "object"
  );
}

export class AiSettingsStore {
  readonly settingsPath: string;
  readonly credentialsPath: string;
  private settings: SettingsFile = {
    schemaVersion: 1,
    activeAccountId: DEFAULT_AI_ACCOUNT_ID,
    accounts: [defaultAccount()],
    geminiReview: { enabled: false, model: DEFAULT_GEMINI_REVIEW_MODEL },
  };
  private credentials: CredentialFile = { schemaVersion: 1, encryptedKeys: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataRoot: string,
    private readonly protector: CredentialProtector,
    private readonly environmentApiKey = process.env.OPENAI_API_KEY?.trim() || "",
    private readonly codexLoginReusable = Boolean(findCodexExecutableSync()),
    private readonly environmentGeminiApiKey = process.env.GEMINI_API_KEY?.trim() || "",
  ) {
    this.settingsPath = path.join(dataRoot, "settings", "ai-providers.json");
    this.credentialsPath = path.join(dataRoot, "settings", "ai-credentials.encrypted.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.settingsPath, "utf8"));
      if (!looksLikeSettings(parsed)) throw new Error("AI 設定格式不相容");
      this.settings = this.sanitizeSettings(parsed);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !String(error).includes("不相容")
      )
        throw error;
      this.settings = {
        schemaVersion: 1,
        activeAccountId: DEFAULT_AI_ACCOUNT_ID,
        accounts: [defaultAccount()],
        geminiReview: { enabled: false, model: DEFAULT_GEMINI_REVIEW_MODEL },
      };
      await this.writeJson(this.settingsPath, this.settings);
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.credentialsPath, "utf8"));
      if (!looksLikeCredentials(parsed)) throw new Error("AI 憑證格式不相容");
      this.credentials = {
        schemaVersion: 1,
        encryptedKeys: Object.fromEntries(
          Object.entries(parsed.encryptedKeys).filter(
            ([id, value]) =>
              (this.settings.accounts.some((account) => account.id === id) || id === GEMINI_REVIEW_CREDENTIAL_ID) &&
              typeof value === "string" &&
              value.length > 0,
          ),
        ),
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !String(error).includes("不相容")
      )
        throw error;
      this.credentials = { schemaVersion: 1, encryptedKeys: {} };
      await this.writeJson(this.credentialsPath, this.credentials);
    }
  }

  getSnapshot(): AiSettingsSnapshot {
    return {
      schemaVersion: 1,
      activeAccountId: this.settings.activeAccountId,
      accounts: this.settings.accounts.map((account) => ({
        ...structuredClone(account),
        credentialStatus: this.credentials.encryptedKeys[account.id]
          ? "SAVED_ENCRYPTED"
          : account.id === DEFAULT_AI_ACCOUNT_ID && this.environmentApiKey
            ? "ENVIRONMENT"
            : "MISSING",
      })),
      encryptionAvailable: this.protector.isAvailable(),
      codexLoginReusable: this.codexLoginReusable,
      geminiReview: {
        enabled: this.settings.geminiReview?.enabled === true,
        model: this.settings.geminiReview?.model ?? DEFAULT_GEMINI_REVIEW_MODEL,
        credentialStatus: this.credentials.encryptedKeys[GEMINI_REVIEW_CREDENTIAL_ID]
          ? "SAVED_ENCRYPTED"
          : this.environmentGeminiApiKey
            ? "ENVIRONMENT"
            : "MISSING",
      },
    };
  }

  async saveGeminiReviewSettings(input: GeminiReviewSettingsUpdate): Promise<AiSettingsSnapshot> {
    if (!input || typeof input !== "object") throw new Error("Gemini 輔助設定格式無效。");
    const model = assertModel(input.model || DEFAULT_GEMINI_REVIEW_MODEL, "Gemini 模型");
    const rawApiKey = input.apiKey?.trim();
    if (rawApiKey) {
      if (rawApiKey.length < 20 || rawApiKey.length > 500 || /\s/.test(rawApiKey))
        throw new Error("Gemini API Key 格式無效。");
      if (!this.protector.isAvailable())
        throw new Error("Windows 安全儲存目前不可用；為避免明文落盤，App 拒絕保存 Gemini API Key。");
    }
    await this.mutate(() => {
      this.settings.geminiReview = { enabled: Boolean(input.enabled), model };
      if (rawApiKey) this.credentials.encryptedKeys[GEMINI_REVIEW_CREDENTIAL_ID] = this.protector.protect(rawApiKey);
      if (input.clearApiKey) delete this.credentials.encryptedKeys[GEMINI_REVIEW_CREDENTIAL_ID];
    });
    return this.getSnapshot();
  }

  getRuntimeGeminiReview(): { enabled: boolean; model: string; apiKey?: string } {
    const enabled = this.settings.geminiReview?.enabled === true;
    const model = this.settings.geminiReview?.model ?? DEFAULT_GEMINI_REVIEW_MODEL;
    let apiKey = this.environmentGeminiApiKey;
    const encrypted = this.credentials.encryptedKeys[GEMINI_REVIEW_CREDENTIAL_ID];
    if (encrypted) {
      if (!this.protector.isAvailable()) return { enabled, model };
      try {
        apiKey = this.protector.unprotect(encrypted);
      } catch {
        return { enabled, model };
      }
    }
    return { enabled, model, ...(apiKey ? { apiKey } : {}) };
  }

  async saveAccount(input: AiAccountSaveInput): Promise<AiSettingsSnapshot> {
    if (!input || input.provider !== "OPENAI")
      throw new Error("本版只啟用 OpenAI provider；其他 AI 已預留 adapter 介面。");
    const id = input.id?.trim() || randomUUID();
    if (!/^[a-zA-Z0-9-]{3,80}$/.test(id)) throw new Error("AI 帳號 ID 無效。");
    const account: StoredAccount = {
      id,
      name: normalizeName(input.name),
      provider: "OPENAI",
      visionModel: assertModel(input.visionModel, "視覺模型"),
      transcriptionModel: assertModel(input.transcriptionModel, "轉錄模型"),
      updatedAt: new Date().toISOString(),
    };
    const rawApiKey = input.apiKey?.trim();
    if (rawApiKey) {
      if (rawApiKey.length < 20 || rawApiKey.length > 500 || /\s/.test(rawApiKey))
        throw new Error("OpenAI API Key 格式無效。");
      if (!this.protector.isAvailable())
        throw new Error("Windows 安全儲存目前不可用；為避免明文落盤，App 拒絕保存 API Key。");
    }
    await this.mutate(() => {
      const index = this.settings.accounts.findIndex((item) => item.id === id);
      if (index >= 0) this.settings.accounts[index] = account;
      else this.settings.accounts.push(account);
      if (rawApiKey) this.credentials.encryptedKeys[id] = this.protector.protect(rawApiKey);
      if (input.clearApiKey) delete this.credentials.encryptedKeys[id];
      if (input.makeActive || !this.settings.accounts.some((item) => item.id === this.settings.activeAccountId))
        this.settings.activeAccountId = id;
    });
    return this.getSnapshot();
  }

  async setActiveAccount(accountId: string): Promise<AiSettingsSnapshot> {
    if (!this.settings.accounts.some((account) => account.id === accountId)) throw new Error("找不到指定的 AI 帳號。");
    await this.mutate(() => {
      this.settings.activeAccountId = accountId;
    });
    return this.getSnapshot();
  }

  async removeAccount(accountId: string): Promise<AiSettingsSnapshot> {
    if (this.settings.accounts.length <= 1) throw new Error("至少需要保留一個 AI 帳號設定。");
    if (!this.settings.accounts.some((account) => account.id === accountId)) throw new Error("找不到指定的 AI 帳號。");
    await this.mutate(() => {
      this.settings.accounts = this.settings.accounts.filter((account) => account.id !== accountId);
      delete this.credentials.encryptedKeys[accountId];
      if (this.settings.activeAccountId === accountId) this.settings.activeAccountId = this.settings.accounts[0].id;
    });
    return this.getSnapshot();
  }

  getRuntimeAccount(accountId = this.settings.activeAccountId): AiAccountProfile & { apiKey: string } {
    const snapshot = this.getSnapshot();
    const account = snapshot.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("找不到作用中的 AI 帳號。");
    let apiKey = "";
    const encrypted = this.credentials.encryptedKeys[account.id];
    if (encrypted) {
      if (!this.protector.isAvailable()) throw new Error("Windows 安全儲存目前不可用，無法解密 AI 憑證。");
      try {
        apiKey = this.protector.unprotect(encrypted);
      } catch {
        throw new Error("AI 憑證無法解密，請在設定頁重新輸入 API Key。");
      }
    } else if (account.id === DEFAULT_AI_ACCOUNT_ID) apiKey = this.environmentApiKey;
    if (!apiKey)
      throw new Error(
        "尚未設定 OpenAI API Key。知識型字幕會再嘗試這台電腦的 Codex／ChatGPT 登入；語音辨識仍需可用的 API Key。",
      );
    return { ...account, apiKey };
  }

  private sanitizeSettings(value: SettingsFile): SettingsFile {
    const accounts: StoredAccount[] = [];
    for (const candidate of value.accounts) {
      try {
        if (!candidate || candidate.provider !== "OPENAI" || !/^[a-zA-Z0-9-]{3,80}$/.test(candidate.id)) continue;
        accounts.push({
          id: candidate.id,
          name: normalizeName(candidate.name),
          provider: "OPENAI",
          visionModel: assertModel(candidate.visionModel, "視覺模型"),
          transcriptionModel: assertModel(candidate.transcriptionModel, "轉錄模型"),
          updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
        });
      } catch {
        /* discard malformed account */
      }
    }
    if (!accounts.length) accounts.push(defaultAccount());
    let geminiReview = { enabled: false, model: DEFAULT_GEMINI_REVIEW_MODEL };
    if (value.geminiReview && typeof value.geminiReview === "object") {
      try {
        geminiReview = {
          enabled: value.geminiReview.enabled === true,
          model: assertModel(value.geminiReview.model || DEFAULT_GEMINI_REVIEW_MODEL, "Gemini 模型"),
        };
      } catch {
        geminiReview = { enabled: false, model: DEFAULT_GEMINI_REVIEW_MODEL };
      }
    }
    return {
      schemaVersion: 1,
      accounts,
      activeAccountId: accounts.some((account) => account.id === value.activeAccountId)
        ? value.activeAccountId
        : accounts[0].id,
      geminiReview,
    };
  }

  private async mutate(mutator: () => void): Promise<void> {
    const operation = this.writeChain.then(async () => {
      mutator();
      await this.writeJson(this.settingsPath, this.settings);
      await this.writeJson(this.credentialsPath, this.credentials);
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const partial = `${filePath}.${process.pid}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await finalizePartialOutput(partial, filePath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
}
