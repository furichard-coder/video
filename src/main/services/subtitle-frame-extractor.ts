import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildSubtitleSamplingPlan,
  type SubtitleSamplingPlan,
  type SubtitleSamplingSegment,
} from "./subtitle-sampling-plan";
import { assertWithinRoot } from "./path-safety";
import { finalizePartialOutput } from "./atomic-output";
import { runProcess } from "./process-runner";
import jpeg from "jpeg-js";
import { computeSubtitleFrameDHash } from "./subtitle-sampling-plan";

type ProcessRunner = typeof runProcess;

export interface SubtitleFrameExtractionRequest {
  projectId: string;
  sourcePath: string;
  cacheRoot: string;
  segments: SubtitleSamplingSegment[];
  intervalSeconds: number;
  sceneThreshold?: number;
  detectSceneChanges?: boolean;
  deduplicateFrames?: boolean;
  /** Kept for compatibility; no sample cap is applied. */
  maxSamples?: number;
  signal?: AbortSignal;
  onProgress?: (progress: SubtitleFrameExtractionProgress) => void;
}

export interface SubtitleFrameExtractionProgress {
  stage: "SCENES" | "BLACK_FRAMES" | "FRAMES";
  completed: number;
  total: number;
  timeMs?: number;
  rawFrames?: number;
  sceneFrames?: number;
  deduplicatedFrames?: number;
}

export interface ExtractedSubtitleFrame {
  timeMs: number;
  segmentType: SubtitleSamplingSegment["type"];
  source: "INTERVAL" | "SCENE_CHANGE" | "FIRST_USABLE";
  path: string;
  perceptualHash?: string;
}

export interface SubtitleFrameExtractionResult {
  purpose: "FRAME_ANALYSIS_ONLY";
  plan: SubtitleSamplingPlan;
  frames: ExtractedSubtitleFrame[];
}

export type SubtitleFrameBatchConsumer = (frames: ExtractedSubtitleFrame[], batchIndex: number) => Promise<void> | void;

export interface SubtitleFrameBatchExtractionResult {
  purpose: "FRAME_ANALYSIS_ONLY";
  plan: SubtitleSamplingPlan;
  batchesEmitted: number;
}

const MAX_CACHE_FILES = 500;
const FRAME_BATCH_SIZE = 20;
const SCAN_CHUNK_MS = 10 * 60 * 1_000;
const FRAME_CACHE_NAME = /^subtitle-frame-[a-f0-9]{64}\.jpg$/;

function frameDHash(bytes: Buffer): string {
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  if (!decoded.width || !decoded.height) throw new Error("無法解碼字幕分析影格以進行感知去重。");
  const gray = new Uint8Array(72);
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 9; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(((x + 0.5) * decoded.width) / 9));
      const sourceY = Math.min(decoded.height - 1, Math.floor(((y + 0.5) * decoded.height) / 8));
      const offset = (sourceY * decoded.width + sourceX) * 4;
      gray[y * 9 + x] = Math.round(
        decoded.data[offset] * 0.299 + decoded.data[offset + 1] * 0.587 + decoded.data[offset + 2] * 0.114,
      );
    }
  return computeSubtitleFrameDHash(gray);
}

function hashDistance(left: string, right: string): number {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let bits = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (bits) {
      distance += bits & 1;
      bits >>>= 1;
    }
  }
  return distance;
}

function seconds(value: number): string {
  return (value / 1_000).toFixed(3).replace(/\.000$/, "");
}

function sourceKey(sourcePath: string, timeMs: number, size: number, modifiedAtMs: number): string {
  return createHash("sha256")
    .update(`${path.resolve(sourcePath)}\0${size}\0${modifiedAtMs}\0${timeMs}`)
    .digest("hex");
}

function parseTimes(stderr: string, pattern: RegExp): number[] {
  const values: number[] = [];
  for (const match of stderr.matchAll(pattern)) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time >= 0) values.push(Math.round(time * 1_000));
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("工作已取消。", "AbortError");
}

function cacheDirectoryFor(
  cacheRoot: string,
  projectId: string,
  sourcePath: string,
  size: number,
  modifiedAtMs: number,
): string {
  const projectKey = createHash("sha256").update(projectId).digest("hex");
  const videoKey = createHash("sha256")
    .update(`${path.resolve(sourcePath)}\0${size}\0${modifiedAtMs}`)
    .digest("hex");
  return assertWithinRoot(cacheRoot, path.join(cacheRoot, "subtitle-frames", projectKey, videoKey));
}

function splitSegment(segment: SubtitleSamplingSegment): SubtitleSamplingSegment[] {
  const chunks: SubtitleSamplingSegment[] = [];
  for (let startMs = segment.startMs; startMs < segment.endMs; startMs += SCAN_CHUNK_MS) {
    chunks.push({
      ...segment,
      startMs,
      endMs: Math.min(segment.endMs, startMs + SCAN_CHUNK_MS),
      usableCandidates: undefined,
    });
  }
  return chunks;
}

async function detectSceneChunk(
  sourcePath: string,
  startMs: number,
  durationMs: number,
  ffmpeg: string,
  threshold: number,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<number[]> {
  const safeThreshold = Math.max(0.05, Math.min(0.95, Number.isFinite(threshold) ? threshold : 0.3));
  const result = await runner(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-ss",
      seconds(startMs),
      "-t",
      seconds(durationMs),
      "-i",
      sourcePath,
      "-vf",
      `scale=320:-2,select='gt(scene,${safeThreshold.toFixed(2)})',showinfo`,
      "-an",
      "-sn",
      "-dn",
      "-f",
      "null",
      "-",
    ],
    signal,
  );
  return parseTimes(result.stderr, /pts_time:\s*([\d.]+)/g).map((time) => time + startMs);
}

async function detectBlackIntervals(
  sourcePath: string,
  segment: SubtitleSamplingSegment,
  ffmpeg: string,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<Array<{ startMs: number; endMs: number }>> {
  const intervals: Array<{ startMs: number; endMs: number }> = [];
  for (let startMs = segment.startMs; startMs < segment.endMs; startMs += SCAN_CHUNK_MS) {
    checkAborted(signal);
    const durationMs = Math.min(SCAN_CHUNK_MS, segment.endMs - startMs);
    const result = await runner(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-ss",
        seconds(startMs),
        "-t",
        seconds(durationMs),
        "-i",
        sourcePath,
        "-vf",
        "scale=320:-2,blackdetect=d=0:pix_th=0.10:pic_th=0.98",
        "-an",
        "-sn",
        "-dn",
        "-f",
        "null",
        "-",
      ],
      signal,
    );
    for (const match of result.stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
        intervals.push({ startMs: startMs + Math.round(start * 1_000), endMs: startMs + Math.round(end * 1_000) });
    }
  }
  return intervals;
}

function isUsable(timeMs: number, intervals: Array<{ startMs: number; endMs: number }>): boolean {
  return !intervals.some((interval) => timeMs >= interval.startMs && timeMs <= interval.endMs);
}

async function pruneOwnedCache(directory: string, keepPaths: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && FRAME_CACHE_NAME.test(entry.name))
      .map(async (entry) => {
        const filePath = assertWithinRoot(directory, path.join(directory, entry.name));
        return { filePath, modifiedAt: (await stat(filePath)).mtimeMs };
      }),
  );
  const stale = files
    .filter((item) => !keepPaths.has(item.filePath))
    .sort((a, b) => a.modifiedAt - b.modifiedAt)
    .slice(0, Math.max(0, files.length - MAX_CACHE_FILES));
  await Promise.all(stale.map(({ filePath }) => rm(filePath, { force: true })));
}

async function removeOwnedFrames(directory: string, frames: ExtractedSubtitleFrame[]): Promise<void> {
  const paths = frames.map(({ path: framePath }) => {
    const resolved = path.resolve(framePath);
    if (path.dirname(resolved) !== path.resolve(directory) || !FRAME_CACHE_NAME.test(path.basename(resolved)))
      throw new Error("只允許移除此影片專案快取中的字幕分析影格。");
    return assertWithinRoot(directory, resolved);
  });
  await Promise.all(paths.map((framePath) => rm(framePath, { force: true })));
}

function combinePlans(parts: SubtitleSamplingPlan[], intervalSeconds: number): SubtitleSamplingPlan {
  const samples = parts.flatMap((part) => part.samples).sort((a, b) => a.timeMs - b.timeMs);
  const pending = samples.filter((sample) => !sample.cached);
  const batches: SubtitleSamplingPlan["batches"] = [];
  for (let index = 0; index < pending.length; index += 20) batches.push(pending.slice(index, index + 20));
  const counters = parts.reduce(
    (total, part) => ({
      raw: total.raw + part.counters.raw,
      scene: total.scene + part.counters.scene,
      dedup: total.dedup + part.counters.dedup,
      sent: total.sent + part.counters.sent,
      requests: total.requests + part.counters.requests,
      cache: total.cache + part.counters.cache,
    }),
    { raw: 0, scene: 0, dedup: 0, sent: 0, requests: 0, cache: 0 },
  );
  return { purpose: "FRAME_ANALYSIS_ONLY", intervalSeconds, samples, batches, counters };
}

/** Extracts analysis stills only. Source media is opened read-only and never encoded as video. */
export class SubtitleFrameExtractor {
  constructor(
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  async extract(request: SubtitleFrameExtractionRequest): Promise<SubtitleFrameExtractionResult> {
    return this.extractInternal(request);
  }

  /**
   * Streams the complete timeline through awaited batches of at most 20 stills.
   * Each batch's paths remain available until the consumer settles, then are
   * removed from this project's video-specific cache before the next batch.
   */
  async extractBatches(
    request: SubtitleFrameExtractionRequest,
    onBatch: SubtitleFrameBatchConsumer,
  ): Promise<SubtitleFrameBatchExtractionResult> {
    const result = await this.extractInternal(request, onBatch);
    return { purpose: result.purpose, plan: result.plan, batchesEmitted: result.batchesEmitted };
  }

  private async extractInternal(
    request: SubtitleFrameExtractionRequest,
    onBatch?: SubtitleFrameBatchConsumer,
  ): Promise<SubtitleFrameExtractionResult & { batchesEmitted: number }> {
    if (!path.isAbsolute(request.sourcePath)) throw new Error("字幕影格來源路徑必須是絕對路徑。");
    if (!path.isAbsolute(request.cacheRoot)) throw new Error("字幕影格快取路徑必須是絕對路徑。");
    if (!request.projectId?.trim()) throw new Error("字幕影格分析需要專案識別碼，以隔離各專案快取。");
    const sourceInfo = await stat(request.sourcePath);
    if (!sourceInfo.isFile()) throw new Error("字幕影格來源必須是一般檔案。");
    checkAborted(request.signal);
    const cacheDirectory = cacheDirectoryFor(
      request.cacheRoot,
      request.projectId,
      request.sourcePath,
      sourceInfo.size,
      sourceInfo.mtimeMs,
    );
    await mkdir(cacheDirectory, { recursive: true });
    checkAborted(request.signal);
    const segments = request.segments.filter(
      (segment) =>
        Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs,
    );

    // Detect on downscaled frames and roll across the complete requested intervals.
    const analysisSegments = segments.filter((segment) => segment.type !== "INTRO" && segment.type !== "PHOTO");
    const sceneChunks = request.detectSceneChanges === false ? [] : analysisSegments.flatMap(splitSegment);
    const sceneTimesMs: number[] = [];
    for (let index = 0; index < sceneChunks.length; index += 1) {
      checkAborted(request.signal);
      const chunk = sceneChunks[index];
      sceneTimesMs.push(
        ...(await detectSceneChunk(
          request.sourcePath,
          chunk.startMs,
          chunk.endMs - chunk.startMs,
          this.ffmpegExecutable,
          request.sceneThreshold ?? 0.3,
          this.runner,
          request.signal,
        )),
      );
      request.onProgress?.({
        stage: "SCENES",
        completed: index + 1,
        total: sceneChunks.length,
        timeMs: chunk.endMs,
        sceneFrames: new Set(sceneTimesMs).size,
      });
    }

    const planParts: SubtitleSamplingPlan[] = [];
    const firstFrameSegments = segments.filter((segment) => segment.type === "INTRO" || segment.type === "PHOTO");
    for (let index = 0; index < firstFrameSegments.length; index += 1) {
      checkAborted(request.signal);
      const segment = firstFrameSegments[index];
      const blackIntervals = await detectBlackIntervals(
        request.sourcePath,
        segment,
        this.ffmpegExecutable,
        this.runner,
        request.signal,
      );
      let candidateTime = Math.min(segment.endMs - 1, segment.startMs + 1_000);
      for (const interval of blackIntervals) {
        if (candidateTime >= interval.startMs && candidateTime <= interval.endMs)
          candidateTime = Math.ceil((interval.endMs + 1) / 250) * 250;
      }
      const usableCandidates =
        candidateTime < segment.endMs && isUsable(candidateTime, blackIntervals)
          ? [{ timeMs: candidateTime, usable: true }]
          : [];
      planParts.push(
        buildSubtitleSamplingPlan({
          segments: [{ ...segment, usableCandidates }],
          intervalSeconds: request.intervalSeconds,
        }),
      );
      request.onProgress?.({
        stage: "BLACK_FRAMES",
        completed: index + 1,
        total: firstFrameSegments.length,
        timeMs: segment.endMs,
      });
    }

    const samplingChunks = analysisSegments.flatMap(splitSegment);
    for (const chunk of samplingChunks) {
      checkAborted(request.signal);
      const scenes = sceneTimesMs.filter((timeMs) => timeMs >= chunk.startMs && timeMs < chunk.endMs);
      planParts.push(
        buildSubtitleSamplingPlan({
          segments: [chunk],
          intervalSeconds: request.intervalSeconds,
          sceneChangeTimesMs: scenes,
        }),
      );
    }
    const plan = combinePlans(planParts, request.intervalSeconds);
    const frames: ExtractedSubtitleFrame[] = [];
    let currentBatch: ExtractedSubtitleFrame[] = [];
    let batchesEmitted = 0;
    let completed = 0;
    let previousHash: string | undefined;
    let previousSegment: SubtitleSamplingSegment["type"] | undefined;
    const acceptedTimes = new Set<number>();
    const acceptFrame = async (frame: ExtractedSubtitleFrame): Promise<boolean> => {
      if (!request.deduplicateFrames) {
        acceptedTimes.add(frame.timeMs);
        return true;
      }
      const hash = frameDHash(await readFile(frame.path));
      frame.perceptualHash = hash;
      // Explicit scene boundaries and each intro/photo sample must survive visual similarity.
      const duplicate =
        frame.source === "INTERVAL" &&
        frame.segmentType === "MAIN" &&
        previousSegment === frame.segmentType &&
        previousHash !== undefined &&
        hashDistance(previousHash, hash) <= 8;
      if (duplicate) {
        plan.counters.dedup += 1;
        plan.counters.sent = Math.max(0, plan.counters.sent - 1);
        return false;
      }
      previousHash = hash;
      previousSegment = frame.segmentType;
      acceptedTimes.add(frame.timeMs);
      return true;
    };
    // Work in fixed batches. Streaming callers see one batch at a time and its
    // files are removed as soon as their awaited callback has finished.
    try {
      for (let offset = 0; offset < plan.samples.length; offset += FRAME_BATCH_SIZE) {
        const batchSamples = plan.samples.slice(offset, offset + FRAME_BATCH_SIZE);
        for (const sample of batchSamples) {
          checkAborted(request.signal);
          const key = sourceKey(request.sourcePath, sample.timeMs, sourceInfo.size, sourceInfo.mtimeMs);
          const output = assertWithinRoot(cacheDirectory, path.join(cacheDirectory, `subtitle-frame-${key}.jpg`));
          try {
            const info = await stat(output);
            if (info.isFile() && info.size >= 128) {
              const frame = {
                timeMs: sample.timeMs,
                segmentType: sample.segmentType,
                source: sample.source,
                path: output,
              };
              if (await acceptFrame(frame)) {
                if (onBatch) currentBatch.push(frame);
                else frames.push(frame);
              }
              completed += 1;
              request.onProgress?.({
                stage: "FRAMES",
                completed,
                total: plan.samples.length,
                timeMs: sample.timeMs,
                rawFrames: plan.counters.raw,
                sceneFrames: plan.counters.scene,
                deduplicatedFrames: plan.counters.dedup,
              });
              continue;
            }
          } catch {
            /* cache miss */
          }
          const partial = assertWithinRoot(
            cacheDirectory,
            path.join(cacheDirectory, `.subtitle-frame-${key}-${randomUUID()}.partial.jpg`),
          );
          try {
            await this.runner(
              this.ffmpegExecutable,
              [
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-ss",
                seconds(sample.timeMs),
                "-i",
                request.sourcePath,
                "-frames:v",
                "1",
                "-vf",
                "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black",
                "-an",
                "-sn",
                "-dn",
                "-q:v",
                "4",
                "-f",
                "image2",
                "-y",
                partial,
              ],
              request.signal,
            );
            const info = await stat(partial);
            if (!info.isFile() || info.size < 128) throw new Error("FFmpeg 產生的字幕分析影格無效。");
            await finalizePartialOutput(partial, output);
            const frame = {
              timeMs: sample.timeMs,
              segmentType: sample.segmentType,
              source: sample.source,
              path: output,
            };
            if (await acceptFrame(frame)) {
              if (onBatch) currentBatch.push(frame);
              else frames.push(frame);
            }
          } finally {
            await rm(partial, { force: true });
          }
          completed += 1;
          request.onProgress?.({
            stage: "FRAMES",
            completed,
            total: plan.samples.length,
            timeMs: sample.timeMs,
            rawFrames: plan.counters.raw,
            sceneFrames: plan.counters.scene,
            deduplicatedFrames: plan.counters.dedup,
          });
        }
        if (onBatch && currentBatch.length > 0) {
          try {
            await onBatch(currentBatch, batchesEmitted);
            batchesEmitted += 1;
          } finally {
            await removeOwnedFrames(cacheDirectory, currentBatch);
            currentBatch = [];
          }
        }
      }
    } catch (error) {
      if (onBatch && currentBatch.length > 0) await removeOwnedFrames(cacheDirectory, currentBatch);
      throw error;
    }
    if (onBatch) await pruneOwnedCache(cacheDirectory, new Set());
    else await pruneOwnedCache(cacheDirectory, new Set(frames.map((frame) => frame.path)));
    plan.samples = plan.samples.filter((sample) => acceptedTimes.has(sample.timeMs));
    plan.batches = [];
    for (let index = 0; index < plan.samples.length; index += FRAME_BATCH_SIZE)
      plan.batches.push(plan.samples.slice(index, index + FRAME_BATCH_SIZE));
    plan.counters.requests = plan.batches.length;
    return { purpose: "FRAME_ANALYSIS_ONLY", plan, frames, batchesEmitted };
  }
}
