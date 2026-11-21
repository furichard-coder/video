import type { ProjectManifest, SourceAsset, SubtitleCue, SubtitleTimelineScope } from "../shared/domain";
import { buildTimelinePlan } from "../shared/timeline-plan";

export interface SubtitlePlaybackSegment {
  id: string;
  asset: SourceAsset;
  scope: SubtitleTimelineScope;
  projectStartMs: number;
  projectEndMs: number;
  ownershipEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
}

/**
 * Proxy review cannot reproduce a rendered xfade without encoding. During an
 * overlap, the next clip owns the clock from its output start. This keeps the
 * project clock monotonic and makes the source seek deterministic.
 */
export function buildSubtitlePlaybackSegments(
  project: ProjectManifest,
  scope: SubtitleTimelineScope,
): SubtitlePlaybackSegment[] {
  const plan =
    scope === "INTRO"
      ? buildTimelinePlan({ ...project, timelineOrder: [] }, { includeIntro: true })
      : buildTimelinePlan(project);
  const scoped = plan.clips.filter((clip) => clip.scope === scope);
  const origin = scoped[0]?.outputStartMs ?? 0;
  return scoped.flatMap((clip, index) => {
    const asset = project.sources.find((item) => item.id === clip.assetId);
    if (!asset) return [];
    const projectStartMs = clip.outputStartMs - origin;
    const projectEndMs = clip.outputEndMs - origin;
    const nextStartMs = scoped[index + 1] ? scoped[index + 1].outputStartMs - origin : projectEndMs;
    return [
      {
        id: clip.segmentId ?? clip.mediaInsertionId ?? `${clip.assetId}:${clip.inMs}:${clip.outMs}:${index}`,
        asset,
        scope,
        projectStartMs,
        projectEndMs,
        ownershipEndMs: Math.max(projectStartMs + 1, Math.min(projectEndMs, nextStartMs)),
        sourceStartMs: clip.inMs,
        sourceEndMs: clip.outMs,
      },
    ];
  });
}

export function playbackSegmentAt(
  segments: readonly SubtitlePlaybackSegment[],
  projectClockMs: number,
): SubtitlePlaybackSegment | undefined {
  const clock = Math.max(0, projectClockMs);
  return (
    segments.find((segment) => clock >= segment.projectStartMs && clock < segment.ownershipEndMs) ??
    (clock === segments.at(-1)?.ownershipEndMs ? segments.at(-1) : undefined)
  );
}

export function projectClockToSourceMs(segment: SubtitlePlaybackSegment, projectClockMs: number): number {
  return Math.max(
    segment.sourceStartMs,
    Math.min(segment.sourceEndMs, segment.sourceStartMs + Math.max(0, projectClockMs - segment.projectStartMs)),
  );
}

export function sourceTimeToProjectClockMs(segment: SubtitlePlaybackSegment, sourceTimeMs: number): number {
  return Math.max(
    segment.projectStartMs,
    Math.min(segment.ownershipEndMs, segment.projectStartMs + Math.max(0, sourceTimeMs - segment.sourceStartMs)),
  );
}

export function activeSubtitleCueAt(
  cues: readonly SubtitleCue[],
  scope: SubtitleTimelineScope,
  projectClockMs: number,
): SubtitleCue | undefined {
  const clock = Math.max(0, projectClockMs);
  return cues.find(
    (cue) =>
      (cue.timelineScope ?? "MAIN") === scope &&
      cue.reviewStatus !== "REJECTED" &&
      cue.startMs <= clock &&
      clock < cue.endMs,
  );
}

export function adjacentCue(
  cues: readonly SubtitleCue[],
  scope: SubtitleTimelineScope,
  cueId: string | undefined,
  direction: -1 | 1,
): SubtitleCue | undefined {
  const scoped = cues.filter((cue) => (cue.timelineScope ?? "MAIN") === scope && cue.reviewStatus !== "REJECTED");
  const index = Math.max(
    0,
    scoped.findIndex((cue) => cue.id === cueId),
  );
  return scoped[Math.max(0, Math.min(scoped.length - 1, index + direction))];
}
