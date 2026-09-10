import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
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
} from "../../shared/domain";
import { DEFAULT_MAIN_START_CARD_OPTIONS, DEFAULT_ZOOM_ENHANCEMENT_PRESET } from "../../shared/domain";
import { colorPreset } from "../../shared/color-presets";
import { DEFAULT_INTRO_TARGET_DURATION_MS, DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT, INTRO_MAX_SEGMENTS, INTRO_MIN_SEGMENT_MS, MAX_IMAGE_DURATION_MS, MIN_IMAGE_DURATION_MS } from "../../shared/domain";
import { assertSafeHexId } from "./path-safety";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import { MediaProbe } from "./media-probe";
import { finalizePartialOutput } from "./atomic-output";
import { imageDurationMs, mainRenderSelections } from "../../shared/editing-rules";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import { buildSubtitleAss, escapeFfmpegFilterPath, validateSubtitleBurnInOptions, writeSubtitleAss } from "./subtitle-burn-in";
import type { SubtitleTranslationService } from "./subtitle-translation";
import { normalizeWatermarkSettings, watermarkAppliesToPurpose, watermarkRenderedText } from "../../shared/watermark";

export interface ConcatInput {
  sourcePath: string;
  startMs?: number;
  durationMs: number;
  hasAudio: boolean;
  isImage?: boolean;
  isPortrait?: boolean;
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
}

export interface BgmRenderInput extends BgmTrack {}

export interface ConcatFilterPlan {
  filterGraph: string;
  videoOutputLabel: string;
  audioOutputLabel: string;
  expectedDurationMs: number;
  width: number;
  height: number;
}

export interface WatermarkRenderResources {
  chineseTextFilePath: string;
  englishTextFilePath: string;
  chineseFontFilePath: string;
  englishFontFilePath: string;
}

const RESOLUTIONS: Record<PreviewResolution, { width: number; height: number }> = {
  "360P": { width: 640, height: 360 },
  "480P": { width: 854, height: 480 },
  "720P": { width: 1280, height: 720 },
  "4K": { width: 3840, height: 2160 },
};

const TRANSITIONS = new Set<TransitionDurationSec>([0.3, 0.5, 0.7]);
const RESOLUTION_NAMES = new Set<PreviewResolution>(["360P", "480P", "720P", "4K"]);
const MAIN_START_TRANSITIONS = new Set(["DISSOLVE", "FADE_BLACK", "HARD_CUT"] as const);

export function validateMainStartCardOptions(raw: MainStartCardOptions): MainStartCardOptions {
  if (!raw || typeof raw !== "object") throw new Error("請先完成正片開始提示頁設定。");
  const integerInRange = (value: unknown, minimum: number, maximum: number) => Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
  if (!integerInRange(raw.durationSeconds, 3, 7)) throw new Error("正片開始提示頁須為 3–7 秒。");
  if (typeof raw.line1 !== "string" || !raw.line1.trim() || raw.line1.length > 80 || /[\r\n]/.test(raw.line1)) throw new Error("提示頁第一行文字須為 1–80 個字且不可換行。");
  if (typeof raw.line2 !== "string" || !raw.line2.trim() || raw.line2.length > 80 || /[\r\n]/.test(raw.line2)) throw new Error("提示頁第二行文字須為 1–80 個字且不可換行。");
  if (!integerInRange(raw.line1FontSize1080p, 36, 180) || !integerInRange(raw.line2FontSize1080p, 30, 160)) throw new Error("提示頁文字大小設定無效。");
  if (!integerInRange(raw.lineGap1080p, 50, 240)) throw new Error("提示頁兩行文字間距設定無效。");
  if (!integerInRange(raw.overlayOpacityPercent, 30, 85)) throw new Error("半透明遮罩須為 30%–85%。");
  if (!MAIN_START_TRANSITIONS.has(raw.transitionStyle)) throw new Error("正片開始提示頁轉場選項無效。");
  if (raw.backgroundIntroSegmentId !== undefined && (typeof raw.backgroundIntroSegmentId !== "string" || !raw.backgroundIntroSegmentId.trim() || raw.backgroundIntroSegmentId.length > 200 || /[\r\n\0]/.test(raw.backgroundIntroSegmentId))) {
    throw new Error("提示頁背景片頭片段識別無效。");
  }
  return { ...raw, line1: raw.line1.trim(), line2: raw.line2.trim(), backgroundIntroSegmentId: raw.backgroundIntroSegmentId?.trim() || undefined };
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
  const chinese = ["msjhbd.ttc", "msjh.ttc", "msyhbd.ttc", "msyh.ttc", "arial.ttf"].map((name) => path.join(windowsRoot, "Fonts", name)).find(existsSync);
  const english = ["arial.ttf", "segoeuib.ttf", "msjhbd.ttc", "msjh.ttc"].map((name) => path.join(windowsRoot, "Fonts", name)).find(existsSync);
  if (!chinese || !english) throw new Error("找不到可用的 Windows 浮水印字型，已阻擋輸出。");
  return { chinese, english };
}

function ffmpegNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function watermarkAlphaExpression(settings: WatermarkSettings): string {
  const phase = `mod(t-${ffmpegNumber(settings.startSeconds)},${ffmpegNumber(settings.intervalSeconds)})`;
  const visible = ffmpegNumber(settings.visibleDurationSeconds);
  const fadeIn = settings.fadeInSeconds;
  const fadeOut = settings.fadeOutSeconds;
  let envelope = "1";
  if (fadeIn > 0 && fadeOut > 0) envelope = `if(lt(${phase},${ffmpegNumber(fadeIn)}),${phase}/${ffmpegNumber(fadeIn)},if(lt(${phase},${ffmpegNumber(settings.visibleDurationSeconds - fadeOut)}),1,(${visible}-${phase})/${ffmpegNumber(fadeOut)}))`;
  else if (fadeIn > 0) envelope = `if(lt(${phase},${ffmpegNumber(fadeIn)}),${phase}/${ffmpegNumber(fadeIn)},1)`;
  else if (fadeOut > 0) envelope = `if(lt(${phase},${ffmpegNumber(settings.visibleDurationSeconds - fadeOut)}),1,(${visible}-${phase})/${ffmpegNumber(fadeOut)})`;
  return `${ffmpegNumber(settings.textOpacityPercent / 100)}*${envelope}`;
}

export function buildWatermarkFilterChain(settings: WatermarkSettings, width: number, height: number, resources: WatermarkRenderResources): string {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error("浮水印輸出解析度無效。");
  const normalized = normalizeWatermarkSettings(settings);
  const scale = height / 1080;
  const margin = Math.max(6, Math.round(normalized.safeMargin1080p * scale));
  const boxBorder = Math.max(4, Math.round(18 * scale));
  const shadow = Math.max(1, Math.round(3 * scale));
  const phase = `mod(t-${ffmpegNumber(normalized.startSeconds)},${ffmpegNumber(normalized.intervalSeconds)})`;
  const enable = `gte(t,${ffmpegNumber(normalized.startSeconds)})*lt(${phase},${ffmpegNumber(normalized.visibleDurationSeconds)})`;
  const alpha = watermarkAlphaExpression(normalized);
  const draw = (item: WatermarkSettings["chinese"], textFilePath: string, fontFilePath: string, shadowOpacity: number) => {
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

function localZoomSegments(input: ConcatInput): Array<ZoomSegment & { localStartSeconds: number; localEndSeconds: number }> {
  const sourceStartMs = input.startMs ?? 0;
  const sourceEndMs = sourceStartMs + input.durationMs;
  return (input.zoomSegments ?? [])
    .filter((segment) => segment.endMs > sourceStartMs && segment.startMs < sourceEndMs && (segment.zoomPercent > 100 || (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) !== "OFF"))
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

function zoomExpression(segments: ReturnType<typeof localZoomSegments>, value: (segment: ZoomSegment) => number, fallback: number): string {
  return segments.reduceRight((next, segment) => `if(between(in_time,${ffmpegNumber(segment.localStartSeconds)},${ffmpegNumber(segment.localEndSeconds)}),${ffmpegNumber(value(segment))},${next})`, ffmpegNumber(fallback));
}

export function buildConcatFilterGraph(
  inputs: ConcatInput[],
  transitionSeconds: TransitionDurationSec,
  resolution: PreviewResolution,
  bgmInputs: BgmRenderInput[] = [],
  sourceAudioVolumePercent: number = DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT,
  portrait = false,
): ConcatFilterPlan {
  if (inputs.length < 1) throw new Error("至少需要一個影片或照片片段才能產出預覽。");
  if (!TRANSITIONS.has(transitionSeconds)) throw new Error("疊化秒數只支援 0.3、0.5 或 0.7 秒。");
  if (!RESOLUTION_NAMES.has(resolution)) throw new Error("預覽解析度只支援 360p、480p、720p 或 4K。");

  const transitionMs = transitionSeconds * 1000;
  for (const input of inputs) {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 100 || (inputs.length > 1 && input.durationMs <= transitionMs + 50)) {
      throw new Error(`片段長度必須大於 ${transitionSeconds} 秒，才能建立完整疊化。`);
    }
  }

  const { width, height } = portrait ? { width: 1080, height: 1920 } : RESOLUTIONS[resolution];
  const filters: string[] = [];
  inputs.forEach((input, index) => {
    const colorChain = input.colorFilters?.length ? `,${input.colorFilters.join(",")}` : "";
    const zooms = input.isImage || input.mainStartCard ? [] : localZoomSegments(input);
    const baseVideoLabel = zooms.length || input.mainStartCard ? `vbase${index}` : `v${index}`;
    if (input.isPortrait || portrait) {
      filters.push(`[${index}:v:0]fps=30000/1001,split=2[pbg${index}][pfg${index}]`);
      filters.push(`[pbg${index}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=luma_radius=min(h\\,w)/30:luma_power=1[blur${index}]`);
      filters.push(`[pfg${index}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2[front${index}]`);
      filters.push(`[blur${index}][front${index}]overlay=(W-w)/2:(H-h)/2${colorChain},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${baseVideoLabel}]`);
    } else {
      filters.push(`[${index}:v:0]fps=30000/1001,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black${colorChain},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${baseVideoLabel}]`);
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
        filters.push(`[${beforeZoomLabel}]${ZOOM_ENHANCEMENT_FILTERS[preset].denoise}:enable='${timing}'[${nextLabel}]`);
        beforeZoomLabel = nextLabel;
      });
      const hasSharpen = zooms.some((segment) => (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) !== "OFF");
      const zoomOutputLabel = hasSharpen ? `vzoom${index}` : `v${index}`;
      filters.push(`[${beforeZoomLabel}]zoompan=z='${zoom}':x='(iw-iw/zoom)*${centerX}':y='(ih-ih/zoom)*${centerY}':d=1:s=${width}x${height}:fps=30000/1001,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${zoomOutputLabel}]`);
      let afterZoomLabel = zoomOutputLabel;
      const sharpened = zooms.filter((segment) => (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) !== "OFF");
      sharpened.forEach((segment, segmentIndex) => {
        const preset = (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET) as Exclude<ZoomEnhancementPreset, "OFF">;
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
      const localSegments = (input.volumeSegments ?? []).map((segment) => ({
        start: Math.max(0, segment.startMs - startMs) / 1000,
        end: Math.min(input.durationMs, segment.endMs - startMs) / 1000,
        gain: segment.volumePercent / 100,
      })).filter((segment) => segment.end > segment.start);
      const volumeExpression = localSegments.reduceRight((fallback, segment) => `if(between(t,${ffmpegNumber(segment.start)},${ffmpegNumber(segment.end)}),${ffmpegNumber(segment.gain)},${fallback})`, ffmpegNumber(sourceAudioVolumePercent / 100));
      filters.push(
        `[${index}:a:0]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume='${volumeExpression}':eval=frame,apad,atrim=duration=${ffmpegNumber(input.durationMs / 1000)},asetpts=PTS-STARTPTS[a${index}]`,
      );
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
    const cardTransition = inputs[index].mainStartCard?.transitionStyle ?? inputs[index - 1].mainStartCard?.transitionStyle;
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
    if (track.timelineInMs < 0 || track.timelineInMs >= expectedDurationMs) throw new Error(`配樂「${track.fileName}」的開始時間已超出目前影片總時間。`);
    const shutterInputCount = inputs.filter((input) => input.photoSoundInputIndex !== undefined).length;
    const inputIndex = inputs.length + shutterInputCount + bgmIndex;
    const effectiveTimelineOutMs = Math.min(track.timelineOutMs, expectedDurationMs);
    const durationSeconds = (effectiveTimelineOutMs - track.timelineInMs) / 1000;
    const effectiveSourceOutMs = Math.min(track.sourceOutMs, track.sourceInMs + durationSeconds * 1000);
    const chain = [
      `[${inputIndex}:a:0]atrim=start=${ffmpegNumber(track.sourceInMs / 1000)}:end=${ffmpegNumber(effectiveSourceOutMs / 1000)}`,
      "asetpts=PTS-STARTPTS", "aresample=48000", "aformat=sample_rates=48000:channel_layouts=stereo",
      `volume=${ffmpegNumber(track.volumePercent / 100)}`,
    ];
    if (track.fadeInMs > 0) chain.push(`afade=t=in:st=0:d=${ffmpegNumber(track.fadeInMs / 1000)}`);
    if (track.fadeOutMs > 0) {
      const effectiveFadeOut = Math.min(track.fadeOutMs / 1000, durationSeconds);
      chain.push(`afade=t=out:st=${ffmpegNumber(Math.max(0, durationSeconds - effectiveFadeOut))}:d=${ffmpegNumber(effectiveFadeOut)}`);
    }
    chain.push(`adelay=${Math.round(track.timelineInMs)}:all=1`, "apad", `atrim=duration=${ffmpegNumber(expectedDurationMs / 1000)}[bgm${bgmIndex}]`);
    filters.push(chain.join(","));
    bgmLabels.push(`bgm${bgmIndex}`);
  });
  if (bgmLabels.length) {
    filters.push(`[${originalAudioLabel}]${bgmLabels.map((label) => `[${label}]`).join("")}amix=inputs=${bgmLabels.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
    audioOutputLabel = "aout";
  } else {
    filters.push(`[${originalAudioLabel}]alimiter=limit=0.95[aout]`);
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
) => Promise<void | { cancelled: boolean; outTimeMs: number }>;

export function runFfmpegWithProgress(
  executable: string,
  args: string[],
  expectedDurationMs: number,
  signal: AbortSignal | undefined,
  onProgress: (progress: ConcatRenderProgress) => void,
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseProgressTime(line);
        if (parsed !== undefined) outTimeMs = Math.max(outTimeMs, parsed);
        if (line.startsWith("progress=")) {
          onProgress({
            phase: "RENDERING",
            percent: Math.min(99, Math.max(0, (outTimeMs / expectedDurationMs) * 100)),
            outTimeMs,
            expectedDurationMs,
          });
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-24_000);
    });

    const onAbort = () => {
      cancellationRequested = true;
      try { child.stdin.write("q\n"); child.stdin.end(); } catch { child.kill(); }
      forceKillTimer = setTimeout(() => child.kill(), 8_000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("exit", (code) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      if (cancellationRequested || signal?.aborted) {
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

export function buildVideoCodecArgs(videoCodec: "H265" | "H264"): string[] {
  if (videoCodec === "H265") return ["-c:v", "libx265", "-preset", "veryfast", "-crf", "27", "-tag:v", "hvc1"];
  if (videoCodec === "H264") return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-profile:v", "high"];
  throw new Error("影片編碼格式無效。只支援 H.265／HEVC 或 H.264／AVC。");
}

export class ConcatRenderService {
  constructor(
    private readonly store: ProjectStore,
    private readonly sources: SourceService,
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly ffmpegRunner: FfmpegProgressRunner = runFfmpegWithProgress,
    private readonly photoSoundPath?: string,
    private readonly subtitleTranslation?: SubtitleTranslationService,
    private readonly subtitleCacheRoot?: string,
  ) {}

  async render(
    request: ConcatRenderRequest,
    outputPath: string,
    signal?: AbortSignal,
    onProgress: (progress: ConcatRenderProgress) => void = () => undefined,
  ): Promise<ConcatRenderResult> {
    if (!Array.isArray(request.orderedAssetIds)) throw new Error("影片片段順序格式無效。");
    const purpose = request.purpose ?? "CONCAT";
    if (purpose !== "CONCAT" && purpose !== "INTRO" && purpose !== "CLIP" && purpose !== "SHORTS") throw new Error("預覽輸出用途無效。");
    if (request.orderedAssetIds.length < 1) throw new Error(purpose === "INTRO" ? "至少需要一個片段才能產出 Intro 預覽。" : purpose === "CLIP" ? "至少需要一個固定時間段才能輸出。" : "正片沒有可供輸出的保留片段。");
    const project = this.store.getProject();
    const videoCodec = request.videoCodec ?? "H264";
    if (videoCodec !== "H265" && videoCodec !== "H264") throw new Error("影片編碼格式無效。只支援 H.265／HEVC 或 H.264／AVC。");
    const introTargetDurationMs = project.introTargetDurationMs ?? DEFAULT_INTRO_TARGET_DURATION_MS;
    const outputIntroSegments = introSegmentsForOutput(project.introSegments, project.introSegmentMaxDurationMs);
    if (purpose === "CONCAT") {
      const introPrefix = request.prependIntro ? outputIntroSegments : [];
      if (request.prependIntro) {
        if (!introPrefix.length) throw new Error("已選擇自動串接片頭，但目前沒有已確認的 Intro 片段。");
        if (introPrefix.length > INTRO_MAX_SEGMENTS) throw new Error(`Intro 最多只能串接 ${INTRO_MAX_SEGMENTS} 段。`);
        if (introPrefix.some((clip) => clip.outMs - clip.inMs < INTRO_MIN_SEGMENT_MS || clip.outMs - clip.inMs > project.introSegmentMaxDurationMs)) throw new Error("Intro 輸出片段不符合目前每段最高時間。");
        if (introPrefix.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0) > introTargetDurationMs) throw new Error(`Intro 總長超過目前設定的 ${Math.round(introTargetDurationMs / 1000)} 秒。`);
      }
      const expected = [...introPrefix, ...mainRenderSelections(project)];
      const requested = request.clipSelections;
      if (!requested || expected.length !== requested.length || expected.some((clip, index) => clip.assetId !== requested[index]?.assetId || clip.inMs !== requested[index]?.inMs || clip.outMs !== requested[index]?.outMs || clip.mediaInsertionId !== requested[index]?.mediaInsertionId)) {
        throw new Error("串連要求與目前片頭／正片保留片段不一致；待決定或已排除範圍不可輸出。");
      }
      if (request.orderedAssetIds.length !== expected.length || request.orderedAssetIds.some((id, index) => id !== expected[index].assetId)) {
        throw new Error("串連來源順序與目前正片保留片段不一致。");
      }
    } else if (purpose === "INTRO") {
      const expected = outputIntroSegments;
      const requested = request.clipSelections;
      if (!requested || expected.length !== requested.length || expected.some((clip, index) => clip.assetId !== requested[index]?.assetId || clip.inMs !== requested[index]?.inMs || clip.outMs !== requested[index]?.outMs)) {
        throw new Error("Intro 輸出要求與目前已確認的片頭片段不一致。");
      }
      if (expected.length > INTRO_MAX_SEGMENTS) throw new Error(`Intro 最多只能輸出 ${INTRO_MAX_SEGMENTS} 段。`);
      if (expected.some((clip) => clip.outMs - clip.inMs < INTRO_MIN_SEGMENT_MS || clip.outMs - clip.inMs > project.introSegmentMaxDurationMs)) throw new Error("Intro 輸出片段不符合目前每段最高時間。");
      if (expected.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0) > introTargetDurationMs) throw new Error(`Intro 總長超過目前設定的 ${Math.round(introTargetDurationMs / 1000)} 秒。`);
    } else if (purpose === "CLIP") {
      const requested = request.clipSelections;
      if (request.resolution !== "4K") throw new Error("最高解析度時間段固定輸出為 4K（3840×2160）。");
      if (request.orderedAssetIds.length !== 1 || requested?.length !== 1 || requested[0].assetId !== request.orderedAssetIds[0]) throw new Error("固定時間段輸出只能包含一個專案影片片段。");
      if (request.prependIntro || request.subtitleBurnIn?.enabled) throw new Error("固定時間段輸出不串接片頭或字幕。");
    } else {
      if (!request.shortsPortrait) throw new Error("Shorts 必須使用 9:16 直式輸出。" );
      if (request.shortsMaxDurationSec !== 60 && request.shortsMaxDurationSec !== 180) throw new Error("Shorts 長度上限只支援 60 或 180 秒。" );
      const requested = request.clipSelections;
      const allowed = request.shortsSource === "INTRO" ? project.introSegments : mainRenderSelections(project);
      if (!requested?.length) throw new Error("Shorts 至少需要一段已選片段。" );
      if (requested.some((clip) => !allowed.some((candidate) => candidate.assetId === clip.assetId && candidate.inMs === clip.inMs && candidate.outMs === clip.outMs))) throw new Error("Shorts 包含不在目前片頭／正片清單內的片段。" );
      if (request.prependIntro) throw new Error("Shorts 不會靜默串接 16:9 Intro；請在 Shorts 頁明確選擇片段。" );
    }
    if (path.extname(outputPath).toLowerCase() !== ".mp4") throw new Error("串連預覽必須輸出為 MP4。");
    const mainStartCard = purpose === "CONCAT" && request.prependIntro
      ? validateMainStartCardOptions(request.mainStartCard ?? DEFAULT_MAIN_START_CARD_OPTIONS)
      : undefined;
    const parsed = path.parse(outputPath);
    const renderId = randomUUID();
    const mainStartTextPaths = mainStartCard ? {
      line1: path.join(parsed.dir, `.${parsed.name}.${renderId}.main-start-line1.txt`),
      line2: path.join(parsed.dir, `.${parsed.name}.${renderId}.main-start-line2.txt`),
    } : undefined;
    const watermarkSettings = normalizeWatermarkSettings(project.watermarkSettings);
    const watermarkActive = request.includeWatermark !== false && watermarkAppliesToPurpose(watermarkSettings, purpose);
    const watermarkTextPaths = watermarkActive ? {
      chinese: path.join(parsed.dir, `.${parsed.name}.${renderId}.watermark-zh.txt`),
      english: path.join(parsed.dir, `.${parsed.name}.${renderId}.watermark-en.txt`),
    } : undefined;

    onProgress({ phase: "PREPARING", percent: 0, outTimeMs: 0, expectedDurationMs: 0 });
    const assetsById = new Map<string, SourceAsset>();
    for (const assetId of new Set(request.orderedAssetIds)) {
      assertSafeHexId(assetId, "Asset ID");
      const asset = this.store.getAsset(assetId);
      if (!asset) throw new Error("串連清單包含不存在或不適用的來源。");
      assetsById.set(assetId, await this.sources.ensureMetadata(assetId, signal));
    }
    const assets = request.orderedAssetIds.map((assetId) => assetsById.get(assetId)!);
    if (assets.some((asset) => asset.metadataState !== "READY" || (asset.kind === "VIDEO" && !asset.mediaInfo?.durationMs))) {
      throw new Error("至少一項素材無法取得有效媒體資訊，請先確認格式或 codec 是否受支援。");
    }
    if (assets.some((asset) => samePath(asset.sourcePath, outputPath))) {
      throw new Error("輸出路徑不可覆蓋任何來源影片。");
    }

    if ((purpose === "INTRO" || purpose === "CLIP") && request.clipSelections?.length !== assets.length) {
      throw new Error("Intro 片段範圍與來源順序不一致。");
    }
    const inputs: ConcatInput[] = assets.map((asset, index) => {
      const isIntroClip = purpose === "INTRO" || (purpose === "CONCAT" && Boolean(request.prependIntro) && index < project.introSegments.length);
      const selectedColorPreset = colorPreset(project.colorSettings.introPresetId);
      const applyColor = isIntroClip || ((purpose === "CONCAT" || purpose === "CLIP") && project.colorSettings.applyToMain);
      const fullDurationMs = asset.kind === "IMAGE" ? (isIntroClip ? MAX_IMAGE_DURATION_MS : imageDurationMs(asset)) : asset.mediaInfo!.durationMs!;
      const introRange = request.clipSelections?.[index];
      const requestedRange = request.clipSelections?.[index] ?? asset.previewRange;
      if (introRange?.assetId !== asset.id) {
        throw new Error("片段範圍與來源影片不一致。");
      }
      const startMs = Math.round(requestedRange?.inMs ?? 0);
      const outMs = Math.round(requestedRange?.outMs ?? fullDurationMs);
      const invalidImageRange = asset.kind === "IMAGE" && (isIntroClip
        ? startMs !== 0 || outMs - startMs < MIN_IMAGE_DURATION_MS || outMs - startMs > MAX_IMAGE_DURATION_MS
        : startMs !== 0 || outMs !== fullDurationMs);
      if (startMs < 0 || outMs > fullDurationMs + 50 || outMs - startMs < 100 || invalidImageRange) {
        throw new Error(`「${asset.fileName}」的片段時間超出素材範圍。`);
      }
      return {
        sourcePath: asset.sourcePath,
        startMs,
        durationMs: outMs - startMs,
        hasAudio: asset.kind === "VIDEO" && Boolean(asset.mediaInfo?.audioCodec),
        isImage: asset.kind === "IMAGE",
        isPortrait: asset.mediaInfo?.isPortrait,
        photoSoundEnabled: asset.kind === "IMAGE" && asset.photoSoundEnabled !== false,
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
    const photoShutterAppliedCount = inputs.filter((input) => input.photoSoundEnabled).length;
    if (photoShutterAppliedCount > 0 && !this.photoSoundPath) {
      throw new Error("找不到已驗證的沙丘前案相機快門音效，已阻擋含照片的輸出；請重新封裝或確認沙丘音效來源仍存在。");
    }
    let shutterInputIndex = inputs.length;
    for (const input of inputs) {
      if (input.photoSoundEnabled) input.photoSoundInputIndex = shutterInputIndex++;
    }
    const currentProject = this.store.getProject();
    const bgmTracks = purpose === "CLIP" || request.includeBgm === false ? [] : currentProject.bgmTracks;
    for (const track of bgmTracks) {
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
    const basePlan = buildConcatFilterGraph(inputs, request.transitionSeconds, request.resolution, [], sourceAudioVolumePercent, purpose === "SHORTS");
    if (purpose === "SHORTS" && basePlan.expectedDurationMs > (request.shortsMaxDurationSec ?? 60) * 1000) throw new Error(`Shorts 總長 ${Math.ceil(basePlan.expectedDurationMs / 1000)} 秒超過目前 ${request.shortsMaxDurationSec ?? 60} 秒上限。`);
    const activeBgmTracks = bgmTracks.filter((track) => track.timelineInMs < basePlan.expectedDurationMs);
    const plan = buildConcatFilterGraph(inputs, request.transitionSeconds, request.resolution, activeBgmTracks, sourceAudioVolumePercent, purpose === "SHORTS");
    onProgress({
      phase: "PREPARING",
      percent: 0,
      outTimeMs: 0,
      expectedDurationMs: plan.expectedDurationMs,
    });

    const partialPath = path.join(parsed.dir, `.${parsed.name}.${renderId}.partial.mp4`);
    const filterScriptPath = path.join(parsed.dir, `.${parsed.name}.${renderId}.filtergraph.txt`);
    let filterGraph = plan.filterGraph;
    let videoOutputLabel = plan.videoOutputLabel;
    let subtitleCleanup: (() => Promise<void>) | undefined;
    let subtitleBurnedLanguages: SubtitleRenderLanguage[] | undefined;
    let subtitleTranslationProviders: SubtitleTranslationProvider[] | undefined;
    if (request.subtitleBurnIn?.enabled) {
      if (purpose !== "CONCAT" && purpose !== "SHORTS") throw new Error("字幕嵌入只適用於正片／Shorts 輸出，不套用片頭單獨預覽。");
      if (!this.subtitleTranslation || !this.subtitleCacheRoot) throw new Error("字幕翻譯與嵌入服務尚未初始化，已阻擋輸出。");
      const subtitleOptions = validateSubtitleBurnInOptions(request.subtitleBurnIn);
      const confirmedCues = project.subtitleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED");
      onProgress({ phase: "TRANSLATING_SUBTITLES", percent: 0, outTimeMs: 0, expectedDurationMs: plan.expectedDurationMs });
      const translated = await this.subtitleTranslation.translate(confirmedCues, subtitleOptions.tracks.map((track) => track.language), signal);
      const ass = buildSubtitleAss(project, request.clipSelections ?? [], request.prependIntro ? project.introSegments.length : 0, request.transitionSeconds, request.resolution, subtitleOptions, translated, mainStartCard);
      if (!ass.eventCount) throw new Error("已確認字幕未落在目前正片時間線內，無法嵌入影片。");
      const temporaryAss = await writeSubtitleAss(this.subtitleCacheRoot, ass.content);
      subtitleCleanup = temporaryAss.cleanup;
      filterGraph = `${filterGraph};[${videoOutputLabel}]ass=filename='${escapeFfmpegFilterPath(temporaryAss.path)}'[vsub]`;
      videoOutputLabel = "vsub";
      subtitleBurnedLanguages = ass.languages;
      subtitleTranslationProviders = translated.providers;
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
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...inputs.flatMap((input) => input.isImage
        ? ["-loop", "1", "-framerate", "30000/1001", "-t", ffmpegNumber(input.durationMs / 1000), "-i", input.sourcePath]
        : ["-ss", ffmpegNumber((input.startMs ?? 0) / 1000), "-t", ffmpegNumber(Math.min(input.durationMs, input.mainStartCard?.sourceDurationMs ?? input.durationMs) / 1000), "-i", input.sourcePath]),
      ...inputs.filter((input) => input.photoSoundEnabled).flatMap(() => ["-i", this.photoSoundPath!]),
      ...activeBgmTracks.flatMap((track) => ["-i", track.sourcePath]),
      "-filter_complex_script",
      filterScriptPath,
      "-map",
      `[${videoOutputLabel}]`,
      "-map",
      `[${plan.audioOutputLabel}]`,
      ...buildVideoCodecArgs(videoCodec),
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30000/1001",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-shortest",
      "-progress",
      "pipe:1",
      "-nostats",
      partialPath,
    ];

    try {
      await rm(partialPath, { force: true });
      await rm(filterScriptPath, { force: true });
      if (mainStartCard && mainStartTextPaths) {
        await Promise.all([
          writeFile(mainStartTextPaths.line1, mainStartCard.line1, { encoding: "utf8", flag: "wx" }),
          writeFile(mainStartTextPaths.line2, mainStartCard.line2, { encoding: "utf8", flag: "wx" }),
        ]);
      }
      if (watermarkTextPaths) {
        await Promise.all([
          writeFile(watermarkTextPaths.chinese, watermarkRenderedText(watermarkSettings.chinese), { encoding: "utf8", flag: "wx" }),
          writeFile(watermarkTextPaths.english, watermarkRenderedText(watermarkSettings.english), { encoding: "utf8", flag: "wx" }),
        ]);
      }
      await writeFile(filterScriptPath, filterGraph, { encoding: "utf8", flag: "wx" });
      const runResult = await this.ffmpegRunner(this.ffmpegExecutable, args, plan.expectedDurationMs, signal, onProgress);
      const cancelled = Boolean(runResult && runResult.cancelled);
      let completedDurationMs = plan.expectedDurationMs;
      if (cancelled) {
        try {
          const partialInfo = await new MediaProbe().probe(partialPath);
          completedDurationMs = partialInfo.durationMs ?? 0;
          if (!partialInfo.videoCodec || completedDurationMs < 300) throw new Error("取消得太早，尚無足夠畫面可完成 MP4。");
        } catch {
          throw new DOMException("取消得太早，未產生可播放影片；不完整檔已清理。", "AbortError");
        }
      }
      onProgress({
        phase: "FINALIZING",
        percent: 99,
        outTimeMs: completedDurationMs,
        expectedDurationMs: plan.expectedDurationMs,
      });
      await finalizePartialOutput(partialPath, outputPath);
      const outputStat = await stat(outputPath);
      if (!outputStat.isFile() || outputStat.size <= 0) throw new Error("輸出檔案驗證失敗。");
      const result: ConcatRenderResult = {
        jobId: randomUUID(),
        outputPath,
        sizeBytes: outputStat.size,
        expectedDurationMs: completedDurationMs,
        transitionSeconds: request.transitionSeconds,
        resolution: request.resolution,
        videoCodec,
        purpose,
        bgmAppliedCount: activeBgmTracks.length,
        photoShutterAppliedCount,
        mixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
        cancelled,
        plannedDurationMs: cancelled ? plan.expectedDurationMs : undefined,
        includedIntroSegmentCount: purpose === "CONCAT" && request.prependIntro ? project.introSegments.length : 0,
        subtitleBurnedLanguages,
        subtitleTranslationProviders,
        colorPresetId: project.colorSettings.introPresetId,
        colorAppliedToMain: purpose === "CONCAT" && project.colorSettings.applyToMain,
        watermarkApplied: watermarkActive,
        mainStartCardDurationSeconds: mainStartCard?.durationSeconds,
        shortsPortrait: purpose === "SHORTS" ? true : undefined,
        aspectRatio: purpose === "SHORTS" ? "PORTRAIT_9_16" : "LANDSCAPE_16_9",
      };
      onProgress({
        phase: "FINALIZING",
        percent: 100,
        outTimeMs: completedDurationMs,
        expectedDurationMs: plan.expectedDurationMs,
      });
      return result;
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    } finally {
      await rm(filterScriptPath, { force: true });
      if (mainStartTextPaths) await Promise.all([rm(mainStartTextPaths.line1, { force: true }), rm(mainStartTextPaths.line2, { force: true })]);
      if (watermarkTextPaths) await Promise.all([rm(watermarkTextPaths.chinese, { force: true }), rm(watermarkTextPaths.english, { force: true })]);
      await subtitleCleanup?.();
    }
  }
}
