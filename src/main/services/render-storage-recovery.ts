import { createHash } from "node:crypto";
import path from "node:path";
import type {
  RenderTempLocationStatus,
  ResumeStorageMoveItem,
  ResumeStoragePlan,
  TemporaryArtifactInventoryItem,
} from "../../shared/domain";

export interface ResumeStoragePlannerInput {
  checkpointId: string;
  primary: RenderTempLocationStatus;
  fallback?: RenderTempLocationStatus;
  peakAdditionalBytes: number;
  nextJobBytes: number;
  cleanupCandidates?: readonly TemporaryArtifactInventoryItem[];
  moveCandidates?: readonly ResumeStorageMoveItem[];
}

function closestSufficientMoveSet(
  candidates: readonly ResumeStorageMoveItem[],
  requiredBytes: number,
  maximumBytes: number,
): ResumeStorageMoveItem[] {
  const eligible = candidates.filter((item) => item.sizeBytes > 0 && item.sizeBytes <= maximumBytes);
  if (eligible.length <= 20) {
    let best: ResumeStorageMoveItem[] = [];
    let bestBytes = Number.POSITIVE_INFINITY;
    const combinations = 1 << eligible.length;
    for (let mask = 1; mask < combinations; mask += 1) {
      let bytes = 0;
      const items: ResumeStorageMoveItem[] = [];
      for (let index = 0; index < eligible.length; index += 1) {
        if (!(mask & (1 << index))) continue;
        bytes += eligible[index]!.sizeBytes;
        if (bytes > maximumBytes || bytes > bestBytes) break;
        items.push(eligible[index]!);
      }
      if (
        bytes >= requiredBytes &&
        bytes <= maximumBytes &&
        (bytes < bestBytes || (bytes === bestBytes && items.length < best.length))
      ) {
        best = items;
        bestBytes = bytes;
      }
    }
    return best;
  }
  // Large inventories avoid exponential search; largest-first closes the gap
  // quickly and a final smallest-fit item limits avoidable I/O.
  const descending = [...eligible].sort((left, right) => right.sizeBytes - left.sizeBytes);
  const selected: ResumeStorageMoveItem[] = [];
  let bytes = 0;
  while (bytes < requiredBytes) {
    const remaining = requiredBytes - bytes;
    const fitting = descending
      .filter((item) => !selected.includes(item) && bytes + item.sizeBytes <= maximumBytes)
      .sort((left, right) => {
        const leftWaste = left.sizeBytes >= remaining ? left.sizeBytes - remaining : Number.POSITIVE_INFINITY;
        const rightWaste = right.sizeBytes >= remaining ? right.sizeBytes - remaining : Number.POSITIVE_INFINITY;
        return leftWaste - rightWaste || right.sizeBytes - left.sizeBytes;
      })[0];
    if (!fitting) return [];
    selected.push(fitting);
    bytes += fitting.sizeBytes;
  }
  return selected;
}

/**
 * The planner never sums free bytes across volumes. It first proposes proven
 * cleanup, then redirects future jobs, and only then proposes enough verified
 * artifacts to close the primary shortfall. Every destructive action remains
 * a proposal requiring a fresh check and explicit user confirmation.
 */
export function buildResumeStoragePlan(input: ResumeStoragePlannerInput): ResumeStoragePlan {
  const primarySchedulable = Math.max(0, input.primary.schedulableBytes);
  const shortfallBytes = Math.max(0, input.peakAdditionalBytes - primarySchedulable);
  const planId = createHash("sha256")
    .update(
      JSON.stringify({
        checkpointId: input.checkpointId,
        primaryFreeBytes: input.primary.freeBytes,
        primaryReserveBytes: input.primary.reserveBytes,
        fallbackFreeBytes: input.fallback?.freeBytes,
        fallbackReserveBytes: input.fallback?.reserveBytes,
        peakAdditionalBytes: input.peakAdditionalBytes,
        nextJobBytes: input.nextJobBytes,
        cleanup: (input.cleanupCandidates ?? []).map((item) => [item.artifactId, item.sizeBytes, item.safeToDelete]),
        moves: (input.moveCandidates ?? []).map((item) => [
          item.artifactId,
          item.sizeBytes,
          item.destinationLocationId,
        ]),
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const base = {
    planId,
    checkpointId: input.checkpointId,
    shortfallBytes,
    moveItems: [] as ResumeStorageMoveItem[],
    deleteArtifactIds: [] as string[],
    expectedPrimaryFreeAfterBytes: input.primary.freeBytes,
    requiresUserConfirmation: false,
  };
  if (!shortfallBytes && input.primary.available) {
    return { ...base, action: "RESUME", reason: "主要 TEMP 可容納剩餘同時峰值。" };
  }

  const fallback = input.fallback;
  if (!input.primary.available) {
    if (fallback?.available && fallback.schedulableBytes >= Math.max(1, input.nextJobBytes)) {
      return {
        ...base,
        action: "REDIRECT_FUTURE_JOBS",
        targetLocationId: fallback.id,
        expectedDestinationFreeAfterBytes: Math.max(0, fallback.freeBytes - input.nextJobBytes),
        reason: "主要 TEMP 離線或不可寫；次要 TEMP 可容納下一個尚未開始的工作。",
      };
    }
    return { ...base, action: "SAFE_PAUSE", reason: "主要 TEMP 離線或不可寫，且沒有可安全接手下一個工作的次要 TEMP。" };
  }

  const cleanup = (input.cleanupCandidates ?? [])
    .filter((item) => item.safeToDelete && !item.referencedByCurrentCheckpoint)
    .sort((left, right) => right.sizeBytes - left.sizeBytes);
  const cleanupBytes = cleanup.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (cleanupBytes >= shortfallBytes && cleanup.length) {
    let selectedBytes = 0;
    const selected: string[] = [];
    for (const item of cleanup) {
      selected.push(item.artifactId);
      selectedBytes += item.sizeBytes;
      if (selectedBytes >= shortfallBytes) break;
    }
    return {
      ...base,
      action: "PROPOSE_CLEANUP",
      deleteArtifactIds: selected,
      expectedPrimaryFreeAfterBytes: input.primary.freeBytes + selectedBytes,
      requiresUserConfirmation: true,
      reason: "先清理已證明可重建或已被取代、且未被 Resume 引用的資料。",
    };
  }

  if (fallback?.available && fallback.schedulableBytes >= Math.max(1, input.nextJobBytes)) {
    return {
      ...base,
      action: "REDIRECT_FUTURE_JOBS",
      targetLocationId: fallback.id,
      expectedDestinationFreeAfterBytes: Math.max(0, fallback.freeBytes - input.nextJobBytes),
      reason: "次要 TEMP 可容納下一個尚未開始的工作；保留既有完成片段原路徑。",
    };
  }

  if (fallback?.available) {
    const availableForCopy = Math.max(0, fallback.schedulableBytes);
    // Estimates are not byte-exact forecasts. Avoid a plan that clears the
    // threshold by only a few MiB: target 5% extra, with a 512 MiB minimum,
    // while still minimizing the selected subset and respecting destination reserve.
    const moveTargetBytes = shortfallBytes + Math.max(512 * 1024 ** 2, Math.ceil(shortfallBytes * 0.05));
    const selected = closestSufficientMoveSet(input.moveCandidates ?? [], moveTargetBytes, availableForCopy);
    const selectedBytes = selected.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (selectedBytes >= moveTargetBytes && selected.length) {
      return {
        ...base,
        action: "PROPOSE_MOVE",
        targetLocationId: fallback.id,
        moveItems: selected,
        expectedPrimaryFreeAfterBytes: input.primary.freeBytes + selectedBytes,
        expectedDestinationFreeAfterBytes: fallback.freeBytes - selectedBytes,
        requiresUserConfirmation: true,
        reason:
          "需搬移已完成且已驗證的 Artifact；方案另含最少 512 MiB／5% 估算緩衝，執行時採 copy-verify-checkpoint-delete。",
      };
    }
  }
  return {
    ...base,
    action: "SAFE_PAUSE",
    reason: "目前沒有足以安全清理、改寫或搬移的已驗證空間；保持 checkpoint 與所有來源不變。",
  };
}

export function artifactDestination(root: string, checkpointWorkRoot: string, sourcePath: string): string {
  return path.join(path.resolve(root), path.basename(checkpointWorkRoot), path.basename(sourcePath));
}
