/** Frame-analysis sampling only. These timestamps must never be used as subtitle cue cadence. */
export type SubtitleSamplingSegmentType = "INTRO" | "MAIN" | "PHOTO" | "INSERT" | "OUTRO";

export interface SubtitleSamplingCandidate {
  timeMs: number;
  usable: boolean;
}

export interface SubtitleSamplingSegment {
  type: SubtitleSamplingSegmentType;
  startMs: number;
  endMs: number;
  /** Required for INTRO/PHOTO; candidates describe decoded frames and their usability. */
  usableCandidates?: SubtitleSamplingCandidate[];
}

export type SubtitleSamplingSource = "INTERVAL" | "SCENE_CHANGE" | "FIRST_USABLE";

export interface SubtitleSamplingSample {
  timeMs: number;
  segmentType: SubtitleSamplingSegmentType;
  source: SubtitleSamplingSource;
  perceptualHash?: string;
  cached: boolean;
}

export interface SubtitleSamplingPlanInput {
  segments: SubtitleSamplingSegment[];
  intervalSeconds: number;
  sceneChangeTimesMs?: number[];
  /** Hashes already present in the caller's analysis cache, keyed by exact time in ms. */
  cachedHashesByTimeMs?: Record<number, string>;
  /** Hashes supplied by the caller for perceptual deduplication, keyed by exact time in ms. */
  perceptualHashesByTimeMs?: Record<number, string>;
  hammingThreshold?: number;
  batchSize?: number;
}

export interface SubtitleSamplingPerformanceCounters {
  raw: number;
  scene: number;
  dedup: number;
  sent: number;
  requests: number;
  cache: number;
}

export interface SubtitleSamplingPlan {
  purpose: "FRAME_ANALYSIS_ONLY";
  intervalSeconds: number;
  /** Unique samples, including entries already satisfied by cache. */
  samples: SubtitleSamplingSample[];
  /** Samples that still need to be sent for analysis, split into bounded batches. */
  batches: SubtitleSamplingSample[][];
  counters: SubtitleSamplingPerformanceCounters;
}

interface RawSample {
  timeMs: number;
  segmentType: SubtitleSamplingSegmentType;
  source: SubtitleSamplingSource;
}

const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 60;
const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 30;
const FIRST_FRAME_OFFSET_MS = 1_000;

/** Computes a 64-bit difference hash from a decoded 9×8 grayscale frame. */
export function computeSubtitleFrameDHash(grayscale9x8: Uint8Array): string {
  if (grayscale9x8.length !== 72) throw new Error("dHash 需要 9×8 灰階影格。");
  let result = "";
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      nibble = (nibble << 1) | (grayscale9x8[y * 9 + x] > grayscale9x8[y * 9 + x + 1] ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        result += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return result;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function segmentAt(segments: SubtitleSamplingSegment[], timeMs: number): SubtitleSamplingSegment | undefined {
  return segments.find((segment) => timeMs >= segment.startMs && timeMs < segment.endMs);
}

function firstUsableSample(segment: SubtitleSamplingSegment): RawSample | undefined {
  const candidates = (segment.usableCandidates ?? [])
    .filter((candidate) => candidate.usable && candidate.timeMs >= segment.startMs && candidate.timeMs < segment.endMs)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (!candidates.length) return undefined;
  const preferredTime = segment.startMs + FIRST_FRAME_OFFSET_MS;
  const candidate = candidates.find((item) => item.timeMs >= preferredTime) ?? candidates[0];
  return { timeMs: candidate.timeMs, segmentType: segment.type, source: "FIRST_USABLE" };
}

function hammingDistance(left: string, right: string): number | undefined {
  if (!/^[\da-f]+$/i.test(left) || !/^[\da-f]+$/i.test(right) || left.length !== right.length) return undefined;
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

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize));
  return batches;
}

/**
 * Builds a deterministic, bounded frame-analysis plan. Intro/photo segments prefer the first
 * usable frame at or after +1s, then fall back to the first usable frame inside their bounds.
 */
export function buildSubtitleSamplingPlan(input: SubtitleSamplingPlanInput): SubtitleSamplingPlan {
  const intervalSeconds = clampInteger(input.intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, 10);
  const intervalMs = intervalSeconds * 1_000;
  const batchSize = clampInteger(input.batchSize ?? 20, MIN_BATCH_SIZE, MAX_BATCH_SIZE, 20);
  const hammingThreshold = clampInteger(input.hammingThreshold ?? 8, 0, 256, 8);
  const segments = [...input.segments]
    .filter(
      (segment) =>
        Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.type.localeCompare(b.type));

  const raw: RawSample[] = [];
  for (const segment of segments) {
    if (segment.type === "INTRO" || segment.type === "PHOTO") {
      const sample = firstUsableSample(segment);
      if (sample) raw.push(sample);
      continue;
    }
    for (let timeMs = segment.startMs; timeMs < segment.endMs; timeMs += intervalMs) {
      raw.push({ timeMs, segmentType: segment.type, source: "INTERVAL" });
    }
  }

  let scene = 0;
  for (const timeMs of input.sceneChangeTimesMs ?? []) {
    if (!Number.isFinite(timeMs)) continue;
    const segment = segmentAt(segments, timeMs);
    if (!segment || segment.type === "INTRO" || segment.type === "PHOTO") continue;
    raw.push({ timeMs, segmentType: segment.type, source: "SCENE_CHANGE" });
    scene += 1;
  }

  raw.sort(
    (a, b) => a.timeMs - b.timeMs || a.source.localeCompare(b.source) || a.segmentType.localeCompare(b.segmentType),
  );
  const hashes = input.perceptualHashesByTimeMs ?? {};
  const cachedHashes = input.cachedHashesByTimeMs ?? {};
  const unique: SubtitleSamplingSample[] = [];
  let previousRepresentativeHash: string | undefined;
  let dedup = 0;
  let cache = 0;
  let previousTimeMs: number | undefined;

  for (const candidate of raw) {
    // Multiple segment/scene sources can resolve to the same exact frame timestamp.
    if (candidate.timeMs === previousTimeMs) {
      dedup += 1;
      continue;
    }
    previousTimeMs = candidate.timeMs;
    const perceptualHash = cachedHashes[candidate.timeMs] ?? hashes[candidate.timeMs];
    if (perceptualHash && previousRepresentativeHash) {
      const distance = hammingDistance(perceptualHash, previousRepresentativeHash);
      if (distance !== undefined && distance <= hammingThreshold) {
        dedup += 1;
        continue;
      }
    }
    if (perceptualHash) previousRepresentativeHash = perceptualHash;
    const isCached = Object.hasOwn(cachedHashes, candidate.timeMs);
    if (isCached) cache += 1;
    unique.push({ ...candidate, ...(perceptualHash ? { perceptualHash } : {}), cached: isCached });
  }

  const pending = unique.filter((sample) => !sample.cached);
  const batches = splitIntoBatches(pending, batchSize);
  return {
    purpose: "FRAME_ANALYSIS_ONLY",
    intervalSeconds,
    samples: unique,
    batches,
    counters: {
      raw: raw.length,
      scene,
      dedup,
      sent: pending.length,
      requests: batches.length,
      cache,
    },
  };
}
