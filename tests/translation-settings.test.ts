import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranslationSettingsStore } from "../src/main/services/translation-settings";

const roots: string[] = [];
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), "source-app-translation-settings-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });

const protector = { isAvailable: () => true, protect: (value: string) => Buffer.from(`protected:${value}`).toString("base64"), unprotect: (value: string) => Buffer.from(value, "base64").toString().replace(/^protected:/, "") };

describe("translation settings", () => {
  it("persists only the encrypted Google Cloud key and restores it", async () => {
    const dataRoot = await root(); const first = new TranslationSettingsStore(dataRoot, protector); await first.initialize();
    const apiKey = "AIza-test-中文-space-safe-1234567890";
    expect((await first.update({ googleCloudApiKey: apiKey })).googleCloudConfigured).toBe(true);
    expect(await readFile(first.credentialsPath, "utf8")).not.toContain(apiKey);
    const reopened = new TranslationSettingsStore(dataRoot, protector); await reopened.initialize();
    expect(reopened.getGoogleCloudApiKey()).toBe(apiKey);
    expect((await reopened.update({ clearGoogleCloudApiKey: true })).googleCloudConfigured).toBe(false);
  });

  it("refuses plaintext persistence when Windows encryption is unavailable", async () => {
    const store = new TranslationSettingsStore(await root(), { isAvailable: () => false, protect: () => "", unprotect: () => "" }); await store.initialize();
    await expect(store.update({ googleCloudApiKey: "AIza-test-12345678901234567890" })).rejects.toThrow(/安全儲存/);
  });
});
