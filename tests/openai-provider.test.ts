import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAccountProfile } from "../src/shared/domain";
import { OpenAiProvider } from "../src/main/services/openai-provider";

const roots: string[] = [];
const account: AiAccountProfile & { apiKey: string } = {
  id: "openai-default",
  name: "測試",
  provider: "OPENAI",
  visionModel: "gpt-5.6-terra",
  transcriptionModel: "gpt-4o-transcribe-diarize",
  credentialStatus: "SAVED_ENCRYPTED",
  updatedAt: "2026-09-02T00:00:00.000Z",
  apiKey: "sk-secret-never-log",
};
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "source-app-openai-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("OpenAI provider adapter", () => {
  it("uses a fresh non-stored Responses request for natural ordered subtitle translation", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.text.format.schema.properties.translations.minItems).toBe(2);
      expect(String(body.input[0].content[0].text)).toMatch(/自然口語字幕/);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ translations: ["Hello", "See you"] }) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    expect(await new OpenAiProvider(fetcher as typeof fetch).translateTexts(["你好", "再見"], "en", account)).toEqual([
      "Hello",
      "See you",
    ]);
  });
  it("sends a Chinese/space audio path as multipart data and parses diarized timestamps", async () => {
    const audioPath = path.join(await root(), "河內 對話.mp3");
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: `Bearer ${account.apiKey}` });
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("model")).toBe("gpt-4o-transcribe-diarize");
      expect((init?.body as FormData).get("response_format")).toBe("diarized_json");
      return new Response(
        JSON.stringify({ segments: [{ start: 0.25, end: 1.5, text: " 我們抵達河內 ", speaker: "A" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const result = await new OpenAiProvider(fetcher as typeof fetch).transcribe(audioPath, account, "zh");
    expect(result).toEqual([{ startMs: 250, endMs: 1500, text: "我們抵達河內", speaker: "A" }]);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("uses low-detail images, project context and strict JSON story matching", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.model).toBe("gpt-5.6-terra");
      expect(body.input[0].content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "input_image", detail: "low" })]),
      );
      expect(body.input[0].content[0].text).toContain("河內老城");
      expect(body.input[0].content[0].text).toContain("animalSpecies");
      expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            suggestedSubtitle: "主持人走進老城",
            visualSummary: "一人在街道步行",
            eventSummary: "抵達老城",
            peopleSummary: ["主持人"],
            locationSummary: ["河內老城"],
            animalSpecies: ["家犬"],
            speciesExplanation: "家犬常與人類共同活動。",
            topicRelevanceScore: 93,
            transcriptVisualMatchScore: 88,
            confidence: 86,
            warnings: [],
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const result = await new OpenAiProvider(fetcher as typeof fetch).analyzeStoryFrames(
      {
        mode: "SUBTITLE",
        transcript: "我們到老城了",
        frames: ["data:image/jpeg;base64,AQID"],
        sourceFileName: "河內 01.mov",
        context: {
          topic: "河內旅行",
          locations: ["河內老城"],
          people: ["主持人"],
          storySummary: "抵達後步行",
          audiencePromise: "看城市",
          subtitleLanguage: "zh",
        },
      },
      account,
    );
    expect(result).toMatchObject({
      suggestedSubtitle: "主持人走進老城",
      animalSpecies: ["家犬"],
      speciesExplanation: "家犬常與人類共同活動。",
      topicRelevanceScore: 93,
      transcriptVisualMatchScore: 88,
    });
  });

  it("uses a non-stored Responses web search and returns structured music links", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        store: false,
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
      });
      expect(body.input[0].content[0].text).toContain("河內旅行");
      expect(body.input[0].content[0].text).toContain("TikTok／抖音近期熱門");
      expect(body.text.format).toMatchObject({ type: "json_schema", name: "music_suggestions", strict: true });
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            suggestions: [
              {
                platform: "YOUTUBE",
                title: "City Walk",
                artist: "Artist",
                reason: "適合步行",
                auditionUrl: "https://www.youtube.com/watch?v=abc123XYZ",
                evidenceUrl: "https://www.youtube.com/watch?v=abc123XYZ",
                rightsEvidence: "一般音樂頁，需確認授權",
                observedAt: "2026-09-08",
                trendEvidence: "",
              },
            ],
            warnings: ["確認授權"],
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const result = await new OpenAiProvider(fetcher as typeof fetch).suggestMusic(
      {
        topic: "河內旅行",
        locations: ["河內"],
        people: [],
        storySummary: "城市步行",
        audiencePromise: "看城市",
        subtitleLanguage: "zh",
      },
      true,
      false,
      account,
    );
    expect(result).toEqual({
      suggestions: [expect.objectContaining({ platform: "YOUTUBE", title: "City Walk" })],
      warnings: ["確認授權"],
    });
  });

  it("turns authentication and quota failures into understandable messages", async () => {
    const unauthorized = new OpenAiProvider(vi.fn(async () => new Response("{}", { status: 401 })) as typeof fetch);
    await expect(unauthorized.testConnection(account)).rejects.toThrow(/API Key 無效/);
    const quota = new OpenAiProvider(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "You exceeded your current quota",
                type: "insufficient_quota",
                code: "insufficient_quota",
              },
            }),
            { status: 429, headers: { "Content-Type": "application/json", "x-request-id": "req_quota_123" } },
          ),
      ) as typeof fetch,
    );
    await expect(quota.testConnection(account)).rejects.toThrow(/Codex／ChatGPT.*API 帳務.*req_quota_123/);
    const limited = new OpenAiProvider(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" },
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/json", "retry-after": "8", "x-ratelimit-reset-tokens": "2s" },
            },
          ),
      ) as typeof fetch,
    );
    await expect(limited.testConnection(account)).rejects.toThrow(/每分鐘.*8 秒後重試.*2s/);
  });

  it("performs real story and transcription checks instead of only listing models", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/models"))
        return new Response(
          JSON.stringify({ data: [{ id: account.visionModel }, { id: account.transcriptionModel }] }),
          { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "req_models" } },
        );
      if (value.endsWith("/responses"))
        return new Response(JSON.stringify({ output_text: "OK" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "x-request-id": "req_story" },
        });
      return new Response(JSON.stringify({ segments: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": "req_audio" },
      });
    });
    const result = await new OpenAiProvider(fetcher as typeof fetch).testConnection(account);
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/audio/transcriptions",
    ]);
    expect(result).toEqual({
      checks: ["API Key 驗證", `故事模型 ${account.visionModel}`, `語音模型 ${account.transcriptionModel}`],
      requestIds: ["req_models", "req_story", "req_audio"],
    });
  });

  it("can preflight only the story model before expensive local storyboard extraction", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: account.visionModel }] }), {
            status: 200,
            headers: { "Content-Type": "application/json", "x-request-id": "req-model-list" },
          })
        : new Response(JSON.stringify({ output_text: "OK" }), {
            status: 200,
            headers: { "Content-Type": "application/json", "x-request-id": "req-story-ready" },
          }),
    );
    const result = await new OpenAiProvider(fetcher as typeof fetch).testStoryConnection(account);
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/responses",
    ]);
    expect(result).toEqual({
      checks: ["API Key 驗證", `故事模型 ${account.visionModel}`],
      requestIds: ["req-model-list", "req-story-ready"],
    });
  });

  it("preserves browser microphone mime type and language without exposing the key", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const file = (init?.body as FormData).get("file") as File;
      expect(file.type).toBe("audio/webm");
      expect((init?.body as FormData).get("language")).toBe("zh");
      return new Response(JSON.stringify({ text: " 河內的城市特色 ", duration: 2.1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await new OpenAiProvider(fetcher as typeof fetch).transcribeBytes(
      new Uint8Array([1, 2, 3]),
      "voice-input.webm",
      "audio/webm",
      account,
      "zh",
    );
    expect(result.segments).toEqual([{ startMs: 0, endMs: 2100, text: "河內的城市特色" }]);
  });
});
