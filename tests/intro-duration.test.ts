import { describe, expect, it } from "vitest";
import { balanceIntroSegments, introSegmentsForOutput, normalizeIntroSegmentMaxDuration } from "../src/shared/intro-duration";
import type { IntroSuggestion, SourceAsset } from "../src/shared/domain";

function asset(id: string, durationMs: number): SourceAsset {
  return {
    id, sourcePath: `C:\\media\\${id}.mp4`, sourceIdentity: id, fileName: `${id}.mp4`, extension: ".mp4", kind: "VIDEO", sizeBytes: 1,
    fileCreatedAt: "2026-01-01T00:00:00Z", fileModifiedAt: "2026-01-01T00:00:00Z", addedAt: "2026-01-01T00:00:00Z", addedOrder: 0,
    sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewCacheKey: id, metadataState: "READY", mediaInfo: { durationMs },
  };
}

function segment(id: string, assetId: string, inMs: number, outMs: number): IntroSuggestion {
  return { id, assetId, fileName: `${assetId}.mp4`, inMs, outMs, score: 50, reasons: ["測試"] };
}

describe("balanced Intro segment durations", () => {
  it("keeps all ordinary segments equal and below the configured maximum", () => {
    const assets = [asset("a", 60_000), asset("b", 60_000), asset("c", 60_000)];
    const balanced = balanceIntroSegments([
      segment("s1", "a", 1_000, 4_000), segment("s2", "b", 10_000, 25_000), segment("s3", "c", 30_000, 50_000),
    ], assets, 36_000, 15_000);
    expect(balanced.map((item) => item.outMs - item.inMs)).toEqual([12_000, 12_000, 12_000]);
    expect(balanced.every((item) => item.outMs - item.inMs <= 15_000)).toBe(true);
  });

  it("only differs when a source is too short and redistributes remaining time predictably", () => {
    const assets = [asset("short", 5_000), asset("long-a", 60_000), asset("long-b", 60_000)];
    const balanced = balanceIntroSegments([
      segment("s1", "short", 0, 5_000), segment("s2", "long-a", 10_000, 15_000), segment("s3", "long-b", 20_000, 25_000),
    ], assets, 35_000, 15_000);
    expect(balanced.map((item) => item.outMs - item.inMs)).toEqual([5_000, 15_000, 15_000]);
  });

  it("validates the fixed 3–22 second setting range", () => {
    expect(normalizeIntroSegmentMaxDuration(15_000)).toBe(15_000);
    expect(() => normalizeIntroSegmentMaxDuration(2_999)).toThrow(/3 到 22 秒/);
    expect(() => normalizeIntroSegmentMaxDuration(22_001)).toThrow(/3 到 22 秒/);
  });

  it("keeps the selected IN point and caps only the rendered OUT point", () => {
    const raw = [segment("review", "a", 8_000, 33_000), segment("short", "b", 2_000, 9_000)];
    const output = introSegmentsForOutput(raw, 12_000);
    expect(output).toEqual([
      { ...raw[0], inMs: 8_000, outMs: 20_000 },
      raw[1],
    ]);
    expect(raw[0]).toMatchObject({ inMs: 8_000, outMs: 33_000 });
  });
});
