import { describe, expect, it } from "vitest";
import { clipZoomSegments, imageDurationMs, mainRenderSelections, normalizeMainExclusionRanges, retainedRangesForAsset, validateBgmTrack, validateImageDurationMs, validatePercent, validateSubtitleCues, validateZoomSegments } from "../src/shared/editing-rules";
import type { ProjectManifest, SourceAsset } from "../src/shared/domain";

const bgm = { id: "bgm", sourcePath: "C:\\Music\\track.mp3", fileName: "track.mp3", sizeBytes: 1, durationMs: 10_000, sourceInMs: 0, sourceOutMs: 5_000, timelineInMs: 0, timelineOutMs: 5_000, fadeInMs: 500, fadeOutMs: 500, volumePercent: 100, sourcePolicy: "READ_ONLY" as const, addedAt: "2026-01-01T00:00:00.000Z" };

describe("editing validation rules", () => {
  it("accepts 0, 100, 200 and 300 percent but rejects values outside the fixed range", () => {
    expect([0, 100, 200, 300].map((value) => validatePercent(value))).toEqual([0, 100, 200, 300]);
    expect(() => validatePercent(-1)).toThrow(); expect(() => validatePercent(300.1)).toThrow(); expect(() => validatePercent(Number.NaN)).toThrow();
    expect([0, 100, 200, 300].map((volumePercent) => validateBgmTrack({ ...bgm, volumePercent }).volumePercent)).toEqual([0, 100, 200, 300]);
  });
  it("validates BGM source/timeline spans and fades", () => {
    expect(() => validateBgmTrack({ ...bgm, timelineOutMs: 4_000 })).toThrow(/长度必须|長度必須/);
    expect(() => validateBgmTrack({ ...bgm, fadeInMs: 3_000, fadeOutMs: 3_000 })).toThrow(/淡入/);
  });
  it("sorts subtitle cues and rejects overlap or empty text", () => {
    const cues = validateSubtitleCues([{ id: "b", startMs: 2000, endMs: 3000, text: "二" }, { id: "a", startMs: 0, endMs: 1000, text: "一" }]);
    expect(cues.map((cue) => cue.id)).toEqual(["a", "b"]);
    expect(() => validateSubtitleCues([{ id: "a", startMs: 0, endMs: 1000, text: "一" }, { id: "b", startMs: 900, endMs: 2000, text: "二" }])).toThrow(/不可重疊/);
    expect(validateSubtitleCues([{ id: "a", startMs: 0, endMs: 1000, text: "既有", reviewStatus: "CONFIRMED" }, { id: "b", startMs: 900, endMs: 2000, text: "待調整", reviewStatus: "DRAFT" }])).toHaveLength(2);
    expect(() => validateSubtitleCues([{ id: "a", startMs: 0, endMs: 1000, text: " " }])).toThrow(/不可空白/);
  });
  it("sorts and merges overlapping or adjacent Main exclusion ranges and subtracts them without placeholders", () => {
    const normalized = normalizeMainExclusionRanges([
      { id: "b", startMs: 4_000, endMs: 5_000 },
      { id: "a", startMs: 1_000, endMs: 2_000 },
      { id: "adjacent", startMs: 2_000, endMs: 3_000 },
      { id: "overlap", startMs: 2_500, endMs: 4_500 },
    ], { inMs: 0, outMs: 6_000 });
    expect(normalized).toEqual([{ id: "a", startMs: 1_000, endMs: 5_000 }]);
    const asset = { kind: "VIDEO", mediaInfo: { durationMs: 6_000 }, mainExclusionRanges: normalized } as SourceAsset;
    expect(retainedRangesForAsset(asset)).toEqual([{ inMs: 0, outMs: 1_000 }, { inMs: 5_000, outMs: 6_000 }]);
    expect(() => normalizeMainExclusionRanges([{ id: "bad", startMs: -1, endMs: 100 }], { inMs: 0, outMs: 6_000 })).toThrow(/目前 IN／OUT/);
  });
  it("uses five seconds for photos and accepts only the three-to-seven-second range", () => {
    const photo = { id: "photo", kind: "IMAGE", imageDurationMs: 5_000 } as SourceAsset;
    expect(imageDurationMs(photo)).toBe(5_000);
    expect(retainedRangesForAsset(photo)).toEqual([{ inMs: 0, outMs: 5_000 }]);
    expect([3_000, 5_000, 7_000].map(validateImageDurationMs)).toEqual([3_000, 5_000, 7_000]);
    expect(() => validateImageDurationMs(2_999)).toThrow(/3 秒到 7 秒/);
    expect(() => validateImageDurationMs(7_001)).toThrow(/3 秒到 7 秒/);
    expect(mainRenderSelections({ sources: [photo], timelineOrder: [photo.id] } as ProjectManifest)).toEqual([{ assetId: photo.id, inMs: 0, outMs: 5_000 }]);
  });
  it("validates non-overlapping local zoom ranges, centers, and clips them to a later IN/OUT", () => {
    const segments = validateZoomSegments([
      { id: "plain", startMs: 1_000, endMs: 2_000, zoomPercent: 100, centerXPercent: 0, centerYPercent: 100 },
      { id: "detail", startMs: 3_000, endMs: 6_000, zoomPercent: 400, centerXPercent: 42.5, centerYPercent: 57.5 },
    ], { inMs: 0, outMs: 8_000 });
    expect(segments.map((item) => item.zoomPercent)).toEqual([100, 400]);
    expect(() => validateZoomSegments([{ ...segments[0], zoomPercent: 99 }], { inMs: 0, outMs: 8_000 })).toThrow(/100% 到 400%/);
    expect(() => validateZoomSegments([{ ...segments[0], centerXPercent: 101 }], { inMs: 0, outMs: 8_000 })).toThrow(/0% 到 100%/);
    expect(() => validateZoomSegments([segments[0], { ...segments[1], startMs: 1_900 }], { inMs: 0, outMs: 8_000 })).toThrow(/不可重疊/);
    expect(clipZoomSegments(segments, { inMs: 1_500, outMs: 5_000 })).toEqual({
      segments: [
        { ...segments[0], startMs: 1_500 },
        { ...segments[1], endMs: 5_000 },
      ],
      adjustedCount: 2,
    });
  });
});
