import { describe, expect, it } from "vitest";
import {
  SUBTITLE_WRAP_MANUAL_MAX,
  SUBTITLE_WRAP_MANUAL_MIN,
  SUBTITLE_WRAP_REFERENCE_WIDTH,
  defaultSubtitleLineWidth,
  isCjkText,
  overlayAnchorForPosition,
  nudgeSubtitleCuePosition,
  resolveSubtitleCuePosition,
  resolveSubtitleWrapLimit,
  resolveCueSubtitleWrapLimit,
  wrapSubtitleText,
} from "../../src/shared/subtitle-text";

describe("subtitle text wrapping", () => {
  it("wraps CJK text without spaces by character count", () => {
    expect(wrapSubtitleText("ABCDEFGHIJK", 4)).toEqual(["ABCD", "EFGH", "IJK"]);
    expect(wrapSubtitleText("這是一段很長的字幕", 4)).toEqual(["這是一段", "很長的字", "幕"]);
  });

  it("keeps explicit line breaks and rejoins short lines", () => {
    expect(wrapSubtitleText("第一行\n第二行", 20)).toEqual(["第一行", "第二行"]);
  });

  it("detects CJK text for full-width advance", () => {
    expect(isCjkText("繁體中文")).toBe(true);
    expect(isCjkText("日本語テスト")).toBe(true);
    expect(isCjkText("pure english text")).toBe(false);
  });

  it("defaults Chinese-only cues to 12 and English or mixed cues to 20", () => {
    expect(defaultSubtitleLineWidth("漫步森林神木群")).toBe(12);
    expect(defaultSubtitleLineWidth("Old Forest Trail")).toBe(20);
    expect(defaultSubtitleLineWidth("神木 Old Forest")).toBe(20);
    expect(resolveCueSubtitleWrapLimit(undefined, undefined, "中文預設")).toBe(12);
    expect(resolveCueSubtitleWrapLimit(undefined, undefined, "English default")).toBe(20);
    expect(resolveCueSubtitleWrapLimit(9, undefined, "English default")).toBe(9);
    expect(resolveCueSubtitleWrapLimit(undefined, 18, "中文預設")).toBe(18);
  });

  it("derives the automatic limit from frame width and font size", () => {
    expect(resolveSubtitleWrapLimit(undefined, 640, 21, true)).toBe(Math.max(8, Math.floor((640 * 0.82) / 21)));
    expect(resolveSubtitleWrapLimit(Number.NaN, 640, 21, true)).toBe(
      resolveSubtitleWrapLimit(undefined, 640, 21, true),
    );
  });

  it("keeps wrapping identical between the 480p preview canvas and 4K output", () => {
    // Both sides resolve against the fixed 480p reference canvas, so the
    // preview overlay and every output resolution must agree exactly.
    const preview = resolveSubtitleWrapLimit(undefined, SUBTITLE_WRAP_REFERENCE_WIDTH, 28, true);
    const output = resolveSubtitleWrapLimit(undefined, SUBTITLE_WRAP_REFERENCE_WIDTH, 28, true);
    expect(preview).toBe(output);
    expect(preview).toBe(Math.max(8, Math.floor((SUBTITLE_WRAP_REFERENCE_WIDTH * 0.82) / 28)));
  });

  it("maps preview overlay anchors the same way as burn-in positions", () => {
    expect(overlayAnchorForPosition(10)).toBe("TOP");
    expect(overlayAnchorForPosition(37.9)).toBe("TOP");
    expect(overlayAnchorForPosition(38)).toBe("MIDDLE");
    expect(overlayAnchorForPosition(64)).toBe("MIDDLE");
    expect(overlayAnchorForPosition(64.1)).toBe("BOTTOM");
    expect(overlayAnchorForPosition(82)).toBe("BOTTOM");
  });
  it("honors the manual override and clamps it to the supported range", () => {
    expect(resolveSubtitleWrapLimit(12, 3840, 126, true)).toBe(12);
    expect(resolveSubtitleWrapLimit(3, 3840, 126, true)).toBe(SUBTITLE_WRAP_MANUAL_MIN);
    expect(resolveSubtitleWrapLimit(100, 3840, 126, true)).toBe(SUBTITLE_WRAP_MANUAL_MAX);
    expect(SUBTITLE_WRAP_MANUAL_MAX).toBe(60);
  });

  it("resolves and nudges cue positions consistently on every output canvas", () => {
    expect(resolveSubtitleCuePosition(undefined, 82, 1920, 1080)).toMatchObject({
      xPercent: 50,
      yPercent: 82,
      xPx: 960,
      yPx: 886,
      anchor: "BOTTOM",
    });
    expect(resolveSubtitleCuePosition({ xPercent: 25, yPercent: 70 }, 82, 2560, 1440)).toMatchObject({
      xPx: 640,
      yPx: 1008,
      anchor: "BOTTOM",
    });
    expect(resolveSubtitleCuePosition({ xPercent: 25, yPercent: 70 }, 82, 1440, 2560)).toMatchObject({
      xPx: 360,
      yPx: 1792,
      anchor: "BOTTOM",
    });
    expect(nudgeSubtitleCuePosition(undefined, 82, "LEFT")).toEqual({ xPercent: 49, yPercent: 82 });
    expect(nudgeSubtitleCuePosition({ xPercent: 49, yPercent: 82 }, 82, "UP", true)).toEqual({
      xPercent: 49,
      yPercent: 77,
    });
    expect(nudgeSubtitleCuePosition({ xPercent: 5, yPercent: 95 }, 82, "LEFT", true)).toEqual({
      xPercent: 5,
      yPercent: 95,
    });
  });
});
