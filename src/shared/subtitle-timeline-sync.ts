import type { ProjectManifest, SubtitleCue, SubtitleTimelineScope, TransitionDurationSec } from "./domain";
import { buildTimelinePlan, type TimelinePlanClip } from "./timeline-plan";

interface CueAnchor {
  cue: SubtitleCue;
  clip: TimelinePlanClip;
  sourceStartMs: number;
}

export interface SubtitleTimelineSyncResult {
  cues: SubtitleCue[];
  fullyMapped: Record<SubtitleTimelineScope, boolean>;
  movedCueCount: number;
}

function scopePlan(project: ProjectManifest, scope: SubtitleTimelineScope, transitionSeconds: TransitionDurationSec) {
  if (scope === "MAIN") return buildTimelinePlan(project, { transitionSeconds });
  return buildTimelinePlan({ ...project, timelineOrder: [] }, { includeIntro: true, transitionSeconds });
}

function containsOutput(clip: TimelinePlanClip, timeMs: number): boolean {
  return timeMs >= clip.outputStartMs && timeMs < clip.outputEndMs;
}

function containsSource(clip: TimelinePlanClip, timeMs: number): boolean {
  return timeMs >= clip.inMs && timeMs < clip.outMs;
}

function anchorCue(cue: SubtitleCue, clips: TimelinePlanClip[]): CueAnchor | undefined {
  const outputCandidates = clips.filter((clip) => containsOutput(clip, cue.startMs));
  const sourceCandidates =
    cue.sourceAssetId && cue.sourceInMs !== undefined
      ? clips.filter((clip) => clip.assetId === cue.sourceAssetId && containsSource(clip, cue.sourceInMs!))
      : [];
  const clip =
    sourceCandidates.find((candidate) => outputCandidates.includes(candidate)) ??
    sourceCandidates[0] ??
    outputCandidates.at(-1);
  if (!clip) return undefined;
  const sourceStartMs =
    cue.sourceAssetId === clip.assetId && cue.sourceInMs !== undefined
      ? Math.max(clip.inMs, Math.min(clip.outMs - 1, cue.sourceInMs))
      : Math.max(clip.inMs, Math.min(clip.outMs - 1, clip.inMs + cue.startMs - clip.outputStartMs));
  return { cue, clip, sourceStartMs };
}

function sameLogicalClip(anchor: CueAnchor, clip: TimelinePlanClip): boolean {
  if (anchor.clip.scope !== clip.scope) return false;
  if (anchor.clip.segmentId) return anchor.clip.segmentId === clip.segmentId;
  if (anchor.clip.mediaInsertionId) return anchor.clip.mediaInsertionId === clip.mediaInsertionId;
  return anchor.clip.assetId === clip.assetId && containsSource(clip, anchor.sourceStartMs);
}

function normalizeConfirmedOverlaps(
  cues: SubtitleCue[],
  scope: SubtitleTimelineScope,
): { cues: SubtitleCue[]; safe: boolean } {
  const sorted = cues
    .map((cue) => ({ ...cue }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let safe = true;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      (previous.reviewStatus ?? "CONFIRMED") !== "CONFIRMED" ||
      (current.reviewStatus ?? "CONFIRMED") !== "CONFIRMED" ||
      previous.endMs <= current.startMs
    )
      continue;
    if (current.startMs - previous.startMs >= 100) previous.endMs = current.startMs;
    else {
      current.reviewStatus = "DRAFT";
      current.aiWarnings = [
        ...new Set([
          ...(current.aiWarnings ?? []),
          `${scope === "INTRO" ? "片頭" : "正片"}順序調整後字幕時間重疊，請人工調整。`,
        ]),
      ];
      safe = false;
    }
  }
  return { cues: sorted, safe };
}

/**
 * Repositions cues with their visual source when a Main/Intro timeline changes.
 * The old plan determines each cue's source-relative anchor; the new plan then
 * applies the selected transition overlap. Unmappable cues are kept as drafts
 * instead of being silently deleted or guessed onto unrelated footage.
 */
export function syncSubtitlesToTimeline(
  previous: ProjectManifest,
  next: ProjectManifest,
  scopes: SubtitleTimelineScope[],
  previousTransitionSeconds = previous.timelineTransitionSeconds ?? 0.3,
  nextTransitionSeconds = next.timelineTransitionSeconds ?? 0.3,
): SubtitleTimelineSyncResult {
  const scopeSet = new Set(scopes);
  const untouched = next.subtitleCues.filter((cue) => !scopeSet.has(cue.timelineScope ?? "MAIN"));
  const synced: SubtitleCue[] = [];
  const fullyMapped: Record<SubtitleTimelineScope, boolean> = { MAIN: true, INTRO: true };
  let movedCueCount = 0;

  for (const scope of scopes) {
    const oldClips = scopePlan(previous, scope, previousTransitionSeconds).clips;
    const newClips = scopePlan(next, scope, nextTransitionSeconds).clips;
    const scopedCues = previous.subtitleCues.filter((cue) => (cue.timelineScope ?? "MAIN") === scope);
    const mapped: SubtitleCue[] = [];
    for (const originalCue of scopedCues) {
      const anchor = anchorCue(originalCue, oldClips);
      const target = anchor && newClips.find((clip) => sameLogicalClip(anchor, clip));
      if (!anchor || !target) {
        fullyMapped[scope] = false;
        mapped.push({
          ...originalCue,
          reviewStatus: originalCue.reviewStatus === "REJECTED" ? "REJECTED" : "DRAFT",
          aiWarnings: [
            ...new Set([
              ...(originalCue.aiWarnings ?? []),
              "素材順序或範圍改變後無法可靠對應，已保留原時間並改為待確認。",
            ]),
          ],
        });
        continue;
      }
      const durationMs = Math.max(1, originalCue.endMs - originalCue.startMs);
      const startMs = Math.max(
        target.outputStartMs,
        Math.min(target.outputEndMs - 1, target.outputStartMs + anchor.sourceStartMs - target.inMs),
      );
      const endMs = Math.max(startMs + 1, Math.min(target.outputEndMs, startMs + durationMs));
      const sourceOutMs = Math.max(
        anchor.sourceStartMs + 1,
        Math.min(target.outMs, anchor.sourceStartMs + endMs - startMs),
      );
      if (startMs !== originalCue.startMs || endMs !== originalCue.endMs) movedCueCount += 1;
      mapped.push({
        ...originalCue,
        startMs,
        endMs,
        timelineScope: scope,
        sourceAssetId: target.assetId,
        sourceInMs: anchor.sourceStartMs,
        sourceOutMs,
      });
    }
    const normalized = normalizeConfirmedOverlaps(mapped, scope);
    fullyMapped[scope] = fullyMapped[scope] && normalized.safe;
    synced.push(...normalized.cues);
  }

  return {
    cues: [...synced, ...untouched].sort(
      (left, right) =>
        ((left.timelineScope ?? "MAIN") === "INTRO" ? 0 : 1) - ((right.timelineScope ?? "MAIN") === "INTRO" ? 0 : 1) ||
        left.startMs - right.startMs ||
        left.endMs - right.endMs,
    ),
    fullyMapped,
    movedCueCount,
  };
}
