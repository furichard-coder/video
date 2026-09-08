import {
  INTRO_MAX_SEGMENT_MS,
  INTRO_MIN_SEGMENT_MS,
  MAX_IMAGE_DURATION_MS,
  type IntroSuggestion,
  type SourceAsset,
} from "./domain";

export function normalizeIntroSegmentMaxDuration(value: unknown): number {
  const durationMs = Math.round(Number(value));
  if (!Number.isFinite(durationMs) || durationMs < INTRO_MIN_SEGMENT_MS || durationMs > INTRO_MAX_SEGMENT_MS) {
    throw new Error("片頭每段最高時間必須介於 3 到 22 秒。");
  }
  return durationMs;
}

interface SegmentCapacity {
  segment: IntroSuggestion;
  asset: SourceAsset;
  minimumMs: number;
  maximumMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
}

function segmentCapacity(segment: IntroSuggestion, asset: SourceAsset, maxSegmentDurationMs: number): SegmentCapacity {
  if (asset.kind === "IMAGE") {
    const maximumMs = Math.min(MAX_IMAGE_DURATION_MS, maxSegmentDurationMs);
    return { segment, asset, minimumMs: INTRO_MIN_SEGMENT_MS, maximumMs, sourceStartMs: 0, sourceEndMs: maximumMs };
  }
  const sourceStartMs = asset.previewRange?.inMs ?? 0;
  const sourceEndMs = asset.previewRange?.outMs ?? asset.mediaInfo?.durationMs ?? segment.outMs;
  const maximumMs = Math.min(maxSegmentDurationMs, Math.max(0, sourceEndMs - sourceStartMs));
  return { segment, asset, minimumMs: INTRO_MIN_SEGMENT_MS, maximumMs, sourceStartMs, sourceEndMs };
}

function equalAllocations(capacities: SegmentCapacity[], targetDurationMs: number): number[] {
  if (!capacities.length) return [];
  if (capacities.some((item) => item.maximumMs < item.minimumMs)) throw new Error("至少一個片頭來源的可用範圍少於 3 秒，無法均衡分配。");
  const minimumTotal = capacities.reduce((sum, item) => sum + item.minimumMs, 0);
  if (targetDurationMs < minimumTotal) throw new Error(`目前 ${capacities.length} 段至少需要 ${Math.ceil(minimumTotal / 1000)} 秒；請提高片頭總長或移除部分片段。`);
  const desiredTotal = Math.min(targetDurationMs, capacities.reduce((sum, item) => sum + item.maximumMs, 0));
  const allocations = capacities.map((item) => item.minimumMs);
  let remaining = desiredTotal - minimumTotal;
  let active = capacities.map((_item, index) => index);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    const nextActive: number[] = [];
    let allocated = 0;
    for (const index of active) {
      const available = capacities[index].maximumMs - allocations[index];
      const addition = Math.min(available, share, remaining - allocated);
      allocations[index] += addition;
      allocated += addition;
      if (allocations[index] < capacities[index].maximumMs) nextActive.push(index);
      if (allocated >= remaining) break;
    }
    if (allocated <= 0) break;
    remaining -= allocated;
    active = nextActive;
  }
  return allocations;
}

function centeredRange(item: SegmentCapacity, durationMs: number): { inMs: number; outMs: number } {
  if (item.asset.kind === "IMAGE") return { inMs: 0, outMs: durationMs };
  const centerMs = (item.segment.inMs + item.segment.outMs) / 2;
  let inMs = Math.round(centerMs - durationMs / 2);
  inMs = Math.max(item.sourceStartMs, Math.min(inMs, item.sourceEndMs - durationMs));
  return { inMs, outMs: inMs + durationMs };
}

/**
 * Equalizes selected Intro segments within the total target while respecting each
 * source's available range. A shorter source/photo may be the only reason that
 * individual durations differ.
 */
export function balanceIntroSegments(
  segments: IntroSuggestion[],
  assets: SourceAsset[],
  targetDurationMs: number,
  maxSegmentDurationMs: number,
): IntroSuggestion[] {
  const maximumMs = normalizeIntroSegmentMaxDuration(maxSegmentDurationMs);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const capacities = segments.map((segment) => {
    const asset = assetById.get(segment.assetId);
    if (!asset) throw new Error(`找不到片頭來源：${segment.fileName || segment.assetId}`);
    return segmentCapacity(segment, asset, maximumMs);
  });
  const allocations = equalAllocations(capacities, Math.round(targetDurationMs));
  return capacities.map((item, index) => ({ ...item.segment, ...centeredRange(item, allocations[index]) }));
}

/**
 * A stored Intro range is also the user's review range and may be longer than
 * the configured output maximum. Rendering always keeps the chosen IN point
 * and takes at most the configured duration from there.
 */
export function introSegmentsForOutput(
  segments: IntroSuggestion[],
  maxSegmentDurationMs: number,
): IntroSuggestion[] {
  const maximumMs = normalizeIntroSegmentMaxDuration(maxSegmentDurationMs);
  return segments.map((segment) => ({
    ...segment,
    outMs: Math.min(segment.outMs, segment.inMs + maximumMs),
  }));
}
