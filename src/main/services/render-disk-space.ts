import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  RenderDiskEstimateBreakdown,
  RenderDiskPressureLevel,
  RenderDiskRuntimeSnapshot,
} from "../../shared/domain";

export const GIB = 1024 ** 3;
export const DISK_MONITOR_INTERVAL_MS = 30_000;
export const ABSOLUTE_DISK_SAFETY_RESERVE_BYTES = 20 * GIB;
export const EMERGENCY_FREE_BYTES = 8 * GIB;

export interface ResumeAdditionalPeakInput {
  legacyPeakBytes: number;
  validatedExternalSegmentBytes: number;
  validatedExternalSegmentDurationMs: number;
  expectedDurationMs: number;
  estimatedFinalOutputBytes: number;
}

export interface ResumeAdditionalPeakEstimate {
  baseMasterBytes: number;
  finalVideoBytes: number;
  finalMuxBranchBytes: number;
  peakAdditionalBytes: number;
}

/**
 * Calculates only the bytes still to be written after a copy-on-write legacy
 * import. Protected external segments already reduce statfs free space and must
 * not be charged a second time, but the new base and final mux do coexist.
 */
export function estimateResumeAdditionalPeak(input: ResumeAdditionalPeakInput): ResumeAdditionalPeakEstimate {
  const externalBytes = Math.max(0, input.validatedExternalSegmentBytes);
  const externalDurationMs = Math.max(1, input.validatedExternalSegmentDurationMs);
  const expectedDurationMs = Math.max(0, input.expectedDurationMs);
  const legacyUnmaterializedBytes = Math.max(0, input.legacyPeakBytes - externalBytes);
  const observedBaseBytes = externalBytes
    ? Math.ceil(
        externalBytes * (expectedDurationMs / externalDurationMs) * 1.25 +
          (expectedDurationMs / 1_000) * 250_000,
      )
    : 0;
  const baseMasterBytes = Math.max(legacyUnmaterializedBytes, observedBaseBytes);
  // The final mux stream-copies the QSV GQ25 picture base. A delivery-bitrate
  // estimate can therefore be much smaller than the already encoded base and
  // must not be used as the sole final-output estimate.
  const finalVideoBytes = Math.max(baseMasterBytes, Math.max(0, input.estimatedFinalOutputBytes));
  const audioTemporaryBytes = Math.ceil((expectedDurationMs / 1_000) * 192_000 + 512 * 1024 ** 2);
  const finalMuxBranchBytes = Math.ceil(finalVideoBytes * 1.08 + 256 * 1024 ** 2 + audioTemporaryBytes);
  return {
    baseMasterBytes,
    finalVideoBytes,
    finalMuxBranchBytes,
    peakAdditionalBytes: baseMasterBytes + finalMuxBranchBytes,
  };
}

export function remainingAdditionalWriteBytes(
  peakAdditionalBytes: number,
  current: { newWorkRootBytes: number; completedBaseMasterBytes?: number; finalOutputBytes: number },
): number {
  return Math.max(
    0,
    peakAdditionalBytes -
      Math.max(0, current.newWorkRootBytes) -
      Math.max(0, current.completedBaseMasterBytes ?? 0) -
      Math.max(0, current.finalOutputBytes),
  );
}

export function volumeRoot(targetPath: string): string {
  return path.parse(path.resolve(targetPath)).root.toUpperCase();
}

export function sameVolume(left: string, right: string): boolean {
  return volumeRoot(left) === volumeRoot(right);
}

export function safetyReserveBytes(remainingWorkBytes: number): number {
  return Math.ceil(Math.max(ABSOLUTE_DISK_SAFETY_RESERVE_BYTES, Math.max(0, remainingWorkBytes) * 0.2));
}

export function isEnospcError(error: unknown): boolean {
  const candidate = error as NodeJS.ErrnoException | undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    candidate?.code === "ENOSPC" ||
    /(?:error code:\s*-28|no space left on device|error writing trailer|error muxing a packet|error closing file)/i.test(
      message,
    )
  );
}

export class DiskSpacePauseError extends Error {
  readonly name = "DiskSpacePauseError";
  constructor(
    message: string,
    readonly snapshot: RenderDiskRuntimeSnapshot,
    readonly failedPath?: string,
    readonly enospc = false,
  ) {
    super(message);
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile()) {
        try {
          total += (await stat(item)).size;
        } catch {
          // A concurrently finalized partial may disappear between readdir/stat.
        }
      }
    }
  }
  return total;
}

async function fileBytes(target: string): Promise<number> {
  try {
    const item = await stat(target);
    return item.isFile() ? item.size : 0;
  } catch {
    return 0;
  }
}

async function diskSpace(targetPath: string): Promise<{ freeBytes: number; capacityBytes: number }> {
  const item = await stat(targetPath).catch(() => undefined);
  const directory = item?.isDirectory() ? targetPath : path.dirname(targetPath);
  const disk = await statfs(directory);
  return {
    freeBytes: Number(disk.bavail) * Number(disk.bsize),
    capacityBytes: Number(disk.blocks) * Number(disk.bsize),
  };
}

export async function validateRenderTemporaryFolder(targetPath: string): Promise<{
  path: string;
  volume: string;
  freeBytes: number;
  capacityBytes: number;
}> {
  if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) throw new Error("Render Temporary Folder 必须是绝对路径。");
  const resolved = path.resolve(targetPath);
  await mkdir(resolved, { recursive: true });
  const marker = path.join(resolved, `.scenerywalker-write-test-${randomUUID()}.tmp`);
  try {
    await writeFile(marker, "SceneryWalker render temp write test\n", { encoding: "utf8", flag: "wx" });
  } finally {
    await rm(marker, { force: true });
  }
  const disk = await diskSpace(resolved);
  return { path: resolved, volume: volumeRoot(resolved), ...disk };
}

export interface PeakDiskEstimateInput {
  sourceLogicalBytes?: number;
  sourceLocalBytes?: number;
  existingProxyBytes?: number;
  existingTemporaryBytes?: number;
  reusableCompletedSegmentBytes?: number;
  remainingIntermediateBytes: number;
  concurrentPartialBytes: number;
  segmentBuildPeakBytes?: number;
  audioTemporaryBytes: number;
  estimatedFinalOutputBytes: number;
  reusableBaseMasterBytes?: number;
  /** Backward-compatible shared/output free space. */
  currentFreeBytes: number;
  currentTempFreeBytes?: number;
  currentOutputFreeBytes?: number;
  tempPath: string;
  outputPath: string;
}

/**
 * Calculates the maximum additional bytes on each lifecycle branch. Existing
 * reusable segments are already allocated and therefore are reported but not
 * charged a second time. When output and work roots share a volume, final mux
 * overlaps all resume segments; when they differ, each volume is evaluated
 * separately by the caller/UI.
 */
export function estimatePeakDiskUsage(input: PeakDiskEstimateInput): RenderDiskEstimateBreakdown {
  const muxOverheadBytes = Math.ceil(input.estimatedFinalOutputBytes * 0.08 + 256 * 1024 ** 2);
  const sharedVolume = sameVolume(input.tempPath, input.outputPath);
  const segmentBuildPeak = Math.max(
    input.segmentBuildPeakBytes ?? 0,
    input.remainingIntermediateBytes + input.concurrentPartialBytes,
  );
  // Final-ready resume segments are the inputs to the picture/base master. Once
  // that master is validated, those segments have no remaining consumer and are
  // collected before the post-audio/final-mux branch starts.
  const baseMasterBuildPeak = input.remainingIntermediateBytes + (input.reusableBaseMasterBytes ?? 0);
  const postAudioMuxTempPeak = input.audioTemporaryBytes + (input.reusableBaseMasterBytes ?? 0);
  const tempPeakBytes = Math.ceil(Math.max(segmentBuildPeak, baseMasterBuildPeak, postAudioMuxTempPeak));
  const outputPeakBytes = Math.ceil(input.estimatedFinalOutputBytes + muxOverheadBytes);
  const postAudioMuxPeak = postAudioMuxTempPeak + outputPeakBytes;
  const sharedPeakBytes = Math.ceil(Math.max(segmentBuildPeak, baseMasterBuildPeak, postAudioMuxPeak));
  const peakWorkingBytes = sharedVolume ? sharedPeakBytes : Math.max(tempPeakBytes, outputPeakBytes);
  const reserve = safetyReserveBytes(peakWorkingBytes);
  const tempRequiredFreeBytes = (sharedVolume ? sharedPeakBytes : tempPeakBytes) + reserve;
  const outputRequiredFreeBytes = (sharedVolume ? sharedPeakBytes : outputPeakBytes) + reserve;
  const requiredPeakFreeBytes = sharedVolume
    ? tempRequiredFreeBytes
    : Math.max(tempRequiredFreeBytes, outputRequiredFreeBytes);
  const currentTempFreeBytes = input.currentTempFreeBytes ?? input.currentFreeBytes;
  const currentOutputFreeBytes = input.currentOutputFreeBytes ?? input.currentFreeBytes;
  const predictedTempMinimumFreeBytes = Math.max(
    0,
    currentTempFreeBytes - (sharedVolume ? sharedPeakBytes : tempPeakBytes),
  );
  const predictedOutputMinimumFreeBytes = Math.max(
    0,
    currentOutputFreeBytes - (sharedVolume ? sharedPeakBytes : outputPeakBytes),
  );
  return {
    sourceLogicalBytes: Math.max(0, input.sourceLogicalBytes ?? 0),
    sourceLocalBytes: Math.max(0, input.sourceLocalBytes ?? 0),
    existingProxyBytes: Math.max(0, input.existingProxyBytes ?? 0),
    existingTemporaryBytes: Math.max(0, input.existingTemporaryBytes ?? 0),
    reusableCompletedSegmentBytes: Math.max(0, input.reusableCompletedSegmentBytes ?? 0),
    remainingIntermediatePeakBytes: Math.max(0, input.remainingIntermediateBytes),
    concurrentPartialPeakBytes: Math.max(0, input.concurrentPartialBytes),
    segmentBuildPeakBytes: segmentBuildPeak,
    baseMasterBuildPeakBytes: baseMasterBuildPeak,
    postAudioMuxPeakBytes: postAudioMuxPeak,
    reusableBaseMasterBytes: Math.max(0, input.reusableBaseMasterBytes ?? 0),
    audioTemporaryBytes: Math.max(0, input.audioTemporaryBytes),
    estimatedFinalOutputBytes: Math.max(0, input.estimatedFinalOutputBytes),
    muxOverheadBytes,
    peakWorkingBytes,
    safetyReserveBytes: reserve,
    requiredPeakFreeBytes,
    predictedMinimumFreeBytes: Math.min(predictedTempMinimumFreeBytes, predictedOutputMinimumFreeBytes),
    tempPeakBytes: sharedVolume ? sharedPeakBytes : tempPeakBytes,
    outputPeakBytes: sharedVolume ? sharedPeakBytes : outputPeakBytes,
    tempRequiredFreeBytes,
    outputRequiredFreeBytes,
    currentTempFreeBytes,
    currentOutputFreeBytes,
    predictedTempMinimumFreeBytes,
    predictedOutputMinimumFreeBytes,
    tempPath: path.resolve(input.tempPath),
    tempVolume: volumeRoot(input.tempPath),
    outputVolume: volumeRoot(input.outputPath),
  };
}

export function diskPressureLevel(freeBytes: number, remainingBytes: number, reserveBytes: number): RenderDiskPressureLevel {
  if (freeBytes <= EMERGENCY_FREE_BYTES || freeBytes < remainingBytes) return "EMERGENCY";
  if (freeBytes < remainingBytes + reserveBytes * 0.5) return "CRITICAL";
  if (freeBytes < remainingBytes + reserveBytes) return "WARNING";
  return "OK";
}

export interface RenderDiskMonitorOptions {
  tempRoot: string;
  outputPath: string;
  proxyRoot?: string;
  estimatedRemainingWriteBytes: (current: { renderTempBytes: number; finalOutputBytes: number }) => number;
  estimatedFinalOutputBytes?: number;
  diagnosticPath?: string;
}

export class RenderDiskMonitor {
  constructor(private readonly options: RenderDiskMonitorOptions) {}

  async snapshot(stage: string, segment?: string): Promise<RenderDiskRuntimeSnapshot> {
    const [tempDisk, outputDisk, renderTempBytes, finalOutputBytes, proxyCacheBytes] = await Promise.all([
      diskSpace(this.options.tempRoot),
      diskSpace(this.options.outputPath),
      directoryBytes(this.options.tempRoot),
      fileBytes(this.options.outputPath),
      this.options.proxyRoot ? directoryBytes(this.options.proxyRoot) : Promise.resolve(0),
    ]);
    const remaining = Math.max(
      0,
      this.options.estimatedRemainingWriteBytes({ renderTempBytes, finalOutputBytes }),
    );
    const shared = sameVolume(this.options.tempRoot, this.options.outputPath);
    const outputRemaining = Math.max(0, (this.options.estimatedFinalOutputBytes ?? 0) - finalOutputBytes);
    const tempRemaining = shared ? remaining : Math.max(0, remaining - outputRemaining);
    const reserve = safetyReserveBytes(remaining);
    const tempLevel = diskPressureLevel(tempDisk.freeBytes, shared ? remaining : tempRemaining, reserve);
    const outputLevel = diskPressureLevel(outputDisk.freeBytes, shared ? remaining : outputRemaining, reserve);
    const rank: Record<RenderDiskPressureLevel, number> = { OK: 0, WARNING: 1, CRITICAL: 2, EMERGENCY: 3 };
    const level = rank[tempLevel] >= rank[outputLevel] ? tempLevel : outputLevel;
    const requiredAdditionalBytes = Math.max(
      0,
      (shared ? remaining : tempRemaining) + reserve - tempDisk.freeBytes,
      (shared ? remaining : outputRemaining) + reserve - outputDisk.freeBytes,
    );
    const snapshot: RenderDiskRuntimeSnapshot = {
      capturedAt: new Date().toISOString(),
      tempPath: this.options.tempRoot,
      tempVolume: volumeRoot(this.options.tempRoot),
      outputPath: this.options.outputPath,
      outputVolume: volumeRoot(this.options.outputPath),
      tempFreeBytes: tempDisk.freeBytes,
      outputFreeBytes: outputDisk.freeBytes,
      tempCapacityBytes: tempDisk.capacityBytes,
      outputCapacityBytes: outputDisk.capacityBytes,
      renderTempBytes,
      intermediateBytes: renderTempBytes,
      finalOutputBytes,
      proxyCacheBytes,
      estimatedRemainingWriteBytes: remaining,
      safetyReserveBytes: reserve,
      requiredAdditionalBytes,
      pressureLevel: level,
    };
    if (this.options.diagnosticPath) {
      await appendFile(
        this.options.diagnosticPath,
        `${JSON.stringify({ at: snapshot.capturedAt, event: "DISK_USAGE", stage, segment, snapshot })}\n`,
        "utf8",
      ).catch(() => undefined);
    }
    return snapshot;
  }

  async assertSafeBoundary(stage: string, segment?: string): Promise<RenderDiskRuntimeSnapshot> {
    const snapshot = await this.snapshot(stage, segment);
    // WARNING/CRITICAL mean the recommended reserve is being consumed. They
    // remain visible advisories. Only a true inability to finish the estimated
    // remaining write (or the 8 GiB emergency floor) stops scheduling.
    if (snapshot.pressureLevel === "EMERGENCY") {
      throw new DiskSpacePauseError(
        `磁碟空間已低於完成目前工作的硬性需求，轉檔已安全暫停。請至少再釋放 ${(snapshot.requiredAdditionalBytes / GIB).toFixed(1)} GB 後繼續轉檔。`,
        snapshot,
      );
    }
    return snapshot;
  }
}

export async function cleanupOwnedDisposableTemp(ownedRoot: string, preservePaths: ReadonlySet<string>): Promise<number> {
  const root = path.resolve(ownedRoot);
  let reclaimed = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const target = path.join(root, entry.name);
    if (preservePaths.has(path.resolve(target))) continue;
    if (!/(?:\.partial(?:\.[^.]+)?$|\.filtergraph\.txt$|\.tmp$)/i.test(entry.name)) continue;
    const item = await stat(target).catch(() => undefined);
    if (!item?.isFile()) continue;
    await rm(target, { force: true });
    reclaimed += item.size;
  }
  return reclaimed;
}
