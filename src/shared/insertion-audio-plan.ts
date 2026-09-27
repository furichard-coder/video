import {
  DEFAULT_INSERTION_AUDIO_FADE_MS,
  DEFAULT_INSERTION_BGM_LOOP_CROSSFADE_MS,
  DEFAULT_INSERTION_BGM_VOLUME_PERCENT,
  DEFAULT_INSERTION_SFX_VOLUME_PERCENT,
  DEFAULT_AUDIO_TRACK_GATES,
  DEFAULT_MAIN_START_CUE_SETTINGS,
  DUNES_SHUTTER_EFFECT_ID,
  MAIN_START_CUE_SFX_ID,
  type AudioTrackGates,
  type InsertionAudioPlan,
  type InsertionAudioScope,
  type InsertionAudioSettings,
  type MainStartCardOptions,
  type ProjectManifest,
  type SourceAsset,
  type TransitionDurationSec,
} from "./domain";
import { mainRenderSelections } from "./editing-rules";
import { introSegmentsForOutput } from "./intro-duration";

const MAX_FADE_MS = 1_000;
const MAX_LOOP_CROSSFADE_MS = 500;
export const MAX_BGM_CROSSFADE_REPEATS = 32;

export function defaultInsertionAudioSettings(kind: SourceAsset["kind"], legacyPhotoSfx = true): InsertionAudioSettings {
  return {
    trackGates: { ...DEFAULT_AUDIO_TRACK_GATES },
    sfxEnabled: kind === "IMAGE" && legacyPhotoSfx,
    ...(kind === "IMAGE" ? { sfxId: DUNES_SHUTTER_EFFECT_ID } : {}),
    sfxVolumePercent: DEFAULT_INSERTION_SFX_VOLUME_PERCENT,
    bgmTrackId: undefined,
    bgmVolumePercent: DEFAULT_INSERTION_BGM_VOLUME_PERCENT,
    fadeMs: DEFAULT_INSERTION_AUDIO_FADE_MS,
    loopCrossfadeMs: DEFAULT_INSERTION_BGM_LOOP_CROSSFADE_MS,
  };
}

export function normalizeAudioTrackGates(value: unknown): AudioTrackGates {
  const input = value && typeof value === "object" ? (value as Partial<AudioTrackGates>) : {};
  return {
    original: input.original !== false,
    voice: input.voice !== false,
    bgm: input.bgm !== false,
    sfx: input.sfx !== false,
  };
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(Number(value)))) : fallback;
}

/** One sanitizer/default source for Main insertions, Intro items, store, renderer and FFmpeg. */
export function normalizeInsertionAudioSettings(
  value: unknown,
  kind: SourceAsset["kind"],
  validBgmTrackIds?: ReadonlySet<string>,
  legacyPhotoSfx = true,
): InsertionAudioSettings {
  const fallback = defaultInsertionAudioSettings(kind, legacyPhotoSfx);
  const input = value && typeof value === "object" ? (value as Partial<InsertionAudioSettings>) : {};
  const candidateTrackId = typeof input.bgmTrackId === "string" && input.bgmTrackId ? input.bgmTrackId : undefined;
  const bgmTrackId = candidateTrackId && (!validBgmTrackIds || validBgmTrackIds.has(candidateTrackId))
    ? candidateTrackId
    : undefined;
  return {
    trackGates: normalizeAudioTrackGates(input.trackGates),
    sfxEnabled: kind === "IMAGE" && (typeof input.sfxEnabled === "boolean" ? input.sfxEnabled : fallback.sfxEnabled),
    ...(kind === "IMAGE" ? { sfxId: DUNES_SHUTTER_EFFECT_ID } : {}),
    sfxVolumePercent: numberInRange(
      input.sfxVolumePercent,
      fallback.sfxVolumePercent,
      0,
      300,
    ),
    bgmTrackId,
    bgmVolumePercent: numberInRange(input.bgmVolumePercent, fallback.bgmVolumePercent, 0, 300),
    fadeMs: numberInRange(input.fadeMs, fallback.fadeMs, 0, MAX_FADE_MS),
    loopCrossfadeMs: numberInRange(
      input.loopCrossfadeMs,
      fallback.loopCrossfadeMs,
      0,
      MAX_LOOP_CROSSFADE_MS,
    ),
  };
}

export interface BuildInsertionAudioPlanOptions {
  purpose: "CONCAT" | "INTRO" | "SHORTS" | "CLIP";
  transitionSeconds?: TransitionDurationSec;
  prependIntro?: boolean;
  mainStartCard?: MainStartCardOptions;
  shortsSource?: "INTRO" | "MAIN";
  /** Final export can explicitly omit every BGM while leaving independent SFX enabled. */
  includeBgm?: boolean;
}

interface PlannedOccurrence {
  instanceId?: string;
  scope?: InsertionAudioScope;
  assetId?: string;
  mediaInsertionId?: string;
  durationMs: number;
  transitionStyle?: MainStartCardOptions["transitionStyle"];
  settings?: InsertionAudioSettings;
  sourceInMs?: number;
  sourceOutMs?: number;
  mainStartCue?: boolean;
}

function occurrenceStartTimes(occurrences: PlannedOccurrence[], transitionMs: number): number[] {
  if (!occurrences.length) return [];
  const starts = [0];
  let cursor = occurrences[0].durationMs;
  for (let index = 1; index < occurrences.length; index += 1) {
    const style = occurrences[index].transitionStyle ?? occurrences[index - 1].transitionStyle;
    const overlap = style === "HARD_CUT" ? 0 : Math.min(transitionMs, occurrences[index].durationMs);
    starts.push(Math.max(0, cursor - overlap));
    cursor += occurrences[index].durationMs - overlap;
  }
  return starts;
}

/**
 * Builds the one canonical SFX/BGM plan consumed by Final Render, proxy preview and export review UI.
 * A photo SFX event starts when that occurrence first becomes visible (the xfade start when applicable).
 */
export function buildInsertionAudioPlan(
  project: ProjectManifest,
  options: BuildInsertionAudioPlanOptions,
): InsertionAudioPlan {
  const transitionMs = Math.max(0, Math.round((options.transitionSeconds ?? project.timelineTransitionSeconds) * 1_000));
  const validTrackIds = new Set(project.bgmTracks.map((track) => track.id));
  const assetById = new Map(project.sources.map((asset) => [asset.id, asset]));
  const insertionById = new Map(project.mediaInsertions.map((item) => [item.id, item]));
  const occurrences: PlannedOccurrence[] = [];
  const intro = introSegmentsForOutput(project.introSegments, project.introSegmentMaxDurationMs);
  const includeIntro = options.purpose === "INTRO" || (options.purpose === "CONCAT" && options.prependIntro) ||
    (options.purpose === "SHORTS" && options.shortsSource !== "MAIN");
  const includeMain = options.purpose === "CONCAT" || (options.purpose === "SHORTS" && options.shortsSource === "MAIN");
  if (includeIntro) {
    for (const segment of intro) {
      const asset = assetById.get(segment.assetId);
      if (!asset) continue;
      occurrences.push({
        instanceId: segment.id,
        scope: "INTRO",
        assetId: segment.assetId,
        durationMs: Math.max(0, segment.outMs - segment.inMs),
        sourceInMs: segment.inMs,
        sourceOutMs: segment.outMs,
        settings: normalizeInsertionAudioSettings(
          segment.insertionAudio,
          asset.kind,
          validTrackIds,
          asset.photoSoundEnabled !== false,
        ),
      });
    }
  }
  if (includeIntro && includeMain && options.mainStartCard) {
    occurrences.push({
      durationMs: Math.max(0, Math.round(options.mainStartCard.durationSeconds * 1_000)),
      transitionStyle: options.mainStartCard.transitionStyle,
      mainStartCue: true,
    });
  }
  if (includeMain) {
    for (const clip of mainRenderSelections(project)) {
      const insertion = clip.mediaInsertionId ? insertionById.get(clip.mediaInsertionId) : undefined;
      const asset = assetById.get(clip.assetId);
      occurrences.push({
        ...(asset ? {
          instanceId: insertion?.id ?? `MAIN:${clip.assetId}:${clip.inMs}:${clip.outMs}`,
          scope: "MAIN" as const,
          assetId: clip.assetId,
          ...(insertion ? { mediaInsertionId: insertion.id } : {}),
          settings: insertion
            ? normalizeInsertionAudioSettings(
                insertion.insertionAudio,
                asset.kind,
                validTrackIds,
                asset.photoSoundEnabled !== false,
              )
            : normalizeInsertionAudioSettings(
                {
                  ...defaultInsertionAudioSettings(asset.kind, asset.photoSoundEnabled !== false),
                  trackGates: normalizeAudioTrackGates(asset.mainAudioGates),
                },
                asset.kind,
                validTrackIds,
                asset.photoSoundEnabled !== false,
              ),
        } : {}),
        durationMs: Math.max(0, clip.outMs - clip.inMs),
        sourceInMs: clip.inMs,
        sourceOutMs: clip.outMs,
      });
    }
  }

  const starts = occurrenceStartTimes(occurrences, transitionMs);
  const timelineDurationMs = occurrences.length
    ? Math.max(...occurrences.map((item, index) => starts[index] + item.durationMs))
    : 0;
  const warnings: string[] = [];
  const items: InsertionAudioPlan["items"] = occurrences.flatMap((occurrence, occurrenceIndex) => {
    if (!occurrence.instanceId || !occurrence.scope || !occurrence.assetId || !occurrence.settings) return [];
    const asset = assetById.get(occurrence.assetId);
    if (!asset) return [];
    const settings = occurrence.settings;
    const track = options.includeBgm === false
      ? undefined
      : settings.bgmTrackId
        ? project.bgmTracks.find((item) => item.id === settings.bgmTrackId)
        : undefined;
    if (options.includeBgm !== false && settings.bgmTrackId && !track)
      warnings.push(`「${asset.fileName}」指定的背景音樂已不存在，這次按不使用背景音樂處理。`);
    const trackIndex = track ? project.bgmTracks.findIndex((item) => item.id === track.id) + 1 : undefined;
    return [{
      instanceId: occurrence.instanceId,
      scope: occurrence.scope,
      assetId: asset.id,
      fileName: asset.fileName,
      kind: asset.kind,
      timelineStartMs: starts[occurrenceIndex],
      timelineEndMs: starts[occurrenceIndex] + occurrence.durationMs,
      durationMs: occurrence.durationMs,
      hasSourceAudio: asset.kind === "VIDEO" && Boolean(asset.mediaInfo?.audioCodec),
      sourceInMs: occurrence.sourceInMs ?? 0,
      sourceOutMs: occurrence.sourceOutMs ?? occurrence.durationMs,
      gates: normalizeAudioTrackGates(settings.trackGates),
      sfxEnabled: asset.kind === "IMAGE" && settings.sfxEnabled && normalizeAudioTrackGates(settings.trackGates).sfx,
      ...(asset.kind === "IMAGE" && settings.sfxEnabled && normalizeAudioTrackGates(settings.trackGates).sfx ? {
        sfxName: project.photoSoundEffect.displayName,
        sfxVolumePercent: settings.sfxVolumePercent,
      } : {}),
      bgmEnabled: Boolean(track) && normalizeAudioTrackGates(settings.trackGates).bgm,
      ...(track ? {
        bgmTrackId: track.id,
        bgmTrackIndex: trackIndex,
        bgmTrackName: track.fileName,
        bgmTimelineStartMs: starts[occurrenceIndex],
        bgmTimelineEndMs: starts[occurrenceIndex] + occurrence.durationMs,
        bgmPlayDurationMs: occurrence.durationMs,
        bgmVolumePercent: settings.bgmVolumePercent,
      } : {}),
      continuousWithPrevious: false,
      usesLoop: false,
      fadeMs: settings.fadeMs,
    }];
  });

  const occurrenceIndexByInstanceId = new Map(
    occurrences.flatMap((item, index) => item.instanceId ? [[item.instanceId, index] as const] : []),
  );
  const bgmRanges: InsertionAudioPlan["bgmRanges"] = [];
  for (const item of items) {
    if (!item.bgmTrackId) continue;
    const occurrenceIndex = occurrenceIndexByInstanceId.get(item.instanceId)!;
    const previous = bgmRanges.at(-1);
    const previousLastInstance = previous?.memberInstanceIds.at(-1);
    const previousOccurrenceIndex = previousLastInstance ? occurrenceIndexByInstanceId.get(previousLastInstance) : undefined;
    const continuous = Boolean(
      previous &&
      previous.scope === item.scope &&
      previous.bgmTrackId === item.bgmTrackId &&
      previousOccurrenceIndex !== undefined &&
      occurrenceIndex === previousOccurrenceIndex + 1,
    );
    const track = project.bgmTracks.find((candidate) => candidate.id === item.bgmTrackId)!;
    if (continuous && previous) {
      previous.timelineEndMs = Math.max(previous.timelineEndMs, item.timelineEndMs);
      previous.durationMs = previous.timelineEndMs - previous.timelineStartMs;
      previous.memberInstanceIds.push(item.instanceId);
      item.continuousWithPrevious = true;
    } else {
      const settings = occurrences[occurrenceIndex].settings!;
      bgmRanges.push({
        id: `${item.scope}:${item.instanceId}:${track.id}`,
        scope: item.scope,
        bgmTrackId: track.id,
        bgmTrackIndex: project.bgmTracks.findIndex((candidate) => candidate.id === track.id) + 1,
        bgmTrackName: track.fileName,
        timelineStartMs: item.timelineStartMs,
        timelineEndMs: item.timelineEndMs,
        durationMs: item.durationMs,
        sourceInMs: track.sourceInMs,
        sourceSpanMs: Math.max(1, track.sourceOutMs - track.sourceInMs || track.durationMs),
        volumePercent: settings.bgmVolumePercent,
        fadeInMs: Math.min(settings.fadeMs, Math.floor(item.durationMs / 2)),
        fadeOutMs: Math.min(settings.fadeMs, Math.floor(item.durationMs / 2)),
        loopCrossfadeMs: settings.loopCrossfadeMs,
        usesLoop: false,
        loopStrategy: "NONE",
        memberInstanceIds: [item.instanceId],
      });
    }
  }
  for (const range of bgmRanges) {
    range.usesLoop = range.durationMs > range.sourceSpanMs;
    if (range.usesLoop) {
      const effectiveCrossfadeMs = Math.min(
        range.loopCrossfadeMs,
        Math.max(0, Math.floor(range.sourceSpanMs / 4)),
      );
      const repeatPeriodMs = Math.max(1, range.sourceSpanMs - effectiveCrossfadeMs);
      const repeatCount = Math.ceil(Math.max(0, range.durationMs - effectiveCrossfadeMs) / repeatPeriodMs);
      range.loopStrategy = repeatCount <= MAX_BGM_CROSSFADE_REPEATS && effectiveCrossfadeMs > 0
        ? "CROSSFADE"
        : "BOUNDED_DECLICK_FALLBACK";
      if (range.loopStrategy === "BOUNDED_DECLICK_FALLBACK") {
        warnings.push(
          `配樂「${range.bgmTrackName}」需要循環 ${repeatCount} 次，已改用有界接點平滑，避免建立過大的音訊濾鏡圖。`,
        );
      }
    }
    range.fadeInMs = Math.min(range.fadeInMs, Math.floor(range.durationMs / 2));
    range.fadeOutMs = Math.min(range.fadeOutMs, Math.floor(range.durationMs / 2));
    for (const instanceId of range.memberInstanceIds) {
      const item = items.find((candidate) => candidate.instanceId === instanceId)!;
      item.usesLoop = range.usesLoop;
      const loopPeriodMs = range.usesLoop && range.loopStrategy === "CROSSFADE"
        ? Math.max(1, range.sourceSpanMs - Math.min(range.loopCrossfadeMs, Math.floor(range.sourceSpanMs / 4)))
        : range.sourceSpanMs;
      item.bgmSourcePositionMs = range.sourceInMs + ((item.timelineStartMs - range.timelineStartMs) % loopPeriodMs);
    }
  }
  const sfxEvents: InsertionAudioPlan["sfxEvents"] = items.flatMap((item) => {
    if (!item.sfxEnabled) return [];
    const settings = occurrences[occurrenceIndexByInstanceId.get(item.instanceId)!].settings!;
    return [{
      instanceId: item.instanceId,
      scope: item.scope,
      timelineStartMs: item.timelineStartMs,
      sfxId: DUNES_SHUTTER_EFFECT_ID,
      displayName: project.photoSoundEffect.displayName,
      volumePercent: settings.sfxVolumePercent,
      source: "PACKAGED_SHUTTER" as const,
    }];
  });
  const mainStartIndex = occurrences.findIndex((item) => item.mainStartCue);
  const mainStartCue = project.mainStartCue ?? DEFAULT_MAIN_START_CUE_SETTINGS;
  if (mainStartIndex >= 0 && mainStartCue.enabled) {
    const cardDurationMs = occurrences[mainStartIndex].durationMs;
    sfxEvents.push({
      instanceId: "MAIN_START_CUE",
      scope: "MAIN",
      timelineStartMs: starts[mainStartIndex],
      sfxId: MAIN_START_CUE_SFX_ID,
      displayName: "正片開始提示音（SFX）",
      volumePercent: 70,
      durationMs: Math.min(cardDurationMs, Math.max(100, mainStartCue.durationMs)),
      source: "SYNTHETIC_MAIN_CUE",
    });
  }
  return {
    version: "insertion-audio-plan-v1",
    timelineDurationMs,
    transitionMs,
    items,
    bgmRanges,
    sfxEvents,
    warnings,
  };
}
