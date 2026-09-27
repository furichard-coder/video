import type { SourceAsset } from "../../shared/domain";
import { runProcess } from "./process-runner";
import { TaskPool } from "./task-pool";

export const SILENCE_ANALYZER_VERSION = "clip-volume-v1";
export const SILENCE_MAX_VOLUME_THRESHOLD_DB = -50;

export type SilenceProcessRunner = typeof runProcess;

export interface SilenceDetector {
  isSilent(asset: SourceAsset, startMs: number, durationMs: number, signal?: AbortSignal): Promise<boolean>;
}

export function parseMaximumVolumeDb(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/gi)];
  const raw = matches.at(-1)?.[1]?.toLowerCase();
  if (!raw) return undefined;
  if (raw === "-inf") return Number.NEGATIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Exact selected-range acoustic check. It never writes to the source file. */
export class ClipSilenceDetector implements SilenceDetector {
  private readonly cache = new Map<string, Promise<boolean>>();
  private readonly pool = new TaskPool(2);

  constructor(
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly runner: SilenceProcessRunner = runProcess,
    private readonly thresholdDb = SILENCE_MAX_VOLUME_THRESHOLD_DB,
  ) {}

  async isSilent(asset: SourceAsset, startMs: number, durationMs: number, signal?: AbortSignal): Promise<boolean> {
    if (asset.kind !== "VIDEO") return false;
    if (!asset.mediaInfo?.audioCodec) return true;
    const normalizedStartMs = Math.max(0, Math.round(startMs));
    const normalizedDurationMs = Math.max(100, Math.round(durationMs));
    const key = [
      SILENCE_ANALYZER_VERSION,
      asset.previewCacheKey,
      normalizedStartMs,
      normalizedDurationMs,
      this.thresholdDb,
    ].join(":");
    const existing = this.cache.get(key);
    if (existing) return existing;
    const task = this.pool.run(() => this.measure(asset, normalizedStartMs, normalizedDurationMs, signal), signal);
    this.cache.set(key, task);
    try {
      return await task;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }

  private async measure(asset: SourceAsset, startMs: number, durationMs: number, signal?: AbortSignal) {
    const nullOutput = process.platform === "win32" ? "NUL" : "/dev/null";
    const { stderr } = await this.runner(
      this.ffmpegExecutable,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-ss",
        (startMs / 1000).toFixed(3),
        "-i",
        asset.sourcePath,
        "-t",
        (durationMs / 1000).toFixed(3),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        nullOutput,
      ],
      signal,
    );
    const maximumDb = parseMaximumVolumeDb(stderr);
    if (maximumDb === undefined)
      throw new Error(`無法判斷「${asset.fileName}」所選片段是否無聲；已停止自動套用配樂，請檢查音軌。`);
    return maximumDb <= this.thresholdDb;
  }
}
