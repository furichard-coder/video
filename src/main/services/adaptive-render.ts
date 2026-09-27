import type { RenderRuntimePolicy, SystemResourceSnapshot } from "../../shared/domain";

const GIB = 1024 ** 3;

export interface AdaptiveConcurrencyState {
  currentJobs: number;
  previousThroughput?: number;
  bestThroughput?: number;
  bestJobs?: number;
  observedPeakPerJobBytes?: number;
  lastChange?: "UP" | "DOWN" | "HOLD";
}

export interface AdaptiveConcurrencyDecision extends AdaptiveConcurrencyState {
  reason: string;
  /** The scheduler waits and samples again instead of starting another wave. */
  pauseNewJobs?: boolean;
}

/**
 * Chooses work concurrency, never FFmpeg buffer sizes. A wave already in flight
 * is allowed to finish; this decision applies only before the next wave starts.
 */
export function decideAdaptiveConcurrency(
  policy: RenderRuntimePolicy,
  state: AdaptiveConcurrencyState,
  resources: SystemResourceSnapshot,
  measuredThroughput?: number,
): AdaptiveConcurrencyDecision {
  if (policy.mode === "LOW_MEMORY" || policy.maximumParallelJobs <= 1) {
    return {
      currentJobs: 1,
      previousThroughput: measuredThroughput,
      bestThroughput: measuredThroughput ?? state.bestThroughput,
      bestJobs: 1,
      observedPeakPerJobBytes: state.observedPeakPerJobBytes,
      lastChange: "HOLD",
      reason: "低記憶體模式固定單工作",
    };
  }

  const current = Math.max(1, Math.min(policy.maximumParallelJobs, state.currentJobs));
  const commitRemaining =
    resources.commitLimitBytes !== undefined && resources.committedBytes !== undefined
      ? resources.commitLimitBytes - resources.committedBytes
      : Number.POSITIVE_INFINITY;
  const observedPerJob =
    resources.currentJobs && resources.ffmpegPrivateBytes
      ? resources.ffmpegPrivateBytes / Math.max(1, resources.currentJobs)
      : undefined;
  const observedPeakPerJobBytes = Math.max(state.observedPeakPerJobBytes ?? 0, observedPerJob ?? 0) || undefined;
  const estimatedPerJob = Math.max(
    512 * 1024 ** 2,
    observedPeakPerJobBytes ??
      policy.estimatedRamPerJobBytes ??
      policy.renderRamBudgetBytes / Math.max(1, policy.maximumParallelJobs),
  );
  const minimumCommitHeadroom = Math.max(2 * GIB, policy.minimumCommitHeadroomBytes ?? 0, estimatedPerJob * 1.2);
  const minimumOutputFree = Math.max(1 * GIB, policy.minimumOutputFreeBytes ?? 0);
  const workingPerJob = Math.max(0, policy.estimatedWorkingBytesPerJob ?? 0);
  const usableRam = resources.availableRamBytes - policy.systemSafetyReserveBytes;
  // outputDriveFreeBytes already reflects files written so far; subtracting
  // renderWorkingBytes again would double-count the same intermediates.
  const diskHeadroom = resources.outputDriveFreeBytes - minimumOutputFree;
  const hardMemoryPressure =
    current > 1 &&
    (resources.availableRamBytes < Math.max(policy.pauseNewStageBelowAvailableBytes, policy.systemSafetyReserveBytes) ||
      commitRemaining < estimatedPerJob * current * 0.85);
  if (hardMemoryPressure) {
    return {
      ...state,
      currentJobs: current - 1,
      previousThroughput: measuredThroughput ?? state.previousThroughput,
      bestJobs: Math.min(state.bestJobs ?? current, current - 1),
      observedPeakPerJobBytes,
      lastChange: "DOWN",
      reason: "RAM／Commit 壓力過高，下一波自動降低一個平行工作",
    };
  }
  const mustPause =
    resources.availableRamBytes <= Math.max(policy.pauseNewStageBelowAvailableBytes, policy.systemSafetyReserveBytes) ||
    commitRemaining <= minimumCommitHeadroom ||
    diskHeadroom <= workingPerJob;
  if (mustPause) {
    return {
      ...state,
      currentJobs: Math.max(1, Math.min(current, state.bestJobs ?? current)),
      observedPeakPerJobBytes,
      lastChange: "HOLD",
      pauseNewJobs: true,
      reason:
        diskHeadroom <= workingPerJob
          ? "SSD 工作空間接近安全門檻，暫停送入新工作"
          : "RAM／Commit 接近安全門檻，暫停送入新工作",
    };
  }
  const underMemoryPressure =
    usableRam < estimatedPerJob * current * 0.9 || commitRemaining < estimatedPerJob * current * 1.1;
  const cpu = resources.cpuUsagePercent ?? 50;
  const gpu = Math.max(
    resources.gpuUsagePercent ?? 0,
    resources.gpuEncodeUsagePercent ?? 0,
    resources.gpuDecodeUsagePercent ?? 0,
    resources.gpuComputeUsagePercent ?? 0,
  );
  const saturated = cpu >= 92 || gpu >= 94;
  const cannotSustainCurrent = usableRam < estimatedPerJob * current * 0.8;

  if (underMemoryPressure || saturated || cannotSustainCurrent) {
    return {
      currentJobs: Math.max(1, current - 1),
      previousThroughput: measuredThroughput ?? state.previousThroughput,
      bestThroughput: state.bestThroughput,
      bestJobs: Math.min(state.bestJobs ?? current, Math.max(1, current - 1)),
      observedPeakPerJobBytes,
      lastChange: current > 1 ? "DOWN" : "HOLD",
      reason: underMemoryPressure || cannotSustainCurrent ? "RAM／Commit 接近安全門檻" : "CPU／GPU 已接近飽和",
    };
  }

  let bestThroughput = state.bestThroughput;
  let bestJobs = state.bestJobs ?? current;
  const comparisonThroughput = bestThroughput ?? state.previousThroughput;
  const testedImprovement =
    measuredThroughput !== undefined &&
    (comparisonThroughput === undefined || measuredThroughput >= comparisonThroughput * 1.03);
  if (testedImprovement) {
    bestThroughput = measuredThroughput;
    bestJobs = current;
  } else if (
    measuredThroughput !== undefined &&
    state.lastChange === "UP" &&
    bestThroughput !== undefined &&
    measuredThroughput < bestThroughput * 1.03
  ) {
    return {
      currentJobs: Math.max(1, Math.min(current - 1, bestJobs)),
      previousThroughput: measuredThroughput,
      bestThroughput,
      bestJobs,
      observedPeakPerJobBytes,
      lastChange: "DOWN",
      reason: "增加工作後吞吐量未改善至少 3%，回到較快的工作數",
    };
  }
  const enoughForAnother =
    usableRam >= estimatedPerJob * (current + 1) * 1.05 &&
    commitRemaining >= estimatedPerJob * (current + 1) * 1.1 &&
    diskHeadroom >= workingPerJob * (current + 1);
  const hasComputeHeadroom = cpu < 78 && gpu < 82;
  const prior = state.previousThroughput;
  const benchmarkImproved = measuredThroughput !== undefined && testedImprovement;
  if (
    measuredThroughput !== undefined &&
    current < policy.maximumParallelJobs &&
    enoughForAnother &&
    hasComputeHeadroom &&
    benchmarkImproved
  ) {
    return {
      currentJobs: current + 1,
      previousThroughput: measuredThroughput ?? prior,
      bestThroughput,
      bestJobs,
      observedPeakPerJobBytes,
      lastChange: "UP",
      reason: "RAM 安全且 CPU／GPU 尚有餘裕，增加一個平行工作",
    };
  }

  return {
    currentJobs: current,
    previousThroughput: measuredThroughput ?? prior,
    bestThroughput,
    bestJobs,
    observedPeakPerJobBytes,
    // A pre-wave safety check has no throughput sample. Preserve the fact
    // that the previous completed wave increased concurrency so the next
    // measured wave can still prove or reject that increase.
    lastChange: measuredThroughput === undefined ? (state.lastChange ?? "HOLD") : "HOLD",
    reason: !benchmarkImproved ? "增加工作後吞吐量未達 3% 改善" : "維持目前最快且安全的工作數",
  };
}
