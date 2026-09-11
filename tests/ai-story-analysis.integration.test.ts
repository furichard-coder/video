import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiSettingsStore } from "../src/main/services/ai-settings";
import { AI_STORY_ANALYZER_VERSION, AiStoryAnalysisService } from "../src/main/services/ai-story-analysis";
import type { CodexCliStoryProvider } from "../src/main/services/codex-cli-provider";
import { MediaProbe } from "../src/main/services/media-probe";
import { OpenAiProvider } from "../src/main/services/openai-provider";
import { ProjectStore } from "../src/main/services/project-store";
import { runProcess } from "../src/main/services/process-runner";
import { SourceService } from "../src/main/services/source-service";

let root: string;
let sourcePath: string;
let store: ProjectStore;
let sources: SourceService;
let service: AiStoryAnalysisService;
let aiSettings: AiSettingsStore;
const analyzeStoryFrames = vi.fn(async (request: { transcript: string }) => ({
  suggestedSubtitle: request.transcript ? `字幕：${request.transcript}` : "主持人走過河內街道",
  visualSummary: "主持人在城市街道步行",
  eventSummary: "抵達後開始步行探索",
  peopleSummary: ["主持人"],
  locationSummary: ["河內"],
  topicRelevanceScore: 94,
  transcriptVisualMatchScore: 89,
  confidence: 87,
  warnings: [],
}));
const provider = {
  testConnection: vi.fn(async () => undefined),
  testStoryConnection: vi.fn(async () => ({ checks: ["API Key 驗證", "故事模型"], requestIds: ["req-story-ready"] })),
  transcribeBytes: vi.fn(async () => ({ segments: [{ startMs: 0, endMs: 1_500, text: "河內城市散步" }] })),
  transcribe: vi.fn(async () => [
    { startMs: 500, endMs: 1_300, text: "我們抵達河內", speaker: "A" },
    { startMs: 1_500, endMs: 2_300, text: "準備開始步行", speaker: "A" },
  ]),
  analyzeStoryFrames,
};
const codexProvider = {
  testConnection: vi.fn(async () => ({ checks: ["ChatGPT 登入可用"], providerLabel: "Codex／ChatGPT 登入" })),
  analyzeStoryFramesBatch: vi.fn(async () => new Map()),
};

async function sha256(filePath: string): Promise<string> { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "source-app-ai-story-")); sourcePath = path.join(root, "河內 故事.mp4");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", sourcePath]);
  const dataRoot = path.join(root, "app-data"); store = new ProjectStore(dataRoot); await store.initialize(); sources = new SourceService(store, new MediaProbe()); await sources.importSelected([sourcePath]); await sources.ensureMetadata(store.getProject().sources[0].id);
  await store.setAiStoryContext({ topic: "河內旅行", locations: ["河內"], people: ["主持人"], storySummary: "抵達後步行探索", audiencePromise: "看見城市體驗", subtitleLanguage: "zh" });
  await store.setSubtitleCues([{ id: "confirmed", startMs: 0, endMs: 400, text: "人工確認開場", origin: "MANUAL", reviewStatus: "CONFIRMED" }]);
  const protector = { isAvailable: () => true, protect: (value: string) => Buffer.from(value).toString("base64"), unprotect: (value: string) => Buffer.from(value, "base64").toString() };
  aiSettings = new AiSettingsStore(dataRoot, protector); await aiSettings.initialize(); await aiSettings.saveAccount({ id: "openai-default", name: "測試 OpenAI", provider: "OPENAI", visionModel: "gpt-5.6-terra", transcriptionModel: "gpt-4o-transcribe-diarize", apiKey: "sk-test-123456789012345678901234567890", makeActive: true });
  service = new AiStoryAnalysisService(path.join(dataRoot, "cache", "ai-story"), store, sources, aiSettings, provider as unknown as OpenAiProvider, codexProvider as unknown as CodexCliStoryProvider); await service.initialize();
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("AI story and subtitle pipeline", () => {
  it("maps speech to the timeline, stores reviewable evidence, reuses visual cache, and preserves source bytes", async () => {
    const before = await sha256(sourcePath); const phases: string[] = [];
    const first = await service.generateSubtitles({ includeSpeechTranscription: true }, undefined, (progress) => phases.push(progress.phase));
    expect(first.analysisVersion).toBe(AI_STORY_ANALYZER_VERSION); expect(first.generatedCount).toBe(2); expect(first.transcribedCount).toBe(2);
    expect(first.project.subtitleCues[0]).toMatchObject({ id: "confirmed", reviewStatus: "CONFIRMED" });
    expect(first.project.subtitleCues.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({ origin: "AI_SPEECH", reviewStatus: "CONFIRMED", sourceAssetId: expect.any(String), sourceInMs: 500, sourceOutMs: 1300, peopleSummary: ["主持人"], locationSummary: ["河內"], topicRelevanceScore: 94, transcriptVisualMatchScore: 89 })]));
    expect(phases).toEqual(expect.arrayContaining(["EXTRACTING_AUDIO", "TRANSCRIBING", "SAMPLING_FRAMES", "MATCHING_STORY", "SAVING_DRAFTS"]));
    const calls = analyzeStoryFrames.mock.calls.length; const second = await service.generateSubtitles({ includeSpeechTranscription: true });
    expect(second.generatedCount).toBe(0); expect(analyzeStoryFrames).toHaveBeenCalledTimes(calls);
    expect(provider.testStoryConnection).toHaveBeenCalledTimes(1);
    expect(await sha256(sourcePath)).toBe(before);
  }, 30_000);

  it("honors cancellation before reading media", async () => {
    const readinessCalls = provider.testStoryConnection.mock.calls.length; const controller = new AbortController(); controller.abort();
    await expect(service.generateSubtitles({ includeSpeechTranscription: false }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.testStoryConnection).toHaveBeenCalledTimes(readinessCalls);
  });

  it("fails quota preflight before probing or extracting any source frame", async () => {
    const ensureMetadata = vi.spyOn(sources, "ensureMetadata"); ensureMetadata.mockClear();
    const unavailableProvider = { ...provider, testStoryConnection: vi.fn(async () => { throw new Error("credit_balance_exhausted"); }) };
    const unavailableCodex = { ...codexProvider, testConnection: vi.fn(async () => { throw new Error("Codex not logged in"); }) };
    const unavailable = new AiStoryAnalysisService(path.join(root, "app-data", "cache", "ai-story-unavailable"), store, sources, aiSettings, unavailableProvider as unknown as OpenAiProvider, unavailableCodex as unknown as CodexCliStoryProvider);
    await unavailable.initialize();
    await expect(unavailable.generateSubtitles({ includeSpeechTranscription: false, scopes: ["INTRO"] })).rejects.toThrow(/尚未開始分析.*credit_balance_exhausted.*Codex not logged in/);
    expect(ensureMetadata).not.toHaveBeenCalled();
    ensureMetadata.mockRestore();
  });

  it("falls back to the signed-in Codex ChatGPT account when the API project has no credit", async () => {
    const asset = store.getProject().sources[0];
    await store.setSubtitleCues([]);
    await store.setIntroSegments([{ id: "intro-codex", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["森林故事"] }]);
    const quotaProvider = { ...provider, testStoryConnection: vi.fn(async () => { throw new Error("credit_balance_exhausted"); }) };
    const codex = {
      testConnection: vi.fn(async () => ({ checks: ["ChatGPT 登入可用"], providerLabel: "Codex／ChatGPT 登入" })),
      analyzeStoryFramesBatch: vi.fn(async (requests: Array<{ id: string }>) => new Map(requests.map((request) => [request.id, {
        suggestedSubtitle: "森林植被有助保水與穩定土壤", visualSummary: "林間步道", eventSummary: "步行觀察森林", peopleSummary: [], locationSummary: ["大雪山"], topicRelevanceScore: 90, transcriptVisualMatchScore: 70, confidence: 84, warnings: [],
      }]))),
    };
    const fallback = new AiStoryAnalysisService(path.join(root, "app-data", "cache", "ai-story-codex"), store, sources, aiSettings, quotaProvider as unknown as OpenAiProvider, codex as unknown as CodexCliStoryProvider);
    await fallback.initialize();
    const openAiAnalysisCalls = analyzeStoryFrames.mock.calls.length;
    const before = await sha256(sourcePath);
    const result = await fallback.generateSubtitles({ includeSpeechTranscription: false, scopes: ["INTRO"], targetCueCount: 1 });
    expect(result).toMatchObject({ generatedCount: 1, providerLabel: "CODEX_CHATGPT", accountName: expect.stringContaining("Codex／ChatGPT") });
    expect(result.project.subtitleCues[0]).toMatchObject({ text: "森林植被有助保水與穩定土壤", reviewStatus: "CONFIRMED", aiAnalysisVersion: AI_STORY_ANALYZER_VERSION });
    expect(codex.testConnection).toHaveBeenCalledTimes(1);
    expect(codex.analyzeStoryFramesBatch).toHaveBeenCalledTimes(1);
    expect(analyzeStoryFrames).toHaveBeenCalledTimes(openAiAnalysisCalls);
    expect(await sha256(sourcePath)).toBe(before);
    const cached = await fallback.generateSubtitles({ includeSpeechTranscription: false, scopes: ["INTRO"], targetCueCount: 1 });
    expect(cached.generatedCount).toBe(0);
    expect(codex.testConnection).toHaveBeenCalledTimes(1);
    expect(codex.analyzeStoryFramesBatch).toHaveBeenCalledTimes(1);
  });

  it("builds visual knowledge drafts by default without extracting or transcribing source audio", async () => {
    await store.setSubtitleCues([]);
    provider.transcribe.mockClear();
    const phases: string[] = [];
    const result = await service.generateSubtitles({ includeSpeechTranscription: false }, undefined, (progress) => phases.push(progress.phase));
    expect(result.visualOnlyCount).toBeGreaterThan(0);
    expect(result.transcribedCount).toBe(0);
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect(phases).toContain("SAMPLING_FRAMES");
    expect(phases).toContain("MATCHING_STORY");
    expect(phases).not.toContain("TRANSCRIBING");
  });

  it("analyzes only the selected Intro scope and preserves Main drafts", async () => {
    const asset = store.getProject().sources[0];
    await store.setIntroSegments([{ id: "intro-scope", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["人物事件"] }]);
    await store.setSubtitleCues([{ id: "main-draft", startMs: 0, endMs: 500, text: "正片待確認", timelineScope: "MAIN", origin: "AI_VISUAL", reviewStatus: "DRAFT" }]);
    const result = await service.generateSubtitles({ includeSpeechTranscription: false, scopes: ["INTRO"] });
    expect(result.project.subtitleCues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "main-draft", timelineScope: "MAIN", reviewStatus: "DRAFT" }),
      expect.objectContaining({ timelineScope: "INTRO", origin: "AI_VISUAL", reviewStatus: "CONFIRMED" }),
    ]));
  });

  it("transcribes bounded microphone audio in Chinese and rejects unsupported input", async () => {
    const result = await service.transcribeVoiceInput({ audioBytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm;codecs=opus", language: "zh-TW" });
    expect(result).toEqual({ text: "河內城市散步", language: "zh-TW", segmentCount: 1 });
    expect(provider.transcribeBytes).toHaveBeenCalledWith(expect.any(Uint8Array), "voice-input.webm", "audio/webm", expect.objectContaining({ apiKey: expect.stringMatching(/^sk-/) }), "zh", undefined);
    await expect(service.transcribeVoiceInput({ audioBytes: new Uint8Array([1]), mimeType: "video/mp4", language: "zh-TW" })).rejects.toThrow(/格式不支援/);
  });

  it("returns editable, source-traceable drafts for manually selected video frames", async () => {
    const asset = store.getProject().sources[0];
    await store.setSubtitleCues([]);
    const before = await sha256(sourcePath);
    const result = await service.analyzeMaterialForSubtitles({ assetId: asset.id, timelineScope: "MAIN", provider: "CHATGPT", frameTimesMs: [1_000] });
    expect(result).toMatchObject({ providerLabel: "OPENAI_API", analyzedFrameTimesMs: [1_000], analysisVersion: "material-subtitle-v3-gemini-timeline-sync", overlaps: [] });
    expect(result.drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewStatus: "DRAFT", origin: "AI_VISUAL", sourceAssetId: asset.id, sourceInMs: 1_000, aiAnalysisVersion: "material-subtitle-v3-gemini-timeline-sync" }),
    ]));
    expect(await sha256(sourcePath)).toBe(before);
  });

  it("keeps the analyzed subtitle and reports the existing text when its time overlaps", async () => {
    const asset = store.getProject().sources[0];
    await store.setSubtitleCues([{ id: "existing-overlap", startMs: 900, endMs: 1_600, text: "既有森林字幕", timelineScope: "MAIN", reviewStatus: "CONFIRMED" }]);
    const result = await service.analyzeMaterialForSubtitles({ assetId: asset.id, timelineScope: "MAIN", provider: "CHATGPT", frameTimesMs: [1_000] });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].text).toBeTruthy();
    expect(result.overlaps).toEqual([{ draftId: result.drafts[0].id, existingCues: [expect.objectContaining({ id: "existing-overlap", text: "既有森林字幕" })] }]);
    expect(result.warnings.join(" ")).toContain("既有森林字幕");
  });

  it("uses the requested cue target to sample a longer clip more than once", async () => {
    await store.setSubtitleCues([]);
    const result = await service.generateSubtitles({ includeSpeechTranscription: false, scopes: ["MAIN"], targetCueCount: 3, mode: "REPLACE_AI_SCOPE" });
    expect(result.generatedCount).toBe(3);
    expect(result.project.subtitleCues.filter((cue) => cue.timelineScope === "MAIN")).toHaveLength(3);
  });
});
