import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  const width = asset.mediaInfo?.displayWidth ?? asset.mediaInfo?.width;
  const height = asset.mediaInfo?.displayHeight ?? asset.mediaInfo?.height;
  if (!width || !height) return undefined;
  const scale = Math.min(1, 854 / width, 480 / height);
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
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

  async ensure(
    assetId: string,
    variant: PreviewVariant,
    signal?: AbortSignal,
  ): Promise<PreviewResult> {
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
        throw new Error(
          `無法建立${variant === "THUMBNAIL" ? "縮圖" : "預覽"}：${detail}`,
        );
      }
      return this.result(asset, variant, invalidated ? "INVALIDATED" : "CREATED");
    }, signal);
  }

  async ensureWithPath(assetId: string, variant: PreviewVariant, signal?: AbortSignal): Promise<PreviewResult & { cachePath: string }> {
    const result = await this.ensure(assetId, variant, signal);
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const names: Record<PreviewVariant, string> = { THUMBNAIL: "thumbnail.jpg", IMAGE_PREVIEW: "image-preview.jpg", VIDEO_PROXY: "video-preview.mp4", VIDEO_CLIP_PROXY: "video-clip-preview.mp4" };
    return { ...result, cachePath: path.join(this.cacheDirectory(asset.previewCacheKey), names[variant]) };
  }

  async ensureClip(assetId: string, inMs: number, outMs: number, signal?: AbortSignal): Promise<PreviewResult> {
    assertSafeHexId(assetId, "Asset ID");
    const startMs = Math.round(inMs); const endMs = Math.round(outMs);
    return this.pool.run(async () => {
      let asset = await this.sources.refreshAsset(assetId);
      if (asset.kind !== "VIDEO") throw new Error("只有影片可以建立區段代理。");
      asset = await this.sources.ensureMetadata(assetId, signal);
      const durationMs = asset.mediaInfo?.durationMs;
      if (!durationMs || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs > durationMs + 50 || endMs - startMs < 100) {
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
      if (await exists(markerPath) && await isUsableCachedOutput(outputPath, "VIDEO_CLIP_PROXY")) {
        try {
          const marker = JSON.parse(await readFile(markerPath, "utf8")) as CacheMarker & { sourceStartMs?: number; sourceEndMs?: number };
          const markerMatches = marker.cacheKey === asset.previewCacheKey && marker.previewerVersion === CLIP_PREVIEWER_VERSION && marker.sourcePath === asset.sourcePath && marker.sourceSize === asset.sizeBytes && marker.sourceModifiedAt === asset.fileModifiedAt && marker.variant === "VIDEO_CLIP_PROXY" && marker.sourceStartMs === startMs && marker.sourceEndMs === endMs;
          if (markerMatches) {
            const output = await stat(outputPath);
            const fingerprintMatches = marker.outputSizeBytes === output.size && marker.outputModifiedAt === output.mtime.toISOString();
            hit = fingerprintMatches || await this.isValidProxy(outputPath);
            if (hit && !fingerprintMatches) {
              await writeFile(markerPath, `${JSON.stringify({ ...marker, outputSizeBytes: output.size, outputModifiedAt: output.mtime.toISOString() }, null, 2)}\n`, "utf8");
            }
          }
        } catch { hit = false; }
      }
      if (!hit) {
        const partialPath = `${outputPath}.${process.pid}.partial.mp4`;
        try {
          await rm(partialPath, { force: true });
          await this.generateVideoProxy(asset, partialPath, signal, { startMs, durationMs: endMs - startMs });
          await this.assertGeneratedOutput(partialPath, "VIDEO_CLIP_PROXY", signal);
          await rename(partialPath, outputPath);
          const output = await stat(outputPath);
          await writeFile(markerPath, `${JSON.stringify({ cacheKey: asset.previewCacheKey, previewerVersion: CLIP_PREVIEWER_VERSION, sourcePath: asset.sourcePath, sourceSize: asset.sizeBytes, sourceModifiedAt: asset.fileModifiedAt, variant: "VIDEO_CLIP_PROXY", sourceStartMs: startMs, sourceEndMs: endMs, generatedAt: new Date().toISOString(), outputSizeBytes: output.size, outputModifiedAt: output.mtime.toISOString() }, null, 2)}\n`, "utf8");
        } catch (error) {
          await rm(partialPath, { force: true });
          if (isAbort(error)) throw error;
          const detail = error instanceof ProcessFailure ? error.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || error.message : error instanceof Error ? error.message : String(error);
          throw new Error(`無法建立快速區段代理：${detail}`);
        }
      }
      return { assetId: asset.id, variant: "VIDEO_CLIP_PROXY", cacheStatus: hit ? "HIT" : "CREATED", sourceStartMs: startMs, sourceEndMs: endMs, url: `preview-media://cache/${asset.id}/video_clip_proxy/${clipKey}?key=${asset.previewCacheKey}` };
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
    assertSafeHexId(assetId, "Asset ID"); assertSafeHexId(clipKey, "Clip cache key");
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const directory = this.cacheDirectory(asset.previewCacheKey);
    const outputPath = assertWithinRoot(directory, path.join(directory, `clip-${clipKey}.mp4`));
    if (!(await exists(outputPath))) throw new Error("區段代理尚未建立或已失效。");
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
      const markerMatches = (
        marker.cacheKey === asset.previewCacheKey &&
        marker.previewerVersion === PREVIEWER_VERSION &&
        marker.sourcePath === asset.sourcePath &&
        marker.sourceSize === asset.sizeBytes &&
        marker.sourceModifiedAt === asset.fileModifiedAt &&
        marker.variant === variant
      );
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
        ? [
            "-ss",
            String(Math.max(0, Math.min(30, (asset.mediaInfo?.durationMs ?? 10_000) / 10_000))),
          ]
        : [];
    await runProcess(
      this.ffmpegExecutable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...seekArgs,
        "-i",
        asset.sourcePath,
        "-frames:v",
        "1",
        "-vf",
        `scale=${maxSize}:${maxSize}:force_original_aspect_ratio=decrease`,
        "-q:v",
        "3",
        "-y",
        outputPath,
      ],
      signal,
    );
  }

  private async generateVideoProxy(asset: SourceAsset, outputPath: string, signal?: AbortSignal, range?: { startMs: number; durationMs: number }): Promise<void> {
    const dimensions = targetDimensions(asset);
    const scale = dimensions
      ? `scale=${dimensions.width}:${dimensions.height}:flags=fast_bilinear,setsar=1,fps=30000/1001`
      : "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,setsar=1,fps=30000/1001";
    const args = (hardware: boolean, audio: boolean) => [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      ...(hardware ? ["-hwaccel", "auto"] : []),
      ...(range ? ["-ss", String(range.startMs / 1000), "-t", String(range.durationMs / 1000)] : []),
      "-i", asset.sourcePath, "-map", "0:v:0", ...(audio ? ["-map", "0:a:0?"] : []),
      "-vf", scale, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p",
      "-map_metadata", "-1", "-sn", "-dn",
      ...(audio ? ["-c:a", "aac", "-b:a", "64k", "-af", "aresample=async=1:first_pts=0"] : ["-an"]),
      "-tag:v", "avc1", "-fps_mode", "cfr", "-avoid_negative_ts", "make_zero", "-max_muxing_queue_size", "2048",
      "-movflags", "+faststart", "-y", outputPath,
    ];
    let lastError: unknown;
    // iPhone HEVC/Dolby Vision MOV commonly spends longer negotiating generic
    // hardware decode than decoding in software. Prefer the measured reliable
    // route for this family, while retaining the previous fallback for others.
    const isAppleHevcMov = asset.extension.toLowerCase() === ".mov" && asset.mediaInfo?.videoCodec?.toLowerCase() === "hevc";
    const attempts = isAppleHevcMov
      ? [[false, true], [false, false], [true, true]] as const
      : [[true, true], [false, true], [false, false]] as const;
    for (const [hardware, audio] of attempts) {
      try { await rm(outputPath, { force: true }); await runProcess(this.ffmpegExecutable, args(hardware, audio), signal); return; }
      catch (error) { if (isAbort(error)) throw error; lastError = error; }
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
