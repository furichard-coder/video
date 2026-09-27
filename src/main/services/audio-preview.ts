import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioPreviewRequest, AudioPreviewResult } from "../../shared/domain";
import { finalizePartialOutput } from "./atomic-output";
import { buildAudioProcessingFilter, parseEbur128Summary, sanitizeAudioProcessingOptions } from "./audio-processing";
import { runProcess } from "./process-runner";
import type { ProjectStore } from "./project-store";
import { MediaProbe } from "./media-probe";

const MAX_PREVIEW_MS = 30_000;
const PREVIEW_CACHE_VERSION = 2;
const MAX_CACHE_BYTES = 2 * 1024 ** 3;
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

export class AudioPreviewService {
  constructor(
    private readonly root: string,
    private readonly store: ProjectStore,
    private readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.cleanup();
  }

  async create(request: AudioPreviewRequest, signal?: AbortSignal): Promise<AudioPreviewResult> {
    const asset = this.store.getProject().sources.find((item) => item.id === request.assetId);
    if (!asset || asset.kind !== "VIDEO") throw new Error("請先選擇一支含音訊的影片才能試聽。");
    const info = await new MediaProbe().probe(asset.sourcePath, signal);
    if (!info.audioCodec) throw new Error("選取的影片沒有可試聽音軌。");
    const options = sanitizeAudioProcessingOptions(request.options);
    const file = await stat(asset.sourcePath);
    const maximumStartMs = Math.max(0, (info.durationMs ?? Number.MAX_SAFE_INTEGER) - 1_000);
    const startMs = Math.min(maximumStartMs, Math.max(0, Math.round(request.startMs ?? 0)));
    const availableDurationMs = Math.max(1_000, (info.durationMs ?? Number.MAX_SAFE_INTEGER) - startMs);
    const durationMs = Math.max(1_000, Math.min(MAX_PREVIEW_MS, availableDurationMs, Math.round(request.durationMs ?? 20_000)));
    const cacheKey = createHash("sha256")
      .update(JSON.stringify({ sourcePath: asset.sourcePath, size: file.size, mtimeMs: file.mtimeMs, startMs, durationMs, timelineRevision: request.timelineRevision ?? this.store.getProject().timelineRevision, options, version: PREVIEW_CACHE_VERSION }))
      .digest("hex");
    const outputPath = path.join(this.root, `${cacheKey}.m4a`);
    const surroundPath = path.join(this.root, `${cacheKey}.5.1.m4a`);
    const meterPath = path.join(this.root, `${cacheKey}.meter.json`);
    const plan = buildAudioProcessingFilter(options);
    if (options.mode === "VIRTUAL_SURROUND_5_1") {
      const surround = await stat(surroundPath).catch(() => undefined);
      if (!surround?.isFile() || surround.size <= 0) {
        const partialSurroundPath = path.join(this.root, `.${cacheKey}.${randomUUID()}.partial.5.1.m4a`);
        try {
          await runProcess(this.ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-y", "-ss", String(startMs / 1000), "-t", String(durationMs / 1000), "-i", asset.sourcePath,
            "-filter_complex", plan.filter!, "-map", "[aout]", "-c:a", "aac", "-b:a", "384k", "-ar", "48000", "-ac", "6", partialSurroundPath,
          ], signal);
          await finalizePartialOutput(partialSurroundPath, surroundPath);
        } finally {
          await rm(partialSurroundPath, { force: true });
        }
      }
    }
    const existing = await stat(outputPath).catch(() => undefined);
    const cacheStatus = existing?.isFile() && existing.size > 0 ? "HIT" as const : "CREATED" as const;
    if (!existing?.isFile() || existing.size <= 0) {
      const partialPath = path.join(this.root, `.${cacheKey}.${randomUUID()}.partial.m4a`);
      const args = options.mode === "VIRTUAL_SURROUND_5_1"
        ? ["-hide_banner", "-loglevel", "error", "-y", "-i", surroundPath]
        : ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startMs / 1000), "-t", String(durationMs / 1000), "-i", asset.sourcePath];
      if (options.mode === "VIRTUAL_SURROUND_5_1") {
        args.push("-map", "0:a:0", "-af", plan.monitoringFilter!);
      } else if (options.mode === "ENHANCED_STEREO") {
        args.push("-map", "0:a:0", "-af", plan.filter ?? "anull");
      } else {
        args.push("-map", "0:a:0", "-af", "aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo");
      }
      args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", partialPath);
      try {
        await runProcess(this.ffmpeg, args, signal);
        await finalizePartialOutput(partialPath, outputPath);
      } finally {
        await rm(partialPath, { force: true });
      }
    }
    let meter = await readFile(meterPath, "utf8").then((value) => JSON.parse(value)).catch(() => undefined);
    if (!meter) {
      const meterInput = options.mode === "VIRTUAL_SURROUND_5_1" ? surroundPath : options.mode === "PRESERVE_MULTICHANNEL" ? asset.sourcePath : outputPath;
      const trimArgs = options.mode === "PRESERVE_MULTICHANNEL" ? ["-ss", String(startMs / 1000), "-t", String(durationMs / 1000)] : [];
      const measured = await runProcess(
        this.ffmpeg,
        ["-hide_banner", "-nostats", ...trimArgs, "-i", meterInput, "-filter_complex", "ebur128=peak=true,astats=metadata=0:reset=0", "-f", "null", "-"],
        signal,
      );
      meter = parseEbur128Summary(measured.stderr);
      await writeFile(meterPath, JSON.stringify(meter), { encoding: "utf8", flag: "wx" }).catch(() => undefined);
    }
    const now = new Date();
    await Promise.all([utimes(outputPath, now, now).catch(() => undefined), utimes(surroundPath, now, now).catch(() => undefined), utimes(meterPath, now, now).catch(() => undefined)]);
    await this.cleanup();
    return {
      cacheKey,
      url: `preview-media://audio-preview/${cacheKey}`,
      mode: options.mode,
      monitoring:
        options.mode === "VIRTUAL_SURROUND_5_1" || options.mode === "PRESERVE_MULTICHANNEL"
          ? "DOWNMIXED_5_1"
          : "STEREO",
      durationMs,
      startMs,
      cacheStatus,
      sourceChannels: info.audioChannels,
      sourceChannelLayout: info.audioChannelLayout,
      meter,
    };
  }

  async resolveExisting(cacheKey: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/i.test(cacheKey)) throw new Error("音訊試聽快取識別碼無效。");
    const outputPath = path.join(this.root, `${cacheKey}.m4a`);
    const file = await stat(outputPath);
    if (!file.isFile() || file.size <= 0) throw new Error("音訊試聽快取不存在。");
    return outputPath;
  }

  async cleanup(now = Date.now()): Promise<{ removedFiles: number; removedBytes: number }> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const filePath = path.join(this.root, entry.name);
            const info = await stat(filePath).catch(() => undefined);
            return info ? { filePath, size: info.size, mtimeMs: info.mtimeMs } : undefined;
          }),
      )
    ).filter((item): item is { filePath: string; size: number; mtimeMs: number } => Boolean(item));
    let total = files.reduce((sum, item) => sum + item.size, 0);
    let removedFiles = 0;
    let removedBytes = 0;
    for (const item of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      const stalePartial = path.basename(item.filePath).includes(".partial") && now - item.mtimeMs > 60 * 60_000;
      if (!stalePartial && now - item.mtimeMs <= CACHE_TTL_MS && total <= MAX_CACHE_BYTES) continue;
      await rm(item.filePath, { force: true });
      total -= item.size;
      removedFiles += 1;
      removedBytes += item.size;
    }
    return { removedFiles, removedBytes };
  }
}
