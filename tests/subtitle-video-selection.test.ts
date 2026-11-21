import { describe, expect, it } from "vitest";
import type { PreviewOutputRecord } from "../src/shared/domain";
import {
  clampSubtitleSamplingBatchSize,
  clampSubtitleSamplingInterval,
  assertSubtitleVideoTimelineMatch,
  selectSubtitleVideoSource,
} from "../src/main/services/subtitle-video-selection";

function output(jobId: string, createdAt: string, overrides: Partial<PreviewOutputRecord> = {}): PreviewOutputRecord {
  return {
    jobId,
    projectId: "project-a",
    successful: true,
    outputPath: `C:/renders/${jobId}.mp4`,
    fileName: `${jobId}.mp4`,
    purpose: "CONCAT",
    origin: "APP_RENDERED",
    createdAt,
    sizeBytes: 100,
    exists: true,
    ...overrides,
  };
}

describe("subtitle video source selection", () => {
  it("blocks cue regeneration against an unrelated manual video", () => {
    expect(() => assertSubtitleVideoTimelineMatch("MANUAL_PATH", 100_000, 130_000)).toThrow(/時長與目前專案時間線不符/);
    expect(() => assertSubtitleVideoTimelineMatch("LATEST_CONCAT", 100_000, 97_999)).toThrow();
    expect(() => assertSubtitleVideoTimelineMatch("MANUAL_PATH", 100_000, 98_000)).not.toThrow();
    expect(() => assertSubtitleVideoTimelineMatch("PROJECT_CONCAT", 100_000, 1_000)).not.toThrow();
  });
  it("prefers the newest successful existing CONCAT for the current project", () => {
    const records = [
      output("other-latest", "2026-10-02T12:00:00.000Z", { projectId: "project-b" }),
      output("project-old", "2026-10-02T10:00:00.000Z"),
      output("project-latest", "2026-10-02T11:00:00.000Z"),
    ];

    expect(selectSubtitleVideoSource(records, { projectId: "project-a" })).toMatchObject({
      reason: "PROJECT_CONCAT",
      record: { jobId: "project-latest" },
      path: "C:/renders/project-latest.mp4",
    });
  });

  it("never falls back to another project's output", () => {
    const records = [
      output("missing", "2026-10-02T12:00:00.000Z", { exists: false }),
      output("cancelled", "2026-10-02T11:00:00.000Z", { cancelled: true }),
      output("failed", "2026-10-02T10:00:00.000Z", { successful: false }),
      output("other-project", "2026-10-02T09:00:00.000Z", { projectId: "project-b" }),
    ];

    expect(selectSubtitleVideoSource(records, { projectId: "project-without-output" })).toEqual({ reason: "NONE" });
  });

  it("accepts legacy records without project or success markers when non-empty, but never cancelled records", () => {
    const legacy = output("legacy", "2026-10-02T10:00:00.000Z", {
      projectId: undefined,
      successful: undefined,
      projectName: "Current",
    });
    const cancelledLegacy = output("cancelled-legacy", "2026-10-02T11:00:00.000Z", {
      projectId: undefined,
      successful: undefined,
      cancelled: true,
    });

    expect(
      selectSubtitleVideoSource([cancelledLegacy, legacy], { projectId: "project-a", projectName: "Current" }),
    ).toMatchObject({
      reason: "LATEST_CONCAT",
      record: { jobId: "legacy" },
    });
    expect(
      selectSubtitleVideoSource([cancelledLegacy], { lastManualPath: "C:/manual.mp4", isManualPathValid: () => true }),
    ).toMatchObject({ reason: "MANUAL_PATH", path: "C:/manual.mp4" });
  });

  it("uses the manual path only when its validator accepts it", () => {
    expect(
      selectSubtitleVideoSource([], {
        lastManualPath: " C:/manual.mp4 ",
        isManualPathValid: (path) => path.endsWith(".mp4"),
      }),
    ).toEqual({ reason: "MANUAL_PATH", path: "C:/manual.mp4" });
    expect(selectSubtitleVideoSource([], { lastManualPath: "C:/missing.mp4", isManualPathValid: () => false })).toEqual(
      { reason: "NONE" },
    );
  });
});

describe("subtitle sampling bounds", () => {
  it("clamps the sampling interval to 1 through 60 seconds", () => {
    expect(clampSubtitleSamplingInterval(-5)).toBe(1);
    expect(clampSubtitleSamplingInterval(30.6)).toBe(31);
    expect(clampSubtitleSamplingInterval(120)).toBe(60);
    expect(clampSubtitleSamplingInterval(Number.NaN)).toBe(1);
  });

  it("clamps the sampling batch size to 10 through 30", () => {
    expect(clampSubtitleSamplingBatchSize(2)).toBe(10);
    expect(clampSubtitleSamplingBatchSize(18.4)).toBe(18);
    expect(clampSubtitleSamplingBatchSize(80)).toBe(30);
    expect(clampSubtitleSamplingBatchSize(Number.NaN)).toBe(10);
  });
});
