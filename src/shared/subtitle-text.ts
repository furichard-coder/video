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
export const SUBTITLE_WRAP_MANUAL_MAX = 40;

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

/**
 * Effective per-line character limit. A manual override (already clamped to
 * 6–40 by UI/sanitize) wins; otherwise derive from the frame width and font
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
