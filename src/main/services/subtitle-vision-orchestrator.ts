import { clampSubtitleSamplingBatchSize } from "./subtitle-video-selection";
import { createHash } from "node:crypto";

export type SubtitleVisionProviderKind = "OPENAI" | "GEMINI";
export type SubtitleDensity = "LOW" | "STANDARD" | "DETAILED";
export type SubtitleVisionLanguage = "zh-TW" | "zh-CN" | "en" | "ja" | "ko";

export interface SubtitleVisionFrame {
  id: string;
  timestampMs: number;
  imageDataUrl: string;
  fingerprint: string;
  videoFingerprint: string;
  videoDurationMs: number;
  contextRevision: string;
  segmentType: "INTRO" | "MAIN" | "PHOTO" | "INSERT" | "OUTRO";
  context: {
    projectName: string;
    title?: string;
    description?: string;
    chapter?: string;
    previousSubtitle?: string;
    neighborTimestampsMs?: number[];
  };
}

export interface SubtitleVisionDraft {
  frameId: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  provenance: Array<"VISIBLE" | "PROJECT_CONTEXT" | "USER_CONFIRMED">;
  warning?: string;
}

export interface SubtitleVisionBatchResult {
  drafts: SubtitleVisionDraft[];
  inputTokens?: number;
  outputTokens?: number;
  requestId?: string;
}

export interface SubtitleVisionProvider {
  readonly kind: SubtitleVisionProviderKind;
  readonly version: string;
  analyzeBatch(
    frames: readonly SubtitleVisionFrame[],
    options: { language: SubtitleVisionLanguage; density: SubtitleDensity },
    signal?: AbortSignal,
  ): Promise<SubtitleVisionBatchResult>;
}

export interface SubtitleVisionRunProgress {
  processed: number;
  total: number;
  requests: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

export interface SubtitleVisionResumeState {
  runSignature: string;
  nextIndex: number;
  drafts: SubtitleVisionDraft[];
  progress: SubtitleVisionRunProgress;
}

export interface SubtitleVisionCache {
  get(key: string): Promise<SubtitleVisionDraft[] | undefined>;
  set(key: string, drafts: readonly SubtitleVisionDraft[]): Promise<void>;
}

function cacheKey(
  frame: SubtitleVisionFrame,
  provider: SubtitleVisionProvider,
  density: SubtitleDensity,
  language: SubtitleVisionLanguage,
): string {
  const contextHash = createHash("sha256")
    .update(
      JSON.stringify({
        videoFingerprint: frame.videoFingerprint,
        contextRevision: frame.contextRevision,
        segmentType: frame.segmentType,
        context: frame.context,
      }),
    )
    .digest("hex");
  return [frame.fingerprint, frame.timestampMs, contextHash, provider.kind, provider.version, density, language].join(
    ":",
  );
}

function validateDraft(draft: SubtitleVisionDraft, framesById: Map<string, SubtitleVisionFrame>): SubtitleVisionDraft {
  const frame = framesById.get(draft.frameId);
  if (!frame) throw new Error("AI 回傳了不屬於本批次的影格識別碼。");
  const text = draft.text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("AI 回傳了空白字幕。");
  if (text.length > 120) throw new Error("AI 字幕超過安全長度，請縮短後再確認。");
  if (
    !Number.isFinite(draft.startMs) ||
    !Number.isFinite(draft.endMs) ||
    draft.startMs < 0 ||
    draft.endMs <= draft.startMs
  )
    throw new Error("AI 回傳了無效字幕時間。");
  if (draft.endMs > frame.videoDurationMs) throw new Error("AI 回傳的字幕超出分析影片時長。");
  const provenance = draft.provenance.filter(
    (item): item is SubtitleVisionDraft["provenance"][number] =>
      item === "VISIBLE" || item === "PROJECT_CONTEXT" || item === "USER_CONFIRMED",
  );
  if (!provenance.length) throw new Error("AI 字幕缺少可追溯來源，不會加入草稿。");
  return { ...draft, text, confidence: Math.max(0, Math.min(1, Number(draft.confidence) || 0)), provenance };
}

export async function runSubtitleVisionDrafts(
  frames: readonly SubtitleVisionFrame[],
  provider: SubtitleVisionProvider,
  cache: SubtitleVisionCache,
  options: {
    batchSize?: number;
    density?: SubtitleDensity;
    language?: SubtitleVisionLanguage;
    resume?: SubtitleVisionResumeState;
    signal?: AbortSignal;
    onProgress?: (progress: SubtitleVisionRunProgress) => void;
  } = {},
): Promise<SubtitleVisionResumeState> {
  const batchSize = clampSubtitleSamplingBatchSize(options.batchSize ?? 20);
  const density = options.density ?? "STANDARD";
  const language = options.language ?? "zh-TW";
  const runSignature = createHash("sha256")
    .update(
      JSON.stringify({
        frames: frames.map((frame) => [
          frame.id,
          frame.videoFingerprint,
          frame.fingerprint,
          frame.timestampMs,
          frame.contextRevision,
        ]),
        provider: provider.kind,
        providerVersion: provider.version,
        density,
        language,
      }),
    )
    .digest("hex");
  const startedAt = Date.now();
  const prior = options.resume;
  if (prior && prior.runSignature !== runSignature)
    throw new Error("字幕分析 Resume 已過期；影片、內容或 Provider 設定已變更。");
  let nextIndex = Math.max(0, Math.min(frames.length, Math.round(prior?.nextIndex ?? 0)));
  const drafts = [...(prior?.drafts ?? [])];
  const progress: SubtitleVisionRunProgress = {
    processed: nextIndex,
    total: frames.length,
    requests: prior?.progress.requests ?? 0,
    cacheHits: prior?.progress.cacheHits ?? 0,
    inputTokens: prior?.progress.inputTokens ?? 0,
    outputTokens: prior?.progress.outputTokens ?? 0,
    elapsedMs: prior?.progress.elapsedMs ?? 0,
  };
  const publish = () => {
    progress.elapsedMs = (prior?.progress.elapsedMs ?? 0) + (Date.now() - startedAt);
    options.onProgress?.({ ...progress });
  };

  while (nextIndex < frames.length) {
    if (options.signal?.aborted) throw new DOMException("AI 字幕分析已取消；既有正式字幕保持不變。", "AbortError");
    const window = frames.slice(nextIndex, nextIndex + batchSize);
    const misses: SubtitleVisionFrame[] = [];
    for (const frame of window) {
      const cached = await cache.get(cacheKey(frame, provider, density, language));
      if (cached) {
        drafts.push(...cached);
        progress.cacheHits += 1;
      } else misses.push(frame);
    }
    if (misses.length) {
      const result = await provider.analyzeBatch(misses, { language, density }, options.signal);
      progress.requests += 1;
      progress.inputTokens += Math.max(0, Math.round(result.inputTokens ?? 0));
      progress.outputTokens += Math.max(0, Math.round(result.outputTokens ?? 0));
      const framesById = new Map(misses.map((frame) => [frame.id, frame]));
      const validated = result.drafts.map((draft) => validateDraft(draft, framesById));
      for (const frame of misses) {
        const forFrame = validated.filter((draft) => draft.frameId === frame.id);
        await cache.set(cacheKey(frame, provider, density, language), forFrame);
        drafts.push(...forFrame);
      }
    }
    nextIndex += window.length;
    progress.processed = nextIndex;
    publish();
  }
  publish();
  return { runSignature, nextIndex, drafts, progress: { ...progress } };
}
