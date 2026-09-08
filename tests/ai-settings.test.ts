import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiSettingsStore, DEFAULT_AI_ACCOUNT_ID } from "../src/main/services/ai-settings";

const roots: string[] = [];
const protector = {
  isAvailable: () => true,
  protect: (value: string) => Buffer.from(`protected:${value}`, "utf8").toString("base64"),
  unprotect: (value: string) => Buffer.from(value, "base64").toString("utf8").replace(/^protected:/, ""),
};

async function root(): Promise<string> { const value = await mkdtemp(path.join(os.tmpdir(), "source-app-ai-settings-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });

describe("AI settings", () => {
  it("encrypts API keys separately, restores profiles, and never writes plaintext", async () => {
    const dataRoot = await root(); const store = new AiSettingsStore(dataRoot, protector); await store.initialize();
    const apiKey = "sk-test-123456789012345678901234567890";
    const saved = await store.saveAccount({ name: "河內 API 帳號", provider: "OPENAI", visionModel: "gpt-5.6-terra", transcriptionModel: "gpt-4o-transcribe-diarize", apiKey, makeActive: true });
    const account = saved.accounts.find((item) => item.name === "河內 API 帳號")!;
    expect(account.credentialStatus).toBe("SAVED_ENCRYPTED");
    expect(store.getRuntimeAccount(account.id).apiKey).toBe(apiKey);
    expect(await readFile(store.settingsPath, "utf8")).not.toContain(apiKey);
    expect(await readFile(store.credentialsPath, "utf8")).not.toContain(apiKey);
    expect((await readdir(path.dirname(store.settingsPath))).filter((name) => name.includes(".partial"))).toEqual([]);

    const restored = new AiSettingsStore(dataRoot, protector); await restored.initialize();
    expect(restored.getSnapshot().activeAccountId).toBe(account.id);
    expect(restored.getRuntimeAccount().apiKey).toBe(apiKey);
  });

  it("uses OPENAI_API_KEY only for the default profile and reports Codex fallback availability separately", async () => {
    const store = new AiSettingsStore(await root(), protector, "sk-env-123456789012345678901234567890", false); await store.initialize();
    expect(store.getSnapshot()).toMatchObject({ activeAccountId: DEFAULT_AI_ACCOUNT_ID, codexLoginReusable: false, accounts: [{ credentialStatus: "ENVIRONMENT" }] });
    expect(store.getRuntimeAccount().apiKey).toContain("sk-env");
    const other = await store.saveAccount({ name: "沒有金鑰", provider: "OPENAI", visionModel: "gpt-5.6-luna", transcriptionModel: "gpt-4o-transcribe", makeActive: true });
    await expect(async () => store.getRuntimeAccount(other.activeAccountId)).rejects.toThrow(/Codex／ChatGPT 登入/);
  });

  it("supports account switching and refuses plaintext storage when encryption is unavailable", async () => {
    const dataRoot = await root(); const store = new AiSettingsStore(dataRoot, protector); await store.initialize();
    const first = await store.saveAccount({ name: "A 帳號", provider: "OPENAI", visionModel: "gpt-5.6-terra", transcriptionModel: "whisper-1", apiKey: "sk-a-123456789012345678901234567890" });
    const id = first.accounts.find((item) => item.name === "A 帳號")!.id;
    expect((await store.setActiveAccount(id)).activeAccountId).toBe(id);
    expect((await store.removeAccount(id)).activeAccountId).toBe(DEFAULT_AI_ACCOUNT_ID);
    const unsafe = new AiSettingsStore(await root(), { isAvailable: () => false, protect: () => "", unprotect: () => "" }); await unsafe.initialize();
    await expect(unsafe.saveAccount({ name: "拒絕明文", provider: "OPENAI", visionModel: "gpt-5.6-terra", transcriptionModel: "gpt-4o-transcribe", apiKey: "sk-no-123456789012345678901234567890" })).rejects.toThrow(/拒絕保存/);
  });
});
