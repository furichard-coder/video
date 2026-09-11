import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConcatRenderProgress, SubtitlePreviewResult } from "../../shared/domain";
import { assertSafeHexId, assertWithinRoot } from "./path-safety";
import { ProjectStore } from "./project-store";
import { ConcatRenderService } from "./concat-render";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import { buildTimelinePlan } from "../../shared/timeline-plan";

export const SUBTITLE_INTRO_PREVIEWER_VERSION = "subtitle-intro-480p-v2";

interface PreviewMarker {
  cacheKey: string;
  previewerVersion: string;
  durationMs: number;
  outputFileName?: string;
  bgmIncluded?: boolean;
  createdAt: string;
}

async function isFile(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile(); }
  catch { return false; }
}

export class SubtitlePreviewService {
  constructor(
    readonly cacheRoot: string,
    private readonly store: ProjectStore,
    private readonly renderer: ConcatRenderService,
  ) {}

  async initialize(): Promise<void> { await mkdir(this.cacheRoot, { recursive: true }); }

  async ensureIntro480p(includeBgm = false, signal?: AbortSignal, onProgress: (progress: ConcatRenderProgress) => void = () => undefined): Promise<SubtitlePreviewResult> {
    const project = this.store.getProject();
    if (!project.introSegments.length) throw new Error("片頭沒有已確認片段，無法建立 480P 字幕預覽。");
    const outputIntroSegments = introSegmentsForOutput(project.introSegments, project.introSegmentMaxDurationMs);
    const sources = new Map(project.sources.map((asset) => [asset.id, asset]));
    const sourceState = await Promise.all([...new Set(project.introSegments.map((segment) => segment.assetId))].map(async (assetId) => {
      const asset = sources.get(assetId);
      if (!asset) throw new Error("片頭包含不存在的來源素材。");
      const file = await stat(asset.sourcePath);
      if (!file.isFile()) throw new Error(`片頭來源不存在：${asset.fileName}`);
      return { assetId, sourcePath: asset.sourcePath, size: file.size, modifiedMs: file.mtimeMs, previewCacheKey: asset.previewCacheKey };
    }));
    const bgmState = includeBgm ? await Promise.all(project.bgmTracks.map(async (track) => {
      if (track.resolutionStatus === "NEEDS_LOCAL_FILE" || !track.sourcePath) throw new Error(`配樂尚未指定可用的本機 MP3：${track.fileName}`);
      const file = await stat(track.sourcePath).catch(() => undefined);
      if (!file?.isFile()) throw new Error(`配樂不存在或已離線：${track.fileName}`);
      return { track, size: file.size, modifiedMs: file.mtimeMs };
    })) : [];
    const cacheKey = createHash("sha256").update(JSON.stringify({
      version: SUBTITLE_INTRO_PREVIEWER_VERSION,
      projectId: project.id,
      introSegments: project.introSegments,
      introSegmentMaxDurationMs: project.introSegmentMaxDurationMs,
      colorSettings: project.colorSettings,
      sourceAudioVolumePercent: project.sourceAudioVolumePercent,
      bgmIncluded: includeBgm,
      bgmState,
      sourceState,
      transitionSeconds: project.timelineTransitionSeconds,
      canonicalMainTimelineDurationMs: buildTimelinePlan(project).durationMs,
    })).digest("hex");
    const directory = assertWithinRoot(this.cacheRoot, path.join(this.cacheRoot, cacheKey));
    const outputFileName = includeBgm ? "intro-bgm-subtitle-preview-480p.mp4" : "intro-subtitle-preview-480p.mp4";
    const outputPath = assertWithinRoot(directory, path.join(directory, outputFileName));
    const markerPath = assertWithinRoot(directory, path.join(directory, "marker.json"));
    await mkdir(directory, { recursive: true });
    if (await isFile(outputPath) && await isFile(markerPath)) {
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as PreviewMarker;
        if (marker.cacheKey === cacheKey && marker.previewerVersion === SUBTITLE_INTRO_PREVIEWER_VERSION && marker.durationMs > 0) {
          onProgress({ phase: "FINALIZING", percent: 100, outTimeMs: marker.durationMs, expectedDurationMs: marker.durationMs });
          const outputStat = await stat(outputPath);
          return { cacheKey, cacheStatus: "HIT", durationMs: marker.durationMs, url: `preview-media://subtitle/${cacheKey}`, outputPath, sizeBytes: outputStat.size, bgmIncluded: includeBgm };
        }
      } catch { /* stale marker: rebuild */ }
    }
    await rm(outputPath, { force: true });
    const result = await this.renderer.render({
      outputToken: `subtitle-preview-${cacheKey}`,
      orderedAssetIds: outputIntroSegments.map((segment) => segment.assetId),
      clipSelections: outputIntroSegments.map((segment) => ({ assetId: segment.assetId, inMs: segment.inMs, outMs: segment.outMs })),
      transitionSeconds: project.timelineTransitionSeconds,
      resolution: "480P",
      videoCodec: "H265_QSV",
      purpose: "INTRO",
      includeBgm,
    }, outputPath, signal, onProgress);
    if (result.cancelled || signal?.aborted) {
      await rm(outputPath, { force: true });
      throw new DOMException("480P 片頭字幕預覽已取消。", "AbortError");
    }
    const marker: PreviewMarker = { cacheKey, previewerVersion: SUBTITLE_INTRO_PREVIEWER_VERSION, durationMs: result.expectedDurationMs, outputFileName, bgmIncluded: includeBgm, createdAt: new Date().toISOString() };
    const partialMarker = `${markerPath}.${process.pid}.${randomUUID()}.partial`;
    try { await rm(markerPath, { force: true }); await writeFile(partialMarker, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(partialMarker, markerPath); }
    catch (error) { await rm(partialMarker, { force: true }); await rm(outputPath, { force: true }); throw error; }
    return { cacheKey, cacheStatus: "CREATED", durationMs: result.expectedDurationMs, url: `preview-media://subtitle/${cacheKey}`, outputPath, sizeBytes: result.sizeBytes, bgmIncluded: includeBgm };
  }

  async resolveExisting(cacheKey: string): Promise<string> {
    assertSafeHexId(cacheKey, "Subtitle preview cache key");
    const directory = assertWithinRoot(this.cacheRoot, path.join(this.cacheRoot, cacheKey));
    const markerPath = assertWithinRoot(directory, path.join(directory, "marker.json"));
    let outputFileName = "intro-subtitle-preview-480p.mp4";
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as PreviewMarker;
      if (marker.outputFileName === "intro-bgm-subtitle-preview-480p.mp4" || marker.outputFileName === "intro-subtitle-preview-480p.mp4") outputFileName = marker.outputFileName;
    } catch { /* Older valid caches use the original filename. */ }
    const outputPath = assertWithinRoot(directory, path.join(directory, outputFileName));
    if (!(await isFile(outputPath))) throw new Error("480P 片頭字幕預覽尚未建立或已失效。");
    return outputPath;
  }
}
