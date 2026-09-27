import { describe, expect, it } from "vitest";
import {
  buildRenderEstimateWorkload,
  buildRenderEstimate,
  MINIMUM_RENDER_RESERVE_BYTES,
  type RenderEstimateWorkload,
} from "../src/main/services/render-estimate";

function workload(inputCount: number, width = 3840, height = 2160, fps = 59.94): RenderEstimateWorkload {
  return {
    expectedDurationMs: 60_000,
    transitionSeconds: 0.3,
    inputs: Array.from({ length: inputCount }, (_, index) => ({
      durationMs: 6_000,
      width,
      height,
      fps,
      codec: index % 2 ? "hevc" : "h264",
      isPhoto: index % 5 === 0,
      isInsertion: index >= 8,
      isGenerated: false,
    })),
  };
}

describe("render preflight estimate", () => {
  it("estimates output size/time and preserves a 1 GB reserve", () => {
    const estimate = buildRenderEstimate("C:\\Output\\preview.mp4", 20 * 1024 ** 3, 60_000, "4K", "H265_QSV");
    expect(estimate).toMatchObject({
      driveRoot: "C:\\",
      canRender: true,
      minimumReserveBytes: MINIMUM_RENDER_RESERVE_BYTES,
    });
    expect(estimate.estimatedOutputBytes).toBeGreaterThan(100_000_000);
    expect(estimate.estimatedRenderTimeMs).toBeGreaterThan(60_000);
  });

  it("blocks when the estimated file would leave less than 1 GB", () => {
    const estimate = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      MINIMUM_RENDER_RESERVE_BYTES + 5_000_000,
      60_000,
      "720P",
      "H265_QSV",
    );
    expect(estimate.canRender).toBe(false);
    expect(estimate.warning).toMatch(/低於 1 GB.*阻擋/);
  });

  it("compares both modes from the same multi-input workload", () => {
    const currentWorkload = workload(12);
    const standard = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      20 * 1024 ** 3,
      60_000,
      "4K",
      "H265_QSV",
      false,
      currentWorkload,
      12 * 1024 ** 3,
      16 * 1024 ** 3,
    );
    const segmented = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      20 * 1024 ** 3,
      60_000,
      "4K",
      "H265_QSV",
      true,
      currentWorkload,
      12 * 1024 ** 3,
      16 * 1024 ** 3,
    );
    expect(segmented.modeEstimates).toEqual(standard.modeEstimates);
    expect(segmented.modeEstimates.lowMemory.usesSegmentedPipeline).toBe(true);
    expect(segmented.modeEstimates.lowMemory.maximumSimultaneousInputs).toBe(4);
    expect(segmented.modeEstimates.normal.maximumSimultaneousInputs).toBe(8);
    expect(segmented.estimatedTemporaryBytes).toBeLessThanOrEqual(standard.estimatedTemporaryBytes ?? 0);
    expect(segmented.modeEstimates.lowMemory.estimatedPeakRamBytes).toBeLessThan(
      segmented.modeEstimates.normal.estimatedPeakRamBytes,
    );
    expect(segmented.estimatedRenderTimeMs).toBeGreaterThan(standard.estimatedRenderTimeMs);
    expect(segmented.estimatedFreeAfterBytes).toBe(standard.estimatedFreeAfterBytes);
    expect(segmented.workload).toMatchObject({
      visualInputCount: 12,
      insertedInputCount: 4,
      photoInputCount: 3,
      videoInputCount: 9,
    });
  });

  it("raises RAM and time estimates for higher-resolution, higher-FPS source work", () => {
    const light = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      20 * 1024 ** 3,
      60_000,
      "720P",
      "H265_QSV",
      false,
      workload(8, 1280, 720, 24),
      12 * 1024 ** 3,
      16 * 1024 ** 3,
    );
    const heavy = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      20 * 1024 ** 3,
      60_000,
      "720P",
      "H265_QSV",
      false,
      workload(8, 3840, 2160, 60),
      12 * 1024 ** 3,
      16 * 1024 ** 3,
    );
    expect(heavy.estimatedRenderTimeMs).toBeGreaterThan(light.estimatedRenderTimeMs);
    expect(heavy.modeEstimates.normal.estimatedPeakRamBytes).toBeGreaterThan(
      light.modeEstimates.normal.estimatedPeakRamBytes,
    );
  });

  it("re-estimates RAM, SSD, output size and time when switching 1080p to 1440p", () => {
    const currentWorkload = workload(20, 3840, 2160, 30);
    const at1080 = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      80 * 1024 ** 3,
      120_000,
      "1080P",
      "H265_QSV",
      true,
      currentWorkload,
      12 * 1024 ** 3,
      24 * 1024 ** 3,
      { lowMemory: 4, normal: 12 },
    );
    const at1440 = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      80 * 1024 ** 3,
      120_000,
      "1440P",
      "H265_QSV",
      true,
      currentWorkload,
      12 * 1024 ** 3,
      24 * 1024 ** 3,
      { lowMemory: 4, normal: 12 },
    );
    expect(at1440.estimatedOutputBytes).toBeGreaterThan(at1080.estimatedOutputBytes);
    expect(at1440.modeEstimates.lowMemory.estimatedTemporaryBytes).toBeGreaterThan(
      at1080.modeEstimates.lowMemory.estimatedTemporaryBytes,
    );
    expect(at1440.modeEstimates.normal.estimatedPeakRamBytes).toBeGreaterThan(
      at1080.modeEstimates.normal.estimatedPeakRamBytes,
    );
    expect(at1440.estimatedRenderTimeMs).toBeGreaterThan(at1080.estimatedRenderTimeMs);
  });

  it("covers the A-E resource matrix independently of free-disk and available-RAM pressure", () => {
    const short16 = buildRenderEstimate(
      "C:\\Output\\a.mp4", 70 * 1024 ** 3, 30_000, "1080P", "H265_QSV", true,
      workload(3, 1920, 1080, 30), 10 * 1024 ** 3, 16 * 1024 ** 3,
    );
    const crowded16 = buildRenderEstimate(
      "C:\\Output\\b.mp4", 70 * 1024 ** 3, 60_000, "1440P", "H265_QSV", true,
      workload(30, 4000, 3000, 30), 8 * 1024 ** 3, 16 * 1024 ** 3,
    );
    const sameAt20 = buildRenderEstimate(
      "C:\\Output\\c.mp4", 70 * 1024 ** 3, 60_000, "1440P", "H265_QSV", true,
      workload(30, 4000, 3000, 30), 12 * 1024 ** 3, 20 * 1024 ** 3,
    );
    const disk20 = buildRenderEstimate(
      "C:\\Output\\d.mp4", 20 * 1024 ** 3, 60_000, "1080P", "H265_QSV", true,
      workload(12), 10 * 1024 ** 3, 16 * 1024 ** 3,
    );
    const disk70LowRam = buildRenderEstimate(
      "C:\\Output\\e.mp4", 70 * 1024 ** 3, 60_000, "1440P", "H265_QSV", false,
      workload(30), 2.5 * 1024 ** 3, 16 * 1024 ** 3,
    );
    expect(short16.canRender).toBe(true);
    expect(crowded16.modeEstimates.lowMemory.usesSegmentedPipeline).toBe(true);
    expect(sameAt20.estimatedOutputBytes).toBe(crowded16.estimatedOutputBytes);
    expect(disk20.canRender).toBe(true);
    expect(disk20.safetyMarginBytes).toBe(20 * 1024 ** 3);
    expect(disk20.requiredFreeBytes).toBeGreaterThan(disk20.currentFreeBytes);
    expect(disk70LowRam.canRender).toBe(true);
    expect(disk70LowRam.modeEstimates.normal.warningLevel).not.toBe("NONE");
  });

  it("derives duration, FPS, codec, photo and insertion work from current project selections", () => {
    const current = buildRenderEstimateWorkload(
      [
        {
          id: "video",
          kind: "VIDEO",
          mediaInfo: { displayWidth: 3840, displayHeight: 2160, frameRate: "60000/1001", videoCodec: "hevc" },
        },
        { id: "photo", kind: "IMAGE", mediaInfo: { width: 4000, height: 3000 } },
      ] as never,
      ["video", "photo"],
      [
        { assetId: "video", inMs: 1_000, outMs: 6_000 },
        { assetId: "photo", inMs: 0, outMs: 4_000, mediaInsertionId: "insert-1" },
      ],
      8_700,
      0.3,
    );
    expect(current.inputs).toEqual([
      expect.objectContaining({ durationMs: 5_000, width: 3840, height: 2160, codec: "hevc", isPhoto: false }),
      expect.objectContaining({ durationMs: 4_000, width: 4000, height: 3000, isPhoto: true, isInsertion: true }),
    ]);
    expect(current.inputs[0].fps).toBeCloseTo(59.94, 1);
  });
});
