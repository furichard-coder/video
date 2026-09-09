import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAiProvider } from "../src/main/services/openai-provider";
import { normalizePublishResponse, PUBLISH_JSON_SCHEMA } from "../src/main/services/publish-generation";

const input = { topic: { topic: "森林", locations: ["河內"], storySummary: "保育", audiencePromise: "認識地方" }, durationMs: 30_000, introSummary: [{ assetId: "a", fileName: "a.mp4", sourceInMs: 0, sourceOutMs: 3_000, order: 1 }], timelineSummary: [], candidates: [{ candidateId: "thumbnail-1", assetId: "a", sourceTimeMs: 0, sourceFileName: "a.mp4", framePath: "C:\\frame.jpg", origin: "INTRO" as const }, { candidateId: "thumbnail-2", assetId: "b", sourceTimeMs: 10_000, sourceFileName: "b.mp4", framePath: "C:\\frame2.jpg", origin: "MAIN" as const }, { candidateId: "thumbnail-3", assetId: "c", sourceTimeMs: 20_000, sourceFileName: "c.mp4", framePath: "C:\\frame3.jpg", origin: "MAIN" as const }] };
function validResponse() { return { titles: [1, 2, 3].map((n) => ({ text: `標題${n}`, reason: "故事" })), description: "說明", englishSummary: "summary", hashtags: ["#森林"], thumbnails: [1, 2, 3].map((n) => ({ candidateId: `thumbnail-${n}`, overlayText: "森林", layout: "LEFT_TEXT", colorNote: "自然", reason: "影格" })), chapters: [{ startMs: 0, title: "開始", description: "" }, { startMs: 10_000, title: "中段", description: "" }, { startMs: 20_000, title: "結尾", description: "" }], warnings: [] }; }

describe("publish generation contract", () => {
  it("normalizes full schema and rejects unknown thumbnail candidate", () => {
    expect(normalizePublishResponse(validResponse(), input).thumbnails).toHaveLength(3);
    expect(() => normalizePublishResponse({ ...validResponse(), thumbnails: [{ ...validResponse().thumbnails[0], candidateId: "other" }, ...validResponse().thumbnails.slice(1)] }, input)).toThrow(/候選影格/);
  });
  it("sends Responses store:false, strict schema and low-res image inputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "publish-gen-")); await writeFile(path.join(root, "frame.jpg"), Buffer.from("fake")); await writeFile(path.join(root, "frame2.jpg"), Buffer.from("fake")); await writeFile(path.join(root, "frame3.jpg"), Buffer.from("fake")); const testInput = { ...input, candidates: input.candidates.map((candidate, index) => ({ ...candidate, framePath: path.join(root, `frame${index ? index + 1 : ""}.jpg`) })) };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); expect(body.store).toBe(false); expect(body.text.format.strict).toBe(true); expect(body.text.format.schema).toEqual(PUBLISH_JSON_SCHEMA); expect(body.input[0].content.some((part: { type: string }) => part.type === "input_image")).toBe(true); return new Response(JSON.stringify({ output_text: JSON.stringify(validResponse()) }), { status: 200, headers: { "x-request-id": "req-test" } }); }) as unknown as typeof fetch;
    const provider = new OpenAiProvider(fetcher);
    const result = await provider.generatePublishAssets(testInput, { id: "x", name: "x", provider: "OPENAI", visionModel: "gpt-test", transcriptionModel: "gpt-test", credentialStatus: "SAVED_ENCRYPTED", updatedAt: "" , apiKey: "sk-test" });
    expect(result.model).toBe("gpt-test"); expect(result.requestId).toBe("req-test"); expect(fetcher).toHaveBeenCalledOnce();
    await rm(root, { recursive: true, force: true });
  });
});
