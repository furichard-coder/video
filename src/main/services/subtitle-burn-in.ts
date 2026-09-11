import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MainStartCardOptions,
  PreviewResolution,
  ProjectManifest,
  RenderClipSelection,
  SubtitleBurnInOptions,
  SubtitleRenderLanguage,
  SubtitleRenderPosition,
} from "../../shared/domain";
import { mainRenderSelections } from "../../shared/editing-rules";
import { buildTimelinePlan } from "../../shared/timeline-plan";
import type { SubtitleTranslationResult } from "./subtitle-translation";
import { sanitizeSubtitleBurnInOptions } from "./user-preferences";

const RESOLUTIONS: Record<PreviewResolution, { width: number; height: number }> = {
  "360P": { width: 640, height: 360 },
  "480P": { width: 854, height: 480 },
  "720P": { width: 1280, height: 720 },
  "4K": { width: 3840, height: 2160 },
};

const FONT_NAMES: Record<SubtitleRenderLanguage, string> = {
  "zh-TW": "Microsoft JhengHei",
  "zh-CN": "Microsoft YaHei",
  en: "Arial",
  ja: "Yu Gothic",
  ko: "Malgun Gothic",
};

function assTime(milliseconds: number): string {
  const centiseconds = Math.max(0, Math.round(milliseconds / 10));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function splitLongToken(token: string, maxLength: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < token.length; index += maxLength) parts.push(token.slice(index, index + maxLength));
  return parts;
}

export function wrapSubtitleText(text: string, maxCharacters: number): string[] {
  const limit = Math.max(4, Math.floor(maxCharacters));
  const explicit = text.replace(/\r/g, "").split("\n");
  const result: string[] = [];
  for (const paragraph of explicit) {
    if (!paragraph) {
      result.push("");
      continue;
    }
    const tokens = /\s/.test(paragraph)
      ? paragraph.split(/\s+/).flatMap((token) => splitLongToken(token, limit))
      : splitLongToken(paragraph, limit);
    let line = "";
    for (const token of tokens) {
      const candidate = line ? `${line} ${token}` : token;
      if (candidate.length <= limit) line = candidate;
      else {
        if (line) result.push(line);
        line = token;
      }
    }
    if (line) result.push(line);
  }
  return result.length ? result : [""];
}

function escapeAssLine(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}");
}

function assColor(hex: string): string {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "FFFFFF";
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`;
}

function positionOverride(
  position: SubtitleRenderPosition,
  lane: number,
  laneCount: number,
  width: number,
  height: number,
  fontSize: number,
): string {
  const margin = Math.max(18, Math.round(height * 0.055));
  const spacing = Math.round(fontSize * 1.7);
  if (position === "TOP") return `{\\an8\\pos(${Math.round(width / 2)},${margin + lane * spacing})}`;
  if (position === "MIDDLE")
    return `{\\an5\\pos(${Math.round(width / 2)},${Math.round(height / 2 + (lane - (laneCount - 1) / 2) * spacing)})}`;
  return `{\\an2\\pos(${Math.round(width / 2)},${height - margin - lane * spacing})}`;
}

export interface SubtitleAssBuildResult {
  content: string;
  eventCount: number;
  languages: SubtitleRenderLanguage[];
}

export type SubtitleOutputScope = "MAIN" | "INTRO" | "MAIN_WITH_INTRO";

/** Subtitle-page preview pixels are defined against its 480p review canvas. */
export function subtitleFrameFontSize(fontSizePx: number, frameHeight: number): number {
  return Math.max(12, Math.round((fontSizePx * frameHeight) / 480));
}

export function validateSubtitleBurnInOptions(rawOptions: SubtitleBurnInOptions): SubtitleBurnInOptions {
  if (
    !rawOptions ||
    rawOptions.enabled !== true ||
    !Array.isArray(rawOptions.tracks) ||
    rawOptions.tracks.length < 1 ||
    rawOptions.tracks.length > 2
  ) {
    throw new Error("字幕嵌入需選擇一至兩種語言。");
  }
  const options = sanitizeSubtitleBurnInOptions(rawOptions);
  if (
    options.tracks.length !== rawOptions.tracks.length ||
    options.tracks.some((track, index) => {
      const raw = rawOptions.tracks[index];
      return (
        track.language !== raw.language || track.position !== raw.position || track.fontSize1080p !== raw.fontSize1080p
      );
    })
  )
    throw new Error("字幕語言不可重複，位置或文字大小設定無效（大小須為 24–96）。");
  return options;
}

export function buildSubtitleAss(
  project: ProjectManifest,
  outputClips: RenderClipSelection[],
  introClipCount: number,
  transitionSeconds: number,
  resolution: PreviewResolution,
  rawOptions: SubtitleBurnInOptions,
  translations: SubtitleTranslationResult,
  mainStartCard?: MainStartCardOptions,
  outputScope: SubtitleOutputScope = introClipCount > 0 ? "MAIN_WITH_INTRO" : "MAIN",
): SubtitleAssBuildResult {
  const options = validateSubtitleBurnInOptions(rawOptions);
  const includesMain = outputScope !== "INTRO";
  const includesIntro = outputScope !== "MAIN";
  const confirmed = project.subtitleCues.filter(
    (cue) =>
      (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" &&
      ((cue.timelineScope ?? "MAIN") === "INTRO" ? includesIntro : includesMain),
  );
  if (!confirmed.length) throw new Error("沒有已確認的字幕可嵌入影片。");
  if (
    (includesMain &&
      (project.mainSubtitleReviewRevision ?? project.subtitleTimelineRevision) !==
        (project.mainTimelineRevision ?? project.timelineRevision)) ||
    (includesIntro &&
      (project.introSubtitleReviewRevision ?? project.subtitleTimelineRevision) !==
        (project.introTimelineRevision ?? project.timelineRevision))
  ) {
    throw new Error("正片或片頭順序／IN／OUT 已變更，請先逐項複核並保存字幕，再嵌入影片。");
  }
  const mainClips = includesMain ? mainRenderSelections(project) : [];
  const canonicalMainPlan = includesMain
    ? buildTimelinePlan(project, { includeIntro: false, transitionSeconds })
    : undefined;
  if (canonicalMainPlan && canonicalMainPlan.clips.length !== mainClips.length)
    throw new Error("字幕時間線與目前正片計畫不一致。");
  const expectedIntroCount = includesIntro ? introClipCount : 0;
  if (
    (outputScope === "INTRO" && introClipCount !== outputClips.length) ||
    (outputScope === "MAIN" && introClipCount !== 0) ||
    outputClips.length !== expectedIntroCount + mainClips.length
  )
    throw new Error("字幕時間線與目前輸出片段不一致。");
  const { width, height } = RESOLUTIONS[resolution];
  const transitionMs = Math.round(transitionSeconds * 1000);
  const outputStarts: number[] = [];
  let outputCursor = 0;
  for (let index = 0; index < outputClips.length; index += 1) {
    outputStarts.push(outputCursor);
    outputCursor +=
      outputClips[index].outMs - outputClips[index].inMs - (index < outputClips.length - 1 ? transitionMs : 0);
  }
  if (mainStartCard && introClipCount > 0 && introClipCount < outputStarts.length) {
    const cardDurationMs = Math.round(mainStartCard.durationSeconds * 1000);
    const mainShiftMs =
      mainStartCard.transitionStyle === "HARD_CUT" ? cardDurationMs + transitionMs : cardDurationMs - transitionMs;
    for (let index = introClipCount; index < outputStarts.length; index += 1) outputStarts[index] += mainShiftMs;
  }
  const mainLogicalStarts: number[] = [];
  let mainCursor = 0;
  for (let index = 0; index < mainClips.length; index += 1) {
    const clip = mainClips[index];
    mainLogicalStarts.push(mainCursor);
    mainCursor += clip.outMs - clip.inMs - (index < mainClips.length - 1 ? transitionMs : 0);
  }
  const introClips = outputClips.slice(0, introClipCount);
  const introLogicalStarts: number[] = [];
  let introCursor = 0;
  for (let index = 0; index < introClips.length; index += 1) {
    const clip = introClips[index];
    introLogicalStarts.push(introCursor);
    introCursor += clip.outMs - clip.inMs - (index < introClips.length - 1 ? transitionMs : 0);
  }

  const sharedStyle = options.styleProfile;
  // The first track is the subtitle-page preview track, so its rendered size
  // and vertical position must use the same 480p reference profile. Optional
  // translated tracks retain their own 1080p size and position controls.
  const resolvedFontSizes = options.tracks.map((track, index) =>
    sharedStyle && index === 0
      ? subtitleFrameFontSize(sharedStyle.fontSizePx, height)
      : Math.max(12, Math.round((track.fontSize1080p * height) / 1080)),
  );
  const styles = options.tracks.map((track, index) => {
    const fontSize = resolvedFontSizes[index];
    const outline = sharedStyle
      ? Math.max(0, Math.round((sharedStyle.outlineWidthPx * height) / 480))
      : Math.max(0, Math.round((2 * height) / 1080));
    const shadow = sharedStyle?.shadowEnabled === false ? 0 : Math.max(1, Math.round(fontSize * 0.035));
    return `Style: Lang${index + 1},${FONT_NAMES[track.language]},${fontSize},${assColor(sharedStyle?.textColor ?? "#FFFFFF")},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,20,20,20,1`;
  });
  const events: string[] = [];
  options.tracks.forEach((track, trackIndex) => {
    const trackTexts = translations.byLanguage[track.language];
    if (!trackTexts || trackTexts.length !== confirmed.length)
      throw new Error(`找不到 ${track.language} 的完整字幕文字。`);
    const laneCount = options.tracks.filter((candidate) => candidate.position === track.position).length;
    const lane = options.tracks
      .slice(0, trackIndex)
      .filter((candidate) => candidate.position === track.position).length;
    const fontSize = resolvedFontSizes[trackIndex];
    const cjk = track.language !== "en";
    const maxCharacters = Math.max(8, Math.floor((width * 0.82) / (fontSize * (cjk ? 1 : 0.58))));
    confirmed.forEach((cue, cueIndex) => {
      const scope = cue.timelineScope ?? "MAIN";
      const scopedClips = scope === "INTRO" ? introClips : mainClips;
      const logicalStarts = scope === "INTRO" ? introLogicalStarts : mainLogicalStarts;
      const outputOffset = scope === "INTRO" ? 0 : introClipCount;
      for (let clipIndex = 0; clipIndex < scopedClips.length; clipIndex += 1) {
        const logicalStart = logicalStarts[clipIndex];
        const logicalEnd = logicalStart + scopedClips[clipIndex].outMs - scopedClips[clipIndex].inMs;
        const overlapStart = Math.max(cue.startMs, logicalStart);
        const overlapEnd = Math.min(cue.endMs, logicalEnd);
        if (overlapEnd <= overlapStart) continue;
        const actualStart = outputStarts[outputOffset + clipIndex] + overlapStart - logicalStart;
        const actualEnd = outputStarts[outputOffset + clipIndex] + overlapEnd - logicalStart;
        const text = wrapSubtitleText(trackTexts[cueIndex], maxCharacters).map(escapeAssLine).join("\\N");
        const position =
          sharedStyle && trackIndex === 0
            ? ((sharedStyle.verticalPositionPercent < 38
                ? "TOP"
                : sharedStyle.verticalPositionPercent > 64
                  ? "BOTTOM"
                  : "MIDDLE") as SubtitleRenderPosition)
            : track.position;
        const override = positionOverride(position, lane, laneCount, width, height, fontSize);
        events.push(
          `Dialogue: ${trackIndex},${assTime(actualStart)},${assTime(actualEnd)},Lang${trackIndex + 1},,0,0,0,,${override}${text}`,
        );
      }
    });
  });
  const content = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...events,
    "",
  ].join("\n");
  return { content, eventCount: events.length, languages: options.tracks.map((track) => track.language) };
}

export async function writeSubtitleAss(
  cacheRoot: string,
  content: string,
): Promise<{ path: string; cleanup(): Promise<void> }> {
  await mkdir(cacheRoot, { recursive: true });
  const outputPath = path.join(cacheRoot, `${randomUUID()}.ass`);
  await writeFile(outputPath, `\uFEFF${content}`, { encoding: "utf8", flag: "wx" });
  return { path: outputPath, cleanup: () => rm(outputPath, { force: true }) };
}

export function escapeFfmpegFilterPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}
