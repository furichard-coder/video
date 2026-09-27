import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_DISK_SAFETY_RESERVE_BYTES,
  diskPressureLevel,
  estimateResumeAdditionalPeak,
  estimatePeakDiskUsage,
  isEnospcError,
  remainingAdditionalWriteBytes,
  safetyReserveBytes,
} from "../src/main/services/render-disk-space";

const GIB = 1024 ** 3;

describe("render disk reliability", () => {
  it("uses the largest lifecycle branch instead of summing files that never coexist", () => {
    const estimate = estimatePeakDiskUsage({
      remainingIntermediateBytes: 50 * GIB,
      concurrentPartialBytes: 10 * GIB,
      audioTemporaryBytes: 2 * GIB,
      estimatedFinalOutputBytes: 20 * GIB,
      reusableBaseMasterBytes: 20 * GIB,
      currentFreeBytes: 120 * GIB,
      tempPath: "C:\\RenderTemp",
      outputPath: "C:\\Output\\final.mp4",
    });
    expect(estimate.tempVolume).toBe("C:\\");
    expect(estimate.outputVolume).toBe("C:\\");
    expect(estimate.segmentBuildPeakBytes).toBe(60 * GIB);
    expect(estimate.baseMasterBuildPeakBytes).toBe(70 * GIB);
    expect(estimate.peakWorkingBytes).toBe(70 * GIB);
    expect(estimate.safetyReserveBytes).toBeGreaterThanOrEqual(ABSOLUTE_DISK_SAFETY_RESERVE_BYTES);
    expect(estimate.requiredPeakFreeBytes).toBe(estimate.peakWorkingBytes + estimate.safetyReserveBytes);
  });

  it("evaluates TEMP and output peaks independently on different volumes", () => {
    const estimate = estimatePeakDiskUsage({
      remainingIntermediateBytes: 50 * GIB,
      concurrentPartialBytes: 10 * GIB,
      audioTemporaryBytes: 2 * GIB,
      estimatedFinalOutputBytes: 20 * GIB,
      reusableBaseMasterBytes: 20 * GIB,
      currentFreeBytes: 45 * GIB,
      currentTempFreeBytes: 100 * GIB,
      currentOutputFreeBytes: 45 * GIB,
      tempPath: "D:\\SceneryWalkerTemp",
      outputPath: "C:\\Output\\final.mp4",
    });
    expect(estimate.tempVolume).toBe("D:\\");
    expect(estimate.outputVolume).toBe("C:\\");
    expect(estimate.tempPeakBytes).toBeGreaterThan(estimate.outputPeakBytes ?? 0);
    expect(estimate.currentTempFreeBytes).toBe(100 * GIB);
    expect(estimate.currentOutputFreeBytes).toBe(45 * GIB);
  });

  it("recognizes Windows/FFmpeg ENOSPC variants and scales the reserve", () => {
    expect(isEnospcError(new Error("Task finished with error code: -28 (No space left on device)"))).toBe(true);
    expect(isEnospcError(new Error("Error muxing a packet; Error writing trailer"))).toBe(true);
    expect(isEnospcError(new Error("Cannot allocate memory"))).toBe(false);
    expect(safetyReserveBytes(10 * GIB)).toBe(20 * GIB);
    expect(safetyReserveBytes(200 * GIB)).toBe(40 * GIB);
    expect(path.win32.parse("D:\\x").root).toBe("D:\\");
  });

  it("keeps recommended reserve pressure distinct from a hard inability to finish", () => {
    expect(diskPressureLevel(144 * GIB, 135 * GIB, 20 * GIB)).toBe("CRITICAL");
    expect(diskPressureLevel(144 * GIB, 145 * GIB, 20 * GIB)).toBe("EMERGENCY");
  });

  it("does not double-count protected v0.79 segments and keeps tracking a base master after it moves", () => {
    const externalSegments = 72_527_956_978;
    const estimate = estimateResumeAdditionalPeak({
      legacyPeakBytes: 138_944_270_919,
      validatedExternalSegmentBytes: externalSegments,
      validatedExternalSegmentDurationMs: 8_976_718,
      expectedDurationMs: 8_970_000,
      estimatedFinalOutputBytes: 42_616_740_592,
    });

    // The 67.55 GiB legacy source already reduces free space. The new write
    // budget contains only Base + Final, never legacyPeak + legacySegments.
    expect(estimate.peakAdditionalBytes).toBeLessThan(138_944_270_919 + externalSegments);
    expect(estimate.baseMasterBytes).toBeGreaterThan(138_944_270_919 - externalSegments);
    expect(estimate.finalVideoBytes).toBe(estimate.baseMasterBytes);
    expect(remainingAdditionalWriteBytes(estimate.peakAdditionalBytes, {
      newWorkRootBytes: 0,
      completedBaseMasterBytes: estimate.baseMasterBytes,
      finalOutputBytes: 0,
    })).toBe(estimate.finalMuxBranchBytes);
    // The corrected estimate may legitimately hard-stop this exact recovery:
    // Base and the stream-copied final coexist, so 144.45 GiB is not enough.
    // This is not caused by charging the protected 67.55 GiB a second time.
    expect(diskPressureLevel(155_105_148_928, estimate.peakAdditionalBytes, safetyReserveBytes(estimate.peakAdditionalBytes)))
      .toBe("EMERGENCY");
  });
});
