import { describe, expect, it } from "vitest";
import { buildSubtitleSamplingPlan, computeSubtitleFrameDHash } from "../src/main/services/subtitle-sampling-plan";

const main = (endMs = 180_000) => [{ type: "MAIN" as const, startMs: 0, endMs }];

describe("subtitle frame sampling plan", () => {
  it.each([[1, 8970], [2, 4485], [10, 897], [60, 150]])("covers a 2h29m30 timeline at %is without a global cap", (intervalSeconds, expected) => {
    const plan = buildSubtitleSamplingPlan({ segments: main(8_970_000), intervalSeconds });
    expect(plan.samples).toHaveLength(expected);
    expect(plan.samples.at(-1)!.timeMs).toBeLessThan(8_970_000);
    expect(Math.max(...plan.batches.map((batch) => batch.length))).toBeLessThanOrEqual(20);
  });
  it("computes perceptual dHash from decoded grayscale pixels", () => {
    const descending = Uint8Array.from({ length: 72 }, (_, index) => 255 - (index % 9));
    const ascending = Uint8Array.from({ length: 72 }, (_, index) => index % 9);
    expect(computeSubtitleFrameDHash(descending)).toBe("ffffffffffffffff");
    expect(computeSubtitleFrameDHash(ascending)).toBe("0000000000000000");
  });
  it.each([
    [1, 180],
    [10, 18],
    [60, 3],
  ])("uses a %i second main interval (%i samples)", (intervalSeconds, sampleCount) => {
    const plan = buildSubtitleSamplingPlan({ segments: main(), intervalSeconds });
    expect(plan.intervalSeconds).toBe(intervalSeconds);
    expect(plan.samples).toHaveLength(sampleCount);
    expect(plan.samples.map((sample) => sample.timeMs).slice(0, 3)).toEqual(
      intervalSeconds === 1 ? [0, 1_000, 2_000] : intervalSeconds === 10 ? [0, 10_000, 20_000] : [0, 60_000, 120_000],
    );
  });

  it("clamps the interval to 1 through 60 seconds", () => {
    expect(buildSubtitleSamplingPlan({ segments: main(3_000), intervalSeconds: 0 }).intervalSeconds).toBe(1);
    expect(buildSubtitleSamplingPlan({ segments: main(180_000), intervalSeconds: 99 }).samples.map((sample) => sample.timeMs)).toEqual([0, 60_000, 120_000]);
  });

  it("skips unusable black intro candidates and selects the first usable frame after +1s", () => {
    const plan = buildSubtitleSamplingPlan({
      segments: [{
        type: "INTRO",
        startMs: 0,
        endMs: 8_000,
        usableCandidates: [
          { timeMs: 1_000, usable: false },
          { timeMs: 1_400, usable: false },
          { timeMs: 2_100, usable: true },
          { timeMs: 3_000, usable: true },
        ],
      }],
      intervalSeconds: 10,
    });
    expect(plan.samples.map((sample) => sample.timeMs)).toEqual([2_100]);
    expect(plan.samples[0].source).toBe("FIRST_USABLE");
  });

  it("falls back to a usable frame inside intro/photo bounds when none is available after +1s", () => {
    const plan = buildSubtitleSamplingPlan({
      segments: [
        { type: "INTRO", startMs: 1_000, endMs: 2_000, usableCandidates: [{ timeMs: 1_200, usable: true }] },
        { type: "PHOTO", startMs: 4_000, endMs: 7_000, usableCandidates: [{ timeMs: 4_500, usable: true }, { timeMs: 6_000, usable: false }] },
      ],
      intervalSeconds: 5,
    });
    expect(plan.samples.map((sample) => sample.timeMs)).toEqual([1_200, 4_500]);
  });

  it("adds scene-change samples, deduplicates perceptually, and records cache and request counters", () => {
    const plan = buildSubtitleSamplingPlan({
      segments: main(40_000),
      intervalSeconds: 10,
      sceneChangeTimesMs: [5_000, 10_000, 25_000, 41_000],
      hammingThreshold: 2,
      perceptualHashesByTimeMs: {
        0: "0000",
        5_000: "0001", // Near the first sample.
        10_000: "FFFF",
        20_000: "FFFE", // Near duplicate of the previous retained scene/frame.
        25_000: "FFFF",
      },
      cachedHashesByTimeMs: { 30_000: "0F0F" },
      batchSize: 10,
    });

    expect(plan.samples.map((sample) => sample.timeMs)).toEqual([0, 10_000, 30_000]);
    expect(plan.batches.flat().map((sample) => sample.timeMs)).toEqual([0, 10_000]);
    expect(plan.counters).toEqual({ raw: 7, scene: 3, dedup: 4, sent: 2, requests: 1, cache: 1 });
    expect(plan.purpose).toBe("FRAME_ANALYSIS_ONLY");
  });

  it("bounds request batches to 10–30 samples", () => {
    const plan = buildSubtitleSamplingPlan({ segments: main(350_000), intervalSeconds: 1, batchSize: 100 });
    expect(plan.batches.map((batch) => batch.length)).toEqual([30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 20]);
  });

  it("compresses only consecutive similar frames and keeps an A→B→A return", () => {
    const plan = buildSubtitleSamplingPlan({
      segments: main(30_000),
      intervalSeconds: 10,
      hammingThreshold: 0,
      perceptualHashesByTimeMs: { 0: "0000", 10_000: "FFFF", 20_000: "0000" },
    });
    expect(plan.samples.map((sample) => sample.timeMs)).toEqual([0, 10_000, 20_000]);
    expect(plan.counters.dedup).toBe(0);
  });
});
