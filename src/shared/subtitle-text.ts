/**
 * Shared subtitle text helpers. The renderer preview overlay and the Main
 * ASS burn-in both use these so the preview shows exactly how cues wrap
 * in the finished file.
 */

/** Reference canvas width the subtitle-page preview is defined against. */
export const SUBTITLE_WRAP_REFERENCE_WIDTH = 854;
/** Lower bound of the automatic width-derived wrap. */
export const SUBTITLE_WRAP_AUTO_MIN = 8;
/** Bounds of the manual per-line override (same in UI, sanitize and burn-in). */
export const SUBTITLE_WRAP_MANUAL_MIN = 6;
export const SUBTITLE_WRAP_MANUAL_MAX = 60;
/** Safe canonical canvas bounds for cue-specific subtitle placement. */
export const SUBTITLE_CUE_POSITION_MIN_PERCENT = 5;
export const SUBTITLE_CUE_POSITION_MAX_PERCENT = 95;
export const SUBTITLE_CUE_POSITION_NUDGE_PERCENT = 1;
export const SUBTITLE_CUE_POSITION_LARGE_NUDGE_PERCENT = 5;
export const SUBTITLE_WRAP_CHINESE_DEFAULT = 12;
export const SUBTITLE_WRAP_ENGLISH_MIXED_DEFAULT = 20;

export function splitLongToken(token: string, maxLength: number): string[] {
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

/** CJK glyphs are full-width; latin glyphs average ~0.58 of a CJK advance. */
export function isCjkText(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(text);
}

/** English letters make the cue English/mixed; Chinese-only cues use 12. */
export function defaultSubtitleLineWidth(text: string): number {
  return /[A-Za-z]/.test(text) || !isCjkText(text)
    ? SUBTITLE_WRAP_ENGLISH_MIXED_DEFAULT
    : SUBTITLE_WRAP_CHINESE_DEFAULT;
}

/**
 * Cue-specific width wins, then the optional global bulk override. Otherwise
 * use the explicit v0.60 text-language defaults rather than frame heuristics.
 */
export function resolveCueSubtitleWrapLimit(
  cueOverride: number | undefined,
  globalOverride: number | undefined,
  text: string,
): number {
  const candidate = cueOverride ?? globalOverride ?? defaultSubtitleLineWidth(text);
  return Math.max(SUBTITLE_WRAP_MANUAL_MIN, Math.min(SUBTITLE_WRAP_MANUAL_MAX, Math.floor(candidate)));
}

/**
 * Preview overlay anchor matching the burned ASS anchor for the same
 * vertical position: TOP grows down, BOTTOM grows up, MIDDLE stays centered.
 * Thresholds mirror the burn-in position mapping so multi-line blocks drift
 * the same way on screen and in the file.
 */
export function overlayAnchorForPosition(verticalPositionPercent: number): "TOP" | "MIDDLE" | "BOTTOM" {
  if (verticalPositionPercent < 38) return "TOP";
  if (verticalPositionPercent > 64) return "BOTTOM";
  return "MIDDLE";
}

/** Subtitle style values are authored on the same 854x480 canvas used by the UI. */
export function subtitleFrameFontSize(fontSizePx: number, frameHeight: number): number {
  return Math.max(12, Math.round((fontSizePx * frameHeight) / 480));
}

export function subtitleFrameOutlineWidth(outlineWidthPx: number, frameHeight: number): number {
  return Math.max(0, Math.round((outlineWidthPx * frameHeight) / 480));
}

export function subtitleFrameShadowSize(fontSizePx: number, frameHeight: number): number {
  return Math.max(1, Math.round(subtitleFrameFontSize(fontSizePx, frameHeight) * 0.035));
}

export function subtitleFramePositionY(verticalPositionPercent: number, frameHeight: number): number {
  return Math.round((Math.max(0, Math.min(100, verticalPositionPercent)) / 100) * frameHeight);
}

export interface ResolvedSubtitleCuePosition {
  xPercent: number;
  yPercent: number;
  xPx: number;
  yPx: number;
  anchor: "TOP" | "MIDDLE" | "BOTTOM";
}

/**
 * Single position resolver used by both the responsive preview and final ASS.
 * Missing cue coordinates are deliberately identical to the pre-v0.71 output.
 */
export function resolveSubtitleCuePosition(
  cuePosition: { xPercent: number; yPercent: number } | undefined,
  globalVerticalPositionPercent: number,
  frameWidth: number,
  frameHeight: number,
): ResolvedSubtitleCuePosition {
  const clamp = (value: number) =>
    Math.max(SUBTITLE_CUE_POSITION_MIN_PERCENT, Math.min(SUBTITLE_CUE_POSITION_MAX_PERCENT, value));
  const xPercent = cuePosition ? clamp(cuePosition.xPercent) : 50;
  const yPercent = cuePosition ? clamp(cuePosition.yPercent) : clamp(globalVerticalPositionPercent);
  return {
    xPercent,
    yPercent,
    xPx: Math.round((xPercent / 100) * frameWidth),
    yPx: Math.round((yPercent / 100) * frameHeight),
    anchor: overlayAnchorForPosition(yPercent),
  };
}

export type SubtitleCueNudgeDirection = "UP" | "DOWN" | "LEFT" | "RIGHT";

export function nudgeSubtitleCuePosition(
  cuePosition: { xPercent: number; yPercent: number } | undefined,
  globalVerticalPositionPercent: number,
  direction: SubtitleCueNudgeDirection,
  largeStep = false,
): { xPercent: number; yPercent: number } {
  const current = resolveSubtitleCuePosition(cuePosition, globalVerticalPositionPercent, 100, 100);
  const step = largeStep ? SUBTITLE_CUE_POSITION_LARGE_NUDGE_PERCENT : SUBTITLE_CUE_POSITION_NUDGE_PERCENT;
  const xPercent = current.xPercent + (direction === "LEFT" ? -step : direction === "RIGHT" ? step : 0);
  const yPercent = current.yPercent + (direction === "UP" ? -step : direction === "DOWN" ? step : 0);
  return {
    xPercent: Math.max(SUBTITLE_CUE_POSITION_MIN_PERCENT, Math.min(SUBTITLE_CUE_POSITION_MAX_PERCENT, xPercent)),
    yPercent: Math.max(SUBTITLE_CUE_POSITION_MIN_PERCENT, Math.min(SUBTITLE_CUE_POSITION_MAX_PERCENT, yPercent)),
  };
}

/**
 * Effective per-line character limit. A manual override (already clamped to
 * 6–60 by UI/sanitize) wins; otherwise derive from the frame width and font
 * size exactly as before, so older styles render identically.
 */
export function resolveSubtitleWrapLimit(
  maxCharactersPerLine: number | undefined,
  width: number,
  fontSize: number,
  cjk: boolean,
): number {
  if (maxCharactersPerLine !== undefined) {
    const manual = Math.floor(maxCharactersPerLine);
    if (Number.isFinite(manual)) return Math.max(SUBTITLE_WRAP_MANUAL_MIN, Math.min(SUBTITLE_WRAP_MANUAL_MAX, manual));
  }
  return Math.max(SUBTITLE_WRAP_AUTO_MIN, Math.floor((width * 0.82) / (fontSize * (cjk ? 1 : 0.58))));
}
