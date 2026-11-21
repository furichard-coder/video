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

export interface SubtitlePreviewPlacement {
  readRoots(): readonly string[];
  chooseWriteRoot(): Promise<string>;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export class SubtitlePreviewService {
  constructor(
    readonly cacheRoot: string,
    private readonly store: ProjectStore,
    private readonly renderer: ConcatRenderService,
    private readonly placement?: SubtitlePreviewPlacement,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
  }

  async ensureIntro480p(
    includeBgm = false,
    signal?: AbortSignal,
    onProgress: (progress: ConcatRenderProgress) => void = () => undefined,
  ): Promise<SubtitlePreviewResult> {
    const project = this.store.getProject();
    if (!project.introSegments.length) throw new Error("片頭沒有已確認片段，無法建立 480P 字幕預覽。");
    const outputIntroSegments = introSegmentsForOutput(project.introSegments, project.introSegmentMaxDurationMs);
    const sources = new Map(project.sources.map((asset) => [asset.id, asset]));
    const sourceState = await Promise.all(
      [...new Set(project.introSegments.map((segment) => segment.assetId))].map(async (assetId) => {
        const asset = sources.get(assetId);
        if (!asset) throw new Error("片頭包含不存在的來源素材。");
        const file = await stat(asset.sourcePath);
        if (!file.isFile()) throw new Error(`片頭來源不存在：${asset.fileName}`);
        return {
          assetId,
          sourcePath: asset.sourcePath,
          size: file.size,
          modifiedMs: file.mtimeMs,
          previewCacheKey: asset.previewCacheKey,
        };
      }),
    );
    const bgmState = includeBgm
      ? await Promise.all(
          project.bgmTracks.map(async (track) => {
            if (track.resolutionStatus === "NEEDS_LOCAL_FILE" || !track.sourcePath)
              throw new Error(`配樂尚未指定可用的本機 MP3：${track.fileName}`);
            const file = await stat(track.sourcePath).catch(() => undefined);
            if (!file?.isFile()) throw new Error(`配樂不存在或已離線：${track.fileName}`);
            return { track, size: file.size, modifiedMs: file.mtimeMs };
          }),
        )
      : [];
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({
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
        }),
      )
      .digest("hex");
    const outputFileName = includeBgm ? "intro-bgm-subtitle-preview-480p.mp4" : "intro-subtitle-preview-480p.mp4";
    for (const directory of this.cacheDirectories(cacheKey)) {
      const outputPath = assertWithinRoot(directory, path.join(directory, outputFileName));
      const markerPath = assertWithinRoot(directory, path.join(directory, "marker.json"));
      if (!(await isFile(outputPath)) || !(await isFile(markerPath))) continue;
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as PreviewMarker;
        if (
          marker.cacheKey === cacheKey &&
          marker.previewerVersion === SUBTITLE_INTRO_PREVIEWER_VERSION &&
          marker.durationMs > 0
        ) {
          onProgress({
            phase: "FINALIZING",
            percent: 100,
            outTimeMs: marker.durationMs,
            expectedDurationMs: marker.durationMs,
          });
          const outputStat = await stat(outputPath);
          return {
            cacheKey,
            cacheStatus: "HIT",
            durationMs: marker.durationMs,
            url: `preview-media://subtitle/${cacheKey}`,
            outputPath,
            sizeBytes: outputStat.size,
            bgmIncluded: includeBgm,
          };
        }
      } catch {
        /* stale marker: rebuild */
      }
    }
    const root = path.resolve(this.placement ? await this.placement.chooseWriteRoot() : this.cacheRoot);
    const directory = assertWithinRoot(root, path.join(root, cacheKey));
    const outputPath = assertWithinRoot(directory, path.join(directory, outputFileName));
    const markerPath = assertWithinRoot(directory, path.join(directory, "marker.json"));
    await mkdir(directory, { recursive: true });
    await rm(outputPath, { force: true });
    const result = await this.renderer.render(
      {
        outputToken: `subtitle-preview-${cacheKey}`,
        orderedAssetIds: outputIntroSegments.map((segment) => segment.assetId),
        clipSelections: outputIntroSegments.map((segment) => ({
          assetId: segment.assetId,
          inMs: segment.inMs,
          outMs: segment.outMs,
        })),
        transitionSeconds: project.timelineTransitionSeconds,
        resolution: "480P",
        videoCodec: "H265_QSV",
        purpose: "INTRO",
        includeBgm,
      },
      outputPath,
      signal,
      onProgress,
    );
    if (result.cancelled || signal?.aborted) {
      await rm(outputPath, { force: true });
      throw new DOMException("480P 片頭字幕預覽已取消。", "AbortError");
    }
    const marker: PreviewMarker = {
      cacheKey,
      previewerVersion: SUBTITLE_INTRO_PREVIEWER_VERSION,
      durationMs: result.expectedDurationMs,
      outputFileName,
      bgmIncluded: includeBgm,
      createdAt: new Date().toISOString(),
    };
    const partialMarker = `${markerPath}.${process.pid}.${randomUUID()}.partial`;
    try {
      await rm(markerPath, { force: true });
      await writeFile(partialMarker, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(partialMarker, markerPath);
    } catch (error) {
      await rm(partialMarker, { force: true });
      await rm(outputPath, { force: true });
      throw error;
    }
    return {
      cacheKey,
      cacheStatus: "CREATED",
      durationMs: result.expectedDurationMs,
      url: `preview-media://subtitle/${cacheKey}`,
      outputPath,
      sizeBytes: result.sizeBytes,
      bgmIncluded: includeBgm,
    };
  }

  async resolveExisting(cacheKey: string): Promise<string> {
    assertSafeHexId(cacheKey, "Subtitle preview cache key");
    for (const directory of this.cacheDirectories(cacheKey)) {
      const markerPath = assertWithinRoot(directory, path.join(directory, "marker.json"));
      const marker = await readFile(markerPath, "utf8").then((value) => JSON.parse(value) as PreviewMarker)
        .catch(() => undefined);
      if (
        marker?.cacheKey !== cacheKey ||
        marker.previewerVersion !== SUBTITLE_INTRO_PREVIEWER_VERSION ||
        !Number.isFinite(marker.durationMs) || marker.durationMs <= 0
      ) continue;
      const outputFileName = marker.outputFileName === "intro-bgm-subtitle-preview-480p.mp4"
        ? marker.outputFileName : "intro-subtitle-preview-480p.mp4";
      const outputPath = assertWithinRoot(directory, path.join(directory, outputFileName));
      if (await isFile(outputPath)) return outputPath;
    }
    throw new Error("480P 片頭字幕預覽尚未建立或已失效。");
  }

  private cacheDirectories(cacheKey: string): string[] {
    const safeKey = assertSafeHexId(cacheKey, "Subtitle preview cache key");
    const roots = [this.cacheRoot, ...(this.placement?.readRoots() ?? [])];
    return [...new Set(roots.map((root) => path.resolve(root)))].map((root) => assertWithinRoot(root, path.join(root, safeKey)));
  }
}
