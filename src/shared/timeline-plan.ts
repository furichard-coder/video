import type { BgmTrack, ProjectManifest, RenderClipSelection, SubtitleCue, SubtitleTimelineScope } from "./domain";
import { mainRenderSelections } from "./editing-rules";

/** Canonical, deterministic output timeline used by estimates, subtitles and BGM mapping. */
export interface TimelinePlanClip extends RenderClipSelection {
  scope: "MAIN" | "INTRO";
  /** Stable identity for an Intro item, including repeated ranges from one source. */
  segmentId?: string;
  outputStartMs: number;
  outputEndMs: number;
}

export interface TimelinePlan {
  clips: TimelinePlanClip[];
  durationMs: number;
  transitionMs: number;
}

export interface TimelinePlanOptions {
  includeIntro?: boolean;
  transitionSeconds?: number;
}

export interface MainTimelineGroup {
  /** Top-level grid asset that owns this rendered sequence. */
  anchorAssetId: string;
  outputStartMs: number;
  outputEndMs: number;
  /** Sum before transition overlap; includes every inserted video/photo. */
  sourceDurationMs: number;
  insertedDurationMs: number;
  clipCount: number;
}

export function buildTimelinePlan(project: ProjectManifest, options: TimelinePlanOptions = {}): TimelinePlan {
  const transitionMs = Math.max(
    0,
    Math.round((options.transitionSeconds ?? project.timelineTransitionSeconds ?? 0.3) * 1000),
  );
  const source: TimelinePlanClip[] = [];
  if (options.includeIntro) {
    for (const clip of project.introSegments)
      source.push({ ...clip, segmentId: clip.id, scope: "INTRO", outputStartMs: 0, outputEndMs: 0 });
  }
  for (const clip of mainRenderSelections(project))
    source.push({ ...clip, scope: "MAIN", outputStartMs: 0, outputEndMs: 0 });
  let cursor = 0;
  source.forEach((clip, index) => {
    const span = Math.max(0, clip.outMs - clip.inMs);
    const overlap = index ? Math.min(transitionMs, span) : 0;
    const start = Math.max(0, cursor - overlap);
    clip.outputStartMs = start;
    clip.outputEndMs = start + span;
    cursor = clip.outputEndMs;
  });
  return { clips: source, durationMs: cursor, transitionMs };
}

/**
 * Groups the canonical Main render plan back onto its top-level grid asset.
 * Insertions remain individual render clips, but their time belongs to the
 * anchor card so preview, Timeline and final render all read one plan.
 */
export function buildMainTimelineGroups(
  project: ProjectManifest,
  options: Pick<TimelinePlanOptions, "transitionSeconds"> = {},
): MainTimelineGroup[] {
  const plan = buildTimelinePlan(project, { includeIntro: false, transitionSeconds: options.transitionSeconds });
  const anchorByInsertionId = new Map(
    (project.mediaInsertions ?? []).map((insertion) => [insertion.id, insertion.anchorVideoAssetId]),
  );
  const groups: MainTimelineGroup[] = [];
  for (const clip of plan.clips) {
    const anchorAssetId = clip.mediaInsertionId
      ? (anchorByInsertionId.get(clip.mediaInsertionId) ?? clip.assetId)
      : clip.assetId;
    const span = Math.max(0, clip.outMs - clip.inMs);
    const current = groups.at(-1);
    if (!current || current.anchorAssetId !== anchorAssetId) {
      groups.push({
        anchorAssetId,
        outputStartMs: clip.outputStartMs,
        outputEndMs: clip.outputEndMs,
        sourceDurationMs: span,
        insertedDurationMs: clip.mediaInsertionId ? span : 0,
        clipCount: 1,
      });
      continue;
    }
    current.outputEndMs = clip.outputEndMs;
    current.sourceDurationMs += span;
    if (clip.mediaInsertionId) current.insertedDurationMs += span;
    current.clipCount += 1;
  }
  return groups;
}

export function mapTimelineCueToPlan(cue: SubtitleCue, plan: TimelinePlan): SubtitleCue | undefined {
  const scope: SubtitleTimelineScope = cue.timelineScope ?? "MAIN";
  const scoped = plan.clips.filter((item) => item.scope === scope);
  if (!scoped.length) return undefined;
  // Subtitle cue times are relative to their own Main/Intro timeline, while a
  // combined plan may place Intro before Main. Convert to a scope-local origin.
  const scopeOrigin = scoped[0].outputStartMs;
  const clip = scoped.find(
    (item) => cue.startMs >= item.outputStartMs - scopeOrigin && cue.startMs < item.outputEndMs - scopeOrigin,
  );
  if (!clip) return undefined;
  const offset = cue.startMs - (clip.outputStartMs - scopeOrigin);
  const duration = Math.max(1, cue.endMs - cue.startMs);
  return {
    ...cue,
    startMs: clip.outputStartMs + offset,
    endMs: Math.min(plan.durationMs, clip.outputStartMs + offset + duration),
  };
}

export function bgmTracksForPlan(tracks: BgmTrack[], plan: TimelinePlan): BgmTrack[] {
  return tracks
    .filter((track) => track.resolutionStatus !== "NEEDS_LOCAL_FILE")
    .map((track) => ({
      ...track,
      timelineInMs: Math.max(0, Math.min(plan.durationMs, track.timelineInMs)),
      timelineOutMs: Math.max(0, Math.min(plan.durationMs, track.timelineOutMs)),
    }))
    .filter((track) => track.timelineOutMs > track.timelineInMs);
}
