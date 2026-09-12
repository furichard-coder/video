import { describe, expect, it } from "vitest";
import {
  SUBTITLE_WRAP_MANUAL_MAX,
  SUBTITLE_WRAP_MANUAL_MIN,
  SUBTITLE_WRAP_REFERENCE_WIDTH,
  isCjkText,
  overlayAnchorForPosition,
  resolveSubtitleWrapLimit,
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
  });
});
