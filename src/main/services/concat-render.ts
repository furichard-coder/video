import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AudioProtectionOptions,
  BgmScopeSelection,
  BasicMediaInfo,
  ConcatRenderProgress,
  ConcatRenderRequest,
  ConcatRenderResult,
  PreviewResolution,
  SourceAsset,
  TransitionDurationSec,
  VolumeSegment,
  BgmTrack,
  SubtitleRenderLanguage,
  SubtitleTranslationProvider,
  ZoomSegment,
  ZoomEnhancementPreset,
  MainStartCardOptions,
  WatermarkSettings,
  RenderVideoCodec,
  RenderRuntimePolicy,
  InsertionAudioPlan,
  InsertionSfxEvent,
  ProjectManifest,
  SystemResourceSnapshot,
} from "../../shared/domain";
import {
  DEFAULT_AUDIO_PROTECTION_OPTIONS,
  DEFAULT_MAIN_START_CARD_OPTIONS,
  DEFAULT_ZOOM_ENHANCEMENT_PRESET,
} from "../../shared/domain";
import { colorPreset } from "../../shared/color-presets";
import {
  DEFAULT_INTRO_TARGET_DURATION_MS,
  DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT,
  INTRO_MAX_SEGMENTS,
  INTRO_EDIT_MIN_SEGMENT_MS,
  MAX_IMAGE_DURATION_MS,
  MIN_IMAGE_DURATION_MS,
} from "../../shared/domain";
import { assertSafeHexId } from "./path-safety";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import { MediaProbe } from "./media-probe";
import { finalizePartialOutput } from "./atomic-output";
import { imageDurationMs, mainRenderSelections } from "../../shared/editing-rules";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import {
  buildSubtitleAss,
  escapeFfmpegFilterPath,
  validateSubtitleBurnInOptions,
  writeSubtitleAss,
} from "./subtitle-burn-in";
import type { SubtitleTranslationService } from "./subtitle-translation";
import { normalizeWatermarkSettings, watermarkAppliesToPurpose, watermarkRenderedText } from "../../shared/watermark";
import { sanitizeAudioProtectionOptions, sanitizeBgmScopeSelection } from "./user-preferences";
import { ClipSilenceDetector, type SilenceDetector } from "./silence-detection";
import { usesBlurredCanvas } from "../../shared/output-canvas";
import { RenderCheckpointStore, type RenderCheckpointRecord, type RenderCheckpointSegment } from "./render-checkpoint";
import { captureSystemResources } from "./system-resource";
import { decideAdaptiveConcurrency, type AdaptiveConcurrencyState } from "./adaptive-render";
import type { RenderCommandState } from "./render-command-state";
import { OUTPUT_RESOLUTIONS, outputDimensions } from "../../shared/render-profile";
import type { RenderHardwareService } from "./render-hardware";
import { RenderElapsedTracker } from "./render-elapsed";
import { sanitizeAudioProcessingOptions } from "./audio-processing";
import { ORIENTATION_NORMALIZER_VERSION, orientationNormalizationFilter } from "../../shared/media-orientation";
import { buildInsertionAudioPlan } from "../../shared/insertion-audio-plan";
import { buildInsertionAudioPostArguments } from "./insertion-audio-render";
import {
  DiskSpacePauseError,
  RenderDiskMonitor,
  estimateResumeAdditionalPeak,
  isEnospcError,
  remainingAdditionalWriteBytes,
} from "./render-disk-space";
import {
  estimatedIntermediateBytes,
  intermediateBitrateArgs,
  resourceProfileFromLegacy,
  type RenderResourceProfile,
} from "../../shared/render-resource";

export interface ConcatInput {
  sourcePath: string;
  sourceVideoCodec?: string;
  assetId?: string;
  startMs?: number;
  durationMs: number;
  hasAudio: boolean;
  detectedSilent?: boolean;
  isImage?: boolean;
  isPortrait?: boolean;
  /** ffprobe Display Matrix rotation normalized to 0/90/180/270. */
  orientationRotationDegrees?: number;
  photoSoundEnabled?: boolean;
  photoSoundInputIndex?: number;
  volumeSegments?: VolumeSegment[];
  colorFilters?: string[];
  zoomSegments?: ZoomSegment[];
  mainStartCard?: MainStartCardOptions & {
    sourceDurationMs: number;
    line1TextFilePath: string;
    line2TextFilePath: string;
    fontFilePath: string;
  };
  /** Stable identity used only for persistent intermediate checkpoint reuse. */
  checkpointKey?: string;
  insertionAudioInstanceId?: string;
  insertionAudioScope?: "INTRO" | "MAIN";
}
export interface BgmRenderInput extends BgmTrack {
  loop?: boolean;
  sourceSpanMs?: number;
  insertionRangeId?: string;
  loopCrossfadeMs?: number;
  loopStrategy?: "NONE" | "CROSSFADE" | "BOUNDED_DECLICK_FALLBACK";
}

export interface ConcatFilterPlan {
  filterGraph: string;
  videoOutputLabel: string;
  audioOutputLabel: string;
  expectedDurationMs: number;
  width: number;
  height: number;
}

export interface ConcatFilterBuildOptions {
  /** Input video/audio already has geometry, color, gain and privacy processing baked in. */
  inputsAreNormalized?: boolean;
  /** Intermediate stages defer the master limiter until BGM and overlays are applied. */
  skipFinalDynamics?: boolean;
  /** QSV frames must be downloaded before the established CPU filter chain. */
  hardwareDecodedInputIndexes?: ReadonlySet<number>;
  /** Canonical independent SFX events; indexes follow visual, legacy shutter and BGM inputs. */
  timedSfxInputs?: InsertionSfxEvent[];
}

type HardwareDecodeBackend = "QSV" | "CUDA";

export interface WatermarkRenderResources {
  chineseTextFilePath: string;
  englishTextFilePath: string;
  chineseFontFilePath: string;
  englishFontFilePath: string;
}

const TRANSITIONS = new Set<TransitionDurationSec>([0.3, 0.5, 0.7]);
const RESOLUTION_NAMES = new Set<PreviewResolution>(OUTPUT_RESOLUTIONS);
const MAIN_START_TRANSITIONS = new Set(["DISSOLVE", "FADE_BLACK", "HARD_CUT"] as const);
export const LOW_MEMORY_MAX_FILTER_INPUTS = 6;

export function groupLowMemoryInputs(
  inputs: ConcatInput[],
  maximumInputs = LOW_MEMORY_MAX_FILTER_INPUTS,
): ConcatInput[][] {
  if (!Number.isInteger(maximumInputs) || maximumInputs < 3) throw new Error("低記憶體批次至少需要容納三個片段。");
  const groups: ConcatInput[][] = [];
  let start = 0;
  while (start < inputs.length) {
    let end = Math.min(inputs.length, start + maximumInputs);
    if (end < inputs.length) {
      // Keep a generated Main-start card with both adjacent clips so its
      // custom HARD_CUT/FADE_BLACK semantics are resolved in the leaf stage.
      if (inputs[end]?.mainStartCard && end - start > 2) end -= 1;
      else if (inputs[end - 1]?.mainStartCard) end = Math.min(inputs.length, end + 1);
    }
    groups.push(inputs.slice(start, end));
    start = end;
  }
  return groups;
}

export function validateAudioProtectionOptions(raw?: AudioProtectionOptions): AudioProtectionOptions {
  if (raw === undefined) return { ...DEFAULT_AUDIO_PROTECTION_OPTIONS };
  if (!raw || typeof raw !== "object") throw new Error("人聲與突發聲音保護設定無效。");
  const sanitized = sanitizeAudioProtectionOptions(raw);
  const booleanKeys = [
    "enabled",
    "autoDuckVoiceAndSuddenSounds",
    "preserveDistantCrowdAmbience",
    "preserveSceneMatchedSounds",
    "eqEnabled",
  ] as const;
  if (
    booleanKeys.some((key) => typeof raw[key] !== "boolean" || raw[key] !== sanitized[key]) ||
    raw.maxDuckingDb !== sanitized.maxDuckingDb ||
    raw.eqReductionDb !== sanitized.eqReductionDb ||
    raw.peakCeilingDb !== sanitized.peakCeilingDb
  ) {
    throw new Error("人聲保護範圍無效：最大壓低須為 3–6 dB、EQ 須為 0.5–4 dB、峰值上限須為 -1 或 -2 dB。");
  }
  return sanitized;
}

export function validateBgmScopeSelection(raw?: BgmScopeSelection): BgmScopeSelection {
  if (raw === undefined) return sanitizeBgmScopeSelection(undefined);
  if (!raw || typeof raw !== "object" || typeof raw.intro !== "boolean" || typeof raw.main !== "boolean") {
    throw new Error("配樂範圍無效；片頭與正片選項必須明確指定。");
  }
  return { intro: raw.intro, main: raw.main };
}

export function concatInputStartTimesMs(inputs: ConcatInput[], transitionSeconds: TransitionDurationSec): number[] {
  if (!inputs.length) return [];
  const starts = [0];
  let accumulatedMs = inputs[0].durationMs;
  for (let index = 1; index < inputs.length; index += 1) {
    const cardTransition =
      inputs[index].mainStartCard?.transitionStyle ?? inputs[index - 1].mainStartCard?.transitionStyle;
    const overlapMs = cardTransition === "HARD_CUT" ? 0 : transitionSeconds * 1000;
    starts.push(Math.max(0, accumulatedMs - overlapMs));
    accumulatedMs += inputs[index].durationMs - overlapMs;
  }
  return starts;
}

export function selectBgmTracksForScopes(
  tracks: BgmTrack[],
  scopes: BgmScopeSelection,
  boundaries?: { introEndMs: number; mainStartMs: number },
): BgmRenderInput[] {
  if (!scopes.intro && !scopes.main) return [];
  if (!boundaries || (scopes.intro && scopes.main)) return tracks.map((track) => ({ ...track }));
  if (scopes.main) {
    return tracks.map((track) => ({
      ...track,
      timelineInMs: track.timelineInMs + boundaries.mainStartMs,
      timelineOutMs: track.timelineOutMs + boundaries.mainStartMs,
    }));
  }
  return tracks.flatMap((track) => {
    const timelineOutMs = Math.min(track.timelineOutMs, boundaries.introEndMs);
    if (track.timelineInMs >= boundaries.introEndMs || timelineOutMs <= track.timelineInMs) return [];
    const durationMs = timelineOutMs - track.timelineInMs;
    return [
      {
        ...track,
        timelineOutMs,
        sourceOutMs: Math.min(track.sourceOutMs, track.sourceInMs + durationMs),
        fadeOutMs: Math.min(durationMs, Math.max(track.fadeOutMs, 1_500)),
      },
    ];
  });
}

export function validateMainStartCardOptions(raw: MainStartCardOptions): MainStartCardOptions {
  if (!raw || typeof raw !== "object") throw new Error("請先完成正片開始提示頁設定。");
  const integerInRange = (value: unknown, minimum: number, maximum: number) =>
    Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
  if (!integerInRange(raw.durationSeconds, 3, 7)) throw new Error("正片開始提示頁須為 3–7 秒。");
  if (typeof raw.line1 !== "string" || !raw.line1.trim() || raw.line1.length > 80 || /[\r\n]/.test(raw.line1))
    throw new Error("提示頁第一行文字須為 1–80 個字且不可換行。");
  if (typeof raw.line2 !== "string" || !raw.line2.trim() || raw.line2.length > 80 || /[\r\n]/.test(raw.line2))
    throw new Error("提示頁第二行文字須為 1–80 個字且不可換行。");
  if (!integerInRange(raw.line1FontSize1080p, 36, 180) || !integerInRange(raw.line2FontSize1080p, 30, 160))
    throw new Error("提示頁文字大小設定無效。");
  if (!integerInRange(raw.lineGap1080p, 50, 240)) throw new Error("提示頁兩行文字間距設定無效。");
  if (!integerInRange(raw.overlayOpacityPercent, 30, 85)) throw new Error("半透明遮罩須為 30%–85%。");
  if (!MAIN_START_TRANSITIONS.has(raw.transitionStyle)) throw new Error("正片開始提示頁轉場選項無效。");
  if (
    raw.backgroundIntroSegmentId !== undefined &&
    (typeof raw.backgroundIntroSegmentId !== "string" ||
      !raw.backgroundIntroSegmentId.trim() ||
      raw.backgroundIntroSegmentId.length > 200 ||
      /[\r\n\0]/.test(raw.backgroundIntroSegmentId))
  ) {
    throw new Error("提示頁背景片頭片段識別無效。");
  }
  return {
    ...raw,
    line1: raw.line1.trim(),
    line2: raw.line2.trim(),
    backgroundIntroSegmentId: raw.backgroundIntroSegmentId?.trim() || undefined,
  };
}

function resolveMainStartCardFont(): string {
  const windowsRoot = process.env.WINDIR || "C:\\Windows";
  const candidates = ["msjh.ttc", "msyh.ttc", "arial.ttf"].map((name) => path.join(windowsRoot, "Fonts", name));
  const selected = candidates.find(existsSync);
  if (!selected) throw new Error("找不到可用的 Windows 標題字型，無法產生正片開始提示頁。");
  return selected;
}

function resolveWatermarkFonts(): { chinese: string; english: string } {
  const windowsRoot = process.env.WINDIR || "C:\\Windows";
  const chinese = ["msjhbd.ttc", "msjh.ttc", "msyhbd.ttc", "msyh.ttc", "arial.ttf"]
    .map((name) => path.join(windowsRoot, "Fonts", name))
    .find(existsSync);
  const english = ["arial.ttf", "segoeuib.ttf", "msjhbd.ttc", "msjh.ttc"]
    .map((name) => path.join(windowsRoot, "Fonts", name))
    .find(existsSync);
  if (!chinese || !english) throw new Error("找不到可用的 Windows 浮水印字型，已阻擋輸出。");
  return { chinese, english };
}

function ffmpegNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

const MAX_BGM_CROSSFADE_REPEATS = 32;

/**
 * Build a finite, bounded BGM loop. Ordinary ranges use a real acrossfade at
 * every loop seam. Extremely short source spans fall back to aloop plus a
 * short gain envelope, so an accidental tiny range cannot explode the graph.
 */
function buildBgmSourceChain(
  inputIndex: number,
  bgmIndex: number,
  track: BgmRenderInput,
  durationSeconds: number,
  sourceSpanMs: number,
): { filters: string[]; outputLabel: string } {
  const prefix = `bgm${bgmIndex}`;
  const sourceInSeconds = track.sourceInMs / 1000;
  const sourceSpanSeconds = sourceSpanMs / 1000;
  const requestedCrossfadeSeconds = Math.max(0, (track.loopCrossfadeMs ?? 0) / 1000);
  const crossfadeSeconds = Math.min(requestedCrossfadeSeconds, sourceSpanSeconds / 4);
  const repeatPeriodSeconds = Math.max(0.001, sourceSpanSeconds - crossfadeSeconds);
  const repeatCount = track.loop
    ? Math.max(1, Math.ceil(Math.max(0, durationSeconds - crossfadeSeconds) / repeatPeriodSeconds))
    : 1;
  const baseChain = [
    `[${inputIndex}:a:0]atrim=start=${ffmpegNumber(sourceInSeconds)}:end=${ffmpegNumber(sourceInSeconds + sourceSpanSeconds)}`,
    "asetpts=PTS-STARTPTS",
    "aresample=48000",
    "aformat=sample_rates=48000:channel_layouts=stereo",
  ].join(",");
  if (track.loop && repeatCount > 1 && repeatCount <= MAX_BGM_CROSSFADE_REPEATS && crossfadeSeconds > 0) {
    const splitLabels = Array.from({ length: repeatCount }, (_, index) => `${prefix}loop${index}`);
    const filters = [`${baseChain},asplit=${repeatCount}${splitLabels.map((label) => `[${label}]`).join("")}`];
    let outputLabel = splitLabels[0];
    for (let index = 1; index < splitLabels.length; index += 1) {
      const nextLabel = `${prefix}cross${index}`;
      filters.push(
        `[${outputLabel}][${splitLabels[index]}]acrossfade=d=${ffmpegNumber(crossfadeSeconds)}:c1=tri:c2=tri[${nextLabel}]`,
      );
      outputLabel = nextLabel;
    }
    const trimmedLabel = `${prefix}looped`;
    filters.push(`[${outputLabel}]atrim=duration=${ffmpegNumber(durationSeconds)},asetpts=PTS-STARTPTS[${trimmedLabel}]`);
    return { filters, outputLabel: trimmedLabel };
  }
  if (track.loop && repeatCount > 1) {
    const smoothingSeconds = Math.min(Math.max(0.005, crossfadeSeconds || 0.06), sourceSpanSeconds / 4);
    const seamGain = smoothingSeconds > 0
      ? `if(lt(mod(t\,${ffmpegNumber(sourceSpanSeconds)})\,${ffmpegNumber(smoothingSeconds)})\,mod(t\,${ffmpegNumber(sourceSpanSeconds)})/${ffmpegNumber(smoothingSeconds)}\,if(gt(mod(t\,${ffmpegNumber(sourceSpanSeconds)})\,${ffmpegNumber(sourceSpanSeconds - smoothingSeconds)})\,(${ffmpegNumber(sourceSpanSeconds)}-mod(t\,${ffmpegNumber(sourceSpanSeconds)}))/${ffmpegNumber(smoothingSeconds)}\,1))`
      : "1";
    const outputLabel = `${prefix}looped`;
    return {
      filters: [
        `${baseChain},aloop=loop=-1:size=${Math.max(1, Math.ceil(sourceSpanSeconds * 48_000))}:start=0,atrim=duration=${ffmpegNumber(durationSeconds)},volume='${seamGain}':eval=frame,asetpts=PTS-STARTPTS[${outputLabel}]`,
      ],
      outputLabel,
    };
  }
  const outputLabel = `${prefix}source`;
  return { filters: [`${baseChain},atrim=duration=${ffmpegNumber(durationSeconds)}[${outputLabel}]`], outputLabel };
}

function watermarkAlphaExpression(settings: WatermarkSettings): string {
  const phase = `mod(t-${ffmpegNumber(settings.startSeconds)},${ffmpegNumber(settings.intervalSeconds)})`;
  const visible = ffmpegNumber(settings.visibleDurationSeconds);
  const fadeIn = settings.fadeInSeconds;
  const fadeOut = settings.fadeOutSeconds;
  let envelope = "1";
  if (fadeIn > 0 && fadeOut > 0)
    envelope = `if(lt(${phase},${ffmpegNumber(fadeIn)}),${phase}/${ffmpegNumber(fadeIn)},if(lt(${phase},${ffmpegNumber(settings.visibleDurationSeconds - fadeOut)}),1,(${visible}-${phase})/${ffmpegNumber(fadeOut)}))`;
  else if (fadeIn > 0) envelope = `if(lt(${phase},${ffmpegNumber(fadeIn)}),${phase}/${ffmpegNumber(fadeIn)},1)`;
  else if (fadeOut > 0)
    envelope = `if(lt(${phase},${ffmpegNumber(settings.visibleDurationSeconds - fadeOut)}),1,(${visible}-${phase})/${ffmpegNumber(fadeOut)})`;
  return `${ffmpegNumber(settings.textOpacityPercent / 100)}*${envelope}`;
}

export function buildWatermarkFilterChain(
  settings: WatermarkSettings,
  width: number,
  height: number,
  resources: WatermarkRenderResources,
): string {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0)
    throw new Error("浮水印輸出解析度無效。");
  const normalized = normalizeWatermarkSettings(settings);
  const scale = height / 1080;
  const margin = Math.max(6, Math.round(normalized.safeMargin1080p * scale));
  const boxBorder = Math.max(4, Math.round(18 * scale));
  const shadow = Math.max(1, Math.round(3 * scale));
  const phase = `mod(t-${ffmpegNumber(normalized.startSeconds)},${ffmpegNumber(normalized.intervalSeconds)})`;
  const enable = `gte(t,${ffmpegNumber(normalized.startSeconds)})*lt(${phase},${ffmpegNumber(normalized.visibleDurationSeconds)})`;
  const alpha = watermarkAlphaExpression(normalized);
  const draw = (
    item: WatermarkSettings["chinese"],
    textFilePath: string,
    fontFilePath: string,
    shadowOpacity: number,
  ) => {
    const x = item.position === "LOWER_LEFT" ? margin.toString() : `w-text_w-${margin}`;
    const fontSize = Math.max(10, Math.round(item.fontSize1080p * scale));
    const lineSpacing = item.layout === "STACKED_TWO_LINES" ? Math.round(-15 * scale) : 0;
    return `drawtext=fontfile='${escapeFfmpegFilterPath(fontFilePath)}':textfile='${escapeFfmpegFilterPath(textFilePath)}':reload=0:fontcolor=white:fontsize=${fontSize}:line_spacing=${lineSpacing}:x=${x}:y=h-text_h-${margin}:box=1:boxcolor=black@${ffmpegNumber(normalized.boxOpacityPercent / 100)}:boxborderw=${boxBorder}:shadowcolor=black@${ffmpegNumber(shadowOpacity)}:shadowx=${shadow}:shadowy=${shadow}:alpha='${alpha}':enable='${enable}'`;
  };
  return `${draw(normalized.chinese, resources.chineseTextFilePath, resources.chineseFontFilePath, 0.65)},${draw(normalized.english, resources.englishTextFilePath, resources.englishFontFilePath, 0.55)}`;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function localZoomSegments(
  input: ConcatInput,
): Array<ZoomSegment & { localStartSeconds: number; localEndSeconds: number }> {
  const sourceStartMs = input.startMs ?? 0;
  const sourceEndMs = sourceStartMs + input.durationMs;
  return (input.zoomSegments ?? [])
    .filter(
      (segment) =>
        segment.endMs > sourceStartMs &&
        segment.startMs < sourceEndMs &&
        (segment.zoomPercent > 100 || (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) !== "OFF"),
    )
    .map((segment) => ({
      ...segment,
      localStartSeconds: Math.max(0, segment.startMs - sourceStartMs) / 1000,
      localEndSeconds: Math.min(input.durationMs, segment.endMs - sourceStartMs) / 1000,
    }));
}

const ZOOM_ENHANCEMENT_FILTERS: Record<Exclude<ZoomEnhancementPreset, "OFF">, { denoise: string; sharpen: string }> = {
  BALANCED: { denoise: "hqdn3d=1.2:1.0:2.0:1.6", sharpen: "unsharp=5:5:0.45:5:5:0" },
  DETAIL: { denoise: "hqdn3d=0.8:0.6:1.2:1.0", sharpen: "unsharp=5:5:0.7:5:5:0" },
  DENOISE: { denoise: "hqdn3d=2.2:1.8:3.2:2.6", sharpen: "unsharp=5:5:0.25:5:5:0" },
};

function zoomExpression(
  segments: ReturnType<typeof localZoomSegments>,
  value: (segment: ZoomSegment) => number,
  fallback: number,
): string {
  return segments.reduceRight(
    (next, segment) =>
      `if(between(in_time,${ffmpegNumber(segment.localStartSeconds)},${ffmpegNumber(segment.localEndSeconds)}),${ffmpegNumber(value(segment))},${next})`,
    ffmpegNumber(fallback),
  );
}

export function buildConcatFilterGraph(
  inputs: ConcatInput[],
  transitionSeconds: TransitionDurationSec,
  resolution: PreviewResolution,
  bgmInputs: BgmRenderInput[] = [],
  sourceAudioVolumePercent: number = DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT,
  portrait = false,
  rawAudioProtection?: AudioProtectionOptions,
  options: ConcatFilterBuildOptions = {},
): ConcatFilterPlan {
  if (inputs.length < 1) throw new Error("至少需要一個影片或照片片段才能產出預覽。");
  if (!TRANSITIONS.has(transitionSeconds)) throw new Error("疊化秒數只支援 0.3、0.5 或 0.7 秒。");
  if (!RESOLUTION_NAMES.has(resolution)) throw new Error("預覽解析度只支援 360p、480p、720p、1080p、1440p 或 4K。");
  const audioProtection = validateAudioProtectionOptions(rawAudioProtection);
  const inputsAreNormalized = options.inputsAreNormalized === true;

  const transitionMs = transitionSeconds * 1000;
  for (const input of inputs) {
    if (
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 100 ||
      (inputs.length > 1 && input.durationMs <= transitionMs + 50)
    ) {
      throw new Error(`片段長度必須大於 ${transitionSeconds} 秒，才能建立完整疊化。`);
    }
  }

  const { width, height } = outputDimensions(resolution, portrait);
  const filters: string[] = [];
  inputs.forEach((input, index) => {
    const colorChain = !inputsAreNormalized && input.colorFilters?.length ? `,${input.colorFilters.join(",")}` : "";
    const zooms = inputsAreNormalized || input.isImage || input.mainStartCard ? [] : localZoomSegments(input);
    const baseVideoLabel = zooms.length || input.mainStartCard ? `vbase${index}` : `v${index}`;
    const hardwareDecoded = options.hardwareDecodedInputIndexes?.has(index) === true;
    let sourceVideoLabel = hardwareDecoded ? `vdownload${index}` : `${index}:v:0`;
    if (hardwareDecoded) filters.push(`[${index}:v:0]hwdownload,format=nv12[${sourceVideoLabel}]`);
    const orientationFilter =
      !inputsAreNormalized && !input.isImage
        ? orientationNormalizationFilter(input.orientationRotationDegrees)
        : undefined;
    if (orientationFilter) {
      const orientedLabel = `voriented${index}`;
      filters.push(`[${sourceVideoLabel}]${orientationFilter}[${orientedLabel}]`);
      sourceVideoLabel = orientedLabel;
    }
    // QSV downloads NV12 (semi-planar chroma). Convert once to the canonical
    // planar CPU format before split/scale/boxblur. This prevents a successful
    // hardware decode from leaking a corrupt UV surface into only one blurred
    // background branch while the centered foreground still looks valid.
    if (hardwareDecoded) {
      const canonicalLabel = `vplanar${index}`;
      filters.push(`[${sourceVideoLabel}]format=yuv420p[${canonicalLabel}]`);
      sourceVideoLabel = canonicalLabel;
    }
    if (inputsAreNormalized) {
      // Leaf stages already produced exact output resolution/FPS/SAR/pixel format.
      // Repeating scale/fps/pad on every reduction level wastes CPU and buffer memory.
      filters.push(`[${sourceVideoLabel}]setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${baseVideoLabel}]`);
    } else if (
      !inputsAreNormalized &&
      usesBlurredCanvas(Boolean(input.isPortrait), portrait ? "PORTRAIT_9_16" : "LANDSCAPE_16_9")
    ) {
      filters.push(`[${sourceVideoLabel}]fps=30000/1001,split=2[pbg${index}][pfg${index}]`);
      filters.push(
        `[pbg${index}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=luma_radius=min(h\\,w)/30:luma_power=1[blur${index}]`,
      );
      filters.push(
        `[pfg${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2[front${index}]`,
      );
      filters.push(
        `[blur${index}][front${index}]overlay=(W-w)/2:(H-h)/2${colorChain},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${baseVideoLabel}]`,
      );
    } else {
      filters.push(
        `[${sourceVideoLabel}]fps=30000/1001,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black${colorChain},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${baseVideoLabel}]`,
      );
    }
    if (zooms.length) {
      const zoom = zoomExpression(zooms, (segment) => segment.zoomPercent / 100, 1);
      const centerX = zoomExpression(zooms, (segment) => segment.centerXPercent / 100, 0.5);
      const centerY = zoomExpression(zooms, (segment) => segment.centerYPercent / 100, 0.5);
      let beforeZoomLabel = baseVideoLabel;
      zooms.forEach((segment, segmentIndex) => {
        const preset = segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET;
        if (preset === "OFF") return;
        const nextLabel = `vdenoise${index}_${segmentIndex}`;
        const timing = `between(t,${ffmpegNumber(segment.localStartSeconds)},${ffmpegNumber(segment.localEndSeconds)})`;
        filters.push(
          `[${beforeZoomLabel}]${ZOOM_ENHANCEMENT_FILTERS[preset].denoise}:enable='${timing}'[${nextLabel}]`,
        );
        beforeZoomLabel = nextLabel;
      });
      const hasSharpen = zooms.some(
        (segment) => (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) !== "OFF",
      );
      const zoomOutputLabel = hasSharpen ? `vzoom${index}` : `v${index}`;
      filters.push(
        `[${beforeZoomLabel}]zoompan=z='${zoom}':x='(iw-iw/zoom)*${centerX}':y='(ih-ih/zoom)*${centerY}':d=1:s=${width}x${height}:fps=30000/1001,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${zoomOutputLabel}]`,
      );
      let afterZoomLabel = zoomOutputLabel;
      const sharpened = zooms.filter(
        (segment) => (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) !== "OFF",
      );
      sharpened.forEach((segment, segmentIndex) => {
        const preset = (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) as Exclude<
          ZoomEnhancementPreset,
          "OFF"
        >;
        const nextLabel = segmentIndex === sharpened.length - 1 ? `v${index}` : `vsharpen${index}_${segmentIndex}`;
        const timing = `between(t,${ffmpegNumber(segment.localStartSeconds)},${ffmpegNumber(segment.localEndSeconds)})`;
        filters.push(`[${afterZoomLabel}]${ZOOM_ENHANCEMENT_FILTERS[preset].sharpen}:enable='${timing}'[${nextLabel}]`);
        afterZoomLabel = nextLabel;
      });
    }
    if (input.mainStartCard) {
      const card = input.mainStartCard;
      const scale = height / 1080;
      const line1Size = Math.max(18, Math.round(card.line1FontSize1080p * scale));
      const line2Size = Math.max(16, Math.round(card.line2FontSize1080p * scale));
      const lineGap = Math.max(25, Math.round(card.lineGap1080p * scale));
      const shadow = Math.max(2, Math.round(4 * scale));
      const fontPath = escapeFfmpegFilterPath(card.fontFilePath);
      const line1Path = escapeFfmpegFilterPath(card.line1TextFilePath);
      const line2Path = escapeFfmpegFilterPath(card.line2TextFilePath);
      filters.push(
        `[${baseVideoLabel}]tpad=stop_mode=clone:stop_duration=7,trim=duration=${ffmpegNumber(input.durationMs / 1000)},drawbox=x=0:y=0:w=iw:h=ih:color=black@${ffmpegNumber(card.overlayOpacityPercent / 100)}:t=fill,drawtext=fontfile='${fontPath}':textfile='${line1Path}':fontcolor=white:fontsize=${line1Size}:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(lineGap / 2)}:shadowcolor=black@0.85:shadowx=${shadow}:shadowy=${shadow},drawtext=fontfile='${fontPath}':textfile='${line2Path}':fontcolor=white:fontsize=${line2Size}:x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(lineGap / 2)}:shadowcolor=black@0.85:shadowx=${shadow}:shadowy=${shadow},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`,
      );
    }
    if (input.isImage && input.photoSoundEnabled && input.photoSoundInputIndex !== undefined) {
      filters.push(
        `[${input.photoSoundInputIndex}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.7,apad,atrim=duration=${ffmpegNumber(input.durationMs / 1000)},asetpts=PTS-STARTPTS[a${index}]`,
      );
    } else if (input.hasAudio) {
      const startMs = input.startMs ?? 0;
      const localSegments = (inputsAreNormalized ? [] : (input.volumeSegments ?? []))
        .map((segment) => ({
          start: Math.max(0, segment.startMs - startMs) / 1000,
          end: Math.min(input.durationMs, segment.endMs - startMs) / 1000,
          gain: segment.volumePercent / 100,
        }))
        .filter((segment) => segment.end > segment.start);
      const volumeExpression = localSegments.reduceRight(
        (fallback, segment) =>
          `if(between(t,${ffmpegNumber(segment.start)},${ffmpegNumber(segment.end)}),${ffmpegNumber(segment.gain)},${fallback})`,
        ffmpegNumber(inputsAreNormalized ? 1 : sourceAudioVolumePercent / 100),
      );
      const applyPerInputProtection = audioProtection.enabled && !inputsAreNormalized;
      const initialAudioLabel = applyPerInputProtection ? `abase${index}` : `a${index}`;
      filters.push(
        inputsAreNormalized
          ? `[${index}:a:0]apad,atrim=duration=${ffmpegNumber(input.durationMs / 1000)},asetpts=PTS-STARTPTS[${initialAudioLabel}]`
          : `[${index}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume='${volumeExpression}':eval=frame,apad,atrim=duration=${ffmpegNumber(input.durationMs / 1000)},asetpts=PTS-STARTPTS[${initialAudioLabel}]`,
      );
      if (applyPerInputProtection) {
        let protectedLabel = initialAudioLabel;
        if (audioProtection.autoDuckVoiceAndSuddenSounds) {
          const dryFloor = 10 ** (-audioProtection.maxDuckingDb / 20);
          const wetGain = 1 - dryFloor;
          const detectorThreshold = audioProtection.preserveDistantCrowdAmbience ? 0.09 : 0.055;
          const attackMs = audioProtection.preserveSceneMatchedSounds ? 45 : 15;
          const releaseMs = audioProtection.preserveSceneMatchedSounds ? 500 : 320;
          filters.push(`[${protectedLabel}]asplit=3[adry${index}][awet${index}][adet${index}]`);
          filters.push(`[adet${index}]highpass=f=1000,lowpass=f=4000[avoice${index}]`);
          filters.push(
            `[awet${index}][avoice${index}]sidechaincompress=threshold=${ffmpegNumber(detectorThreshold)}:ratio=12:attack=${attackMs}:release=${releaseMs}:makeup=1[aducked${index}]`,
          );
          filters.push(`[adry${index}]volume=${ffmpegNumber(dryFloor)}[afloor${index}]`);
          filters.push(`[aducked${index}]volume=${ffmpegNumber(wetGain)}[awetgain${index}]`);
          filters.push(
            `[afloor${index}][awetgain${index}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aprivacy${index}]`,
          );
          protectedLabel = `aprivacy${index}`;
        }
        if (audioProtection.eqEnabled) {
          filters.push(
            `[${protectedLabel}]equalizer=f=2500:t=q:w=0.8:g=-${ffmpegNumber(audioProtection.eqReductionDb)}[aeq${index}]`,
          );
          protectedLabel = `aeq${index}`;
        }
        filters.push(`[${protectedLabel}]anull[a${index}]`);
      }
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${ffmpegNumber(input.durationMs / 1000)},asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
  });

  let accumulatedSeconds = inputs[0].durationMs / 1000;
  let videoOutputLabel = "v0";
  let audioOutputLabel = "a0";
  for (let index = 1; index < inputs.length; index += 1) {
    const nextVideoLabel = `vx${index}`;
    const nextAudioLabel = `ax${index}`;
    const cardTransition =
      inputs[index].mainStartCard?.transitionStyle ?? inputs[index - 1].mainStartCard?.transitionStyle;
    if (cardTransition === "HARD_CUT") {
      filters.push(`[${videoOutputLabel}][v${index}]concat=n=2:v=1:a=0[${nextVideoLabel}]`);
      filters.push(`[${audioOutputLabel}][a${index}]concat=n=2:v=0:a=1[${nextAudioLabel}]`);
      accumulatedSeconds += inputs[index].durationMs / 1000;
    } else {
      const offset = accumulatedSeconds - transitionSeconds;
      const transitionName = cardTransition === "FADE_BLACK" ? "fadeblack" : "fade";
      filters.push(
        `[${videoOutputLabel}][v${index}]xfade=transition=${transitionName}:duration=${ffmpegNumber(transitionSeconds)}:offset=${ffmpegNumber(offset)}[${nextVideoLabel}]`,
      );
      filters.push(
        `[${audioOutputLabel}][a${index}]acrossfade=d=${ffmpegNumber(transitionSeconds)}:c1=tri:c2=tri[${nextAudioLabel}]`,
      );
      accumulatedSeconds += inputs[index].durationMs / 1000 - transitionSeconds;
    }
    videoOutputLabel = nextVideoLabel;
    audioOutputLabel = nextAudioLabel;
  }

  const expectedDurationMs = Math.round(accumulatedSeconds * 1000);
  const originalAudioLabel = audioOutputLabel;
  const bgmLabels: string[] = [];
  bgmInputs.forEach((track, bgmIndex) => {
    if (track.timelineInMs < 0 || track.timelineInMs >= expectedDurationMs)
      throw new Error(`配樂「${track.fileName}」的開始時間已超出目前影片總時間。`);
    const shutterInputCount = inputs.filter((input) => input.photoSoundInputIndex !== undefined).length;
    const inputIndex = inputs.length + shutterInputCount + bgmIndex;
    const effectiveTimelineOutMs = Math.min(track.timelineOutMs, expectedDurationMs);
    const durationSeconds = (effectiveTimelineOutMs - track.timelineInMs) / 1000;
    const sourceSpanMs = Math.max(1, track.sourceSpanMs ?? track.sourceOutMs - track.sourceInMs);
    const source = buildBgmSourceChain(inputIndex, bgmIndex, track, durationSeconds, sourceSpanMs);
    filters.push(...source.filters);
    const chain = [
      `[${source.outputLabel}]volume=${ffmpegNumber(track.volumePercent / 100)}`,
    ];
    if (track.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${ffmpegNumber(track.fadeInMs / 1000)}`);
    if (track.fadeOutMs > 0) {
      const effectiveFadeOut = Math.min(track.fadeOutMs / 1000, durationSeconds);
      chain.push(
        `afade=t=out:st=${ffmpegNumber(Math.max(0, durationSeconds - effectiveFadeOut))}:d=${ffmpegNumber(effectiveFadeOut)}`,
      );
    }
    chain.push(
      `adelay=${Math.round(track.timelineInMs)}:all=1`,
      "apad",
      `atrim=duration=${ffmpegNumber(expectedDurationMs / 1000)}[bgm${bgmIndex}]`,
    );
    filters.push(chain.join(","));
    bgmLabels.push(`bgm${bgmIndex}`);
  });
  const sfxLabels: string[] = [];
  const timedSfxInputs = options.timedSfxInputs ?? [];
  const shutterInputCount = inputs.filter((input) => input.photoSoundInputIndex !== undefined).length;
  timedSfxInputs.forEach((event, eventIndex) => {
    if (event.timelineStartMs < 0 || event.timelineStartMs >= expectedDurationMs) return;
    const inputIndex = inputs.length + shutterInputCount + bgmInputs.length + eventIndex;
    const label = `sfx${eventIndex}`;
    filters.push(
      `[${inputIndex}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=${ffmpegNumber(event.volumePercent / 100)},adelay=${Math.round(event.timelineStartMs)}:all=1,apad,atrim=duration=${ffmpegNumber(expectedDurationMs / 1000)}[${label}]`,
    );
    sfxLabels.push(label);
  });
  // Master bus stays transparent: it only catches true peaks just under the
  // ceiling instead of riding the program. A lower threshold here would erase
  // the contrast created by the per-clip ducking above.
  const finalDynamics = options.skipFinalDynamics
    ? "anull"
    : audioProtection.enabled
      ? `acompressor=threshold=0.891251:ratio=2:attack=15:release=300:makeup=1,alimiter=limit=${ffmpegNumber(10 ** (audioProtection.peakCeilingDb / 20))}:attack=5:release=100`
      : "alimiter=limit=0.95";
  const overlayLabels = [...bgmLabels, ...sfxLabels];
  if (overlayLabels.length) {
    filters.push(
      `[${originalAudioLabel}]${overlayLabels.map((label) => `[${label}]`).join("")}amix=inputs=${overlayLabels.length + 1}:duration=first:dropout_transition=0:normalize=0,${finalDynamics}[aout]`,
    );
    audioOutputLabel = "aout";
  } else {
    filters.push(`[${originalAudioLabel}]${finalDynamics}[aout]`);
    audioOutputLabel = "aout";
  }

  return {
    filterGraph: filters.join(";"),
    videoOutputLabel,
    audioOutputLabel,
    expectedDurationMs,
    width,
    height,
  };
}

function parseProgressTime(line: string): number | undefined {
  const [key, rawValue] = line.trim().split("=", 2);
  if ((key === "out_time_us" || key === "out_time_ms") && /^\d+$/.test(rawValue ?? "")) {
    return Math.max(0, Math.round(Number(rawValue) / 1000));
  }
  if (key !== "out_time") return undefined;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(rawValue ?? "");
  if (!match) return undefined;
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
}

export type FfmpegProgressRunner = (
  executable: string,
  args: string[],
  expectedDurationMs: number,
  signal: AbortSignal | undefined,
  onProgress: (progress: ConcatRenderProgress) => void,
  context?: FfmpegRunContext,
) => Promise<void | { cancelled: boolean; outTimeMs: number }>;

export interface FfmpegRunContext {
  outputPath: string;
  workingPaths?: string[];
  currentSegment?: string;
  segmentIndex?: number;
  segmentCount?: number;
  onProcessStarted?(pid: number): void;
  onProcessFinished?(pid: number): void;
  getActiveProcessIds?(): number[];
  encoderName?: string;
  decoderName?: string;
  onResourceSnapshot?(snapshot: Awaited<ReturnType<typeof captureSystemResources>>): void | Promise<void>;
}

export function runFfmpegWithProgress(
  executable: string,
  args: string[],
  expectedDurationMs: number,
  signal: AbortSignal | undefined,
  onProgress: (progress: ConcatRenderProgress) => void,
  context?: FfmpegRunContext,
): Promise<{ cancelled: boolean; outTimeMs: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("串連預覽已取消。", "AbortError"));
      return;
    }

    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let outTimeMs = 0;
    let cancellationRequested = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let resourceTimer: ReturnType<typeof setInterval> | undefined;
    let resourceSamplePromise: Promise<void> = Promise.resolve();
    let latestResources: Awaited<ReturnType<typeof captureSystemResources>> | undefined;
    let resourceSampleActive = false;
    let latestFps: number | undefined;
    let latestSpeed: number | undefined;
    let smoothedSpeed: number | undefined;
    let resourceStopError: Error | undefined;
    const progressStartedAt = Date.now();

    if (child.pid) context?.onProcessStarted?.(child.pid);

    const sampleResources = async () => {
      if (resourceSampleActive || !child.pid || !context) return;
      resourceSampleActive = true;
      try {
        latestResources = await captureSystemResources(context.outputPath, {
          ffmpegPids: context.getActiveProcessIds?.() ?? [child.pid],
          currentJobs: context.getActiveProcessIds?.().length ?? 1,
          ffmpegFps: latestFps,
          ffmpegSpeed: latestSpeed,
          encoderName: context.encoderName,
          decoderName: context.decoderName,
          workingPaths: context.workingPaths,
          tempPath: context.workingPaths?.[0],
        });
        await context.onResourceSnapshot?.(latestResources);
      } catch (error) {
        if (error instanceof DiskSpacePauseError && !resourceStopError) {
          resourceStopError = error;
          cancellationRequested = true;
          try {
            child.stdin.write("q\n");
            child.stdin.end();
          } catch {
            child.kill();
          }
          forceKillTimer = setTimeout(() => child.kill(), 8_000);
        }
        // Ordinary telemetry failures are diagnostic only. A deliberate
        // DiskSpacePauseError requests a graceful FFmpeg stop before ENOSPC.
      } finally {
        resourceSampleActive = false;
      }
    };
    if (context) {
      resourceSamplePromise = sampleResources();
      resourceTimer = setInterval(() => {
        if (!resourceSampleActive) resourceSamplePromise = sampleResources();
      }, 15_000);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseProgressTime(line);
        if (parsed !== undefined) outTimeMs = Math.max(outTimeMs, parsed);
        if (line.startsWith("fps=")) {
          const value = Number(line.slice(4));
          if (Number.isFinite(value)) latestFps = value;
        }
        if (line.startsWith("speed=")) {
          const value = Number(line.slice(6).replace(/x$/i, ""));
          if (Number.isFinite(value) && value > 0) {
            latestSpeed = value;
            // Startup probes, decoder warm-up and first filter buffers make the
            // early speed value noisy. Recalibrate ETA only after 30 seconds,
            // then use an EMA so a single complex transition cannot make it jump.
            if (Date.now() - progressStartedAt >= 30_000)
              smoothedSpeed = smoothedSpeed === undefined ? value : smoothedSpeed * 0.75 + value * 0.25;
          }
        }
        if (line.startsWith("progress=")) {
          onProgress({
            phase: "RENDERING",
            percent: Math.min(99, Math.max(0, (outTimeMs / expectedDurationMs) * 100)),
            outTimeMs,
            expectedDurationMs,
            ...(context?.currentSegment ? { currentSegment: context.currentSegment } : {}),
            ...(context?.segmentIndex ? { segmentIndex: context.segmentIndex } : {}),
            ...(context?.segmentCount ? { segmentCount: context.segmentCount } : {}),
            estimatedRemainingMs: Math.max(0, (expectedDurationMs - outTimeMs) / Math.max(0.01, smoothedSpeed ?? 1)),
            ...(latestResources ? { resourceUsage: latestResources } : {}),
          });
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-24_000);
    });

    const onAbort = () => {
      cancellationRequested = true;
      try {
        child.stdin.write("q\n");
        child.stdin.end();
      } catch {
        child.kill();
      }
      forceKillTimer = setTimeout(() => child.kill(), 8_000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", async (error) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (resourceTimer) clearInterval(resourceTimer);
      signal?.removeEventListener("abort", onAbort);
      await resourceSamplePromise.catch(() => undefined);
      if (child.pid) context?.onProcessFinished?.(child.pid);
      reject(error);
    });
    child.once("exit", async (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (resourceTimer) clearInterval(resourceTimer);
      signal?.removeEventListener("abort", onAbort);
      // Do not publish/discard a completed checkpoint while a final telemetry
      // callback can still save a stale PENDING snapshot behind it.
      await resourceSamplePromise.catch(() => undefined);
      if (child.pid) context?.onProcessFinished?.(child.pid);
      if (resourceStopError) {
        reject(resourceStopError);
      } else if (cancellationRequested || signal?.aborted) {
        resolve({ cancelled: true, outTimeMs });
      } else if (code === 0) {
        resolve({ cancelled: false, outTimeMs: expectedDurationMs });
      } else {
        const detail = stderr.trim().split(/\r?\n/).slice(-6).join(" ");
        reject(new Error(`FFmpeg 串連失敗${detail ? `：${detail}` : "。"}`));
      }
    });
  });
}

export function buildVideoCodecArgs(videoCodec: RenderVideoCodec): string[] {
  if (videoCodec === "H264_NVENC")
    return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-profile:v", "high"];
  if (videoCodec === "H265_NVENC")
    return ["-c:v", "hevc_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "25", "-b:v", "0", "-tag:v", "hvc1"];
  if (videoCodec === "H265_QSV")
    return ["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", "27", "-tag:v", "hvc1"];
  if (videoCodec === "H264_QSV")
    return ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "25", "-profile:v", "high"];
  if (videoCodec === "H265") return ["-c:v", "libx265", "-preset", "veryfast", "-crf", "27", "-tag:v", "hvc1"];
  if (videoCodec === "H264") return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-profile:v", "high"];
  throw new Error("影片編碼格式無效。只支援 NVIDIA NVENC、Intel QSV 或 CPU H.265／H.264。");
}

export function buildIntermediateVideoCodecArgs(
  videoCodec: RenderVideoCodec,
  resolution: PreviewResolution = "1080P",
  resourceProfile: RenderResourceProfile = "BALANCED",
): string[] {
  const rate = intermediateBitrateArgs(resolution, resourceProfile);
  if (videoCodec === "H264_NVENC" || videoCodec === "H265_NVENC")
    return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "20", "-b:v", rate.bitrate, "-maxrate", rate.maxrate, "-bufsize", rate.bufsize, "-profile:v", "high"];
  if (videoCodec === "H265_QSV" || videoCodec === "H264_QSV")
    return ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "20", "-b:v", rate.bitrate, "-maxrate", rate.maxrate, "-bufsize", rate.bufsize, "-profile:v", "high"];
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-maxrate", rate.maxrate, "-bufsize", rate.bufsize, "-profile:v", "high"];
}

function encoderName(videoCodec: RenderVideoCodec, intermediate = false): string {
  if (intermediate) {
    if (videoCodec.endsWith("_NVENC")) return "h264_nvenc";
    return videoCodec.endsWith("_QSV") ? "h264_qsv" : "libx264";
  }
  if (videoCodec === "H264_NVENC") return "h264_nvenc";
  if (videoCodec === "H265_NVENC") return "hevc_nvenc";
  if (videoCodec === "H265_QSV") return "hevc_qsv";
  if (videoCodec === "H264_QSV") return "h264_qsv";
  return videoCodec === "H265" ? "libx265" : "libx264";
}

function qsvDecodeEligible(input: ConcatInput): boolean {
  if (input.isImage) return false;
  const codec = (input.sourceVideoCodec ?? "").toLowerCase();
  return codec.includes("h264") || codec.includes("avc") || codec.includes("hevc") || codec.includes("h265");
}

export function hardwareDecodeIndexes(inputs: ConcatInput[], enabled: boolean, outputPortrait = false): Set<number> {
  return new Set(
    enabled
      ? inputs
          .map((input, index) => {
            if (!qsvDecodeEligible(input)) return -1;
            const needsExplicitRotation = Boolean(orientationNormalizationFilter(input.orientationRotationDegrees));
            const usesBlurredFill = usesBlurredCanvas(
              Boolean(input.isPortrait),
              outputPortrait ? "PORTRAIT_9_16" : "LANDSCAPE_16_9",
            );
            // On this Intel HD 530/QSV path, a rotated 4K NV12 surface can
            // complete without an FFmpeg error yet carry corrupt chroma into
            // the blurred-fill branch. Decode only this risky combination on
            // CPU; hardware encode remains enabled for the stage.
            return needsExplicitRotation && usesBlurredFill ? -1 : index;
          })
          .filter((index) => index >= 0)
      : [],
  );
}

function hardwareDecodeBackendFor(videoCodec: RenderVideoCodec): HardwareDecodeBackend | undefined {
  if (videoCodec.endsWith("_NVENC")) return "CUDA";
  if (videoCodec.endsWith("_QSV")) return "QSV";
  return undefined;
}

function decoderName(indexes: ReadonlySet<number>, backend?: HardwareDecodeBackend): string {
  if (!indexes.size || !backend) return "CPU software decode";
  return backend === "CUDA" ? "NVIDIA CUDA/NVDEC（失敗自動回退 CPU）" : "Intel QSV（失敗自動回退 CPU）";
}

function isHardwareDecodeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /qsv|mfx|cuda|nvdec|cuvid|hwaccel|hwdownload|hardware device|device creation|unsupported.*device/i.test(
    message,
  );
}

function withLocalPhotoSoundIndexes(inputs: ConcatInput[]): ConcatInput[] {
  let nextInputIndex = inputs.length;
  return inputs.map((input) => ({
    ...input,
    photoSoundInputIndex: input.photoSoundEnabled ? nextInputIndex++ : undefined,
  }));
}

function buildInputArguments(
  inputs: ConcatInput[],
  photoSoundPath: string | undefined,
  bgmInputs: BgmRenderInput[],
  timedSfxInputs: InsertionSfxEvent[] = [],
  hardwareDecodeIndexes: ReadonlySet<number> = new Set(),
  hardwareDecodeBackend: HardwareDecodeBackend = "QSV",
) {
  return [
    ...inputs.flatMap((input, inputIndex) =>
      input.isImage
        ? [
            "-loop",
            "1",
            "-framerate",
            "30000/1001",
            "-t",
            ffmpegNumber(input.durationMs / 1000),
            "-i",
            input.sourcePath,
          ]
        : [
            ...(hardwareDecodeIndexes.has(inputIndex)
              ? [
                  "-hwaccel",
                  hardwareDecodeBackend === "CUDA" ? "cuda" : "qsv",
                  "-hwaccel_output_format",
                  hardwareDecodeBackend === "CUDA" ? "cuda" : "qsv",
                ]
              : []),
            "-ss",
            ffmpegNumber((input.startMs ?? 0) / 1000),
            "-t",
            ffmpegNumber(Math.min(input.durationMs, input.mainStartCard?.sourceDurationMs ?? input.durationMs) / 1000),
            "-noautorotate",
            "-i",
            input.sourcePath,
          ],
    ),
    ...inputs.filter((input) => input.photoSoundEnabled).flatMap(() => ["-i", photoSoundPath!]),
    ...bgmInputs.flatMap((track) => ["-i", track.sourcePath]),
    ...timedSfxInputs.flatMap(() => ["-i", photoSoundPath!]),
  ];
}

function checkpointKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function renderRequestSignature(projectId: string, projectUpdatedAt: string, request: ConcatRenderRequest): string {
  const {
    outputToken: _outputToken,
    resourceWarningAcknowledged: _ack,
    resumeCheckpointId: _resume,
    ...stable
  } = request;
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId,
        projectUpdatedAt,
        orientationNormalizerVersion: ORIENTATION_NORMALIZER_VERSION,
        request: stable,
      }),
    )
    .digest("hex")
    .toUpperCase();
}

function projectWithoutInsertionAudio(project: ProjectManifest): unknown {
  const { updatedAt: _updatedAt, ...stable } = structuredClone(project);
  stable.mediaInsertions = stable.mediaInsertions.map(({ insertionAudio: _audio, ...item }) => item);
  stable.introSegments = stable.introSegments.map(({ insertionAudio: _audio, ...item }) => item);
  stable.sources = stable.sources.map(({ mainAudioGates: _gates, photoSoundEnabled: _sfx, dubWithBgm: _dub, ...asset }) => asset);
  stable.bgmTracks = [];
  stable.mainStartCue = { enabled: false, durationMs: 0 };
  return stable;
}

/** Stable signature for picture plus timeline-correct source audio. All post-mix gates/BGM/SFX/final DSP are excluded. */
export function pictureBaseRenderSignature(project: ProjectManifest, request: ConcatRenderRequest): string {
  const {
    outputToken: _outputToken,
    resourceWarningAcknowledged: _ack,
    resumeCheckpointId: _resume,
    audioProcessing: _audioProcessing,
    includeBgm: _includeBgm,
    bgmScopes: _bgmScopes,
    ...stableRequest
  } = request;
  return createHash("sha256")
    .update(JSON.stringify({
      project: projectWithoutInsertionAudio(project),
      request: stableRequest,
      orientationNormalizerVersion: ORIENTATION_NORMALIZER_VERSION,
      baseMasterVersion: "timeline-base-master-v1",
    }))
    .digest("hex")
    .toUpperCase();
}

export function finalInsertionAudioSignature(
  pictureSignature: string,
  plan: InsertionAudioPlan,
  request: ConcatRenderRequest,
  postBgmTracks: readonly BgmRenderInput[] = [],
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      pictureSignature,
      plan,
      postBgmTracks,
      audioProcessing: sanitizeAudioProcessingOptions(request.audioProcessing),
      audioProtection: validateAudioProtectionOptions(request.audioProtection),
      postVersion: "canonical-track-gates-post-v2",
    }))
    .digest("hex")
    .toUpperCase();
}

function waitWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("轉檔已取消。", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("轉檔已取消。", "AbortError"));
      },
      { once: true },
    );
  });
}

function memoryFailureMessage(error: unknown, completedSegments: number): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (!/cannot allocate memory|error code:\s*-12|return code\s*-12/i.test(raw))
    return error instanceof Error ? error : new Error(raw);
  return new Error(
    [
      "轉檔因記憶體配置失敗而中止。這不是單憑 C 槽剩餘空間即可判斷的錯誤。",
      "可能原因：Windows RAM＋Pagefile 的 Commit 額度不足、同時解碼／濾鏡處理過多高解析影格，或 FFmpeg filter graph buffer 過大。",
      "建議：關閉瀏覽器或其他大型 App、確認 Windows 虛擬記憶體已啟用、改用低記憶體模式，或以更小分段重試。",
      completedSegments > 0
        ? `已保留並驗證 ${completedSegments} 個完成片段；下次可從 checkpoint 繼續，不必全部重轉。`
        : "這次尚無可重用的完成片段；App 仍保留診斷紀錄供下次調整策略。",
      `FFmpeg 摘要：${raw}`,
    ].join("\n"),
  );
}

function runtimePolicyFor(request: ConcatRenderRequest, visualInputCount: number): RenderRuntimePolicy {
  const fallbackLimit = request.lowMemorySegmented === true ? LOW_MEMORY_MAX_FILTER_INPUTS : 16;
  const policy = request.runtimePolicy;
  return {
    mode: request.lowMemorySegmented === true ? "LOW_MEMORY" : request.highSpeedMode === true ? "HIGH_SPEED" : "NORMAL",
    resourceProfile: resourceProfileFromLegacy(request),
    maxVisualInputsPerStage: Math.max(
      3,
      Math.min(16, Math.floor(policy?.maxVisualInputsPerStage ?? Math.min(fallbackLimit, visualInputCount))),
    ),
    initialParallelJobs: Math.max(1, Math.min(4, Math.floor(policy?.initialParallelJobs ?? 1))),
    maximumParallelJobs: Math.max(1, Math.min(4, Math.floor(policy?.maximumParallelJobs ?? 1))),
    filterComplexThreads: Math.max(
      1,
      Math.min(4, Math.floor(policy?.filterComplexThreads ?? (request.lowMemorySegmented ? 2 : 4))),
    ),
    encoderThreads: Math.max(
      1,
      Math.min(8, Math.floor(policy?.encoderThreads ?? (request.lowMemorySegmented ? 2 : 4))),
    ),
    systemSafetyReserveBytes: Math.max(4 * 1024 ** 3, policy?.systemSafetyReserveBytes ?? 4 * 1024 ** 3),
    renderRamBudgetBytes: Math.max(1024 ** 3, policy?.renderRamBudgetBytes ?? 4 * 1024 ** 3),
    pauseNewStageBelowAvailableBytes: Math.max(1024 ** 3, policy?.pauseNewStageBelowAvailableBytes ?? 2 * 1024 ** 3),
    ...(policy?.estimatedRamPerJobBytes ? { estimatedRamPerJobBytes: policy.estimatedRamPerJobBytes } : {}),
    ...(policy?.estimatedWorkingBytesPerJob ? { estimatedWorkingBytesPerJob: policy.estimatedWorkingBytesPerJob } : {}),
    ...(policy?.minimumCommitHeadroomBytes ? { minimumCommitHeadroomBytes: policy.minimumCommitHeadroomBytes } : {}),
    ...(policy?.minimumOutputFreeBytes ? { minimumOutputFreeBytes: policy.minimumOutputFreeBytes } : {}),
    ...(policy?.maximumRenderTempBytes ? { maximumRenderTempBytes: policy.maximumRenderTempBytes } : {}),
  };
}

export class ConcatRenderService {
  private readonly checkpoints: RenderCheckpointStore;

  constructor(
    private readonly store: ProjectStore,
    private readonly sources: SourceService,
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly ffmpegRunner: FfmpegProgressRunner = runFfmpegWithProgress,
    private readonly photoSoundPath?: string,
    private readonly subtitleTranslation?: SubtitleTranslationService,
    private readonly subtitleCacheRoot?: string,
    private readonly silenceDetector: SilenceDetector = new ClipSilenceDetector(ffmpegExecutable),
    checkpointStore?: RenderCheckpointStore,
    private readonly hardwareService?: RenderHardwareService,
    private readonly renderCommands?: RenderCommandState,
  ) {
    this.checkpoints = checkpointStore ?? new RenderCheckpointStore(store.getRenderStateRoot());
  }

  getResumeOffer() {
    return this.checkpoints.offer(this.store.getProject().id);
  }

  discardResume(checkpointId: string) {
    return this.checkpoints.discard(this.store.getProject().id, checkpointId);
  }

  discardReusableVideoMaster() {
    return this.checkpoints.discardVideoBaseMaster(this.store.getProject().id);
  }

  async resume(
    checkpointId: string,
    signal: AbortSignal | undefined,
    onProgress: (progress: ConcatRenderProgress) => void,
  ): Promise<ConcatRenderResult> {
    const project = this.store.getProject();
    let checkpoint = await this.checkpoints.load(project.id);
    if (
      checkpoint &&
      checkpoint.checkpointId === checkpointId &&
      checkpoint.checkpointProducer !== "v0.80" &&
      !checkpoint.recoveryMigration &&
      checkpoint.concatStatus === "PAUSED_DISK_SPACE"
    ) {
      checkpoint = await this.checkpoints.importV079RecoveryCopy(project.id, checkpointId);
    }
    if (
      !checkpoint ||
      (checkpoint.checkpointId !== checkpointId && checkpoint.recoveryMigration?.sourceCheckpointId !== checkpointId)
    )
      throw new Error("找不到可續轉的工作，可能已完成或被捨棄。");
    return this.render(
      {
        ...structuredClone(checkpoint.request),
        outputToken: "resume-checkpoint",
        resumeCheckpointId: checkpoint.checkpointId,
        resourceWarningAcknowledged: true,
      },
      checkpoint.outputPath,
      signal,
      onProgress,
    );
  }

  private async buildResumableIntermediates(
    originalInputs: ConcatInput[],
    transitionSeconds: TransitionDurationSec,
    resolution: PreviewResolution,
    videoCodec: RenderVideoCodec,
    portrait: boolean,
    sourceAudioVolumePercent: number,
    audioProtection: AudioProtectionOptions,
    checkpoint: RenderCheckpointRecord,
    maximumInputs: number,
    filterComplexThreads: number,
    encoderThreads: number,
    diskMonitor: RenderDiskMonitor,
    activeFfmpegPids: Set<number>,
    onFfmpegStarted: () => void,
    overallExpectedDurationMs: number,
    signal: AbortSignal | undefined,
    onProgress: (progress: ConcatRenderProgress) => void,
  ): Promise<{ inputs: ConcatInput[]; stageCount: number; resumedSegmentCount: number }> {
    await mkdir(checkpoint.workRoot, { recursive: true });
    let current = originalInputs;
    let level = 0;
    let completedJobs = 0;
    let resumedSegmentCount = 0;
    let simulatedCount = originalInputs.length;
    let totalJobs = 0;
    while (simulatedCount > maximumInputs) {
      simulatedCount = Math.ceil(simulatedCount / maximumInputs);
      totalJobs += simulatedCount;
    }
    checkpoint.totalSegmentCount = totalJobs;
    await this.checkpoints.save(checkpoint);
    // Resume from the deepest fully materialized level. Earlier levels may have
    // been dependency-collected after their validated replacements were saved.
    const expectedByLevel: number[] = [];
    let expectedCount = originalInputs.length;
    while (expectedCount > maximumInputs) {
      expectedCount = Math.ceil(expectedCount / maximumInputs);
      expectedByLevel.push(expectedCount);
    }
    for (let candidateLevel = expectedByLevel.length; candidateLevel >= 1; candidateLevel -= 1) {
      const candidates = checkpoint.segments
        .filter((segment) => segment.level === candidateLevel && segment.status === "COMPLETED")
        .sort((left, right) => left.index - right.index);
      if (candidates.length !== expectedByLevel[candidateLevel - 1]) continue;
      const validity = await Promise.all(candidates.map((segment) => this.checkpoints.validateSegment(segment)));
      if (!validity.every(Boolean)) continue;
      current = candidates.map((segment) => ({
        sourcePath: segment.outputPath,
        sourceVideoCodec: "h264",
        durationMs: segment.durationMs,
        hasAudio: true,
        checkpointKey: segment.id,
      }));
      level = candidateLevel;
      resumedSegmentCount = candidates.length;
      completedJobs = checkpoint.segments.filter(
        (segment) => segment.level <= candidateLevel && (segment.status === "COMPLETED" || segment.status === "RELEASED"),
      ).length;
      break;
    }
    const runtimePolicy = runtimePolicyFor(checkpoint.request, originalInputs.length);
    let adaptiveState: AdaptiveConcurrencyState = {
      currentJobs: Math.min(runtimePolicy.initialParallelJobs, runtimePolicy.maximumParallelJobs),
    };
    let lastDiskSnapshotAt = 0;
    let requestedDiskPause: DiskSpacePauseError | undefined;
    let wavePeakResources: Awaited<ReturnType<typeof captureSystemResources>> | undefined;

    while (current.length > maximumInputs) {
      const groups = groupLowMemoryInputs(current, maximumInputs);
      const next = new Array<ConcatInput>(groups.length);
      const renderGroup = async (groupIndex: number) => {
        if (signal?.aborted) throw new DOMException("分段轉檔已取消。", "AbortError");
        const stageInputs = withLocalPhotoSoundIndexes(groups[groupIndex]);
        const decodeBackend = hardwareDecodeBackendFor(videoCodec);
        let qsvIndexes = hardwareDecodeIndexes(
          stageInputs,
          Boolean(decodeBackend),
          portrait,
        );
        const stagePlanFor = (decodeIndexes: ReadonlySet<number>) =>
          buildConcatFilterGraph(
            stageInputs,
            transitionSeconds,
            resolution,
            [],
            sourceAudioVolumePercent,
            portrait,
            audioProtection,
            {
              inputsAreNormalized: level > 0,
              skipFinalDynamics: true,
              hardwareDecodedInputIndexes: decodeIndexes,
            },
          );
        let stagePlan = stagePlanFor(qsvIndexes);
        const stem = `level-${level + 1}-part-${String(groupIndex + 1).padStart(3, "0")}`;
        const segmentId = checkpointKey({
          segmentPipelineVersion: 2,
          level,
          inputs: stageInputs.map((input) => input.checkpointKey),
          transitionSeconds,
          resolution,
          portrait,
        });
        const stageOutputPath = path.join(checkpoint.workRoot, `${stem}-${segmentId}.mkv`);
        const partialStagePath = path.join(checkpoint.workRoot, `.${stem}-${segmentId}.partial.mkv`);
        const filterScriptPath = path.join(checkpoint.workRoot, `.${stem}-${segmentId}.filtergraph.txt`);
        let preserveStagePartial = false;
        let segment = checkpoint.segments.find((item) => item.id === segmentId);
        if (segment?.status === "COMPLETED" && (await this.checkpoints.validateSegment(segment))) {
          next[groupIndex] = {
            // A v0.80 recovery checkpoint may reference a verified segment in
            // the read-only v0.79 work root. Reuse that exact path; deriving a
            // new work-root path would silently point at a file that does not
            // exist and would discard 20+ hours of reusable work.
            sourcePath: segment.outputPath,
            sourceVideoCodec: "h264",
            durationMs: stagePlan.expectedDurationMs,
            hasAudio: true,
            checkpointKey: segmentId,
          };
          completedJobs += 1;
          resumedSegmentCount += 1;
          onProgress({
            phase: "RENDERING",
            percent: totalJobs ? Math.min(70, (completedJobs / totalJobs) * 70) : 0,
            outTimeMs: Math.round((completedJobs / Math.max(1, totalJobs)) * overallExpectedDurationMs),
            expectedDurationMs: overallExpectedDurationMs,
            currentSegment: `沿用已完成片段 ${completedJobs}/${totalJobs}`,
            segmentIndex: completedJobs,
            segmentCount: totalJobs,
          });
          return stagePlan.expectedDurationMs;
        }
        if (!segment) {
          segment = {
            id: segmentId,
            level: level + 1,
            index: groupIndex + 1,
            status: "PENDING",
            outputPath: stageOutputPath,
            durationMs: stagePlan.expectedDurationMs,
            renderProfile: checkpoint.mode,
            codec: videoCodec.endsWith("_NVENC") ? "H264_NVENC" : videoCodec.endsWith("_QSV") ? "H264_QSV" : "H264",
            resolution,
            fps: "30000/1001",
            pixelFormat: "yuv420p",
            audioFormat: "AAC 48 kHz stereo 192 kbps",
          };
          checkpoint.segments.push(segment);
        } else {
          segment.status = "PENDING";
          segment.lastError = undefined;
          segment.outputPath = stageOutputPath;
          segment.durationMs = stagePlan.expectedDurationMs;
        }
        await this.checkpoints.save(checkpoint);
        await rm(partialStagePath, { force: true });
        await rm(filterScriptPath, { force: true });
        await writeFile(filterScriptPath, stagePlan.filterGraph, { encoding: "utf8", flag: "wx" });
        try {
          const runStage = async () =>
            this.ffmpegRunner(
              this.ffmpegExecutable,
              [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                ...buildInputArguments(stageInputs, this.photoSoundPath, [], [], qsvIndexes, decodeBackend),
                "-filter_complex_threads",
                String(filterComplexThreads),
                "-/filter_complex",
                filterScriptPath,
                "-map",
                `[${stagePlan.videoOutputLabel}]`,
                "-map",
                `[${stagePlan.audioOutputLabel}]`,
                ...buildIntermediateVideoCodecArgs(videoCodec, resolution, runtimePolicy.resourceProfile ?? "BALANCED"),
                "-threads",
                String(encoderThreads),
                "-pix_fmt",
                "yuv420p",
                "-r",
                "30000/1001",
                "-map_metadata",
                "-1",
                "-metadata:s:v:0",
                "rotate=0",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-shortest",
                "-progress",
                "pipe:1",
                "-nostats",
                partialStagePath,
              ],
              stagePlan.expectedDurationMs,
              signal,
              (progress) => {
                const percent = totalJobs
                  ? Math.min(70, ((completedJobs + progress.percent / 100) / totalJobs) * 70)
                  : 0;
                onProgress({
                  phase: "RENDERING",
                  percent,
                  outTimeMs: Math.round((percent / 100) * overallExpectedDurationMs),
                  expectedDurationMs: overallExpectedDurationMs,
                  currentSegment: `正在建立片段 ${groupIndex + 1}/${groups.length}（同時 ${activeFfmpegPids.size || 1} 個工作）`,
                  segmentIndex: completedJobs + 1,
                  segmentCount: totalJobs,
                  ...(progress.resourceUsage ? { resourceUsage: progress.resourceUsage } : {}),
                  ...(progress.resourceUsage?.diskUsage ? { diskStatus: progress.resourceUsage.diskUsage } : {}),
                });
              },
              {
                outputPath: checkpoint.outputPath,
                workingPaths: [checkpoint.workRoot, partialStagePath],
                currentSegment: `片段 ${completedJobs + 1}/${totalJobs}`,
                segmentIndex: completedJobs + 1,
                segmentCount: totalJobs,
                onProcessStarted: (pid) => {
                  onFfmpegStarted();
                  activeFfmpegPids.add(pid);
                },
                onProcessFinished: (pid) => activeFfmpegPids.delete(pid),
                getActiveProcessIds: () => [...activeFfmpegPids],
                encoderName: encoderName(videoCodec, true),
                decoderName: decoderName(qsvIndexes, decodeBackend),
                onResourceSnapshot: async (snapshot) => {
                  checkpoint.latestResources = snapshot;
                  wavePeakResources = {
                    ...(wavePeakResources ?? snapshot),
                    ...snapshot,
                    cpuUsagePercent: Math.max(wavePeakResources?.cpuUsagePercent ?? 0, snapshot.cpuUsagePercent ?? 0),
                    gpuUsagePercent: Math.max(wavePeakResources?.gpuUsagePercent ?? 0, snapshot.gpuUsagePercent ?? 0),
                    gpuEncodeUsagePercent: Math.max(
                      wavePeakResources?.gpuEncodeUsagePercent ?? 0,
                      snapshot.gpuEncodeUsagePercent ?? 0,
                    ),
                    gpuDecodeUsagePercent: Math.max(
                      wavePeakResources?.gpuDecodeUsagePercent ?? 0,
                      snapshot.gpuDecodeUsagePercent ?? 0,
                    ),
                    gpuComputeUsagePercent: Math.max(
                      wavePeakResources?.gpuComputeUsagePercent ?? 0,
                      snapshot.gpuComputeUsagePercent ?? 0,
                    ),
                    ffmpegPrivateBytes: Math.max(
                      wavePeakResources?.ffmpegPrivateBytes ?? 0,
                      snapshot.ffmpegPrivateBytes ?? 0,
                    ),
                  };
                  if (snapshot.currentJobs && snapshot.ffmpegPrivateBytes) {
                    adaptiveState.observedPeakPerJobBytes = Math.max(
                      adaptiveState.observedPeakPerJobBytes ?? 0,
                      snapshot.ffmpegPrivateBytes / snapshot.currentJobs,
                    );
                  }
                  await this.checkpoints.appendDiagnostic(checkpoint, {
                    event: "RUNTIME_RESOURCE",
                    segmentId,
                    resources: snapshot,
                  });
                  if (Date.now() - lastDiskSnapshotAt >= 30_000) {
                    lastDiskSnapshotAt = Date.now();
                    const disk = await diskMonitor.snapshot("SEGMENT_RUNNING", segmentId);
                    snapshot.diskUsage = disk;
                    checkpoint.diskState = {
                      status: "RUNNING",
                      lastSnapshot: disk,
                      requiredAdditionalBytes: disk.requiredAdditionalBytes,
                      completedSegmentCount: checkpoint.segments.filter((item) => item.status === "COMPLETED").length,
                      resumable: true,
                    };
                    await this.checkpoints.save(checkpoint);
                    if (disk.pressureLevel === "EMERGENCY") {
                      requestedDiskPause = new DiskSpacePauseError(
                        `磁碟空間接近安全下限；目前工作完成後將安全暫停。請至少再釋放 ${(disk.requiredAdditionalBytes / 1024 ** 3).toFixed(1)} GB。`,
                        disk,
                      );
                    }
                  }
                },
              },
            );
          let runResult: void | { cancelled: boolean; outTimeMs: number };
          try {
            runResult = await runStage();
          } catch (error) {
            if (!qsvIndexes.size || !isHardwareDecodeFailure(error)) throw error;
            await this.checkpoints.appendDiagnostic(checkpoint, {
              event: "HARDWARE_DECODE_FALLBACK",
              segmentId,
              decoder: decodeBackend === "CUDA" ? "NVIDIA CUDA/NVDEC" : "Intel QSV",
              fallback: "CPU software decode",
              error: error instanceof Error ? error.message : String(error),
            });
            qsvIndexes = new Set();
            stagePlan = stagePlanFor(qsvIndexes);
            await rm(partialStagePath, { force: true });
            await rm(filterScriptPath, { force: true });
            await writeFile(filterScriptPath, stagePlan.filterGraph, { encoding: "utf8", flag: "wx" });
            runResult = await runStage();
          }
          if (runResult?.cancelled) throw new DOMException("分段轉檔已取消。", "AbortError");
          await finalizePartialOutput(partialStagePath, stageOutputPath);
          const outputStat = await stat(stageOutputPath);
          if (!outputStat.isFile() || outputStat.size <= 0) throw new Error("低記憶體分段暫存檔驗證失敗。");
          await this.checkpoints.completeSegment(checkpoint, segment);
          next[groupIndex] = {
            sourcePath: stageOutputPath,
            sourceVideoCodec: "h264",
            durationMs: stagePlan.expectedDurationMs,
            hasAudio: true,
            checkpointKey: segmentId,
          };
          completedJobs += 1;
          return stagePlan.expectedDurationMs;
        } catch (error) {
          segment.status = "FAILED";
          segment.lastError = error instanceof Error ? error.message : String(error);
          checkpoint.lastError = segment.lastError;
          const enospc = isEnospcError(error);
          const diskPause = error instanceof DiskSpacePauseError;
          if (enospc || diskPause) {
            const disk = diskPause ? error.snapshot : await diskMonitor.snapshot("SEGMENT_ENOSPC", segmentId);
            preserveStagePartial = existsSync(partialStagePath);
            if (preserveStagePartial) {
              const partialStat = await stat(partialStagePath).catch(() => undefined);
              checkpoint.recoverablePartial = partialStat
                ? {
                    path: partialStagePath,
                    sizeBytes: partialStat.size,
                    recordedAt: new Date().toISOString(),
                  }
                : undefined;
            }
            checkpoint.concatStatus = "PAUSED_DISK_SPACE";
            checkpoint.diskState = {
              status: enospc ? "FAILED_ENOSPC" : "PAUSED_DISK_SPACE",
              lastSnapshot: disk,
              failedPath: partialStagePath,
              requiredAdditionalBytes: disk.requiredAdditionalBytes,
              completedSegmentCount: checkpoint.segments.filter((item) => item.status === "COMPLETED").length,
              resumable: true,
            };
          } else checkpoint.concatStatus = "FAILED";
          await this.checkpoints.save(checkpoint);
          await this.checkpoints.appendDiagnostic(checkpoint, {
            event: "SEGMENT_FAILED",
            segmentId,
            error: segment.lastError,
            resources: checkpoint.latestResources,
          });
          if (enospc || diskPause) {
            const required = checkpoint.diskState?.requiredAdditionalBytes ?? 0;
            throw new DiskSpacePauseError(
              required > 0
                ? `轉檔因磁碟空間不足而暫停；已完成片段與可檢驗 partial 保留。請至少再釋放 ${(required / 1024 ** 3).toFixed(1)} GB 後繼續轉檔。`
                : "轉檔因磁碟空間不足而暫停；已完成片段與可檢驗 partial 保留。請重新檢查工作磁碟後繼續。",
              checkpoint.diskState!.lastSnapshot!,
              partialStagePath,
              true,
            );
          }
          throw error;
        } finally {
          if (!preserveStagePartial) await rm(partialStagePath, { force: true });
          await rm(filterScriptPath, { force: true });
        }
      };

      let groupCursor = 0;
      while (groupCursor < groups.length) {
        if (signal?.aborted) throw new DOMException("分段轉檔已取消。", "AbortError");
        await this.renderCommands?.waitAtSafeBoundary(
          signal,
          `已完成 ${completedJobs}/${totalJobs} 个中继分段，等待继续。`,
        );
        if (requestedDiskPause) throw requestedDiskPause;
        try {
          const disk = await diskMonitor.assertSafeBoundary("BEFORE_SEGMENT_WAVE", `${completedJobs + 1}/${totalJobs}`);
          checkpoint.diskState = {
            status: "RUNNING",
            lastSnapshot: disk,
            requiredAdditionalBytes: disk.requiredAdditionalBytes,
            completedSegmentCount: checkpoint.segments.filter((item) => item.status === "COMPLETED").length,
            resumable: true,
          };
          await this.checkpoints.save(checkpoint);
        } catch (error) {
          if (!(error instanceof DiskSpacePauseError)) throw error;
          checkpoint.concatStatus = "PAUSED_DISK_SPACE";
          checkpoint.lastError = error.message;
          checkpoint.diskState = {
            status: "PAUSED_DISK_SPACE",
            lastSnapshot: error.snapshot,
            failedPath: error.failedPath,
            requiredAdditionalBytes: error.snapshot.requiredAdditionalBytes,
            completedSegmentCount: checkpoint.segments.filter((item) => item.status === "COMPLETED").length,
            resumable: true,
          };
          await this.checkpoints.save(checkpoint);
          onProgress({
            phase: "PAUSED_DISK_SPACE",
            percent: totalJobs ? Math.min(70, (completedJobs / totalJobs) * 70) : 0,
            outTimeMs: Math.round((completedJobs / Math.max(1, totalJobs)) * overallExpectedDurationMs),
            expectedDurationMs: overallExpectedDurationMs,
            currentSegment: error.message,
            segmentIndex: completedJobs,
            segmentCount: totalJobs,
            diskStatus: error.snapshot,
          });
          throw error;
        }
        let resources = await captureSystemResources(checkpoint.outputPath, {
          ffmpegPids: [...activeFfmpegPids],
          currentJobs: activeFfmpegPids.size,
          workingPaths: [checkpoint.workRoot],
          tempPath: checkpoint.workRoot,
        });
        while (resources.availableRamBytes < runtimePolicy.pauseNewStageBelowAvailableBytes) {
          checkpoint.latestResources = resources;
          await this.checkpoints.appendDiagnostic(checkpoint, { event: "WAITING_FOR_MEMORY", resources });
          onProgress({
            phase: "WAITING_FOR_MEMORY",
            percent: totalJobs ? Math.min(70, (completedJobs / totalJobs) * 70) : 0,
            outTimeMs: Math.round((completedJobs / Math.max(1, totalJobs)) * overallExpectedDurationMs),
            expectedDurationMs: overallExpectedDurationMs,
            currentSegment: "可用 RAM 接近安全門檻，暫停送入新工作",
            segmentIndex: completedJobs + 1,
            segmentCount: totalJobs,
            resourceUsage: resources,
          });
          await waitWithAbort(5_000, signal);
          resources = await captureSystemResources(checkpoint.outputPath, {
            workingPaths: [checkpoint.workRoot],
            tempPath: checkpoint.workRoot,
          });
        }

        let gate = decideAdaptiveConcurrency(runtimePolicy, adaptiveState, resources);
        while (gate.pauseNewJobs) {
          checkpoint.latestResources = resources;
          await this.checkpoints.appendDiagnostic(checkpoint, {
            event: "ADAPTIVE_PAUSED",
            decision: gate.reason,
            resources,
          });
          onProgress({
            phase: "WAITING_FOR_MEMORY",
            percent: totalJobs ? Math.min(70, (completedJobs / totalJobs) * 70) : 0,
            outTimeMs: Math.round((completedJobs / Math.max(1, totalJobs)) * overallExpectedDurationMs),
            expectedDurationMs: overallExpectedDurationMs,
            currentSegment: gate.reason,
            segmentIndex: completedJobs + 1,
            segmentCount: totalJobs,
            resourceUsage: resources,
          });
          await waitWithAbort(5_000, signal);
          resources = await captureSystemResources(checkpoint.outputPath, {
            workingPaths: [checkpoint.workRoot],
            tempPath: checkpoint.workRoot,
          });
          gate = decideAdaptiveConcurrency(runtimePolicy, adaptiveState, resources);
        }
        adaptiveState = gate;
        let waveSize = Math.min(adaptiveState.currentJobs, groups.length - groupCursor);
        if (runtimePolicy.maximumRenderTempBytes) {
          const currentWorkingBytes = resources.renderWorkingBytes ?? 0;
          while (waveSize > 0) {
            const predictedWaveBytes = groups
              .slice(groupCursor, groupCursor + waveSize)
              .reduce(
                (sum, group) =>
                  sum +
                  estimatedIntermediateBytes(
                    Math.max(
                      0,
                      group.reduce((duration, item) => duration + item.durationMs, 0) -
                        transitionSeconds * 1000 * Math.max(0, group.length - 1),
                    ),
                    resolution,
                    runtimePolicy.resourceProfile ?? "BALANCED",
                  ),
                0,
              );
            if (currentWorkingBytes + predictedWaveBytes <= runtimePolicy.maximumRenderTempBytes) break;
            waveSize -= 1;
          }
          if (waveSize < 1) {
            const snapshot = await diskMonitor.snapshot("TEMP_BUDGET_WAIT", `${completedJobs + 1}/${totalJobs}`);
            throw new DiskSpacePauseError(
              `Render TEMP 已达到使用者设定上限；已在安全边界暂停。请提高 TEMP 上限、清理可重建工作档，或改用低磁碟模式。`,
              snapshot,
            );
          }
        }
        const waveIndexes = Array.from({ length: waveSize }, (_, offset) => groupCursor + offset);
        const waveStartedAt = Date.now();
        wavePeakResources = undefined;
        await this.checkpoints.appendDiagnostic(checkpoint, {
          event: "ADAPTIVE_WAVE_STARTED",
          level: level + 1,
          jobs: waveSize,
          policy: runtimePolicy,
          resources,
        });
        const settled = await Promise.allSettled(waveIndexes.map((groupIndex) => renderGroup(groupIndex)));
        const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
        if (failure) throw failure.reason;
        const renderedDurationMs = settled.reduce(
          (sum, item) => sum + (item.status === "fulfilled" ? item.value : 0),
          0,
        );
        const elapsedMs = Math.max(1, Date.now() - waveStartedAt);
        const throughput = renderedDurationMs / elapsedMs;
        const after = await captureSystemResources(checkpoint.outputPath, {
          ffmpegPids: [...activeFfmpegPids],
          currentJobs: activeFfmpegPids.size,
          workingPaths: [checkpoint.workRoot],
          tempPath: checkpoint.workRoot,
        });
        // Resource samples arrive from the child-process monitor callback. TypeScript
        // cannot prove that the callback ran before this point, so preserve the
        // explicit runtime guard while giving the narrowed value a stable type.
        const measuredWavePeak = wavePeakResources as SystemResourceSnapshot | undefined;
        const decisionResources = measuredWavePeak
          ? {
              ...after,
              cpuUsagePercent: measuredWavePeak.cpuUsagePercent,
              gpuUsagePercent: measuredWavePeak.gpuUsagePercent,
              gpuEncodeUsagePercent: measuredWavePeak.gpuEncodeUsagePercent,
              gpuDecodeUsagePercent: measuredWavePeak.gpuDecodeUsagePercent,
              gpuComputeUsagePercent: measuredWavePeak.gpuComputeUsagePercent,
              ffmpegPrivateBytes: measuredWavePeak.ffmpegPrivateBytes,
              currentJobs: waveSize,
            }
          : after;
        const decision = decideAdaptiveConcurrency(runtimePolicy, adaptiveState, decisionResources, throughput);
        await this.checkpoints.appendDiagnostic(checkpoint, {
          event: "ADAPTIVE_WAVE_COMPLETED",
          level: level + 1,
          jobs: waveSize,
          elapsedMs,
          renderedDurationMs,
          throughput,
          nextJobs: decision.currentJobs,
          decision: decision.reason,
          resources: after,
        });
        adaptiveState = decision;
        groupCursor += waveSize;
      }
      const releasedBytes = await this.checkpoints.releaseConsumedSegments(
        checkpoint,
        current.map((item) => item.sourcePath),
      );
      if (releasedBytes > 0) {
        await this.checkpoints.appendDiagnostic(checkpoint, {
          event: "DEPENDENCY_GC",
          level,
          releasedBytes,
          reason: "all downstream replacements validated",
        });
      }
      current = next;
      level += 1;
    }
    return { inputs: current, stageCount: completedJobs + 1, resumedSegmentCount };
  }

  async render(
    request: ConcatRenderRequest,
    outputPath: string,
    signal?: AbortSignal,
    onProgress: (progress: ConcatRenderProgress) => void = () => undefined,
  ): Promise<ConcatRenderResult> {
    if (!Array.isArray(request.orderedAssetIds)) throw new Error("影片片段順序格式無效。");
    const purpose = request.purpose ?? "CONCAT";
    if (purpose !== "CONCAT" && purpose !== "INTRO" && purpose !== "CLIP" && purpose !== "SHORTS")
      throw new Error("預覽輸出用途無效。");
    if (request.orderedAssetIds.length < 1)
      throw new Error(
        purpose === "INTRO"
          ? "至少需要一個片段才能產出 Intro 預覽。"
          : purpose === "CLIP"
            ? "至少需要一個固定時間段才能輸出。"
            : "正片沒有可供輸出的保留片段。",
      );
    const project = this.store.getProject();
    const audioProcessing = sanitizeAudioProcessingOptions(request.audioProcessing);
    const videoCodec = request.videoCodec ?? "H264";
    if (
      videoCodec !== "H264_NVENC" &&
      videoCodec !== "H265_NVENC" &&
      videoCodec !== "H265_QSV" &&
      videoCodec !== "H265" &&
      videoCodec !== "H264_QSV" &&
      videoCodec !== "H264"
    )
      throw new Error("影片編碼格式無效。只支援 NVIDIA NVENC、Intel QSV 或 CPU H.265／H.264。");
    await this.hardwareService?.assertCodecAvailable(videoCodec);
    const introTargetDurationMs = project.introTargetDurationMs ?? DEFAULT_INTRO_TARGET_DURATION_MS;
    const outputIntroSegments = introSegmentsForOutput(project.introSegments, project.introSegmentMaxDurationMs);
    if (purpose === "CONCAT") {
      const introPrefix = request.prependIntro ? outputIntroSegments : [];
      if (request.prependIntro) {
        if (!introPrefix.length) throw new Error("已選擇自動串接片頭，但目前沒有已確認的 Intro 片段。");
        if (introPrefix.length > INTRO_MAX_SEGMENTS) throw new Error(`Intro 最多只能串接 ${INTRO_MAX_SEGMENTS} 段。`);
        if (introPrefix.some((clip) => clip.outMs - clip.inMs < INTRO_EDIT_MIN_SEGMENT_MS))
          throw new Error(`Intro 輸出片段至少需要 ${INTRO_EDIT_MIN_SEGMENT_MS / 1000} 秒。`);
        if (introPrefix.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0) > introTargetDurationMs)
          throw new Error(`Intro 總長超過目前設定的 ${Math.round(introTargetDurationMs / 1000)} 秒。`);
      }
      const expected = [...introPrefix, ...mainRenderSelections(project)];
      const requested = request.clipSelections;
      if (
        !requested ||
        expected.length !== requested.length ||
        expected.some(
          (clip, index) =>
            clip.assetId !== requested[index]?.assetId ||
            clip.inMs !== requested[index]?.inMs ||
            clip.outMs !== requested[index]?.outMs ||
            clip.mediaInsertionId !== requested[index]?.mediaInsertionId,
        )
      ) {
        throw new Error("串連要求與目前片頭／正片保留片段不一致；待決定或已排除範圍不可輸出。");
      }
      if (
        request.orderedAssetIds.length !== expected.length ||
        request.orderedAssetIds.some((id, index) => id !== expected[index].assetId)
      ) {
        throw new Error("串連來源順序與目前正片保留片段不一致。");
      }
    } else if (purpose === "INTRO") {
      const expected = outputIntroSegments;
      const requested = request.clipSelections;
      if (
        !requested ||
        expected.length !== requested.length ||
        expected.some(
          (clip, index) =>
            clip.assetId !== requested[index]?.assetId ||
            clip.inMs !== requested[index]?.inMs ||
            clip.outMs !== requested[index]?.outMs,
        )
      ) {
        throw new Error("Intro 輸出要求與目前已確認的片頭片段不一致。");
      }
      if (expected.length > INTRO_MAX_SEGMENTS) throw new Error(`Intro 最多只能輸出 ${INTRO_MAX_SEGMENTS} 段。`);
      if (expected.some((clip) => clip.outMs - clip.inMs < INTRO_EDIT_MIN_SEGMENT_MS))
        throw new Error(`Intro 輸出片段至少需要 ${INTRO_EDIT_MIN_SEGMENT_MS / 1000} 秒。`);
      if (expected.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0) > introTargetDurationMs)
        throw new Error(`Intro 總長超過目前設定的 ${Math.round(introTargetDurationMs / 1000)} 秒。`);
    } else if (purpose === "CLIP") {
      const requested = request.clipSelections;
      if (request.resolution !== "4K") throw new Error("最高解析度時間段固定輸出為 4K（3840×2160）。");
      if (
        request.orderedAssetIds.length !== 1 ||
        requested?.length !== 1 ||
        requested[0].assetId !== request.orderedAssetIds[0]
      )
        throw new Error("固定時間段輸出只能包含一個專案影片片段。");
      if (request.prependIntro || request.subtitleBurnIn?.enabled) throw new Error("固定時間段輸出不串接片頭或字幕。");
    } else {
      if (!request.shortsPortrait) throw new Error("Shorts 必須使用 9:16 直式輸出。");
      if (request.shortsMaxDurationSec !== 60 && request.shortsMaxDurationSec !== 180)
        throw new Error("Shorts 長度上限只支援 60 或 180 秒。");
      const requested = request.clipSelections;
      const allowed = request.shortsSource === "INTRO" ? project.introSegments : mainRenderSelections(project);
      if (!requested?.length) throw new Error("Shorts 至少需要一段已選片段。");
      if (
        requested.some(
          (clip) =>
            !allowed.some(
              (candidate) =>
                candidate.assetId === clip.assetId && candidate.inMs === clip.inMs && candidate.outMs === clip.outMs,
            ),
        )
      )
        throw new Error("Shorts 包含不在目前片頭／正片清單內的片段。");
      if (request.prependIntro) throw new Error("Shorts 不會靜默串接 16:9 Intro；請在 Shorts 頁明確選擇片段。");
    }
    if (path.extname(outputPath).toLowerCase() !== ".mp4") throw new Error("串連預覽必須輸出為 MP4。");
    const mainStartCard =
      purpose === "CONCAT" && request.prependIntro
        ? validateMainStartCardOptions(request.mainStartCard ?? DEFAULT_MAIN_START_CARD_OPTIONS)
        : undefined;
    const parsed = path.parse(outputPath);
    const renderId = randomUUID();
    const mainStartTextPaths = mainStartCard
      ? {
          line1: path.join(parsed.dir, `.${parsed.name}.${renderId}.main-start-line1.txt`),
          line2: path.join(parsed.dir, `.${parsed.name}.${renderId}.main-start-line2.txt`),
        }
      : undefined;
    const watermarkSettings = normalizeWatermarkSettings(project.watermarkSettings);
    const watermarkActive = request.includeWatermark !== false && watermarkAppliesToPurpose(watermarkSettings, purpose);
    const watermarkTextPaths = watermarkActive
      ? {
          chinese: path.join(parsed.dir, `.${parsed.name}.${renderId}.watermark-zh.txt`),
          english: path.join(parsed.dir, `.${parsed.name}.${renderId}.watermark-en.txt`),
        }
      : undefined;

    onProgress({ phase: "PREPARING", percent: 0, outTimeMs: 0, expectedDurationMs: 0 });
    const assetsById = new Map<string, SourceAsset>();
    for (const assetId of new Set(request.orderedAssetIds)) {
      assertSafeHexId(assetId, "Asset ID");
      const asset = this.store.getAsset(assetId);
      if (!asset) throw new Error("串連清單包含不存在或不適用的來源。");
      assetsById.set(assetId, await this.sources.ensureMetadata(assetId, signal));
    }
    const assets = request.orderedAssetIds.map((assetId) => assetsById.get(assetId)!);
    if (
      assets.some(
        (asset) => asset.metadataState !== "READY" || (asset.kind === "VIDEO" && !asset.mediaInfo?.durationMs),
      )
    ) {
      throw new Error("至少一項素材無法取得有效媒體資訊，請先確認格式或 codec 是否受支援。");
    }
    if (assets.some((asset) => samePath(asset.sourcePath, outputPath))) {
      throw new Error("輸出路徑不可覆蓋任何來源影片。");
    }
    const preserveNativeAsset = audioProcessing.mode === "PRESERVE_MULTICHANNEL" ? assets[0] : undefined;
    if (audioProcessing.mode === "PRESERVE_MULTICHANNEL") {
      if (
        purpose !== "CLIP" ||
        assets.length !== 1 ||
        preserveNativeAsset?.kind !== "VIDEO" ||
        (preserveNativeAsset.mediaInfo?.audioChannels ?? 0) <= 2 ||
        !preserveNativeAsset.mediaInfo?.audioChannelLayout
      ) {
        throw new Error(
          "「保持原始多聲道」目前只适用于单支原生多声道影片的时间段输出；多片段、转场或混合配乐请改用 Original Stereo 或 Virtual Surround 5.1，避免破坏真正的原生多声道。",
        );
      }
    }

    if ((purpose === "INTRO" || purpose === "CLIP") && request.clipSelections?.length !== assets.length) {
      throw new Error("Intro 片段範圍與來源順序不一致。");
    }
    const inputs: ConcatInput[] = assets.map((asset, index) => {
      const isIntroClip =
        purpose === "INTRO" ||
        (purpose === "CONCAT" && Boolean(request.prependIntro) && index < project.introSegments.length);
      const selectedColorPreset = colorPreset(project.colorSettings.introPresetId);
      const applyColor =
        isIntroClip || ((purpose === "CONCAT" || purpose === "CLIP") && project.colorSettings.applyToMain);
      const fullDurationMs =
        asset.kind === "IMAGE"
          ? isIntroClip
            ? MAX_IMAGE_DURATION_MS
            : imageDurationMs(asset)
          : asset.mediaInfo!.durationMs!;
      const introRange = request.clipSelections?.[index];
      const requestedRange = request.clipSelections?.[index] ?? asset.previewRange;
      if (introRange?.assetId !== asset.id) {
        throw new Error("片段範圍與來源影片不一致。");
      }
      const startMs = Math.round(requestedRange?.inMs ?? 0);
      const outMs = Math.round(requestedRange?.outMs ?? fullDurationMs);
      const invalidImageRange =
        asset.kind === "IMAGE" &&
        (isIntroClip
          ? startMs !== 0 || outMs - startMs < MIN_IMAGE_DURATION_MS || outMs - startMs > MAX_IMAGE_DURATION_MS
          : startMs !== 0 || outMs !== fullDurationMs);
      if (startMs < 0 || outMs > fullDurationMs + 50 || outMs - startMs < 100 || invalidImageRange) {
        throw new Error(`「${asset.fileName}」的片段時間超出素材範圍。`);
      }
      return {
        sourcePath: asset.sourcePath,
        sourceVideoCodec: asset.mediaInfo?.videoCodec,
        assetId: asset.id,
        startMs,
        durationMs: outMs - startMs,
        hasAudio: asset.kind === "VIDEO" && Boolean(asset.mediaInfo?.audioCodec),
        isImage: asset.kind === "IMAGE",
        isPortrait: asset.mediaInfo?.isPortrait,
        orientationRotationDegrees: asset.mediaInfo?.rotationDegrees,
        // All photo SFX is now represented by the canonical post-audio plan.
        photoSoundEnabled: false,
        ...(isIntroClip
          ? { insertionAudioInstanceId: outputIntroSegments[index]?.id, insertionAudioScope: "INTRO" as const }
          : introRange?.mediaInsertionId
            ? { insertionAudioInstanceId: introRange.mediaInsertionId, insertionAudioScope: "MAIN" as const }
            : {}),
        volumeSegments: asset.volumeSegments ?? [],
        zoomSegments: asset.zoomSegments ?? [],
        colorFilters: applyColor ? [...selectedColorPreset.ffmpegFilters] : [],
      };
    });
    if (mainStartCard && mainStartTextPaths) {
      const firstMainInput = inputs[outputIntroSegments.length];
      if (!firstMainInput) throw new Error("找不到正片開場素材，無法建立正片開始提示頁。");
      const selectedIntroIndex = mainStartCard.backgroundIntroSegmentId
        ? outputIntroSegments.findIndex((segment) => segment.id === mainStartCard.backgroundIntroSegmentId)
        : -1;
      if (mainStartCard.backgroundIntroSegmentId && selectedIntroIndex < 0) {
        throw new Error("指定的提示頁背景已不在目前片頭清單，請重新選擇。");
      }
      const backgroundInput = selectedIntroIndex >= 0 ? inputs[selectedIntroIndex] : firstMainInput;
      const backgroundSourceDurationMs = backgroundInput.durationMs;
      inputs.splice(outputIntroSegments.length, 0, {
        ...backgroundInput,
        durationMs: mainStartCard.durationSeconds * 1000,
        hasAudio: false,
        photoSoundEnabled: false,
        photoSoundInputIndex: undefined,
        volumeSegments: [],
        zoomSegments: [],
        mainStartCard: {
          ...mainStartCard,
          sourceDurationMs: backgroundSourceDurationMs,
          line1TextFilePath: mainStartTextPaths.line1,
          line2TextFilePath: mainStartTextPaths.line2,
          fontFilePath: resolveMainStartCardFont(),
        },
      });
    }
    const currentProject = this.store.getProject();
    const insertionAudioPlan = buildInsertionAudioPlan(currentProject, {
      purpose,
      transitionSeconds: request.transitionSeconds,
      prependIntro: request.prependIntro,
      mainStartCard,
      shortsSource: request.shortsSource,
      includeBgm: request.includeBgm,
    });
    const timedSfxInputs = insertionAudioPlan.sfxEvents;
    const photoShutterAppliedCount = timedSfxInputs.filter((event) => event.source === "PACKAGED_SHUTTER").length;
    if (photoShutterAppliedCount > 0 && !this.photoSoundPath) {
      throw new Error("找不到已驗證的相機快門效果音（SFX），已阻擋含照片的輸出；請重新封裝或確認內建音效仍存在。");
    }
    let shutterInputIndex = inputs.length;
    for (const input of inputs) {
      if (input.photoSoundEnabled) input.photoSoundInputIndex = shutterInputIndex++;
    }
    inputs.forEach((input, index) => {
      const { mainStartCard: card, ...stableInput } = input;
      input.checkpointKey = checkpointKey({
        index,
        ...stableInput,
        ...(card
          ? {
              mainStartCard: {
                durationSeconds: card.durationSeconds,
                line1: card.line1,
                line2: card.line2,
                line1FontSize1080p: card.line1FontSize1080p,
                line2FontSize1080p: card.line2FontSize1080p,
                lineGap1080p: card.lineGap1080p,
                overlayOpacityPercent: card.overlayOpacityPercent,
                transitionStyle: card.transitionStyle,
                sourceDurationMs: card.sourceDurationMs,
              },
            }
          : {}),
      });
    });
    const requestedBgmScopes = validateBgmScopeSelection(request.bgmScopes);
    const bgmScopesApplied: BgmScopeSelection =
      purpose === "CLIP" || request.includeBgm === false
        ? { intro: false, main: false }
        : purpose === "INTRO"
          ? { intro: requestedBgmScopes.intro, main: false }
          : purpose === "SHORTS"
            ? request.shortsSource === "MAIN"
              ? { intro: false, main: requestedBgmScopes.main }
              : { intro: requestedBgmScopes.intro, main: false }
            : request.prependIntro
              ? requestedBgmScopes
              : { intro: false, main: requestedBgmScopes.main };
    const inputStartTimesMs = concatInputStartTimesMs(inputs, request.transitionSeconds);
    const mainStartCardIndex = mainStartCard ? outputIntroSegments.length : -1;
    const bgmBoundaries =
      mainStartCardIndex >= 0
        ? {
            introEndMs: inputStartTimesMs[mainStartCardIndex],
            mainStartMs: inputStartTimesMs[mainStartCardIndex + 1],
          }
        : undefined;
    const bgmTracks = selectBgmTracksForScopes(currentProject.bgmTracks, bgmScopesApplied, bgmBoundaries);
    // v0.60 uses the literal first BGM-page item. For videos with an audio
    // stream, analyze the exact selected source range instead of assuming the
    // track is audible. Photos and the generated start card are ignored.
    const dubSourceTrack = currentProject.bgmTracks[0];
    const autoDubTracks: BgmRenderInput[] = [];
    if (
      request.includeBgm !== false &&
      (purpose === "CONCAT" || purpose === "INTRO") &&
      dubSourceTrack?.resolutionStatus !== "NEEDS_LOCAL_FILE" &&
      dubSourceTrack?.sourcePath
    ) {
      await Promise.all(
        inputs.map(async (input) => {
          if (input.mainStartCard || input.isImage || input.insertionAudioInstanceId) return;
          const asset = assets.find((item) => item.id === input.assetId);
          if (!asset || asset.kind !== "VIDEO" || asset.dubWithBgm === false) return;
          input.detectedSilent = await this.silenceDetector.isSilent(
            asset,
            input.startMs ?? 0,
            input.durationMs,
            signal,
          );
        }),
      );
      inputs.forEach((input, index) => {
        if (input.mainStartCard || input.isImage || input.insertionAudioInstanceId || !input.detectedSilent) return;
        const asset = assets.find((item) => item.id === input.assetId);
        if (!asset || asset.kind !== "VIDEO" || asset.dubWithBgm === false) return;
        const spanMs = Math.max(0, Math.round(input.durationMs));
        const startMs = Math.round(inputStartTimesMs[index] ?? 0);
        const canonicalItem = insertionAudioPlan.items.find(
          (item) => item.scope === "MAIN" && item.assetId === asset.id && item.timelineStartMs === startMs,
        );
        if (canonicalItem?.gates.bgm === false) return;
        const sourceSpanMs = Math.max(1, dubSourceTrack.sourceOutMs - dubSourceTrack.sourceInMs || dubSourceTrack.durationMs);
        autoDubTracks.push({
          ...dubSourceTrack,
          id: randomUUID(),
          timelineInMs: startMs,
          timelineOutMs: startMs + spanMs,
          sourceInMs: dubSourceTrack.sourceInMs,
          sourceOutMs: dubSourceTrack.sourceOutMs,
          loop: spanMs > sourceSpanMs,
          sourceSpanMs,
          loopCrossfadeMs: 120,
        });
      });
    }
    const insertionBgmTracks: BgmRenderInput[] = request.includeBgm === false
      ? []
      : insertionAudioPlan.bgmRanges.map((range) => {
          const track = currentProject.bgmTracks.find((candidate) => candidate.id === range.bgmTrackId)!;
          return {
            ...track,
            id: range.id,
            timelineInMs: range.timelineStartMs,
            timelineOutMs: range.timelineEndMs,
            sourceInMs: range.sourceInMs,
            sourceOutMs: range.sourceInMs + range.sourceSpanMs,
            volumePercent: range.volumePercent,
            fadeInMs: range.fadeInMs,
            fadeOutMs: range.fadeOutMs,
            loop: range.usesLoop,
            sourceSpanMs: range.sourceSpanMs,
            insertionRangeId: range.id,
            loopCrossfadeMs: range.loopCrossfadeMs,
            loopStrategy: range.loopStrategy,
          };
        });
    // Every optional music/SFX layer stays out of the reusable picture/source-audio
    // master. Track-gate changes therefore only rerun the post-audio pass.
    const postBgmTracks = [...bgmTracks, ...autoDubTracks];
    for (const track of [...postBgmTracks, ...insertionBgmTracks]) {
      if (track.resolutionStatus === "NEEDS_LOCAL_FILE" || !track.sourcePath) {
        throw new Error(`配樂「${track.fileName}」只有 YouTube 參考連結，尚未指定自有或已授權的本機 MP3，已阻擋輸出。`);
      }
      try {
        if (!(await stat(track.sourcePath)).isFile()) throw new Error();
      } catch {
        throw new Error(`配樂「${track.fileName}」不存在或離線，已阻擋輸出。`);
      }
      if (samePath(track.sourcePath, outputPath)) throw new Error("輸出路徑不可覆蓋配樂來源。");
    }
    const sourceAudioVolumePercent = currentProject.sourceAudioVolumePercent ?? DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT;
    const audioProtection = validateAudioProtectionOptions(request.audioProtection);
    const basePlan = buildConcatFilterGraph(
      inputs,
      request.transitionSeconds,
      request.resolution,
      [],
      sourceAudioVolumePercent,
      purpose === "SHORTS",
      audioProtection,
    );
    if (purpose === "SHORTS" && basePlan.expectedDurationMs > (request.shortsMaxDurationSec ?? 60) * 1000)
      throw new Error(
        `Shorts 總長 ${Math.ceil(basePlan.expectedDurationMs / 1000)} 秒超過目前 ${request.shortsMaxDurationSec ?? 60} 秒上限。`,
      );
    const activePostBgmTracks = postBgmTracks.filter(
      (track) => track.timelineInMs < basePlan.expectedDurationMs,
    );
    onProgress({
      phase: "PREPARING",
      percent: 0,
      outTimeMs: 0,
      expectedDurationMs: basePlan.expectedDurationMs,
    });

    let partialPath = "";
    let filterScriptPath = "";
    const audioPartialPath = path.join(parsed.dir, `.${parsed.name}.${renderId}.final-audio.partial.mp4`);
    let audioFilterScriptPath = "";
    const runtimePolicy = runtimePolicyFor(request, inputs.length);
    request.runtimePolicy = runtimePolicy;
    const segmentedActive = inputs.length > runtimePolicy.maxVisualInputsPerStage;
    const lowMemoryActive = request.lowMemorySegmented === true && segmentedActive;
    const signature = renderRequestSignature(currentProject.id, currentProject.updatedAt, request);
    const pictureBaseSignature = pictureBaseRenderSignature(currentProject, request);
    const finalAudioSignature = finalInsertionAudioSignature(pictureBaseSignature, insertionAudioPlan, request, activePostBgmTracks);
    let checkpoint: RenderCheckpointRecord | undefined;
    const existing = await this.checkpoints.load(currentProject.id);
    if (request.resumeCheckpointId) {
      checkpoint = existing;
      if (!checkpoint || checkpoint.checkpointId !== request.resumeCheckpointId)
        throw new Error("續轉 checkpoint 已不存在，請重新開始轉檔。");
      if (
        checkpoint.pictureBaseSignature
          ? checkpoint.pictureBaseSignature !== pictureBaseSignature
          : checkpoint.signature !== signature || checkpoint.projectUpdatedAt !== currentProject.updatedAt
      ) throw new Error("影像、時間線或基礎音軌已變更，舊 checkpoint 不可安全套用；請捨棄後重新轉檔。");
    } else if (existing) {
      if (existing.pictureBaseSignature !== pictureBaseSignature) {
        // A new explicit render is allowed to supersede an unrelated failed
        // job. Only the isolated checkpoint work root is removed; persistent
        // verified picture masters and user media are never touched.
        await this.checkpoints.discard(currentProject.id, existing.checkpointId);
        checkpoint = await this.checkpoints.create(
          currentProject.id,
          currentProject.updatedAt,
          signature,
          runtimePolicy.mode,
          outputPath,
          request,
          request.renderTemporaryFolder,
        );
      } else checkpoint = existing;
    } else {
      checkpoint = await this.checkpoints.create(
        currentProject.id,
        currentProject.updatedAt,
        signature,
        runtimePolicy.mode,
        outputPath,
        request,
        request.renderTemporaryFolder,
      );
    }
    checkpoint.signature = signature;
    checkpoint.pictureBaseSignature = pictureBaseSignature;
    checkpoint.finalAudioSignature = finalAudioSignature;
    checkpoint.projectUpdatedAt = currentProject.updatedAt;
    checkpoint.outputPath = outputPath;
    checkpoint.request = { ...structuredClone(request), outputToken: "persisted-checkpoint" };
    checkpoint.mode = runtimePolicy.mode;
    checkpoint.concatStatus = "PENDING";
    checkpoint.lastError = undefined;
    partialPath = path.join(checkpoint.workRoot, `.${parsed.name}.${renderId}.base.partial.mkv`);
    filterScriptPath = path.join(checkpoint.workRoot, `.${parsed.name}.${renderId}.filtergraph.txt`);
    audioFilterScriptPath = path.join(checkpoint.workRoot, `.${parsed.name}.${renderId}.audio.filtergraph.txt`);
    const legacyEstimatedPeakDiskBytes = Math.max(
      request.estimatedPeakDiskBytes ?? 0,
      (runtimePolicy.estimatedWorkingBytesPerJob ?? 0) * Math.max(1, Math.ceil(inputs.length / runtimePolicy.maxVisualInputsPerStage)),
      request.estimatedFinalOutputBytes ?? 0,
    );
    const migrationSegments = checkpoint.recoveryMigration
      ? checkpoint.segments.filter((segment) => segment.status === "COMPLETED")
      : [];
    const validatedExternalSegmentBytes = checkpoint.recoveryMigration?.validatedExternalSegmentBytes ??
      migrationSegments.reduce((sum, segment) => sum + Math.max(0, segment.sizeBytes ?? 0), 0);
    const validatedExternalSegmentDurationMs = checkpoint.recoveryMigration?.validatedExternalSegmentDurationMs ??
      migrationSegments.reduce((sum, segment) => sum + Math.max(0, segment.durationMs), 0);
    const recoveryDiskEstimate = checkpoint.recoveryMigration
      ? estimateResumeAdditionalPeak({
          legacyPeakBytes: legacyEstimatedPeakDiskBytes,
          validatedExternalSegmentBytes,
          validatedExternalSegmentDurationMs,
          expectedDurationMs: basePlan.expectedDurationMs,
          estimatedFinalOutputBytes: request.estimatedFinalOutputBytes ?? 0,
        })
      : undefined;
    const estimatedPeakDiskBytes = recoveryDiskEstimate?.peakAdditionalBytes ?? legacyEstimatedPeakDiskBytes;
    const diskMonitor = new RenderDiskMonitor({
      tempRoot: checkpoint.workRoot,
      outputPath,
      estimatedRemainingWriteBytes: ({ renderTempBytes, finalOutputBytes }) =>
        remainingAdditionalWriteBytes(estimatedPeakDiskBytes, {
          newWorkRootBytes: renderTempBytes,
          completedBaseMasterBytes:
            checkpoint.audioMaster?.status === "COMPLETED" &&
            checkpoint.audioMaster.sizeBytes &&
            existsSync(checkpoint.audioMaster.outputPath)
              ? checkpoint.audioMaster.sizeBytes
              : 0,
          finalOutputBytes,
        }),
      estimatedFinalOutputBytes: request.estimatedFinalOutputBytes,
      diagnosticPath: checkpoint.diagnosticLogPath,
    });
    await this.checkpoints.save(checkpoint);
    await this.checkpoints.appendDiagnostic(checkpoint, {
      event: request.resumeCheckpointId || existing ? "RESUME_STARTED" : "RENDER_STARTED",
      mode: runtimePolicy.mode,
      policy: runtimePolicy,
      inputCount: inputs.length,
      outputPath,
      pictureBaseSignature,
      finalAudioSignature,
      renderTemporaryFolder: request.renderTemporaryFolder,
      estimatedPeakDiskBytes,
      ...(recoveryDiskEstimate
        ? {
            recoveryDiskEstimate,
            validatedExternalSegmentBytes,
            validatedExternalSegmentDurationMs,
            externalSegmentsAlreadyReflectedInFreeSpace: true,
          }
        : {}),
    });
    const elapsedTracker = new RenderElapsedTracker(this.checkpoints, renderId, checkpoint);
    let latestTimedProgress: ConcatRenderProgress = {
      phase: "PREPARING",
      percent: 0,
      outTimeMs: 0,
      expectedDurationMs: basePlan.expectedDurationMs,
    };
    const emitProgress = (progress: ConcatRenderProgress) => {
      latestTimedProgress = progress;
      onProgress(elapsedTracker.decorate(progress));
    };
    const assertDiskBoundary = async (stage: string, currentSegment: string) => {
      try {
        const disk = await diskMonitor.assertSafeBoundary(stage, currentSegment);
        checkpoint!.diskState = {
          status: "RUNNING",
          lastSnapshot: disk,
          requiredAdditionalBytes: disk.requiredAdditionalBytes,
          completedSegmentCount: checkpoint!.segments.filter((item) => item.status === "COMPLETED").length,
          resumable: true,
        };
        await this.checkpoints.save(checkpoint!);
        return disk;
      } catch (error) {
        if (!(error instanceof DiskSpacePauseError)) throw error;
        checkpoint!.concatStatus = "PAUSED_DISK_SPACE";
        checkpoint!.lastError = error.message;
        checkpoint!.diskState = {
          status: "PAUSED_DISK_SPACE",
          lastSnapshot: error.snapshot,
          failedPath: error.failedPath,
          requiredAdditionalBytes: error.snapshot.requiredAdditionalBytes,
          completedSegmentCount: checkpoint!.segments.filter((item) => item.status === "COMPLETED").length,
          resumable: true,
        };
        await this.checkpoints.save(checkpoint!);
        emitProgress({
          phase: "PAUSED_DISK_SPACE",
          percent: latestTimedProgress.percent,
          outTimeMs: latestTimedProgress.outTimeMs,
          expectedDurationMs: basePlan.expectedDurationMs,
          currentSegment: error.message,
          diskStatus: error.snapshot,
          timingStatus: "PAUSED_DISK_SPACE",
        });
        throw error;
      }
    };
    let subtitleCleanup: (() => Promise<void>) | undefined;
    let subtitleAssPath: string | undefined;
    let subtitleBurnedLanguages: SubtitleRenderLanguage[] | undefined;
    let subtitleTranslationProviders: SubtitleTranslationProvider[] | undefined;
    if (request.subtitleBurnIn?.enabled) {
      if (purpose !== "CONCAT" && purpose !== "INTRO" && purpose !== "SHORTS")
        throw new Error("字幕嵌入只適用於正片、片頭或 Shorts 輸出。");
      if (!this.subtitleTranslation || !this.subtitleCacheRoot)
        throw new Error("字幕翻譯與嵌入服務尚未初始化，已阻擋輸出。");
      const subtitleOptions = validateSubtitleBurnInOptions(request.subtitleBurnIn);
      const subtitleOutputScope =
        purpose === "INTRO" ? "INTRO" : purpose === "CONCAT" && request.prependIntro ? "MAIN_WITH_INTRO" : "MAIN";
      const confirmedCues = project.subtitleCues.filter(
        (cue) =>
          (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" &&
          ((cue.timelineScope ?? "MAIN") === "INTRO"
            ? subtitleOutputScope !== "MAIN"
            : subtitleOutputScope !== "INTRO"),
      );
      if (!confirmedCues.length)
        throw new Error(`沒有已確認的${purpose === "INTRO" ? "片頭" : "正片"}字幕可嵌入影片。`);
      onProgress({
        phase: "TRANSLATING_SUBTITLES",
        percent: 0,
        outTimeMs: 0,
        expectedDurationMs: basePlan.expectedDurationMs,
      });
      const translated = await this.subtitleTranslation.translate(
        confirmedCues,
        subtitleOptions.tracks.map((track) => track.language),
        signal,
      );
      const introClipCount =
        purpose === "INTRO"
          ? (request.clipSelections?.length ?? 0)
          : request.prependIntro
            ? outputIntroSegments.length
            : 0;
      const ass = buildSubtitleAss(
        project,
        request.clipSelections ?? [],
        introClipCount,
        request.transitionSeconds,
        request.resolution,
        subtitleOptions,
        translated,
        mainStartCard,
        subtitleOutputScope,
        Boolean(request.shortsPortrait),
      );
      if (!ass.eventCount)
        throw new Error(`已確認字幕未落在目前${purpose === "INTRO" ? "片頭" : "正片"}時間線內，無法嵌入影片。`);
      const temporaryAss = await writeSubtitleAss(this.subtitleCacheRoot, ass.content);
      subtitleCleanup = temporaryAss.cleanup;
      subtitleAssPath = temporaryAss.path;
      subtitleBurnedLanguages = ass.languages;
      subtitleTranslationProviders = translated.providers;
    }
    let lowMemoryStageCount = 1;
    let resumedSegmentCount = 0;
    let renderSucceeded = false;
    let preserveBasePartial = false;
    let preserveAudioPartial = false;
    const activeFfmpegPids = new Set<number>();

    try {
      await rm(partialPath, { force: true });
      await rm(filterScriptPath, { force: true });
      await rm(audioPartialPath, { force: true });
      await rm(audioFilterScriptPath, { force: true });
      if (mainStartCard && mainStartTextPaths) {
        await Promise.all([
          writeFile(mainStartTextPaths.line1, mainStartCard.line1, { encoding: "utf8", flag: "wx" }),
          writeFile(mainStartTextPaths.line2, mainStartCard.line2, { encoding: "utf8", flag: "wx" }),
        ]);
      }
      if (watermarkTextPaths) {
        await Promise.all([
          writeFile(watermarkTextPaths.chinese, watermarkRenderedText(watermarkSettings.chinese), {
            encoding: "utf8",
            flag: "wx",
          }),
          writeFile(watermarkTextPaths.english, watermarkRenderedText(watermarkSettings.english), {
            encoding: "utf8",
            flag: "wx",
          }),
        ]);
      }
      let baseMasterPath: string | undefined;
      let runResult: { cancelled?: boolean } | void = undefined;
      const persistentBase = await this.checkpoints.loadVideoBaseMaster(currentProject.id, pictureBaseSignature);
      if (persistentBase) {
        baseMasterPath = persistentBase.outputPath;
        resumedSegmentCount += 1;
        emitProgress({
          phase: "FINALIZING",
          percent: 96,
          outTimeMs: basePlan.expectedDurationMs,
          expectedDurationMs: basePlan.expectedDurationMs,
          currentSegment: "重用已验证的画面／基础原音 master；不重新编码影片",
        });
      } else {
        let finalInputs = inputs;
        if (segmentedActive && checkpoint) {
          const staged = await this.buildResumableIntermediates(
            inputs,
            request.transitionSeconds,
            request.resolution,
            videoCodec,
            purpose === "SHORTS",
            sourceAudioVolumePercent,
            audioProtection,
            checkpoint,
            runtimePolicy.maxVisualInputsPerStage,
            runtimePolicy.filterComplexThreads,
            runtimePolicy.encoderThreads,
            diskMonitor,
            activeFfmpegPids,
            () => elapsedTracker.markFfmpegStarted(),
            basePlan.expectedDurationMs,
            signal,
            emitProgress,
          );
          finalInputs = staged.inputs;
          lowMemoryStageCount = staged.stageCount;
          resumedSegmentCount = staged.resumedSegmentCount;
        }
        const plan = buildConcatFilterGraph(
          finalInputs,
          request.transitionSeconds,
          request.resolution,
          [],
          segmentedActive ? 100 : sourceAudioVolumePercent,
          purpose === "SHORTS",
          audioProtection,
          { inputsAreNormalized: segmentedActive, skipFinalDynamics: true },
        );
        if (Math.abs(plan.expectedDurationMs - basePlan.expectedDurationMs) > 2)
          throw new Error("分段时间线验证失败，已停止且不会留下不完整成品。");
        let filterGraph = plan.filterGraph;
        let videoOutputLabel = plan.videoOutputLabel;
        if (subtitleAssPath) {
          filterGraph = `${filterGraph};[${videoOutputLabel}]ass=filename='${escapeFfmpegFilterPath(subtitleAssPath)}'[vsub]`;
          videoOutputLabel = "vsub";
        }
        if (watermarkActive && watermarkTextPaths) {
          const fonts = resolveWatermarkFonts();
          const watermarkFilter = buildWatermarkFilterChain(watermarkSettings, plan.width, plan.height, {
            chineseTextFilePath: watermarkTextPaths.chinese,
            englishTextFilePath: watermarkTextPaths.english,
            chineseFontFilePath: fonts.chinese,
            englishFontFilePath: fonts.english,
          });
          filterGraph = `${filterGraph};[${videoOutputLabel}]${watermarkFilter}[vwatermark]`;
          videoOutputLabel = "vwatermark";
        }
        const args = [
          "-hide_banner", "-loglevel", "error", "-y",
          ...buildInputArguments(finalInputs, this.photoSoundPath, []),
          "-filter_complex_threads", String(runtimePolicy.filterComplexThreads),
          "-/filter_complex", filterScriptPath,
          "-map", `[${videoOutputLabel}]`, "-map", `[${plan.audioOutputLabel}]`,
          // Preserve the v0.79 quality-mode picture encode. A bounded-rate
          // 30-second QSV trial reduced source-relative SSIM without a speed
          // benefit; disk safety is handled by peak estimates and monitoring.
          ...buildVideoCodecArgs(videoCodec),
          "-threads", String(runtimePolicy.encoderThreads),
          "-pix_fmt", "yuv420p", "-r", "30000/1001",
          "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0",
          // Lossless neutral base audio prevents an avoidable lossy generation;
          // insertion mix plus final DSP is encoded once in the post pass.
          "-c:a", "flac", "-ar", "48000", "-ac", "2", "-shortest",
          "-progress", "pipe:1", "-nostats", partialPath,
        ];
        await writeFile(filterScriptPath, filterGraph, { encoding: "utf8", flag: "wx" });
        await this.checkpoints.appendDiagnostic(checkpoint, {
          event: "FFMPEG_COMMAND",
          stage: "BASE_MASTER",
          executable: this.ffmpegExecutable,
          args,
          outputPath: partialPath,
        });
        await assertDiskBoundary("BEFORE_BASE_MASTER", "畫面／基礎原音 master");
        await this.renderCommands?.waitAtSafeBoundary(signal, "画面／基础原音 master 尚未启动，已在安全边界暂停。");
        runResult = await this.ffmpegRunner(
          this.ffmpegExecutable,
          args,
          plan.expectedDurationMs,
          signal,
          segmentedActive
            ? (progress) => emitProgress({
                ...progress,
                percent: 70 + progress.percent * 0.25,
                outTimeMs: Math.round(basePlan.expectedDurationMs * (0.7 + (progress.percent / 100) * 0.25)),
                expectedDurationMs: basePlan.expectedDurationMs,
              })
            : emitProgress,
          {
            outputPath,
            currentSegment: "画面／基础原音 master（不含插入 BGM/SFX）",
            workingPaths: [checkpoint.workRoot, partialPath],
            segmentIndex: checkpoint.totalSegmentCount + 1,
            segmentCount: checkpoint.totalSegmentCount + 2,
            onProcessStarted: (pid) => { elapsedTracker.markFfmpegStarted(); activeFfmpegPids.add(pid); },
            onProcessFinished: (pid) => activeFfmpegPids.delete(pid),
            getActiveProcessIds: () => [...activeFfmpegPids],
            encoderName: encoderName(videoCodec),
            decoderName: segmentedActive ? "CPU software decode（已正規化中继）" : "CPU software decode",
            onResourceSnapshot: async (snapshot) => {
              checkpoint.latestResources = snapshot;
              const disk = await diskMonitor.snapshot("BASE_MASTER_RUNNING", "畫面／基礎原音 master");
              snapshot.diskUsage = disk;
              checkpoint.diskState = {
                status: "RUNNING",
                lastSnapshot: disk,
                requiredAdditionalBytes: disk.requiredAdditionalBytes,
                completedSegmentCount: checkpoint.segments.filter((item) => item.status === "COMPLETED").length,
                resumable: true,
              };
              await this.checkpoints.appendDiagnostic(checkpoint, {
                event: "RUNTIME_RESOURCE",
                stage: "BASE_MASTER",
                resources: snapshot,
              });
              await this.checkpoints.save(checkpoint);
              if (disk.pressureLevel === "EMERGENCY") {
                preserveBasePartial = true;
                throw new DiskSpacePauseError(
                  `Base Master 寫入將超過目前可用空間，已在 FFmpeg 可關閉邊界停止並保留 partial。`,
                  disk,
                  partialPath,
                );
              }
            },
          },
        );
        const cancelledBase = Boolean(runResult && runResult.cancelled);
        const baseInfo = await new MediaProbe().probe(partialPath);
        if (!baseInfo.videoCodec || (baseInfo.durationMs ?? 0) < 300)
          throw new Error("画面／基础原音 master 验证失败。");
        if (!cancelledBase) {
          const saved = await this.checkpoints.saveVideoBaseMaster(
            currentProject.id,
            pictureBaseSignature,
            partialPath,
            plan.expectedDurationMs,
            videoCodec,
            request.resolution,
            path.dirname(checkpoint.workRoot),
          );
          baseMasterPath = saved.outputPath;
          checkpoint.audioMaster = {
            id: "timeline-base-master",
            level: -1,
            index: -1,
            status: "COMPLETED",
            outputPath: saved.outputPath,
            durationMs: saved.durationMs,
            renderProfile: checkpoint.mode,
            codec: videoCodec,
            resolution: request.resolution,
            fps: "30000/1001",
            pixelFormat: "yuv420p",
            audioFormat: "flac/stereo/48000",
            sizeBytes: saved.sizeBytes,
            sha256: saved.sha256,
            completedAt: saved.createdAt,
          };
          await this.checkpoints.save(checkpoint);
          const releasedBytes = await this.checkpoints.releaseConsumedSegments(
            checkpoint,
            checkpoint.segments.filter((segment) => segment.status === "COMPLETED").map((segment) => segment.outputPath),
          );
          await this.checkpoints.appendDiagnostic(checkpoint, {
            event: "VIDEO_BASE_MASTER_CHECKPOINTED",
            outputPath: saved.outputPath,
            pictureBaseSignature,
            releasedIntermediateBytes: releasedBytes,
          });
        } else {
          baseMasterPath = partialPath;
        }
      }

      const cancelled = Boolean(runResult && runResult.cancelled);
      let completedDurationMs = basePlan.expectedDurationMs;
      if (cancelled) completedDurationMs = (await new MediaProbe().probe(baseMasterPath!)).durationMs ?? completedDurationMs;
      let audioRemuxedWithoutVideoEncode = true;
      let finalAudioInfo: BasicMediaInfo;
      await assertDiskBoundary("BEFORE_FINAL_MUX", "最終音訊混音／封裝");
      await this.renderCommands?.waitAtSafeBoundary(signal, "画面已完成，插入素材音讯后处理尚未启动，已安全暂停。");
      if (audioProcessing.mode === "PRESERVE_MULTICHANNEL" && preserveNativeAsset) {
        if (insertionAudioPlan.bgmRanges.length || insertionAudioPlan.sfxEvents.length)
          throw new Error("保持原始多声道不可同时混入插入素材 BGM/SFX；请改用 Original Stereo 或 Virtual Surround 5.1。");
        await this.renderCommands?.waitAtSafeBoundary(signal, "影片画面已完成，原始多声道封装尚未启动，已安全暂停。");
        const selection = request.clipSelections?.[0];
        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          baseMasterPath!,
          "-ss",
          ffmpegNumber((selection?.inMs ?? 0) / 1000),
          "-t",
          ffmpegNumber(completedDurationMs / 1000),
          "-i",
          preserveNativeAsset.sourcePath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-movflags",
          "+faststart",
          "-shortest",
          audioPartialPath,
        ];
        await this.ffmpegRunner(this.ffmpegExecutable, args, basePlan.expectedDurationMs, cancelled ? undefined : signal, () => undefined, {
          outputPath,
          currentSegment: "保持原始多聲道並重新封裝（影像／音訊不重編）",
          workingPaths: [baseMasterPath!, audioPartialPath],
          segmentIndex: 2,
          segmentCount: 2,
          onProcessStarted: (pid) => {
            elapsedTracker.markFfmpegStarted();
            activeFfmpegPids.add(pid);
          },
          onProcessFinished: (pid) => activeFfmpegPids.delete(pid),
          getActiveProcessIds: () => [...activeFfmpegPids],
          encoderName: "video/audio stream copy",
          decoderName: "not decoded",
        });
        finalAudioInfo = await new MediaProbe().probe(audioPartialPath);
        if (finalAudioInfo.audioChannels !== preserveNativeAsset.mediaInfo?.audioChannels)
          throw new Error("保持原始多聲道验证失败：输出声道数与来源不一致。");
        if (Math.abs((finalAudioInfo.durationMs ?? 0) - completedDurationMs) > 750)
          throw new Error("保持原始多声道后 A/V 时长差异超过安全范围，未覆盖成品。");
      } else {
        const baseInfo = await new MediaProbe().probe(baseMasterPath!);
        const post = buildInsertionAudioPostArguments({
          baseMasterPath: baseMasterPath!,
          outputPath: audioPartialPath,
          durationMs: completedDurationMs,
          baseHasAudio: Boolean(baseInfo.audioCodec),
          plan: insertionAudioPlan,
          tracks: currentProject.bgmTracks,
          additionalBgmTracks: activePostBgmTracks,
          shutterPath: this.photoSoundPath,
          audioProcessing,
          audioProtection,
          filterScriptPath: audioFilterScriptPath,
        });
        await writeFile(audioFilterScriptPath, post.filterScript, { encoding: "utf8", flag: "wx" });
        emitProgress({
          phase: "FINALIZING",
          percent: 96,
          outTimeMs: completedDurationMs,
          expectedDurationMs: completedDurationMs,
          currentSegment: "插入 BGM/SFX＋最终 Audio Processing（影像 stream copy）",
        });
        await this.ffmpegRunner(this.ffmpegExecutable, post.args, completedDurationMs, cancelled ? undefined : signal, () => undefined, {
          outputPath,
          currentSegment: "独立音讯混音与无损影像重新封装",
          workingPaths: [baseMasterPath!, audioPartialPath],
          segmentIndex: checkpoint.totalSegmentCount + 2,
          segmentCount: checkpoint.totalSegmentCount + 2,
          onProcessStarted: (pid) => { elapsedTracker.markFfmpegStarted(); activeFfmpegPids.add(pid); },
          onProcessFinished: (pid) => activeFfmpegPids.delete(pid),
          getActiveProcessIds: () => [...activeFfmpegPids],
          encoderName: `audio ${audioProcessing.codec.toLowerCase()} / video stream copy`,
          decoderName: "audio software decode / video not decoded",
        });
        finalAudioInfo = await new MediaProbe().probe(audioPartialPath);
        if (finalAudioInfo.audioChannels !== post.channels)
          throw new Error(`音讯输出验证失败：预期 ${post.channels} 声道，实际 ${finalAudioInfo.audioChannels ?? "未知"} 声道。`);
      }
      if (Math.abs((finalAudioInfo.durationMs ?? 0) - completedDurationMs) > 750)
        throw new Error("音讯后处理 A/V 时长差异超过安全范围，已停止且不会覆盖成品。");
      emitProgress({
        phase: "FINALIZING",
        percent: 99,
        outTimeMs: completedDurationMs,
        expectedDurationMs: basePlan.expectedDurationMs,
      });
      await finalizePartialOutput(audioPartialPath, outputPath);
      const outputStat = await stat(outputPath);
      if (!outputStat.isFile() || outputStat.size <= 0) throw new Error("輸出檔案驗證失敗。");
      const terminalTiming = await elapsedTracker.finish(cancelled ? "CANCELLED" : "COMPLETED");
      const result: ConcatRenderResult = {
        jobId: randomUUID(),
        outputPath,
        sizeBytes: outputStat.size,
        expectedDurationMs: completedDurationMs,
        transitionSeconds: request.transitionSeconds,
        resolution: request.resolution,
        videoCodec,
        purpose,
        bgmAppliedCount: activePostBgmTracks.length + insertionAudioPlan.bgmRanges.length,
        bgmScopesApplied,
        autoDubClipCount: autoDubTracks.length,
        photoShutterAppliedCount,
        mixPolicy: audioProtection.enabled ? "VOICE_DUCK_EQ_COMPRESS_LIMIT" : "ORIGINAL_PLUS_BGM_LIMITED_0_95",
        audioProtectionApplied: audioProtection.enabled,
        audioPeakCeilingDb: audioProtection.enabled ? audioProtection.peakCeilingDb : undefined,
        audioProcessing,
        audioCodec: finalAudioInfo.audioCodec,
        audioChannels: finalAudioInfo.audioChannels,
        audioChannelLayout: finalAudioInfo.audioChannelLayout,
        audioSampleRate: finalAudioInfo.audioSampleRate,
        audioBitrate: finalAudioInfo.audioBitrate,
        audioRemuxedWithoutVideoEncode,
        cancelled,
        plannedDurationMs: cancelled ? basePlan.expectedDurationMs : undefined,
        includedIntroSegmentCount: purpose === "CONCAT" && request.prependIntro ? project.introSegments.length : 0,
        subtitleBurnedLanguages,
        subtitleTranslationProviders,
        colorPresetId: project.colorSettings.introPresetId,
        colorAppliedToMain: purpose === "CONCAT" && project.colorSettings.applyToMain,
        watermarkApplied: watermarkActive,
        mainStartCardDurationSeconds: mainStartCard?.durationSeconds,
        shortsPortrait: purpose === "SHORTS" ? true : undefined,
        aspectRatio: purpose === "SHORTS" ? "PORTRAIT_9_16" : "LANDSCAPE_16_9",
        lowMemorySegmented: lowMemoryActive,
        highSpeedMode: request.highSpeedMode === true,
        lowMemoryStageCount: lowMemoryActive ? lowMemoryStageCount : undefined,
        segmentedRender: segmentedActive,
        segmentInputLimit: runtimePolicy.maxVisualInputsPerStage,
        resumedSegmentCount,
        attemptElapsedMs: terminalTiming?.attemptElapsedMs,
        cumulativeElapsedMs: terminalTiming?.cumulativeElapsedMs,
        insertionAudioPlan,
        videoBaseMasterReused: Boolean(persistentBase),
        pictureBaseSignature,
        finalAudioSignature,
      };
      renderSucceeded = true;
      if (checkpoint) await this.checkpoints.complete(currentProject.id, checkpoint.checkpointId);
      emitProgress({
        phase: "FINALIZING",
        percent: 100,
        outTimeMs: completedDurationMs,
        expectedDurationMs: basePlan.expectedDurationMs,
      });
      return result;
    } catch (error) {
      const diskPause = error instanceof DiskSpacePauseError;
      const enospc = isEnospcError(error);
      const rawError = error instanceof Error ? error.message : String(error);
      const timingStatus =
        diskPause || enospc
          ? "PAUSED_DISK_SPACE"
          : error instanceof DOMException && error.name === "AbortError"
          ? signal?.reason === "APP_CLOSED"
            ? "INTERRUPTED"
            : "CANCELLED"
          : "FAILED";
      const terminalTiming = await elapsedTracker.finish(timingStatus);
      if (terminalTiming) onProgress({ ...latestTimedProgress, ...terminalTiming });
      if (checkpoint) {
        // Persist the original bounded stderr/message before translating it into a
        // user-facing recovery status. v0.79 overwrote this evidence, which made
        // it impossible to distinguish a real FFmpeg ENOSPC from an app guard.
        await this.checkpoints.appendDiagnostic(checkpoint, {
          event: "RENDER_RAW_ERROR",
          error: rawError,
          diskPause,
          enospc,
          stage: existsSync(audioPartialPath) ? "FINAL_AUDIO_MUX" : existsSync(partialPath) ? "BASE_MASTER" : "UNKNOWN",
        });
        if (error instanceof DOMException && error.name === "AbortError" && signal?.reason !== "APP_CLOSED") {
          await this.checkpoints.discard(currentProject.id, checkpoint.checkpointId);
        } else {
          if (diskPause || enospc) {
            const recoverablePath = existsSync(audioPartialPath)
              ? audioPartialPath
              : existsSync(partialPath)
                ? partialPath
                : undefined;
            if (recoverablePath) {
              try {
                const partialStat = await stat(recoverablePath);
                const partialInfo = await new MediaProbe().probe(recoverablePath);
                checkpoint.recoverablePartial = {
                  path: recoverablePath,
                  sizeBytes: partialStat.size,
                  durationMs: partialInfo.durationMs,
                  videoCodec: partialInfo.videoCodec,
                  audioCodec: partialInfo.audioCodec,
                  recordedAt: new Date().toISOString(),
                };
                preserveBasePartial = recoverablePath === partialPath;
                preserveAudioPartial = recoverablePath === audioPartialPath;
              } catch (partialError) {
                // Keep the file even when probe cannot validate it. Recovery is
                // a separate explicit step; the source is never deleted here.
                preserveBasePartial = recoverablePath === partialPath;
                preserveAudioPartial = recoverablePath === audioPartialPath;
                await this.checkpoints.appendDiagnostic(checkpoint, {
                  event: "RECOVERABLE_PARTIAL_PROBE_FAILED",
                  path: recoverablePath,
                  error: partialError instanceof Error ? partialError.message : String(partialError),
                });
              }
            }
            const disk = diskPause
              ? error.snapshot
              : await diskMonitor.snapshot("RENDER_ENOSPC", checkpoint.diskState?.failedPath);
            const failedPath = diskPause
              ? error.failedPath
              : checkpoint.diskState?.failedPath ?? (existsSync(audioPartialPath) ? audioPartialPath : partialPath);
            checkpoint.concatStatus = "PAUSED_DISK_SPACE";
            const requiredAdditionalText = disk.requiredAdditionalBytes > 0
              ? `建議至少再釋放：${(disk.requiredAdditionalBytes / 1024 ** 3).toFixed(1)} GB`
              : "目前快照未顯示額外缺口；請重新檢查工作磁碟後再續轉。";
            checkpoint.lastError = [
              "轉檔因磁碟空間不足而中止，已完成 checkpoint 片段保留。",
              `發生磁碟：${disk.tempVolume === disk.outputVolume ? disk.tempVolume : `${disk.tempVolume} / ${disk.outputVolume}`}`,
              `失敗路徑：${failedPath ?? "未能判定"}`,
              `目前可用：${(Math.min(disk.tempFreeBytes, disk.outputFreeBytes) / 1024 ** 3).toFixed(2)} GB`,
              requiredAdditionalText,
              recoverablePath ? `已保留可檢驗的部分輸出：${recoverablePath}` : "未找到可保留的部分輸出。",
            ].join("\n");
            checkpoint.diskState = {
              status: enospc ? "FAILED_ENOSPC" : "PAUSED_DISK_SPACE",
              lastSnapshot: disk,
              failedPath,
              requiredAdditionalBytes: disk.requiredAdditionalBytes,
              completedSegmentCount: checkpoint.segments.filter((segment) => segment.status === "COMPLETED").length,
              resumable: true,
            };
          } else {
            checkpoint.concatStatus = "FAILED";
            checkpoint.lastError =
              signal?.reason === "APP_CLOSED"
                ? "APP 已關閉或 Windows 工作階段中止；已完成片段已保存，可於下次啟動續轉。"
                : error instanceof Error
                  ? error.message
                  : String(error);
          }
          await this.checkpoints.save(checkpoint);
          await this.checkpoints.appendDiagnostic(checkpoint, {
            event: diskPause || enospc ? "RENDER_PAUSED_DISK_SPACE" : "RENDER_FAILED",
            error: checkpoint.lastError,
            completedSegmentCount: checkpoint.segments.filter((segment) => segment.status === "COMPLETED").length,
            resources: checkpoint.latestResources,
            diskState: checkpoint.diskState,
          });
        }
      }
      if (diskPause || enospc) return Promise.reject(new Error(checkpoint?.lastError ?? String(error)));
      throw memoryFailureMessage(
        error,
        checkpoint?.segments.filter((segment) => segment.status === "COMPLETED").length ?? 0,
      );
    } finally {
      if (!preserveBasePartial) await rm(partialPath, { force: true });
      await rm(filterScriptPath, { force: true });
      if (!preserveAudioPartial) await rm(audioPartialPath, { force: true });
      await rm(audioFilterScriptPath, { force: true });
      if (checkpoint && renderSucceeded) await rm(checkpoint.workRoot, { recursive: true, force: true });
      if (mainStartTextPaths)
        await Promise.all([
          rm(mainStartTextPaths.line1, { force: true }),
          rm(mainStartTextPaths.line2, { force: true }),
        ]);
      if (watermarkTextPaths)
        await Promise.all([
          rm(watermarkTextPaths.chinese, { force: true }),
          rm(watermarkTextPaths.english, { force: true }),
        ]);
      await subtitleCleanup?.();
    }
  }
}
