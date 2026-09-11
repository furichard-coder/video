import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntroAnalysisProgress, IntroAnalysisResult, IntroSuggestion, SourceAsset } from "../../shared/domain";
import {
  DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  DEFAULT_INTRO_TARGET_DURATION_MS,
  INTRO_MAX_SEGMENT_MS,
  INTRO_MAX_SEGMENTS,
  INTRO_MIN_SEGMENT_MS,
} from "../../shared/domain";
import { balanceIntroSegments, normalizeIntroSegmentMaxDuration } from "../../shared/intro-duration";
import { assertSafeHexId, assertWithinRoot } from "./path-safety";
import { runProcess } from "./process-runner";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import type { AiStoryAnalysisService } from "./ai-story-analysis";

export const INTRO_ANALYZER_VERSION = "intro-local-sampler-v2";

interface CandidateScore {
  inMs: number;
  outMs: number;
  score: number;
  reasons: string[];
}

interface AnalysisCache {
  analyzerVersion: string;
  assetId: string;
  previewCacheKey: string;
  analyzedAt: string;
  candidates: CandidateScore[];
}

interface SignalMetrics {
  exposure: number;
  color: number;
  motion: number;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values: number[], fallback: number): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

export function parseSignalMetrics(output: string): SignalMetrics | undefined {
  const values: Record<"YAVG" | "SATAVG" | "YDIF", number[]> = { YAVG: [], SATAVG: [], YDIF: [] };
  const matcher = /lavfi\.signalstats\.(YAVG|SATAVG|YDIF)=([+-]?\d+(?:\.\d+)?)/g;
  for (const match of output.matchAll(matcher)) values[match[1] as keyof typeof values].push(Number(match[2]));
  if (!values.YAVG.length && !values.SATAVG.length && !values.YDIF.length) return undefined;
  const yAverage = average(values.YAVG, 120);
  const saturation = average(values.SATAVG, 24);
  const difference = average(values.YDIF, 5);
  return {
    exposure: clamp(100 - Math.abs(yAverage - 120) * 0.85),
    color: clamp(saturation * 3.2),
    motion: clamp(difference * 7.5),
  };
}

function candidateWindows(durationMs: number): Array<{ inMs: number; outMs: number }> {
  if (durationMs < INTRO_MIN_SEGMENT_MS) return [];
  const clipLength = Math.round(Math.min(INTRO_MAX_SEGMENT_MS, Math.max(INTRO_MIN_SEGMENT_MS, durationMs * 0.18)));
  if (durationMs <= clipLength + 200) return [{ inMs: 0, outMs: durationMs }];
  const starts = durationMs < 15_000 ? [0, 0.45] : [0.02, 0.3, 0.58, 0.8];
  return starts.map((fraction) => {
    const inMs = Math.round(Math.min(durationMs - clipLength, durationMs * fraction));
    return { inMs, outMs: Math.min(durationMs, inMs + clipLength) };
  });
}

function suggestionId(assetId: string, inMs: number, outMs: number): string {
  return createHash("sha256")
    .update(`${INTRO_ANALYZER_VERSION}:${assetId}:${inMs}:${outMs}`)
    .digest("hex")
    .slice(0, 24);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class IntroAnalyzer {
  constructor(
    readonly cacheRoot: string,
    private readonly store: ProjectStore,
    private readonly sources: SourceService,
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly aiStory?: AiStoryAnalysisService,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
  }

  async analyze(
    assetIds: string[],
    signal?: AbortSignal,
    onProgress: (progress: IntroAnalysisProgress) => void = () => undefined,
    maxDurationMs: number = DEFAULT_INTRO_TARGET_DURATION_MS,
    maxSegmentDurationMs: number = DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  ): Promise<IntroAnalysisResult> {
    const uniqueIds = [...new Set(assetIds)];
    if (!uniqueIds.length) throw new Error("沒有可供片頭分析的影片。");
    const selectionLimitMs = Math.round(maxDurationMs);
    if (!Number.isFinite(selectionLimitMs) || selectionLimitMs < INTRO_MIN_SEGMENT_MS)
      throw new Error("片頭目標總長至少需要 0:03。");
    const segmentLimitMs = normalizeIntroSegmentMaxDuration(maxSegmentDurationMs);
    onProgress({ phase: "PREPARING", processed: 0, total: uniqueIds.length });
    const allSuggestions: IntroSuggestion[] = [];
    let analyzedAssetCount = 0;
    let cacheHits = 0;

    for (let index = 0; index < uniqueIds.length; index += 1) {
      if (signal?.aborted) throw new DOMException("片頭分析已取消。", "AbortError");
      const assetId = assertSafeHexId(uniqueIds[index], "Asset ID");
      const existing = this.store.getAsset(assetId);
      if (!existing || existing.kind !== "VIDEO") continue;
      onProgress({
        phase: "ANALYZING",
        processed: index,
        total: uniqueIds.length,
        currentName: existing.fileName,
      });
      const asset = await this.sources.ensureMetadata(assetId, signal);
      if (asset.metadataState !== "READY" || !asset.mediaInfo?.durationMs) continue;
      const cached = await this.readCache(asset);
      const candidates = cached ?? (await this.analyzeAsset(asset, signal));
      if (cached) cacheHits += 1;
      else await this.writeCache(asset, candidates);
      analyzedAssetCount += 1;
      allSuggestions.push(
        ...candidates.map((candidate) => {
          const candidateDurationMs = candidate.outMs - candidate.inMs;
          const durationMs = Math.min(candidateDurationMs, segmentLimitMs);
          const centerMs = (candidate.inMs + candidate.outMs) / 2;
          const inMs = Math.max(
            0,
            Math.min(asset.mediaInfo!.durationMs! - durationMs, Math.round(centerMs - durationMs / 2)),
          );
          const outMs = inMs + durationMs;
          return {
            id: suggestionId(asset.id, inMs, outMs),
            assetId: asset.id,
            fileName: asset.fileName,
            origin: "AI" as const,
            ...candidate,
            inMs,
            outMs,
          };
        }),
      );
    }

    onProgress({ phase: "RANKING", processed: uniqueIds.length, total: uniqueIds.length });
    const suggestions: IntroSuggestion[] = [];
    const perAsset = new Map<string, number>();
    let totalDurationMs = 0;
    for (const candidate of allSuggestions.sort((left, right) => right.score - left.score)) {
      if ((perAsset.get(candidate.assetId) ?? 0) >= 2) continue;
      if (
        suggestions.some(
          (item) =>
            item.assetId === candidate.assetId &&
            Math.max(item.inMs, candidate.inMs) < Math.min(item.outMs, candidate.outMs),
        )
      )
        continue;
      if (
        suggestions.length >= INTRO_MAX_SEGMENTS ||
        totalDurationMs + candidate.outMs - candidate.inMs > selectionLimitMs
      )
        continue;
      suggestions.push(candidate);
      perAsset.set(candidate.assetId, (perAsset.get(candidate.assetId) ?? 0) + 1);
      totalDurationMs += candidate.outMs - candidate.inMs;
    }

    const enriched = this.aiStory
      ? await this.aiStory.enrichIntroSuggestions(suggestions, signal)
      : { suggestions, analyzedCount: 0, fallbackReason: "未啟用雲端故事分析。" };
    const balancedSuggestions = balanceIntroSegments(
      enriched.suggestions,
      this.store.getProject().sources,
      selectionLimitMs,
      segmentLimitMs,
    );
    return {
      analyzerVersion: INTRO_ANALYZER_VERSION,
      analyzedAssetCount,
      cacheHits,
      generatedAt: new Date().toISOString(),
      suggestions: balancedSuggestions,
      analysisMode: enriched.analyzedCount > 0 ? "OPENAI_STORY_MATCH" : "LOCAL_SIGNAL_ONLY",
      cloudAnalyzedCount: enriched.analyzedCount,
      cloudFallbackReason: enriched.fallbackReason,
    };
  }

  private async analyzeAsset(asset: SourceAsset, signal?: AbortSignal): Promise<CandidateScore[]> {
    const durationMs = asset.mediaInfo!.durationMs!;
    const windows = candidateWindows(durationMs);
    const candidates: CandidateScore[] = [];
    for (const window of windows) {
      if (signal?.aborted) throw new DOMException("片頭分析已取消。", "AbortError");
      const sampleDurationMs = Math.min(1_500, window.outMs - window.inMs);
      try {
        const { stdout, stderr } = await runProcess(
          this.ffmpegExecutable,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            String(window.inMs / 1000),
            "-t",
            String(sampleDurationMs / 1000),
            "-i",
            asset.sourcePath,
            "-map",
            "0:v:0",
            "-vf",
            "fps=4,scale=320:180:force_original_aspect_ratio=decrease,signalstats,metadata=mode=print:file=-",
            "-an",
            "-f",
            "null",
            "-",
          ],
          signal,
        );
        const metrics = parseSignalMetrics(`${stdout}\n${stderr}`) ?? { exposure: 58, color: 48, motion: 45 };
        const score = Math.round(clamp(metrics.exposure * 0.45 + metrics.motion * 0.32 + metrics.color * 0.23));
        const reasons = [
          metrics.exposure >= 68 ? "曝光平衡" : undefined,
          metrics.motion >= 58 ? "動態明確" : undefined,
          metrics.color >= 58 ? "色彩醒目" : undefined,
          window.inMs <= durationMs * 0.12 ? "快速進入" : undefined,
        ].filter((reason): reason is string => Boolean(reason));
        candidates.push({ ...window, score, reasons: reasons.length ? reasons : ["畫面節奏候選"] });
      } catch (error) {
        if (isAbort(error)) throw error;
        candidates.push({ ...window, score: 35, reasons: ["依時長與位置建議（畫面抽樣失敗）"] });
      }
    }
    return candidates;
  }

  private cachePath(asset: SourceAsset): string {
    const key = assertSafeHexId(asset.previewCacheKey, "Cache key");
    return assertWithinRoot(this.cacheRoot, path.join(this.cacheRoot, `${key}.json`));
  }

  private async readCache(asset: SourceAsset): Promise<CandidateScore[] | undefined> {
    try {
      const cached = JSON.parse(await readFile(this.cachePath(asset), "utf8")) as AnalysisCache;
      if (
        cached.analyzerVersion === INTRO_ANALYZER_VERSION &&
        cached.assetId === asset.id &&
        cached.previewCacheKey === asset.previewCacheKey &&
        Array.isArray(cached.candidates)
      )
        return cached.candidates;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    return undefined;
  }

  private async writeCache(asset: SourceAsset, candidates: CandidateScore[]): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    const targetPath = this.cachePath(asset);
    const partialPath = `${targetPath}.${process.pid}.tmp`;
    const cache: AnalysisCache = {
      analyzerVersion: INTRO_ANALYZER_VERSION,
      assetId: asset.id,
      previewCacheKey: asset.previewCacheKey,
      analyzedAt: new Date().toISOString(),
      candidates,
    };
    try {
      await writeFile(partialPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await rename(partialPath, targetPath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }
}
