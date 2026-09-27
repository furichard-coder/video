import type {
  AudioProcessingOptions,
  AudioProtectionOptions,
  BgmTrack,
  InsertionAudioPlan,
} from "../../shared/domain";
import { audioCodecArgs, buildAudioProcessingFilter, sanitizeAudioProcessingOptions } from "./audio-processing";
import {
  MAIN_START_CUE_BASE_GAINS,
  MAIN_START_CUE_FREQUENCIES_HZ,
  mainStartCueSpec,
} from "../../shared/main-start-cue";

const MAX_CROSSFADE_REPEATS = 32;

function number(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function smoothGateEnvelope(muted: Array<{ start: number; end: number }>): string | undefined {
  if (!muted.length) return undefined;
  const expressions = muted.map(({ start, end }) => {
    const fade = Math.min(0.025, Math.max(0.005, (end - start) / 4));
    const downEnd = start + fade;
    const upStart = Math.max(downEnd, end - fade);
    return `if(lt(t\,${number(start)})\,1\,if(lt(t\,${number(downEnd)})\,(${number(downEnd)}-t)/${number(fade)}\,if(lt(t\,${number(upStart)})\,0\,if(lt(t\,${number(end)})\,(t-${number(upStart)})/${number(fade)}\,1))))`;
  });
  return expressions.join("*");
}

function sourceGateEnvelope(plan: InsertionAudioPlan): string | undefined {
  return smoothGateEnvelope(
    plan.items
      .filter((item) => item.hasSourceAudio && !item.gates.original && item.timelineEndMs > item.timelineStartMs)
      .map((item) => ({ start: item.timelineStartMs / 1_000, end: item.timelineEndMs / 1_000 })),
  );
}

function insertionLoop(
  inputIndex: number,
  rangeIndex: number,
  durationSeconds: number,
  sourceInSeconds: number,
  sourceSpanSeconds: number,
  crossfadeSecondsInput: number,
): { filters: string[]; label: string } {
  const prefix = `ibgm${rangeIndex}`;
  const crossfadeSeconds = Math.min(Math.max(0, crossfadeSecondsInput), sourceSpanSeconds / 4);
  const periodSeconds = Math.max(0.001, sourceSpanSeconds - crossfadeSeconds);
  const repeatCount = Math.max(1, Math.ceil(Math.max(0, durationSeconds - crossfadeSeconds) / periodSeconds));
  const source = [
    `[${inputIndex}:a:0]atrim=start=${number(sourceInSeconds)}:end=${number(sourceInSeconds + sourceSpanSeconds)}`,
    "asetpts=PTS-STARTPTS",
    "aresample=48000",
    "aformat=sample_rates=48000:channel_layouts=stereo",
  ].join(",");
  if (repeatCount > 1 && repeatCount <= MAX_CROSSFADE_REPEATS && crossfadeSeconds > 0) {
    const branches = Array.from({ length: repeatCount }, (_, index) => `${prefix}part${index}`);
    const filters = [`${source},asplit=${repeatCount}${branches.map((label) => `[${label}]`).join("")}`];
    let previous = branches[0];
    for (let index = 1; index < branches.length; index += 1) {
      const next = `${prefix}join${index}`;
      filters.push(`[${previous}][${branches[index]}]acrossfade=d=${number(crossfadeSeconds)}:c1=tri:c2=tri[${next}]`);
      previous = next;
    }
    const label = `${prefix}looped`;
    filters.push(`[${previous}]atrim=duration=${number(durationSeconds)},asetpts=PTS-STARTPTS[${label}]`);
    return { filters, label };
  }
  if (repeatCount > 1) {
    const smooth = Math.min(Math.max(0.005, crossfadeSeconds || 0.06), sourceSpanSeconds / 4);
    const phase = `mod(t\\,${number(sourceSpanSeconds)})`;
    const envelope = smooth > 0
      ? `if(lt(${phase}\\,${number(smooth)})\\,${phase}/${number(smooth)}\\,if(gt(${phase}\\,${number(sourceSpanSeconds - smooth)})\\,(${number(sourceSpanSeconds)}-${phase})/${number(smooth)}\\,1))`
      : "1";
    const label = `${prefix}looped`;
    return {
      filters: [
        `${source},aloop=loop=-1:size=${Math.max(1, Math.ceil(sourceSpanSeconds * 48_000))}:start=0,atrim=duration=${number(durationSeconds)},volume='${envelope}':eval=frame,asetpts=PTS-STARTPTS[${label}]`,
      ],
      label,
    };
  }
  const label = `${prefix}source`;
  return {
    filters: [`${source},atrim=duration=${number(durationSeconds)},asetpts=PTS-STARTPTS[${label}]`],
    label,
  };
}

export interface InsertionAudioPostBuildOptions {
  baseMasterPath: string;
  outputPath: string;
  durationMs: number;
  baseHasAudio: boolean;
  plan: InsertionAudioPlan;
  tracks: readonly BgmTrack[];
  /** Global project BGM and silent-clip auto-dub; mixed after the reusable picture/source-audio master. */
  additionalBgmTracks?: readonly (BgmTrack & {
    loop?: boolean;
    sourceSpanMs?: number;
    loopCrossfadeMs?: number;
  })[];
  shutterPath?: string;
  audioProcessing: AudioProcessingOptions;
  audioProtection: AudioProtectionOptions;
  filterScriptPath: string;
}

export interface InsertionAudioPostBuildResult {
  args: string[];
  filterScript: string;
  channels: 2 | 6;
  layout: "stereo" | "5.1(side)";
  bgmInputCount: number;
  sfxInputCount: number;
}

/**
 * The canonical insertion-audio post pass. Input 0 is a timeline-correct
 * picture/base-audio master; no video decoder or encoder is opened here.
 */
export function buildInsertionAudioPostArguments(
  options: InsertionAudioPostBuildOptions,
): InsertionAudioPostBuildResult {
  const durationSeconds = Math.max(0.001, options.durationMs / 1_000);
  const trackById = new Map(options.tracks.map((track) => [track.id, track]));
  const filters: string[] = [];
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", options.baseMasterPath];
  const validRanges = options.plan.bgmRanges.map((range) => {
    const track = trackById.get(range.bgmTrackId);
    if (!track?.sourcePath) throw new Error(`插入素材配樂「${range.bgmTrackName}」不存在或尚未指定本機檔案。`);
    args.push("-i", track.sourcePath);
    return { range, track };
  });
  const additionalBgmTracks = (options.additionalBgmTracks ?? []).filter(
    (track) => track.timelineInMs < options.durationMs && track.timelineOutMs > track.timelineInMs,
  );
  for (const track of additionalBgmTracks) {
    if (!track.sourcePath) throw new Error(`配樂「${track.fileName}」不存在或尚未指定本機檔案。`);
    args.push("-i", track.sourcePath);
  }
  const packagedSfxEvents = options.plan.sfxEvents.filter((event) => event.source !== "SYNTHETIC_MAIN_CUE");
  if (packagedSfxEvents.length && !options.shutterPath)
    throw new Error("找不到內建相機快門效果音（SFX），無法完成插入素材音訊混音。");
  for (const _event of packagedSfxEvents) args.push("-i", options.shutterPath!);

  if (options.baseHasAudio) {
    const envelope = sourceGateEnvelope(options.plan);
    filters.push(`[0:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,atrim=duration=${number(durationSeconds)},apad,atrim=duration=${number(durationSeconds)}${envelope ? `,volume='${envelope}':eval=frame` : ""}[ibase]`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${number(durationSeconds)},asetpts=PTS-STARTPTS[ibase]`);
  }

  const overlays: string[] = [];
  validRanges.forEach(({ range }, index) => {
    const source = insertionLoop(
      1 + index,
      index,
      range.durationMs / 1_000,
      range.sourceInMs / 1_000,
      Math.max(1, range.sourceSpanMs) / 1_000,
      range.loopCrossfadeMs / 1_000,
    );
    filters.push(...source.filters);
    const label = `ibgmout${index}`;
    const chain = [`[${source.label}]volume=${number(range.volumePercent / 100)}`];
    if (range.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${number(range.fadeInMs / 1_000)}`);
    if (range.fadeOutMs > 0) {
      const fade = Math.min(range.durationMs, range.fadeOutMs) / 1_000;
      chain.push(`afade=t=out:st=${number(Math.max(0, range.durationMs / 1_000 - fade))}:d=${number(fade)}`);
    }
    chain.push(
      `adelay=${Math.max(0, Math.round(range.timelineStartMs))}:all=1`,
      "apad",
      `atrim=duration=${number(durationSeconds)}`,
    );
    const disabled = options.plan.items.filter(
      (item) => range.memberInstanceIds.includes(item.instanceId) && !item.gates.bgm,
    );
    if (disabled.length) {
      const expression = smoothGateEnvelope(disabled.map((item) => ({
        start: item.timelineStartMs / 1_000,
        end: item.timelineEndMs / 1_000,
      })))!;
      chain.push(`volume='${expression}':eval=frame`);
    }
    chain[chain.length - 1] += `[${label}]`;
    filters.push(chain.join(","));
    overlays.push(label);
  });
  additionalBgmTracks.forEach((track, index) => {
    const timelineEndMs = Math.min(options.durationMs, track.timelineOutMs);
    const durationMs = Math.max(1, timelineEndMs - track.timelineInMs);
    const sourceSpanMs = Math.max(1, track.sourceSpanMs ?? track.sourceOutMs - track.sourceInMs);
    const source = insertionLoop(
      1 + validRanges.length + index,
      validRanges.length + index,
      durationMs / 1_000,
      track.sourceInMs / 1_000,
      sourceSpanMs / 1_000,
      (track.loopCrossfadeMs ?? 120) / 1_000,
    );
    filters.push(...source.filters);
    const label = `pbgm${index}`;
    const chain = [`[${source.label}]volume=${number(track.volumePercent / 100)}`];
    if (track.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${number(Math.min(durationMs, track.fadeInMs) / 1_000)}`);
    if (track.fadeOutMs > 0) {
      const fade = Math.min(durationMs, track.fadeOutMs) / 1_000;
      chain.push(`afade=t=out:st=${number(Math.max(0, durationMs / 1_000 - fade))}:d=${number(fade)}`);
    }
    chain.push(`adelay=${Math.max(0, Math.round(track.timelineInMs))}:all=1`, "apad", `atrim=duration=${number(durationSeconds)}`);
    const disabled = options.plan.items.filter(
      (item) => !item.gates.bgm && item.timelineEndMs > track.timelineInMs && item.timelineStartMs < timelineEndMs,
    );
    if (disabled.length) {
      const expression = smoothGateEnvelope(disabled.map((item) => ({
        start: item.timelineStartMs / 1_000,
        end: item.timelineEndMs / 1_000,
      })))!;
      chain.push(`volume='${expression}':eval=frame`);
    }
    chain[chain.length - 1] += `[${label}]`;
    filters.push(chain.join(","));
    overlays.push(label);
  });
  const sfxOffset = 1 + validRanges.length + additionalBgmTracks.length;
  let packagedSfxIndex = 0;
  options.plan.sfxEvents.forEach((event, index) => {
    const label = `isfx${index}`;
    if (event.source === "SYNTHETIC_MAIN_CUE") {
      const cue = mainStartCueSpec(event.durationMs ?? 650);
      const cueGain = event.volumePercent / 100;
      const secondDelayMs = Math.round(cue.secondDelaySeconds * 1_000);
      filters.push(
        `sine=frequency=${MAIN_START_CUE_FREQUENCIES_HZ[0]}:sample_rate=48000:duration=${number(cue.durationSeconds)},volume=${number(cueGain * MAIN_START_CUE_BASE_GAINS[0])},afade=t=out:st=${number(Math.max(0, cue.durationSeconds - cue.fadeOutSeconds))}:d=${number(cue.fadeOutSeconds)}[cue${index}a]`,
        `sine=frequency=${MAIN_START_CUE_FREQUENCIES_HZ[1]}:sample_rate=48000:duration=${number(cue.secondToneSeconds)},volume=${number(cueGain * MAIN_START_CUE_BASE_GAINS[1])},afade=t=out:st=${number(Math.max(0, cue.secondToneSeconds - cue.fadeOutSeconds))}:d=${number(cue.fadeOutSeconds)},adelay=${secondDelayMs}:all=1[cue${index}b]`,
        `[cue${index}a][cue${index}b]amix=inputs=2:duration=longest:normalize=0,aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.max(0, Math.round(event.timelineStartMs))}:all=1,apad,atrim=duration=${number(durationSeconds)}[${label}]`,
      );
    } else {
      filters.push(
        `[${sfxOffset + packagedSfxIndex}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=${number(event.volumePercent / 100)},adelay=${Math.max(0, Math.round(event.timelineStartMs))}:all=1,apad,atrim=duration=${number(durationSeconds)}[${label}]`,
      );
      packagedSfxIndex += 1;
    }
    overlays.push(label);
  });

  const mixInputs = ["ibase", ...overlays];
  filters.push(`${mixInputs.map((label) => `[${label}]`).join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[imix]`);
  const processing = sanitizeAudioProcessingOptions(options.audioProcessing);
  const processingPlan = buildAudioProcessingFilter(processing);
  if (processing.mode === "ENHANCED_STEREO") {
    filters.push(`[imix]${processingPlan.filter}[aout]`);
  } else if (processing.mode === "VIRTUAL_SURROUND_5_1") {
    const parts = (processingPlan.filter ?? "").split(";");
    filters.push(`[imix]${parts[0]}`, ...parts.slice(1));
  } else {
    const peak = options.audioProtection.enabled
      ? 10 ** (options.audioProtection.peakCeilingDb / 20)
      : 0.95;
    filters.push(`[imix]alimiter=limit=${number(peak)}:attack=5:release=100[aout]`);
  }

  args.push(
    "-/filter_complex",
    options.filterScriptPath,
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    ...audioCodecArgs(processing, processingPlan.channels),
    "-metadata:s:a:0",
    `title=${processing.mode}`,
    "-movflags",
    "+faststart",
    "-shortest",
    "-progress",
    "pipe:1",
    "-nostats",
    options.outputPath,
  );
  return {
    args,
    filterScript: filters.join(";"),
    channels: processingPlan.channels,
    layout: processingPlan.layout,
    bgmInputCount: validRanges.length + additionalBgmTracks.length,
    sfxInputCount: packagedSfxEvents.length,
  };
}
