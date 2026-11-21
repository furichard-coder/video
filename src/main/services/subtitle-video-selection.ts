import type { PreviewOutputRecord } from "../../shared/domain";

export type SubtitleVideoSelectionReason = "PROJECT_CONCAT" | "LATEST_CONCAT" | "MANUAL_PATH" | "NONE";

export interface SubtitleVideoSelection {
  reason: SubtitleVideoSelectionReason;
  record?: PreviewOutputRecord;
  path?: string;
}

export interface SubtitleVideoSelectionOptions {
  projectId?: string;
  projectName?: string;
  lastManualPath?: string;
  /** The caller can provide filesystem-backed validation while keeping selection itself pure. */
  isManualPathValid?: (path: string) => boolean;
}

type CompatibleOutputRecord = PreviewOutputRecord & { succeeded?: boolean };

function isSuccessful(record: CompatibleOutputRecord): boolean {
  if (record.cancelled === true) return false;
  if (record.successful === false || record.succeeded === false) return false;

  // Older history entries predate the successful marker. Their non-empty output
  // is sufficient evidence of completion once the file still exists.
  return record.successful === true || record.succeeded === true || record.sizeBytes > 0;
}

function createdAtTime(record: PreviewOutputRecord): number {
  const timestamp = Date.parse(record.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function latest(records: PreviewOutputRecord[]): PreviewOutputRecord | undefined {
  return records.reduce<PreviewOutputRecord | undefined>((selected, record) => {
    if (!selected || createdAtTime(record) > createdAtTime(selected)) return record;
    return selected;
  }, undefined);
}

/**
 * Selects a subtitle video source from output history, then a validated manual
 * path. Filesystem checks belong in the caller and can be supplied as a pure
 * predicate for the manual fallback.
 */
export function selectSubtitleVideoSource(
  outputs: readonly PreviewOutputRecord[],
  options: SubtitleVideoSelectionOptions = {},
): SubtitleVideoSelection {
  const eligible = outputs.filter((record) => record.exists && record.purpose === "CONCAT" && isSuccessful(record));

  if (options.projectId) {
    const projectRecord = latest(eligible.filter((record) => record.projectId === options.projectId));
    if (projectRecord) return { reason: "PROJECT_CONCAT", record: projectRecord, path: projectRecord.outputPath };
  }

  const latestRecord = options.projectName
    ? latest(eligible.filter((record) => !record.projectId && record.projectName === options.projectName))
    : undefined;
  if (latestRecord) return { reason: "LATEST_CONCAT", record: latestRecord, path: latestRecord.outputPath };

  const manualPath = options.lastManualPath?.trim();
  if (manualPath && (options.isManualPathValid?.(manualPath) ?? false)) {
    return { reason: "MANUAL_PATH", path: manualPath };
  }

  return { reason: "NONE" };
}

export function clampSubtitleSamplingInterval(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(60, Math.max(1, Math.round(value)));
}

export function clampSubtitleSamplingBatchSize(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(30, Math.max(10, Math.round(value)));
}

export function assertSubtitleVideoTimelineMatch(
  reason: SubtitleVideoSelectionReason,
  timelineDurationMs: number,
  videoDurationMs: number,
  toleranceMs = 2_000,
): void {
  if (reason === "PROJECT_CONCAT") return;
  if (
    !Number.isFinite(timelineDurationMs) ||
    !Number.isFinite(videoDurationMs) ||
    videoDurationMs <= 0 ||
    Math.abs(timelineDurationMs - videoDurationMs) > toleranceMs
  )
    throw new Error("人工／其他專案影片時長與目前專案時間線不符；為避免字幕套錯時間，本次不會寫入專案。");
}

/** Container/audio padding may differ slightly on long exports. Identity remains a separate check. */
export function subtitleTimelineCompatibility(timelineDurationMs: number, videoDurationMs: number) {
  const toleranceMs = Math.max(2_000, Math.min(10_000, Math.round(timelineDurationMs * 0.001)));
  const differenceMs = Math.abs(timelineDurationMs - videoDurationMs);
  const compatible =
    Number.isFinite(timelineDurationMs) &&
    Number.isFinite(videoDurationMs) &&
    timelineDurationMs > 0 &&
    videoDurationMs > 0 &&
    differenceMs <= toleranceMs;
  return { compatible, differenceMs, toleranceMs };
}

export function subtitleAnalysisMode(
  reason: SubtitleVideoSelectionReason,
  timelineDurationMs: number,
  videoDurationMs: number,
) {
  const comparison = subtitleTimelineCompatibility(timelineDurationMs, videoDurationMs);
  // A legacy title-only association is not proof of render/project identity.
  return {
    ...comparison,
    mode: comparison.compatible && reason === "PROJECT_CONCAT" ? ("PROJECT_AWARE" as const) : ("VIDEO_FIRST" as const),
  };
}
