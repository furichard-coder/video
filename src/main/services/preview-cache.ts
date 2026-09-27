import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PREVIEWER_VERSION,
  CLIP_PREVIEWER_VERSION,
  type CacheStatus,
  type PreviewResult,
  type PreviewVariant,
  type SourceAsset,
} from "../../shared/domain";
import { assertSafeHexId, assertWithinRoot } from "./path-safety";
import { ProcessFailure, runProcess } from "./process-runner";
import { MediaProbe } from "./media-probe";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import { TaskPool } from "./task-pool";
import { resolveMediaOrientation } from "../../shared/media-orientation";

interface CacheMarker {
  cacheKey: string;
  previewerVersion: string;
  sourcePath: string;
  sourceSize: number;
  sourceModifiedAt: string;
  variant: PreviewVariant;
  generatedAt: string;
  /** Verified output fingerprint; lets small per-cue proxies reopen without a new ffprobe process. */
  outputSizeBytes?: number;
  outputModifiedAt?: string;
}

const INTRO_THUMBNAIL_VERSION = "intro-thumbnail-v1";
const INTRO_THUMBNAIL_LIMIT_PER_ASSET = 64;

const OUTPUT_NAMES: Record<PreviewVariant, string> = {
  THUMBNAIL: "thumbnail.jpg",
  IMAGE_PREVIEW: "image-preview.jpg",
  VIDEO_PROXY: "video-preview.mp4",
  VIDEO_CLIP_PROXY: "video-clip-preview.mp4",
};

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isUsableCachedOutput(filePath: string, variant: PreviewVariant): Promise<boolean> {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) return false;
    return file.size >= (variant === "VIDEO_PROXY" || variant === "VIDEO_CLIP_PROXY" ? 1_024 : 64);
  } catch {
    return false;
  }
}

function targetDimensions(asset: SourceAsset): { width: number; height: number } | undefined {
  const orientation = resolveMediaOrientation({
    width: asset.mediaInfo?.width,
    height: asset.mediaInfo?.height,
    rotationDegrees: asset.mediaInfo?.rotationDegrees,
  });
  const width = orientation.displayWidth;
  const height = orientation.displayHeight;
  if (!width || !height) return undefined;
  const scale = Math.min(1, 854 / width, 480 / height);
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

async function pruneIntroThumbnailCache(directory: string, keepKey: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const markerNames = entries
    .filter((entry) => entry.isFile() && /^intro-[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => entry.name);
  if (markerNames.length <= INTRO_THUMBNAIL_LIMIT_PER_ASSET) return;
  const markers = await Promise.all(
    markerNames.map(async (name) => {
      const markerPath = assertWithinRoot(directory, path.join(directory, name));
      const file = await stat(markerPath);
      return { name, modifiedAtMs: file.mtimeMs };
    }),
  );
  const stale = markers
    .filter(({ name }) => name !== `intro-${keepKey}.json`)
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)
    .slice(0, Math.max(0, markers.length - INTRO_THUMBNAIL_LIMIT_PER_ASSET));
  await Promise.all(
    stale.flatMap(({ name }) => {
      const key = name.slice("intro-".length, -".json".length);
      return [
        rm(assertWithinRoot(directory, path.join(directory, `intro-${key}.json`)), { force: true }),
        rm(assertWithinRoot(directory, path.join(directory, `intro-${key}.jpg`)), { force: true }),
      ];
    }),
  );
}

export class PreviewCache {
  private readonly pool = new TaskPool(2);

  constructor(
    readonly cacheRoot: string,
    private readonly store: ProjectStore,
    private readonly sources: SourceService,
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly mediaProbe = new MediaProbe(),
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
  }

  async ensure(assetId: string, variant: PreviewVariant, signal?: AbortSignal): Promise<PreviewResult> {
    assertSafeHexId(assetId, "Asset ID");
    if (variant === "VIDEO_CLIP_PROXY") throw new Error("區段代理必須包含安全的片段時間範圍。");
    return this.pool.run(async () => {
      const before = this.store.getAsset(assetId);
      if (!before) throw new Error("找不到來源項目。");
      let asset = await this.sources.refreshAsset(assetId);
      const invalidated = before.previewCacheKey !== asset.previewCacheKey;

      if (variant === "IMAGE_PREVIEW" && asset.kind !== "IMAGE") {
        throw new Error("此來源不是圖片，無法建立圖片預覽。");
      }
      if (variant === "VIDEO_PROXY" && asset.kind !== "VIDEO") {
        throw new Error("此來源不是影片，無法建立影片預覽。");
      }
      if (
        asset.kind === "VIDEO" &&
        (variant === "THUMBNAIL" || variant === "VIDEO_PROXY") &&
        asset.metadataState !== "READY"
      ) {
        asset = await this.sources.ensureMetadata(assetId, signal);
      }

      const directory = this.cacheDirectory(asset.previewCacheKey);
      const outputPath = assertWithinRoot(directory, path.join(directory, OUTPUT_NAMES[variant]));
      const markerPath = assertWithinRoot(directory, path.join(directory, `${variant.toLowerCase()}.json`));
      await mkdir(directory, { recursive: true });

      if (await this.cacheHit(markerPath, outputPath, asset, variant)) {
        return this.result(asset, variant, "HIT");
      }

      const partialPath = `${outputPath}.${process.pid}.partial${path.extname(outputPath)}`;
      try {
        await rm(partialPath, { force: true });
        await this.generate(asset, variant, partialPath, signal);
        await this.assertGeneratedOutput(partialPath, variant, signal);
        await rename(partialPath, outputPath);
        const marker: CacheMarker = {
          cacheKey: asset.previewCacheKey,
          previewerVersion: PREVIEWER_VERSION,
          sourcePath: asset.sourcePath,
          sourceSize: asset.sizeBytes,
          sourceModifiedAt: asset.fileModifiedAt,
          variant,
          generatedAt: new Date().toISOString(),
        };
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      } catch (error) {
        await rm(partialPath, { force: true });
        if (isAbort(error)) throw error;
        const detail =
          error instanceof ProcessFailure
            ? error.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || error.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(`無法建立${variant === "THUMBNAIL" ? "縮圖" : "預覽"}：${detail}`);
      }
      return this.result(asset, variant, invalidated ? "INVALIDATED" : "CREATED");
    }, signal);
  }

  async ensureWithPath(
    assetId: string,
    variant: PreviewVariant,
    signal?: AbortSignal,
  ): Promise<PreviewResult & { cachePath: string }> {
    const result = await this.ensure(assetId, variant, signal);
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const names: Record<PreviewVariant, string> = {
      THUMBNAIL: "thumbnail.jpg",
      IMAGE_PREVIEW: "image-preview.jpg",
      VIDEO_PROXY: "video-preview.mp4",
      VIDEO_CLIP_PROXY: "video-clip-preview.mp4",
    };
    return { ...result, cachePath: path.join(this.cacheDirectory(asset.previewCacheKey), names[variant]) };
  }

  async ensureClip(assetId: string, inMs: number, outMs: number, signal?: AbortSignal): Promise<PreviewResult> {
    assertSafeHexId(assetId, "Asset ID");
    const startMs = Math.round(inMs);
    const endMs = Math.round(outMs);
    return this.pool.run(async () => {
      let asset = await this.sources.refreshAsset(assetId);
      if (asset.kind !== "VIDEO") throw new Error("只有影片可以建立區段代理。");
      asset = await this.sources.ensureMetadata(assetId, signal);
      const durationMs = asset.mediaInfo?.durationMs;
      if (
        !durationMs ||
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        startMs < 0 ||
        endMs > durationMs + 50 ||
        endMs - startMs < 100
      ) {
        throw new Error("區段代理時間必須位於來源影片內，且至少 0.1 秒。");
      }
      const clipKey = createHash("sha256")
        .update(`${CLIP_PREVIEWER_VERSION}\0${asset.previewCacheKey}\0${startMs}\0${endMs}`)
        .digest("hex");
      const directory = this.cacheDirectory(asset.previewCacheKey);
      const outputPath = assertWithinRoot(directory, path.join(directory, `clip-${clipKey}.mp4`));
      const markerPath = assertWithinRoot(directory, path.join(directory, `clip-${clipKey}.json`));
      await mkdir(directory, { recursive: true });
      let hit = false;
      if ((await exists(markerPath)) && (await isUsableCachedOutput(outputPath, "VIDEO_CLIP_PROXY"))) {
        try {
          const marker = JSON.parse(await readFile(markerPath, "utf8")) as CacheMarker & {
            sourceStartMs?: number;
            sourceEndMs?: number;
          };
          const markerMatches =
            marker.cacheKey === asset.previewCacheKey &&
            marker.previewerVersion === CLIP_PREVIEWER_VERSION &&
            marker.sourcePath === asset.sourcePath &&
            marker.sourceSize === asset.sizeBytes &&
            marker.sourceModifiedAt === asset.fileModifiedAt &&
            marker.variant === "VIDEO_CLIP_PROXY" &&
            marker.sourceStartMs === startMs &&
            marker.sourceEndMs === endMs;
          if (markerMatches) {
            const output = await stat(outputPath);
            const fingerprintMatches =
              marker.outputSizeBytes === output.size && marker.outputModifiedAt === output.mtime.toISOString();
            hit = fingerprintMatches || (await this.isValidProxy(outputPath));
            if (hit && !fingerprintMatches) {
              await writeFile(
                markerPath,
                `${JSON.stringify({ ...marker, outputSizeBytes: output.size, outputModifiedAt: output.mtime.toISOString() }, null, 2)}\n`,
                "utf8",
              );
            }
          }
        } catch {
          hit = false;
        }
      }
      if (!hit) {
        const partialPath = `${outputPath}.${process.pid}.partial.mp4`;
        try {
          await rm(partialPath, { force: true });
          await this.generateVideoProxy(asset, partialPath, signal, { startMs, durationMs: endMs - startMs });
          await this.assertGeneratedOutput(partialPath, "VIDEO_CLIP_PROXY", signal);
          await rename(partialPath, outputPath);
          const output = await stat(outputPath);
          await writeFile(
            markerPath,
            `${JSON.stringify({ cacheKey: asset.previewCacheKey, previewerVersion: CLIP_PREVIEWER_VERSION, sourcePath: asset.sourcePath, sourceSize: asset.sizeBytes, sourceModifiedAt: asset.fileModifiedAt, variant: "VIDEO_CLIP_PROXY", sourceStartMs: startMs, sourceEndMs: endMs, generatedAt: new Date().toISOString(), outputSizeBytes: output.size, outputModifiedAt: output.mtime.toISOString() }, null, 2)}\n`,
            "utf8",
          );
        } catch (error) {
          await rm(partialPath, { force: true });
          if (isAbort(error)) throw error;
          const detail =
            error instanceof ProcessFailure
              ? error.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || error.message
              : error instanceof Error
                ? error.message
                : String(error);
          throw new Error(`無法建立快速區段代理：${detail}`);
        }
      }
      return {
        assetId: asset.id,
        variant: "VIDEO_CLIP_PROXY",
        cacheStatus: hit ? "HIT" : "CREATED",
        sourceStartMs: startMs,
        sourceEndMs: endMs,
        url: `preview-media://cache/${asset.id}/video_clip_proxy/${clipKey}?key=${asset.previewCacheKey}`,
      };
    }, signal);
  }

  async resolveExisting(assetId: string, variant: PreviewVariant): Promise<string> {
    assertSafeHexId(assetId, "Asset ID");
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const directory = this.cacheDirectory(asset.previewCacheKey);
    const outputPath = assertWithinRoot(directory, path.join(directory, OUTPUT_NAMES[variant]));
    if (!(await exists(outputPath))) throw new Error("預覽尚未建立或已失效。");
    return outputPath;
  }

  async resolveClipExisting(assetId: string, clipKey: string): Promise<string> {
    assertSafeHexId(assetId, "Asset ID");
    assertSafeHexId(clipKey, "Clip cache key");
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const directory = this.cacheDirectory(asset.previewCacheKey);
    const outputPath = assertWithinRoot(directory, path.join(directory, `clip-${clipKey}.mp4`));
    if (!(await exists(outputPath))) throw new Error("區段代理尚未建立或已失效。");
    return outputPath;
  }

  async ensureIntroThumbnail(
    assetId: string,
    inMs: number,
    outMs: number,
    signal?: AbortSignal,
  ): Promise<{ url: string; cacheStatus: "HIT" | "CREATED" }> {
    assertSafeHexId(assetId, "Asset ID");
    const startMs = Math.max(0, Math.round(inMs));
    const endMs = Math.max(startMs + 100, Math.round(outMs));
    return this.pool.run(async () => {
      let asset = await this.sources.refreshAsset(assetId);
      if (asset.kind === "VIDEO") asset = await this.sources.ensureMetadata(assetId, signal);
      const durationMs = asset.mediaInfo?.durationMs;
      if (durationMs && (startMs >= durationMs || endMs > durationMs + 50)) throw new Error("片頭縮圖時間超出來源範圍。");
      const thumbnailKey = createHash("sha256")
        .update(`${INTRO_THUMBNAIL_VERSION}\0${asset.previewCacheKey}\0${startMs}\0${endMs}`)
        .digest("hex");
      const directory = this.cacheDirectory(asset.previewCacheKey);
      const outputPath = assertWithinRoot(directory, path.join(directory, `intro-${thumbnailKey}.jpg`));
      const markerPath = assertWithinRoot(directory, path.join(directory, `intro-${thumbnailKey}.json`));
      await mkdir(directory, { recursive: true });
      if ((await exists(markerPath)) && (await isUsableCachedOutput(outputPath, "THUMBNAIL"))) {
        try {
          const marker = JSON.parse(await readFile(markerPath, "utf8")) as CacheMarker & {
            sourceStartMs?: number;
            sourceEndMs?: number;
          };
          if (
            marker.cacheKey === asset.previewCacheKey &&
            marker.previewerVersion === INTRO_THUMBNAIL_VERSION &&
            marker.sourcePath === asset.sourcePath &&
            marker.sourceSize === asset.sizeBytes &&
            marker.sourceModifiedAt === asset.fileModifiedAt &&
            marker.sourceStartMs === startMs &&
            marker.sourceEndMs === endMs
          ) {
            return {
              cacheStatus: "HIT" as const,
              url: `preview-media://intro-thumbnail/${asset.id}/${thumbnailKey}?key=${asset.previewCacheKey}`,
            };
          }
        } catch {
          // Invalid marker is regenerated below.
        }
      }
      const partialPath = `${outputPath}.${process.pid}.partial.jpg`;
      const orientation = resolveMediaOrientation({
        width: asset.mediaInfo?.width,
        height: asset.mediaInfo?.height,
        rotationDegrees: asset.mediaInfo?.rotationDegrees,
      });
      const scale = `${orientation.ffmpegFilter ? `${orientation.ffmpegFilter},` : ""}scale=480:480:force_original_aspect_ratio=decrease`;
      try {
        await rm(partialPath, { force: true });
        if (asset.kind === "VIDEO") {
          const scanSeconds = Math.max(0.1, Math.min(2, (endMs - startMs) / 1000));
          try {
            await runProcess(
              this.ffmpegExecutable,
              [
                "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(startMs / 1000), "-noautorotate",
                "-i", asset.sourcePath, "-t", String(scanSeconds), "-frames:v", "1", "-vf",
                `${orientation.ffmpegFilter ? `${orientation.ffmpegFilter},` : ""}blackframe=amount=98:threshold=32,metadata=select:key=lavfi.blackframe.pblack:value=98:function=less,scale=480:480:force_original_aspect_ratio=decrease`,
                "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0", "-q:v", "4", "-y", partialPath,
              ],
              signal,
            );
          } catch (error) {
            if (isAbort(error)) throw error;
            await rm(partialPath, { force: true });
            await runProcess(
              this.ffmpegExecutable,
              [
                "-hide_banner", "-loglevel", "error", "-nostdin", "-ss",
                String(Math.min(endMs - 1, startMs + Math.min(500, Math.max(0, endMs - startMs - 1))) / 1000),
                "-noautorotate", "-i", asset.sourcePath, "-frames:v", "1", "-vf", scale,
                "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0", "-q:v", "4", "-y", partialPath,
              ],
              signal,
            );
          }
        } else {
          await runProcess(
            this.ffmpegExecutable,
            ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", asset.sourcePath, "-frames:v", "1", "-vf", scale, "-q:v", "4", "-y", partialPath],
            signal,
          );
        }
        if (!(await isUsableCachedOutput(partialPath, "THUMBNAIL"))) throw new Error("FFmpeg 未產生有效片頭縮圖。");
        await rename(partialPath, outputPath);
        await writeFile(
          markerPath,
          `${JSON.stringify({ cacheKey: asset.previewCacheKey, previewerVersion: INTRO_THUMBNAIL_VERSION, sourcePath: asset.sourcePath, sourceSize: asset.sizeBytes, sourceModifiedAt: asset.fileModifiedAt, variant: "THUMBNAIL", sourceStartMs: startMs, sourceEndMs: endMs, generatedAt: new Date().toISOString() }, null, 2)}\n`,
          "utf8",
        );
        await pruneIntroThumbnailCache(directory, thumbnailKey).catch(() => undefined);
      } finally {
        await rm(partialPath, { force: true });
      }
      return {
        cacheStatus: "CREATED" as const,
        url: `preview-media://intro-thumbnail/${asset.id}/${thumbnailKey}?key=${asset.previewCacheKey}`,
      };
    }, signal);
  }

  async resolveIntroThumbnailExisting(assetId: string, thumbnailKey: string): Promise<string> {
    assertSafeHexId(assetId, "Asset ID");
    assertSafeHexId(thumbnailKey, "Intro thumbnail cache key");
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const directory = this.cacheDirectory(asset.previewCacheKey);
    const outputPath = assertWithinRoot(directory, path.join(directory, `intro-${thumbnailKey}.jpg`));
    if (!(await exists(outputPath))) throw new Error("片頭縮圖尚未建立或已失效。");
    return outputPath;
  }

  private cacheDirectory(cacheKey: string): string {
    const safeKey = assertSafeHexId(cacheKey, "Cache key");
    return assertWithinRoot(this.cacheRoot, path.join(this.cacheRoot, safeKey));
  }

  private async cacheHit(
    markerPath: string,
    outputPath: string,
    asset: SourceAsset,
    variant: PreviewVariant,
  ): Promise<boolean> {
    if (!(await isUsableCachedOutput(outputPath, variant)) || !(await exists(markerPath))) return false;
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as CacheMarker;
      const markerMatches =
        marker.cacheKey === asset.previewCacheKey &&
        marker.previewerVersion === PREVIEWER_VERSION &&
        marker.sourcePath === asset.sourcePath &&
        marker.sourceSize === asset.sizeBytes &&
        marker.sourceModifiedAt === asset.fileModifiedAt &&
        marker.variant === variant;
      if (!markerMatches) return false;
      return variant === "VIDEO_PROXY" ? this.isValidProxy(outputPath) : true;
    } catch {
      return false;
    }
  }

  private async isValidProxy(filePath: string, signal?: AbortSignal): Promise<boolean> {
    if (!(await isUsableCachedOutput(filePath, "VIDEO_PROXY"))) return false;
    try {
      const info = await this.mediaProbe.probe(filePath, signal);
      return info.videoCodec === "h264" && Boolean(info.width && info.height && info.durationMs && info.durationMs > 0);
    } catch (error) {
      if (isAbort(error)) throw error;
      return false;
    }
  }

  private async assertGeneratedOutput(filePath: string, variant: PreviewVariant, signal?: AbortSignal): Promise<void> {
    if (variant !== "VIDEO_PROXY" && variant !== "VIDEO_CLIP_PROXY") {
      if (!(await isUsableCachedOutput(filePath, variant))) throw new Error("FFmpeg 未產生有效的預覽檔案。");
      return;
    }
    if (!(await this.isValidProxy(filePath, signal))) {
      throw new Error("MOV／影片已完成轉檔程序，但產生的 MP4 無法通過 H.264 播放驗證。");
    }
  }

  private async generate(
    asset: SourceAsset,
    variant: PreviewVariant,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (variant === "VIDEO_PROXY") {
      await this.generateVideoProxy(asset, outputPath, signal);
      return;
    }

    const maxSize = variant === "IMAGE_PREVIEW" ? 1800 : 480;
    const seekArgs =
      asset.kind === "VIDEO"
        ? ["-ss", String(Math.max(0, Math.min(30, (asset.mediaInfo?.durationMs ?? 10_000) / 10_000)))]
        : [];
    const orientation = resolveMediaOrientation({
      width: asset.mediaInfo?.width,
      height: asset.mediaInfo?.height,
      rotationDegrees: asset.mediaInfo?.rotationDegrees,
    });
    const videoOrientationFilter = asset.kind === "VIDEO" ? orientation.ffmpegFilter : undefined;
    await runProcess(
      this.ffmpegExecutable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...seekArgs,
        ...(asset.kind === "VIDEO" ? ["-noautorotate"] : []),
        "-i",
        asset.sourcePath,
        "-frames:v",
        "1",
        "-vf",
        `${videoOrientationFilter ? `${videoOrientationFilter},` : ""}scale=${maxSize}:${maxSize}:force_original_aspect_ratio=decrease`,
        "-map_metadata",
        "-1",
        "-metadata:s:v:0",
        "rotate=0",
        "-q:v",
        "3",
        "-y",
        outputPath,
      ],
      signal,
    );
  }

  private async generateVideoProxy(
    asset: SourceAsset,
    outputPath: string,
    signal?: AbortSignal,
    range?: { startMs: number; durationMs: number },
  ): Promise<void> {
    const dimensions = targetDimensions(asset);
    const orientation = resolveMediaOrientation({
      width: asset.mediaInfo?.width,
      height: asset.mediaInfo?.height,
      rotationDegrees: asset.mediaInfo?.rotationDegrees,
    });
    const geometry = dimensions
      ? `scale=${dimensions.width}:${dimensions.height}:flags=fast_bilinear,setsar=1,fps=30000/1001`
      : "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,setsar=1,fps=30000/1001";
    const scale = `${orientation.ffmpegFilter ? `${orientation.ffmpegFilter},` : ""}${geometry}`;
    const args = (hardware: boolean, audio: boolean) => [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...(hardware ? ["-hwaccel", "auto"] : []),
      ...(range ? ["-ss", String(range.startMs / 1000), "-t", String(range.durationMs / 1000)] : []),
      "-noautorotate",
      "-i",
      asset.sourcePath,
      "-map",
      "0:v:0",
      ...(audio ? ["-map", "0:a:0?"] : []),
      "-vf",
      scale,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "32",
      "-pix_fmt",
      "yuv420p",
      "-map_metadata",
      "-1",
      "-metadata:s:v:0",
      "rotate=0",
      "-sn",
      "-dn",
      ...(audio ? ["-c:a", "aac", "-b:a", "64k", "-af", "aresample=async=1:first_pts=0"] : ["-an"]),
      "-tag:v",
      "avc1",
      "-fps_mode",
      "cfr",
      "-avoid_negative_ts",
      "make_zero",
      "-max_muxing_queue_size",
      "2048",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ];
    let lastError: unknown;
    // iPhone HEVC/Dolby Vision MOV commonly spends longer negotiating generic
    // hardware decode than decoding in software. Prefer the measured reliable
    // route for this family, while retaining the previous fallback for others.
    const isAppleHevcMov =
      asset.extension.toLowerCase() === ".mov" && asset.mediaInfo?.videoCodec?.toLowerCase() === "hevc";
    const attempts = isAppleHevcMov
      ? ([
          [false, true],
          [false, false],
          [true, true],
        ] as const)
      : ([
          [true, true],
          [false, true],
          [false, false],
        ] as const);
    for (const [hardware, audio] of attempts) {
      try {
        await rm(outputPath, { force: true });
        await runProcess(this.ffmpegExecutable, args(hardware, audio), signal);
        return;
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private result(asset: SourceAsset, variant: PreviewVariant, cacheStatus: CacheStatus): PreviewResult {
    return {
      assetId: asset.id,
      variant,
      cacheStatus,
      url: `preview-media://cache/${asset.id}/${variant.toLowerCase()}?key=${asset.previewCacheKey}`,
    };
  }
}
