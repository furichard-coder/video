import { describe, expect, it } from "vitest";
import { decideAdaptiveConcurrency } from "../src/main/services/adaptive-render";
import type { RenderRuntimePolicy, SystemResourceSnapshot } from "../src/shared/domain";

const GIB = 1024 ** 3;
const policy: RenderRuntimePolicy = {
  mode: "NORMAL",
  maxVisualInputsPerStage: 8,
  initialParallelJobs: 1,
  maximumParallelJobs: 4,
  filterComplexThreads: 4,
  encoderThreads: 4,
  systemSafetyReserveBytes: 8 * GIB,
  renderRamBudgetBytes: 18 * GIB,
  pauseNewStageBelowAvailableBytes: 8 * GIB,
};
const resources = (availableRamBytes: number, cpuUsagePercent = 45, gpuUsagePercent = 35): SystemResourceSnapshot => ({
  capturedAt: new Date().toISOString(),
  totalRamBytes: 40 * GIB,
  availableRamBytes,
  appWorkingSetBytes: GIB,
  otherProgramsRamBytes: 5 * GIB,
  tempPath: "C:/Temp",
  tempDriveFreeBytes: 100 * GIB,
  outputDriveFreeBytes: 100 * GIB,
  cpuUsagePercent,
  gpuUsagePercent,
});

describe("adaptive render concurrency", () => {
  it("ramps one job at a time only when benchmark and resources have headroom", () => {
    const next = decideAdaptiveConcurrency(
      policy,
      { currentJobs: 1, previousThroughput: 1 },
      resources(32 * GIB),
      1.08,
    );
    expect(next.currentJobs).toBe(2);
    expect(next.lastChange).toBe("UP");
  });

  it("finishes the wave and lowers the next wave under memory pressure", () => {
    const next = decideAdaptiveConcurrency(policy, { currentJobs: 3, previousThroughput: 2 }, resources(7 * GIB), 2.1);
    expect(next.currentJobs).toBe(2);
    expect(next.lastChange).toBe("DOWN");
  });

  it("does not add work when CPU is saturated or throughput failed to improve", () => {
    expect(
      decideAdaptiveConcurrency(policy, { currentJobs: 2, previousThroughput: 2 }, resources(32 * GIB, 95), 2.2)
        .currentJobs,
    ).toBe(1);
    expect(
      decideAdaptiveConcurrency(policy, { currentJobs: 2, previousThroughput: 2 }, resources(32 * GIB), 2.01)
        .currentJobs,
    ).toBe(2);
  });

  it("pauses new waves at a RAM or SSD guard without interrupting active work", () => {
    const guardedPolicy: RenderRuntimePolicy = {
      ...policy,
      systemSafetyReserveBytes: 6 * GIB,
      pauseNewStageBelowAvailableBytes: 6 * GIB,
      minimumCommitHeadroomBytes: 3 * GIB,
      minimumOutputFreeBytes: 2 * GIB,
      estimatedWorkingBytesPerJob: 4 * GIB,
    };
    const nearRam = decideAdaptiveConcurrency(guardedPolicy, { currentJobs: 1 }, resources(6 * GIB));
    expect(nearRam.pauseNewJobs).toBe(true);
    expect(nearRam.currentJobs).toBe(1);
    const lowDisk = decideAdaptiveConcurrency(
      guardedPolicy,
      { currentJobs: 1 },
      { ...resources(20 * GIB), outputDriveFreeBytes: 5 * GIB },
    );
    expect(lowDisk.pauseNewJobs).toBe(true);
    expect(lowDisk.reason).toMatch(/SSD/);
  });

  it("returns to the prior best count when a higher wave gains less than three percent", () => {
    const preWave = decideAdaptiveConcurrency(
      policy,
      { currentJobs: 3, previousThroughput: 2.01, bestThroughput: 2, bestJobs: 2, lastChange: "UP" },
      resources(32 * GIB),
    );
    expect(preWave.lastChange).toBe("UP");
    const next = decideAdaptiveConcurrency(
      policy,
      preWave,
      resources(32 * GIB),
      2.03,
    );
    expect(next.currentJobs).toBe(2);
    expect(next.lastChange).toBe("DOWN");
  });
});
