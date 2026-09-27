import { describe, expect, it } from "vitest";
import { buildRuntimeRenderPolicy, resourceWarnings } from "../src/main/services/system-resource";

const GIB = 1024 ** 3;
const estimate = {
  lowMemorySegmented: false,
  usesSegmentedPipeline: false,
  estimatedOutputBytes: GIB,
  estimatedTemporaryBytes: 2 * GIB,
  estimatedPeakRamBytes: 10 * GIB,
  estimatedRenderTimeMs: 60_000,
  estimatedFreeAfterBytes: 50 * GIB,
  maximumSimultaneousInputs: 40,
  intermediateJobCount: 0,
  warningLevel: "NONE" as const,
  warnings: [],
  canRender: true,
};

describe("runtime render resources", () => {
  it("keeps a system reserve and bounds normal mode instead of opening every input", () => {
    const policy = buildRuntimeRenderPolicy(false, estimate, 24 * GIB, 16 * GIB, 91);
    expect(policy.systemSafetyReserveBytes).toBeGreaterThanOrEqual(6 * GIB);
    expect(policy.maxVisualInputsPerStage).toBeGreaterThan(6);
    expect(policy.maxVisualInputsPerStage).toBeLessThanOrEqual(10);
    expect(policy.renderRamBudgetBytes).toBeLessThan(16 * GIB);
    expect(policy.initialParallelJobs).toBe(1);
    expect(policy.maximumParallelJobs).toBe(2);
  });

  it("uses staged 10/14/18 GiB normal budgets while preserving the system reserve", () => {
    const ten = buildRuntimeRenderPolicy(false, estimate, 24 * GIB, 17 * GIB, 91, {
      cpuUsagePercent: 35,
      gpuUsagePercent: 20,
    });
    const fourteen = buildRuntimeRenderPolicy(false, estimate, 24 * GIB, 22 * GIB, 91, {
      cpuUsagePercent: 35,
      gpuUsagePercent: 20,
    });
    const eighteen = buildRuntimeRenderPolicy(false, estimate, 40 * GIB, 32 * GIB, 91, {
      cpuUsagePercent: 35,
      gpuUsagePercent: 20,
    });
    expect(ten.renderRamBudgetBytes).toBe(10 * GIB);
    expect(fourteen.renderRamBudgetBytes).toBe(14 * GIB);
    expect(eighteen.renderRamBudgetBytes).toBe(18 * GIB);
    expect(eighteen.systemSafetyReserveBytes).toBeGreaterThanOrEqual(8 * GIB);
    expect(eighteen.maximumParallelJobs).toBe(2);
  });

  it("starts conservatively when CPU or GPU is already busy", () => {
    const policy = buildRuntimeRenderPolicy(false, estimate, 40 * GIB, 32 * GIB, 91, {
      cpuUsagePercent: 88,
      gpuUsagePercent: 30,
    });
    expect(policy.initialParallelJobs).toBe(1);
    expect(policy.maximumParallelJobs).toBeGreaterThan(1);
  });

  it("offers a guarded four-job ceiling in high-speed mode but benchmarks from one job", () => {
    const policy = buildRuntimeRenderPolicy(
      false,
      estimate,
      24 * GIB,
      16 * GIB,
      91,
      { cpuUsagePercent: 25, gpuUsagePercent: 10 },
      true,
    );
    expect(policy.mode).toBe("HIGH_SPEED");
    expect(policy.maximumParallelJobs).toBe(4);
    expect(policy.initialParallelJobs).toBe(1);
    expect(policy.renderRamBudgetBytes + policy.systemSafetyReserveBytes).toBeLessThanOrEqual(16 * GIB);
  });

  it("reduces low-memory group size when currently available RAM is small", () => {
    const constrained = buildRuntimeRenderPolicy(true, estimate, 16 * GIB, 5 * GIB, 30);
    const comfortable = buildRuntimeRenderPolicy(true, estimate, 20 * GIB, 14 * GIB, 30);
    expect(constrained.maxVisualInputsPerStage).toBe(3);
    expect(comfortable.maxVisualInputsPerStage).toBe(4);
  });

  it("warns about low available RAM and disabled pagefile without blocking the policy", () => {
    const policy = buildRuntimeRenderPolicy(false, estimate, 16 * GIB, 3 * GIB, 30);
    const warnings = resourceWarnings(
      {
        capturedAt: new Date().toISOString(),
        totalRamBytes: 16 * GIB,
        availableRamBytes: 3 * GIB,
        appWorkingSetBytes: GIB,
        otherProgramsRamBytes: 12 * GIB,
        committedBytes: 14 * GIB,
        commitLimitBytes: 16 * GIB,
        pagefileEnabled: false,
        pagefileTotalBytes: 0,
        pagefileUsedBytes: 0,
        pagefilePeakUsedBytes: 0,
        tempPath: "C:/Temp",
        tempDriveFreeBytes: 20 * GIB,
        outputDriveFreeBytes: 20 * GIB,
      },
      estimate,
      policy,
    );
    expect(warnings.join(" ")).toMatch(/關閉瀏覽器.*Pagefile.*Commit/);
    expect(policy.maxVisualInputsPerStage).toBeGreaterThanOrEqual(3);
  });
});
