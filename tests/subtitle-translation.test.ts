import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSettingsStore } from "../src/main/services/ai-settings";
import { GoogleCloudTranslationProvider, SubtitleTranslationService } from "../src/main/services/subtitle-translation";
import { TranslationSettingsStore } from "../src/main/services/translation-settings";

const roots: string[] = [];
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "source-app-subtitle-translation-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});
const protector = {
  isAvailable: () => true,
  protect: (value: string) => Buffer.from(value).toString("base64"),
  unprotect: (value: string) => Buffer.from(value, "base64").toString(),
};

async function stores(dataRoot: string) {
  const ai = new AiSettingsStore(dataRoot, protector);
  await ai.initialize();
  await ai.saveAccount({
    id: "openai-default",
    name: "測試",
    provider: "OPENAI",
    visionModel: "gpt-test",
    transcriptionModel: "whisper-1",
    apiKey: "sk-test-123456789012345678901234",
    makeActive: true,
  });
  const translation = new TranslationSettingsStore(dataRoot, protector);
  await translation.initialize();
  await translation.update({ googleCloudApiKey: "AIza-test-12345678901234567890" });
  return { ai, translation };
}

describe("subtitle translation orchestration", () => {
  it("sends the Google key in a header, never in the URL, and decodes returned text", async () => {
    const key = "AIza-sensitive-never-in-url";
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain(key);
      expect(init?.headers).toMatchObject({ "X-Goog-Api-Key": key });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        q: ["你 & 我"],
        source: "zh-TW",
        target: "en",
        format: "text",
      });
      return new Response(JSON.stringify({ data: { translations: [{ translatedText: "You &amp; me" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    expect(
      await new GoogleCloudTranslationProvider(fetcher as typeof fetch).translateTexts(["你 & 我"], "en", key),
    ).toEqual(["You & me"]);
  });
  it("keeps Traditional Chinese and prefers a fresh OpenAI result", async () => {
    const dataRoot = await root();
    const { ai, translation } = await stores(dataRoot);
    const openAi = { translateTexts: vi.fn(async () => ["Hello", "Goodbye"]) };
    const google = { translateTexts: vi.fn() };
    const service = new SubtitleTranslationService(
      path.join(dataRoot, "cache"),
      ai,
      translation,
      openAi as never,
      google as never,
    );
    await service.initialize();
    const cues = [
      { id: "1", startMs: 0, endMs: 1000, text: "你好" },
      { id: "2", startMs: 1000, endMs: 2000, text: "再見" },
    ];
    const result = await service.translate(cues, ["zh-TW", "en"]);
    expect(result.byLanguage["zh-TW"]).toEqual(["你好", "再見"]);
    expect(result.byLanguage.en).toEqual(["Hello", "Goodbye"]);
    expect(result.providers).toEqual(["ORIGINAL", "OPENAI"]);
    expect(google.translateTexts).not.toHaveBeenCalled();
  });

  it("falls back to Google Cloud in the same order when OpenAI has no quota, then reuses cache", async () => {
    const dataRoot = await root();
    const { ai, translation } = await stores(dataRoot);
    const openAi = {
      translateTexts: vi.fn(async () => {
        throw new Error("credit_balance_exhausted");
      }),
    };
    const google = { translateTexts: vi.fn(async () => ["こんにちは", "さようなら"]) };
    const service = new SubtitleTranslationService(
      path.join(dataRoot, "cache"),
      ai,
      translation,
      openAi as never,
      google as never,
    );
    await service.initialize();
    const cues = [
      { id: "1", startMs: 0, endMs: 1000, text: "你好" },
      { id: "2", startMs: 1000, endMs: 2000, text: "再見" },
    ];
    expect((await service.translate(cues, ["ja"])).byLanguage.ja).toEqual(["こんにちは", "さようなら"]);
    expect((await service.translate(cues, ["ja"])).providers).toEqual(["GOOGLE_CLOUD"]);
    expect(google.translateTexts).toHaveBeenCalledTimes(1);
  });
});
