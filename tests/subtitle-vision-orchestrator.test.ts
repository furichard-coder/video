import { describe, expect, it, vi } from "vitest";
import {
  runSubtitleVisionDrafts,
  type SubtitleVisionCache,
  type SubtitleVisionFrame,
  type SubtitleVisionProvider,
} from "../src/main/services/subtitle-vision-orchestrator";

function frame(index: number): SubtitleVisionFrame {
  return {
    id: `f${index}`,
    timestampMs: index * 2_000,
    imageDataUrl: "data:image/jpeg;base64,AA==",
    fingerprint: `hash-${index}`,
    videoFingerprint: "video-hash",
    videoDurationMs: 120_000,
    contextRevision: "context-v1",
    segmentType: "MAIN",
    context: { projectName: "測試", neighborTimestampsMs: [] },
  };
}

function memoryCache(): SubtitleVisionCache {
  const values = new Map<string, any>();
  return { get: async (key) => values.get(key), set: async (key, value) => void values.set(key, [...value]) };
}

describe("subtitle vision orchestration", () => {
  it("uses bounded batches, cache and resumable counters without touching an official SRT", async () => {
    const provider: SubtitleVisionProvider = {
      kind: "OPENAI",
      version: "mock-v1",
      analyzeBatch: vi.fn(async (frames) => ({
        drafts: frames.map((item) => ({ frameId: item.id, startMs: item.timestampMs, endMs: item.timestampMs + 900, text: `畫面 ${item.id}`, confidence: 0.8, provenance: ["VISIBLE"] })),
        inputTokens: 10,
        outputTokens: 5,
      })),
    };
    const cache = memoryCache();
    const first = await runSubtitleVisionDrafts(Array.from({ length: 25 }, (_, index) => frame(index)), provider, cache, { batchSize: 10 });
    expect(provider.analyzeBatch).toHaveBeenCalledTimes(3);
    expect(first).toMatchObject({ nextIndex: 25, progress: { processed: 25, requests: 3, inputTokens: 30, outputTokens: 15 } });
    const cached = await runSubtitleVisionDrafts(Array.from({ length: 25 }, (_, index) => frame(index)), provider, cache, { batchSize: 30 });
    expect(provider.analyzeBatch).toHaveBeenCalledTimes(3);
    expect(cached.progress.cacheHits).toBe(25);
  });

  it("surfaces provider failure and rejects unsupported factual provenance", async () => {
    const bad: SubtitleVisionProvider = {
      kind: "GEMINI",
      version: "mock",
      analyzeBatch: async (frames) => ({ drafts: [{ frameId: frames[0].id, startMs: 0, endMs: 1_000, text: "猜測", confidence: 1, provenance: [] }] }),
    };
    await expect(runSubtitleVisionDrafts([frame(0)], bad, memoryCache())).rejects.toThrow(/可追溯來源/);
    const failed = { ...bad, analyzeBatch: async () => { throw new Error("provider unavailable"); } };
    await expect(runSubtitleVisionDrafts([frame(0)], failed, memoryCache())).rejects.toThrow("provider unavailable");
  });

  it("rejects a resume checkpoint after frame or context identity changes", async () => {
    const provider: SubtitleVisionProvider = {
      kind: "OPENAI",
      version: "mock",
      analyzeBatch: async () => ({ drafts: [] }),
    };
    const first = await runSubtitleVisionDrafts([frame(0)], provider, memoryCache());
    await expect(
      runSubtitleVisionDrafts([{ ...frame(0), contextRevision: "changed" }], provider, memoryCache(), { resume: first }),
    ).rejects.toThrow(/Resume 已過期/);
  });
});
