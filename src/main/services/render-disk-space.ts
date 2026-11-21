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
/** Advisory defaults. These are intentionally not fatal disk limits. */
export const DEFAULT_DATA_VOLUME_SOFT_RESERVE_BYTES = 1 * GIB;
export const DEFAULT_SYSTEM_VOLUME_SOFT_RESERVE_BYTES = 2 * GIB;
/**
 * Last-resort filesystem headroom used only while deciding whether an active
 * writer can safely reach its next checkpoint. It is separate from the user's
 * soft reserve and never participates in render identity.
 */
export const MINIMUM_FILESYSTEM_HEADROOM_BYTES = 256 * 1024 ** 2;
export const MINIMUM_SYSTEM_VOLUME_HEADROOM_BYTES = 512 * 1024 ** 2;
/** @deprecated Compatibility alias for callers that have not supplied a location reserve. */
export const ABSOLUTE_DISK_SAFETY_RESERVE_BYTES = DEFAULT_DATA_VOLUME_SOFT_RESERVE_BYTES;
export const EMERGENCY_FREE_BYTES = MINIMUM_FILESYSTEM_HEADROOM_BYTES;

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
        externalBytes * (expectedDurationMs / externalDurationMs) * 1.25 + (expectedDurationMs / 1_000) * 250_000,
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
  // Advisory only. The previous max(20 GiB, 20%) value was also used as a
  // fatal threshold, which produced the misleading +54.1 GiB guard even when
  // FFmpeg had not reported ENOSPC. Capacity admission is handled per job and
  // per volume; runtime hard stops use hardSafetyLimitBytes below.
  void remainingWorkBytes;
  return DEFAULT_DATA_VOLUME_SOFT_RESERVE_BYTES;
}

export function hardSafetyLimitBytes(targetPath: string): number {
  return volumeRoot(targetPath) === "C:\\" ? MINIMUM_SYSTEM_VOLUME_HEADROOM_BYTES : MINIMUM_FILESYSTEM_HEADROOM_BYTES;
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

async function monitoredDiskSpace(
  targetPath: string,
): Promise<{ freeBytes: number; capacityBytes: number; unavailable: boolean }> {
  try {
    return { ...(await diskSpace(targetPath)), unavailable: false };
  } catch {
    return { freeBytes: 0, capacityBytes: 0, unavailable: true };
  }
}

export async function validateRenderTemporaryFolder(targetPath: string): Promise<{
  path: string;
  volume: string;
  freeBytes: number;
  capacityBytes: number;
}> {
  if (typeof targetPath !== "string" || !path.isAbsolute(targetPath))
    throw new Error("Render Temporary Folder 必须是绝对路径。");
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

export function diskPressureLevel(
  freeBytes: number,
  remainingBytes: number,
  reserveBytes: number,
): RenderDiskPressureLevel {
  if (freeBytes < remainingBytes) return "EMERGENCY";
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
  tempLocations?: readonly import("../../shared/domain").RenderTempLocationConfig[];
  /** Test/host injection; production uses statfs with offline handling. */
  diskSpaceForMonitoring?: (targetPath: string) => Promise<{ freeBytes: number; capacityBytes: number }>;
}

export function splitRemainingWriteByVolume(input: {
  totalRemainingBytes: number;
  estimatedFinalOutputBytes: number;
  finalOutputBytes: number;
  sharedVolume: boolean;
}): { tempRemainingBytes: number; outputRemainingBytes: number } {
  const totalRemainingBytes = Math.max(0, input.totalRemainingBytes);
  if (input.sharedVolume) {
    return { tempRemainingBytes: totalRemainingBytes, outputRemainingBytes: totalRemainingBytes };
  }
  const outputRemainingBytes = Math.max(
    0,
    Math.max(0, input.estimatedFinalOutputBytes) - Math.max(0, input.finalOutputBytes),
  );
  return {
    tempRemainingBytes: Math.max(0, totalRemainingBytes - outputRemainingBytes),
    outputRemainingBytes,
  };
}

export function remainingReservedWriteBytes(
  estimatedBytes: number,
  baselineBytes: number,
  currentBytes: number,
): number {
  return Math.max(0, Math.max(0, estimatedBytes) - Math.max(0, currentBytes - baselineBytes));
}

export class RenderDiskMonitor {
  private readonly activeReservations = new Map<
    string,
    {
      locationId: string;
      path: string;
      volume: string;
      estimatedRemainingWriteBytes: number;
      baselineBytes: number;
    }
  >();

  constructor(private readonly options: RenderDiskMonitorOptions) {}

  private async monitoredSpace(targetPath: string) {
    if (!this.options.diskSpaceForMonitoring) return monitoredDiskSpace(targetPath);
    try {
      return { ...(await this.options.diskSpaceForMonitoring(targetPath)), unavailable: false };
    } catch {
      return { freeBytes: 0, capacityBytes: 0, unavailable: true };
    }
  }

  async reserveTempJob(jobId: string, locationId: string, targetPath: string, estimatedBytes: number): Promise<void> {
    this.activeReservations.set(jobId, {
      locationId,
      path: path.resolve(targetPath),
      volume: volumeRoot(targetPath),
      estimatedRemainingWriteBytes: Math.max(0, estimatedBytes),
      baselineBytes: await fileBytes(targetPath),
    });
  }

  releaseTempJob(jobId: string): void {
    this.activeReservations.delete(jobId);
  }

  async snapshot(stage: string, segment?: string): Promise<RenderDiskRuntimeSnapshot> {
    const [tempDisk, outputDisk, renderTempBytes, finalOutputBytes, proxyCacheBytes] = await Promise.all([
      this.monitoredSpace(this.options.tempRoot),
      this.monitoredSpace(this.options.outputPath),
      directoryBytes(this.options.tempRoot),
      fileBytes(this.options.outputPath),
      this.options.proxyRoot ? directoryBytes(this.options.proxyRoot) : Promise.resolve(0),
    ]);
    const remaining = Math.max(0, this.options.estimatedRemainingWriteBytes({ renderTempBytes, finalOutputBytes }));
    const shared = sameVolume(this.options.tempRoot, this.options.outputPath);
    const { tempRemainingBytes: tempRemaining, outputRemainingBytes: outputRemaining } = splitRemainingWriteByVolume({
      totalRemainingBytes: remaining,
      estimatedFinalOutputBytes: this.options.estimatedFinalOutputBytes ?? 0,
      finalOutputBytes,
      sharedVolume: shared,
    });
    const configuredReserve = (targetPath: string, locationId?: string) => {
      const config = this.options.tempLocations?.find(
        (item) =>
          (locationId && item.id === locationId) ||
          path.resolve(item.path).toLowerCase() === path.resolve(targetPath).toLowerCase(),
      );
      return Math.max(
        0,
        config?.reserveBytes ??
          (volumeRoot(targetPath) === "C:\\"
            ? DEFAULT_SYSTEM_VOLUME_SOFT_RESERVE_BYTES
            : DEFAULT_DATA_VOLUME_SOFT_RESERVE_BYTES),
      );
    };
    const reserve = configuredReserve(this.options.tempRoot, "primary");
    const tempLevel = diskPressureLevel(
      tempDisk.freeBytes,
      (shared ? remaining : tempRemaining) + hardSafetyLimitBytes(this.options.tempRoot),
      reserve,
    );
    const outputLevel = diskPressureLevel(
      outputDisk.freeBytes,
      (shared ? remaining : outputRemaining) + hardSafetyLimitBytes(this.options.outputPath),
      reserve,
    );
    const rank: Record<RenderDiskPressureLevel, number> = { OK: 0, WARNING: 1, CRITICAL: 2, EMERGENCY: 3 };
    let level = rank[tempLevel] >= rank[outputLevel] ? tempLevel : outputLevel;
    const requiredAdditionalBytes = Math.max(
      0,
      (shared ? remaining : tempRemaining) + reserve - tempDisk.freeBytes,
      (shared ? remaining : outputRemaining) + reserve - outputDisk.freeBytes,
    );
    const reservationGroups = new Map<
      string,
      { locationId: string; path: string; remaining: number; activeJobCount: number; currentBytes: number }
    >();
    for (const reservation of this.activeReservations.values()) {
      const currentBytes = await fileBytes(reservation.path);
      const remainingBytes = remainingReservedWriteBytes(
        reservation.estimatedRemainingWriteBytes,
        reservation.baselineBytes,
        currentBytes,
      );
      const current = reservationGroups.get(reservation.volume);
      if (current) {
        current.remaining += remainingBytes;
        current.currentBytes += currentBytes;
        current.activeJobCount += 1;
      } else
        reservationGroups.set(reservation.volume, {
          locationId: reservation.locationId,
          path: reservation.path,
          remaining: remainingBytes,
          activeJobCount: 1,
          currentBytes,
        });
    }
    const extraTempVolumes = await Promise.all(
      [...reservationGroups.entries()]
        .filter(([volume]) => volume !== volumeRoot(this.options.tempRoot))
        .map(async ([volume, reservation]) => {
          const disk = await this.monitoredSpace(reservation.path);
          const locationReserve = configuredReserve(reservation.path, reservation.locationId);
          const locationPressure = diskPressureLevel(
            disk.freeBytes,
            reservation.remaining + hardSafetyLimitBytes(reservation.path),
            locationReserve,
          );
          return {
            locationId: reservation.locationId,
            path: reservation.path,
            volume,
            role: "FALLBACK" as const,
            freeBytes: disk.freeBytes,
            capacityBytes: disk.capacityBytes,
            currentBytes: reservation.currentBytes,
            estimatedRemainingWriteBytes: reservation.remaining,
            reserveBytes: locationReserve,
            requiredAdditionalBytes: Math.max(0, reservation.remaining + locationReserve - disk.freeBytes),
            pressureLevel: locationPressure,
            activeJobCount: reservation.activeJobCount,
            availableForNextJob: !disk.unavailable && locationPressure !== "EMERGENCY",
            ...(disk.unavailable ? { unavailableReason: "OFFLINE_OR_UNREADABLE" as const } : {}),
          };
        }),
    );
    for (const item of extraTempVolumes) {
      if (rank[item.pressureLevel] > rank[level]) level = item.pressureLevel;
    }
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
      volumes: [
        ...(shared
          ? [
              {
                locationId: "primary",
                path: this.options.tempRoot,
                volume: volumeRoot(this.options.tempRoot),
                role: "PRIMARY" as const,
                freeBytes: tempDisk.freeBytes,
                capacityBytes: tempDisk.capacityBytes,
                currentBytes: renderTempBytes + finalOutputBytes,
                estimatedRemainingWriteBytes: remaining,
                reserveBytes: reserve,
                requiredAdditionalBytes,
                pressureLevel: level,
                activeJobCount: reservationGroups.get(volumeRoot(this.options.tempRoot))?.activeJobCount ?? 0,
                availableForNextJob: !tempDisk.unavailable && level !== "EMERGENCY",
                ...(tempDisk.unavailable ? { unavailableReason: "OFFLINE_OR_UNREADABLE" as const } : {}),
              },
            ]
          : [
              {
                locationId: "primary",
                path: this.options.tempRoot,
                volume: volumeRoot(this.options.tempRoot),
                role: "PRIMARY" as const,
                freeBytes: tempDisk.freeBytes,
                capacityBytes: tempDisk.capacityBytes,
                currentBytes: renderTempBytes,
                estimatedRemainingWriteBytes: tempRemaining,
                reserveBytes: reserve,
                requiredAdditionalBytes: Math.max(0, tempRemaining + reserve - tempDisk.freeBytes),
                pressureLevel: tempLevel,
                activeJobCount: reservationGroups.get(volumeRoot(this.options.tempRoot))?.activeJobCount ?? 0,
                availableForNextJob: !tempDisk.unavailable && tempLevel !== "EMERGENCY",
                ...(tempDisk.unavailable ? { unavailableReason: "OFFLINE_OR_UNREADABLE" as const } : {}),
              },
              {
                locationId: "final-output",
                path: this.options.outputPath,
                volume: volumeRoot(this.options.outputPath),
                role: "FINAL_OUTPUT" as const,
                freeBytes: outputDisk.freeBytes,
                capacityBytes: outputDisk.capacityBytes,
                currentBytes: finalOutputBytes,
                estimatedRemainingWriteBytes: outputRemaining,
                reserveBytes: reserve,
                requiredAdditionalBytes: Math.max(0, outputRemaining + reserve - outputDisk.freeBytes),
                pressureLevel: outputLevel,
                activeJobCount: 0,
                availableForNextJob: false,
                ...(outputDisk.unavailable ? { unavailableReason: "OFFLINE_OR_UNREADABLE" as const } : {}),
              },
            ]),
        ...extraTempVolumes,
      ],
    };
    const activeVolumes =
      snapshot.volumes?.filter((item) => item.role === "FINAL_OUTPUT" || item.activeJobCount > 0) ?? [];
    if (activeVolumes.length) {
      snapshot.pressureLevel = activeVolumes.reduce(
        (worst, item) => (rank[item.pressureLevel] > rank[worst] ? item.pressureLevel : worst),
        "OK" as RenderDiskPressureLevel,
      );
      snapshot.requiredAdditionalBytes = activeVolumes.reduce(
        (maximum, item) => Math.max(maximum, item.requiredAdditionalBytes),
        0,
      );
    }
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
    // remaining write plus the last-resort filesystem headroom stops scheduling.
    // The 512 MiB C: floor is not a guarantee that Windows/pagefile health is
    // good; writable probes and OS failures still disable that location.
    if (snapshot.pressureLevel === "EMERGENCY") {
      throw new DiskSpacePauseError(
        `磁碟空間已低於完成目前工作的硬性需求，轉檔已安全暫停。請至少再釋放 ${(snapshot.requiredAdditionalBytes / GIB).toFixed(1)} GB 後繼續轉檔。`,
        snapshot,
      );
    }
    return snapshot;
  }
}

export async function cleanupOwnedDisposableTemp(
  ownedRoot: string,
  preservePaths: ReadonlySet<string>,
): Promise<number> {
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
