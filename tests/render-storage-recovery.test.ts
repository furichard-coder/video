import { describe, expect, it } from "vitest";
import { buildResumeStoragePlan } from "../src/main/services/render-storage-recovery";
import type { RenderTempLocationStatus, ResumeStorageMoveItem } from "../src/shared/domain";

const GIB = 1024 ** 3;
const status = (id: string, role: "PRIMARY" | "FALLBACK", free: number, reserve: number): RenderTempLocationStatus => ({
  id,
  path: `${role === "PRIMARY" ? "E" : "C"}:\\Temp`,
  volume: `${role === "PRIMARY" ? "E" : "C"}:\\`,
  role,
  enabled: true,
  allowFallback: true,
  freeBytes: free,
  capacityBytes: 500 * GIB,
  committedBytes: 0,
  reserveBytes: reserve,
  schedulableBytes: Math.max(0, free - reserve),
  available: free > reserve,
});

describe("resume storage recovery planner", () => {
  it("redirects a new job to C instead of aborting when E cannot fit it", () => {
    const plan = buildResumeStoragePlan({
      checkpointId: "checkpoint-1234",
      primary: status("e", "PRIMARY", 20 * GIB, GIB),
      fallback: status("c", "FALLBACK", 75 * GIB, 2 * GIB),
      peakAdditionalBytes: 80 * GIB,
      nextJobBytes: 40 * GIB,
    });
    expect(plan).toMatchObject({
      action: "REDIRECT_FUTURE_JOBS",
      targetLocationId: "c",
      requiresUserConfirmation: false,
    });
  });

  it("proposes only enough verified artifacts and requires consent", () => {
    const moves: ResumeStorageMoveItem[] = [18, 17, 22, 60].map((size, index) => ({
      artifactId: `segment-${index}`,
      sourcePath: `E:\\Temp\\segment-${index}.mkv`,
      destinationPath: `C:\\Temp\\segment-${index}.mkv`,
      sizeBytes: size * GIB,
      destinationLocationId: "c",
      reason: "completed and verified",
    }));
    const plan = buildResumeStoragePlan({
      checkpointId: "checkpoint-1234",
      primary: status("e", "PRIMARY", 165 * GIB, GIB),
      fallback: status("c", "FALLBACK", 75 * GIB, 2 * GIB),
      peakAdditionalBytes: 218 * GIB,
      nextJobBytes: 80 * GIB,
      moveCandidates: moves,
    });
    expect(plan.action).toBe("PROPOSE_MOVE");
    expect(plan.requiresUserConfirmation).toBe(true);
    expect(plan.moveItems.reduce((sum, item) => sum + item.sizeBytes, 0)).toBe(57 * GIB);
  });

  it("does not turn an unavailable primary with zero arithmetic shortfall into a cleanup proposal", () => {
    const primary = {
      ...status("e", "PRIMARY", 10 * GIB, GIB),
      available: false,
      unavailableReason: "UNWRITABLE" as const,
    };
    const plan = buildResumeStoragePlan({
      checkpointId: "checkpoint-1234",
      primary,
      peakAdditionalBytes: 0,
      nextJobBytes: GIB,
      cleanupCandidates: [
        {
          artifactId: "cache",
          artifactType: "PREVIEW_CACHE",
          path: "E:\\cache",
          drive: "E:\\",
          sizeBytes: GIB,
          status: "REBUILDABLE_CACHE",
          referencedByCurrentCheckpoint: false,
          safeToDelete: true,
          safeToMove: true,
          reason: "rebuildable",
        },
      ],
    });
    expect(plan.action).toBe("SAFE_PAUSE");
    expect(plan.deleteArtifactIds).toEqual([]);
  });

  it("never proposes deleting a current checkpoint dependency or UNKNOWN item", () => {
    const plan = buildResumeStoragePlan({
      checkpointId: "checkpoint-1234",
      primary: status("e", "PRIMARY", 10 * GIB, GIB),
      peakAdditionalBytes: 30 * GIB,
      nextJobBytes: 30 * GIB,
      cleanupCandidates: [
        {
          artifactId: "required",
          artifactType: "COMPLETED_SEGMENT",
          path: "E:\\x",
          drive: "E:\\",
          sizeBytes: 50 * GIB,
          status: "RESUME_REQUIRED",
          referencedByCurrentCheckpoint: true,
          safeToDelete: false,
          safeToMove: false,
          reason: "required",
        },
        {
          artifactId: "unknown",
          artifactType: "UNKNOWN",
          path: "E:\\y",
          drive: "E:\\",
          sizeBytes: 50 * GIB,
          status: "UNKNOWN",
          referencedByCurrentCheckpoint: false,
          safeToDelete: false,
          safeToMove: false,
          reason: "unknown",
        },
      ],
    });
    expect(plan.action).toBe("SAFE_PAUSE");
    expect(plan.deleteArtifactIds).toEqual([]);
  });
});
