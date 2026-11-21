import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiModelCatalog, AiVisionTestResult } from "../src/shared/domain";
import type {
  SubtitleVisionCache,
  SubtitleVisionFrame,
  SubtitleVisionProvider,
} from "../src/main/services/subtitle-vision-orchestrator";
import {
  OpenAiSubtitleVisionProvider,
  SubtitleVisionRequestError,
} from "../src/main/services/subtitle-vision-providers";
import { runSubtitleVisionBatchWithFallback } from "../src/main/services/subtitle-vision-fallback";

const key = "fixture-secret-that-must-not-leak";
const frame: SubtitleVisionFrame = {
  id: "frame-1",
  timestampMs: 1000,
  imageDataUrl: "data:image/png;base64,AQID",
  fingerprint: "frame-hash",
  videoFingerprint: "video-hash",
  videoDurationMs: 5000,
  contextRevision: "ctx-1",
  segmentType: "MAIN",
  context: { projectName: "Test" },
};
const cache: SubtitleVisionCache = { get: async () => undefined, set: async () => undefined };

class FakeProvider implements SubtitleVisionProvider {
  readonly kind = "OPENAI" as const;
  get version() {
    return `responses-subtitle-vision-v2:${this.model}`;
  }
  constructor(
    readonly model: string,
    private readonly run: () => Promise<void> = async () => undefined,
  ) {}
  async analyzeBatch(): Promise<{ drafts: [] }> {
    await this.run();
    return { drafts: [] };
  }
}

function testResult(modelId: string, overrides: Partial<AiVisionTestResult> = {}): AiVisionTestResult {
  return {
    ok: true,
    provider: "OPENAI",
    modelId,
    authentication: true,
    modelAccess: true,
    visionSupported: true,
    structuredOutputSupported: true,
    latencyMs: 5,
    message: "probe passed",
    ...overrides,
  };
}

function catalog(models: AiModelCatalog["models"]): AiModelCatalog {
  return { provider: "OPENAI", models, updatedAt: new Date(0).toISOString(), selectionMode: "AUTO" };
}

afterEach(() => vi.restoreAllMocks());

describe("same-provider subtitle vision Auto fallback", () => {
  it("switches only after an eligible model error and a successful candidate image/schema probe", async () => {
    const failure = new SubtitleVisionRequestError(404, "model_not_found", "MODEL_UNAVAILABLE", "OpenAI");
    const refresh = vi.fn(async () =>
      catalog([
        { id: "gpt-4.1-mini", displayName: "gpt-4.1-mini", candidate: true, capability: "UNKNOWN" },
        { id: "gpt-6.1", displayName: "gpt-6.1", candidate: true, capability: "UNKNOWN" },
      ]),
    );
    const test = vi.fn(async (_provider: "OPENAI" | "GEMINI", _key: string, model: string) => testResult(model));
    const onFallback = vi.fn();
    let replacementRan = false;
    const initial = new FakeProvider("gpt-retired", async () => {
      throw failure;
    });
    const outcome = await runSubtitleVisionBatchWithFallback(
      [frame],
      initial,
      cache,
      {},
      {
        catalog: { refresh, test },
        apiKey: key,
        selectionMode: "AUTO",
        onFallback,
        createProvider: (kind, model, suppliedKey) => {
          expect(kind).toBe("OPENAI");
          expect(suppliedKey).toBe(key);
          return new FakeProvider(model, async () => {
            replacementRan = true;
          });
        },
      },
    );
    expect(outcome.provider.version).toContain("gpt-6.1");
    expect(outcome.result.drafts).toEqual([]);
    expect(replacementRan).toBe(true);
    expect(test).toHaveBeenCalledWith("OPENAI", key, "gpt-6.1");
    expect(onFallback).toHaveBeenCalledWith("gpt-retired", "gpt-6.1", failure);
  });

  it("does not fallback for manual selection or quota, auth, and general errors", async () => {
    const refresh = vi.fn(async () => catalog([]));
    const test = vi.fn(async () => testResult("unused"));
    const requestError = (code: string, failure: SubtitleVisionRequestError["failure"]) =>
      new SubtitleVisionRequestError(429, code, failure, "OpenAI");
    for (const [mode, error] of [
      ["MANUAL", new SubtitleVisionRequestError(404, "model_not_found", "MODEL_UNAVAILABLE", "OpenAI")],
      ["AUTO", requestError("insufficient_quota", "OTHER")],
      ["AUTO", new SubtitleVisionRequestError(401, "invalid_api_key", "OTHER", "OpenAI")],
      ["AUTO", new Error("network failed")],
    ] as const) {
      const initial = new FakeProvider("gpt-selected", async () => {
        throw error;
      });
      await expect(
        runSubtitleVisionBatchWithFallback(
          [frame],
          initial,
          cache,
          {},
          {
            catalog: { refresh, test },
            apiKey: key,
            selectionMode: mode,
          },
        ),
      ).rejects.toBe(error);
    }
    expect(refresh).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
  });

  it("exposes only sanitized status/code and classifies image/schema versus quota responses", async () => {
    const run = async (status: number, code: string, message: string) => {
      const provider = new OpenAiSubtitleVisionProvider(
        "gpt-old",
        key,
        vi.fn(async () => new Response(JSON.stringify({ error: { code, message } }), { status })) as typeof fetch,
      );
      try {
        await provider.analyzeBatch([frame], { language: "zh-TW", density: "STANDARD" });
      } catch (error) {
        return error;
      }
      throw new Error("expected provider request failure");
    };
    const capability = await run(400, "unsupported_parameter", `image input is unsupported for ${key}`);
    expect(capability).toBeInstanceOf(SubtitleVisionRequestError);
    expect(capability).toMatchObject({ status: 400, code: "unsupported_parameter", failure: "CAPABILITY_UNSUPPORTED" });
    expect((capability as Error).message).not.toContain(key);
    const quota = await run(429, "insufficient_quota", "credit balance exhausted");
    expect(quota).toMatchObject({ status: 429, code: "insufficient_quota", failure: "OTHER" });
    const perModelRateLimit = await run(429, "rate_limit_exceeded", "too many requests");
    expect(perModelRateLimit).toMatchObject({ status: 429, code: "rate_limit_exceeded", failure: "RATE_LIMITED" });
  });
});
