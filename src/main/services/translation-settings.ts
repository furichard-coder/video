import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TranslationSettingsSnapshot, TranslationSettingsUpdate } from "../../shared/domain";
import type { CredentialProtector } from "./ai-settings";
import { finalizePartialOutput } from "./atomic-output";

interface CredentialFile {
  schemaVersion: 1;
  encryptedGoogleCloudApiKey?: string;
}

export class TranslationSettingsStore {
  readonly credentialsPath: string;
  private credentials: CredentialFile = { schemaVersion: 1 };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dataRoot: string,
    private readonly protector: CredentialProtector,
  ) {
    this.credentialsPath = path.join(dataRoot, "settings", "translation-credentials.encrypted.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.credentialsPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.credentialsPath, "utf8")) as Partial<CredentialFile>;
      if (
        parsed.schemaVersion !== 1 ||
        (parsed.encryptedGoogleCloudApiKey !== undefined && typeof parsed.encryptedGoogleCloudApiKey !== "string")
      )
        throw new Error("翻譯憑證格式不相容");
      this.credentials = {
        schemaVersion: 1,
        ...(parsed.encryptedGoogleCloudApiKey ? { encryptedGoogleCloudApiKey: parsed.encryptedGoogleCloudApiKey } : {}),
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !String(error).includes("不相容")
      )
        throw error;
      this.credentials = { schemaVersion: 1 };
      await this.writeNow();
    }
  }

  snapshot(): TranslationSettingsSnapshot {
    return {
      schemaVersion: 1,
      googleCloudConfigured: Boolean(this.credentials.encryptedGoogleCloudApiKey),
      encryptionAvailable: this.protector.isAvailable(),
    };
  }

  async update(update: TranslationSettingsUpdate): Promise<TranslationSettingsSnapshot> {
    if (!update || typeof update !== "object") throw new Error("翻譯設定格式無效。");
    const apiKey = update.googleCloudApiKey?.trim();
    if (apiKey && (apiKey.length < 20 || apiKey.length > 500 || /\s/.test(apiKey)))
      throw new Error("Google Cloud Translation API Key 格式無效。");
    if (apiKey && !this.protector.isAvailable())
      throw new Error("Windows 安全儲存目前不可用；為避免明文落盤，App 拒絕保存 Google API Key。");
    const operation = this.writeChain.then(async () => {
      if (apiKey) this.credentials.encryptedGoogleCloudApiKey = this.protector.protect(apiKey);
      if (update.clearGoogleCloudApiKey) delete this.credentials.encryptedGoogleCloudApiKey;
      await this.writeNow();
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
    return this.snapshot();
  }

  getGoogleCloudApiKey(): string {
    const encrypted = this.credentials.encryptedGoogleCloudApiKey;
    if (!encrypted) throw new Error("尚未設定 Google Cloud Translation API Key。");
    if (!this.protector.isAvailable()) throw new Error("Windows 安全儲存目前不可用，無法解密 Google 翻譯憑證。");
    try {
      return this.protector.unprotect(encrypted);
    } catch {
      throw new Error("Google 翻譯憑證無法解密，請在 AI 設定頁重新輸入。");
    }
  }

  private async writeNow(): Promise<void> {
    const partial = `${this.credentialsPath}.${process.pid}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(this.credentials, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await finalizePartialOutput(partial, this.credentialsPath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
}
