import { describe, expect, it, vi } from "vitest";
import type { SubtitleVisionFrame } from "../src/main/services/subtitle-vision-orchestrator";
import {
  GeminiSubtitleVisionProvider,
  OpenAiSubtitleVisionProvider,
} from "../src/main/services/subtitle-vision-providers";

const secret = "fixture-secret-subtitle-key";
const frame: SubtitleVisionFrame = {
  id: "frame-7",
  timestampMs: 12_500,
  imageDataUrl: "data:image/jpeg;base64,AQID",
  fingerprint: "frame-fingerprint",
  videoFingerprint: "video-fingerprint",
  videoDurationMs: 60_000,
  contextRevision: "context-1",
  segmentType: "MAIN",
  context: { projectName: "河內旅行", title: "老城散步", previousSubtitle: "抵達河內" },
};
const drafts = [
  {
    frameId: "frame-7",
    startMs: 12_000,
    endMs: 14_000,
    text: "走進河內老城",
    confidence: 0.92,
    provenance: ["VISIBLE"],
    warning: "",
  },
];

describe("timed subtitle vision providers", () => {
  it("uses OpenAI Responses with store:false, low detail images, strict JSON, and keeps the key out of results", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
      expect(body.input[0].content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "input_image", detail: "low", image_url: "data:image/jpeg;base64,AQID" }),
        ]),
      );
      expect(body.input[0].content[0].text).toContain('"timestampMs":12500');
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({ drafts }),
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "req-subtitle" } },
      );
    });
    const provider = new OpenAiSubtitleVisionProvider("gpt-vision", secret, fetcher as typeof fetch);
    const result = await provider.analyzeBatch([frame], { language: "zh-TW", density: "STANDARD" });
    expect(result).toEqual({ drafts, inputTokens: 100, outputTokens: 20, requestId: "req-subtitle" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("uses Gemini generateContent inlineData JSON schema and never exposes its key", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/models/gemini-vision:generateContent");
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(secret);
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
      expect(body.generationConfig.responseSchema.required).toContain("drafts");
      expect(body.contents[0].parts).toContainEqual({ inlineData: { mimeType: "image/jpeg", data: "AQID" } });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ drafts }) }] } }],
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const provider = new GeminiSubtitleVisionProvider("gemini-vision", secret, fetcher as typeof fetch);
    const result = await provider.analyzeBatch([frame], { language: "zh-TW", density: "DETAILED" });
    expect(result).toEqual({ drafts, inputTokens: 90, outputTokens: 15 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not expose keys from failed requests and does not fall back to another provider", async () => {
    const openAiFetcher = vi.fn(async () => {
      throw new Error(`transport leaked ${secret}`);
    });
    const openAi = new OpenAiSubtitleVisionProvider("gpt-vision", secret, openAiFetcher as typeof fetch);
    await expect(openAi.analyzeBatch([frame], { language: "zh-TW", density: "LOW" })).rejects.toThrow(
      "OpenAI 字幕視覺分析失敗；請檢查連線與 API 設定。",
    );
    expect(openAiFetcher).toHaveBeenCalledTimes(1);

    const geminiFetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    const gemini = new GeminiSubtitleVisionProvider("gemini-vision", secret, geminiFetcher as typeof fetch);
    await expect(gemini.analyzeBatch([frame], { language: "zh-TW", density: "LOW" })).rejects.toThrow(
      "Gemini 字幕視覺分析失敗（HTTP 503）。",
    );
    expect(geminiFetcher).toHaveBeenCalledTimes(1);
  });
});
