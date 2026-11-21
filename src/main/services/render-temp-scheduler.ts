import path from "node:path";
import type { RenderTempLocationConfig, RenderTempLocationStatus } from "../../shared/domain";
import {
  ABSOLUTE_DISK_SAFETY_RESERVE_BYTES,
  DEFAULT_DATA_VOLUME_SOFT_RESERVE_BYTES,
  DEFAULT_SYSTEM_VOLUME_SOFT_RESERVE_BYTES,
  validateRenderTemporaryFolder,
  volumeRoot,
} from "./render-disk-space";

export interface RenderTempLocationProbe {
  config: RenderTempLocationConfig;
  freeBytes: number;
  capacityBytes: number;
  committedBytes?: number;
  writable?: boolean;
}

export interface RenderTempAssignment {
  locationId: string;
  path: string;
  volume: string;
  reserveBytes: number;
  schedulableBytes: number;
}

export function evaluateRenderTempPreflight(
  statuses: readonly RenderTempLocationStatus[],
  estimatedNextJobBytes: number,
  selection: "AUTO" | "PRIMARY" | "FALLBACK",
  outputFreeBytes: number,
  outputHardRequiredBytes: number,
  outputVolume?: string,
  estimatedOutputBytes = 0,
  outputReserveBytes = 0,
) {
  // A TEMP job and the final output can coexist on one volume. Do not admit
  // each independently when their combined peak would breach that reserve.
  const sharedVolumeConflict = statuses.some(
    (status) =>
      status.volume === outputVolume &&
      status.available &&
      status.schedulableBytes >= estimatedNextJobBytes &&
      status.freeBytes <
        estimatedNextJobBytes + estimatedOutputBytes + Math.max(status.reserveBytes ?? 0, outputReserveBytes),
  );
  const selectedTemp = selectRenderTempForNextJob(
    statuses.map((status) => ({
      config: status,
      freeBytes: status.freeBytes,
      capacityBytes: status.capacityBytes,
      committedBytes: status.committedBytes,
      writable:
        status.unavailableReason !== "UNWRITABLE" &&
        !(
          status.volume === outputVolume &&
          status.freeBytes <
            estimatedNextJobBytes + estimatedOutputBytes + Math.max(status.reserveBytes ?? 0, outputReserveBytes)
        ),
    })),
    estimatedNextJobBytes,
    selection,
  );
  const outputVolumeCanRender = Math.max(0, outputFreeBytes) >= Math.max(0, outputHardRequiredBytes);
  return {
    selectedTemp,
    outputVolumeCanRender,
    sharedVolumeConflict,
    canRender: Boolean(selectedTemp) && outputVolumeCanRender,
  };
}

export async function probeRenderTempLocations(
  configs: readonly RenderTempLocationConfig[],
  committedBytesByVolume: Readonly<Record<string, number>> = {},
): Promise<RenderTempLocationStatus[]> {
  return Promise.all(
    configs.map(async (candidate) => {
      const config = normalizeRenderTempLocation(candidate);
      try {
        const disk = await validateRenderTemporaryFolder(config.path);
        return describeRenderTempLocation({
          config,
          freeBytes: disk.freeBytes,
          capacityBytes: disk.capacityBytes,
          committedBytes: committedBytesByVolume[disk.volume] ?? 0,
          writable: true,
        });
      } catch {
        return describeRenderTempLocation({
          config,
          freeBytes: 0,
          capacityBytes: 0,
          committedBytes: committedBytesByVolume[volumeRoot(config.path)] ?? 0,
          writable: false,
        });
      }
    }),
  );
}

function safeLocationId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) throw new Error("Render TEMP location id 無效。");
  return value;
}

export function normalizeRenderTempLocation(config: RenderTempLocationConfig): RenderTempLocationConfig {
  if (!path.isAbsolute(config.path)) throw new Error("Render TEMP location 必須是絕對路徑。");
  const resolved = path.resolve(config.path);
  const defaultReserve =
    volumeRoot(resolved) === "C:\\" ? DEFAULT_SYSTEM_VOLUME_SOFT_RESERVE_BYTES : DEFAULT_DATA_VOLUME_SOFT_RESERVE_BYTES;
  return {
    id: safeLocationId(config.id),
    path: resolved,
    role: config.role,
    enabled: config.enabled !== false,
    allowFallback: config.allowFallback !== false,
    reserveBytes: Math.max(0, Math.ceil(config.reserveBytes ?? defaultReserve)),
  };
}

export function describeRenderTempLocation(probe: RenderTempLocationProbe): RenderTempLocationStatus {
  const config = normalizeRenderTempLocation(probe.config);
  const reserveBytes = config.reserveBytes ?? ABSOLUTE_DISK_SAFETY_RESERVE_BYTES;
  const committedBytes = Math.max(0, probe.committedBytes ?? 0);
  const freeBytes = Math.max(0, probe.freeBytes);
  const schedulableBytes = Math.max(0, freeBytes - committedBytes - reserveBytes);
  const unavailableReason =
    probe.writable === false
      ? "UNWRITABLE"
      : !config.enabled
        ? "DISABLED"
        : schedulableBytes <= 0
          ? "BELOW_RESERVE"
          : undefined;
  return {
    ...config,
    volume: volumeRoot(config.path),
    freeBytes,
    capacityBytes: Math.max(0, probe.capacityBytes),
    committedBytes,
    schedulableBytes,
    available: !unavailableReason,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

/**
 * Selects storage only for a job that has not started. Callers must persist the
 * assignment on the segment and must never use this to move a running or
 * completed file. Primary order is stable; fallback is automatic by default.
 */
export function selectRenderTempForNextJob(
  probes: readonly RenderTempLocationProbe[],
  estimatedJobBytes: number,
  selection: "AUTO" | "PRIMARY" | "FALLBACK" = "AUTO",
): RenderTempAssignment | undefined {
  const required = Math.max(0, Math.ceil(estimatedJobBytes));
  const statuses = probes.map(describeRenderTempLocation);
  const eligible = statuses.filter((item) => item.available && item.schedulableBytes >= required);
  const selected =
    selection === "PRIMARY"
      ? eligible.find((item) => item.role === "PRIMARY")
      : selection === "FALLBACK"
        ? eligible.find((item) => item.role === "FALLBACK")
        : (eligible.find((item) => item.role === "PRIMARY") ??
          eligible.find((item) => item.role === "FALLBACK" && item.allowFallback !== false));
  if (!selected) return undefined;
  return {
    locationId: selected.id,
    path: selected.path,
    volume: selected.volume,
    reserveBytes: selected.reserveBytes ?? ABSOLUTE_DISK_SAFETY_RESERVE_BYTES,
    schedulableBytes: selected.schedulableBytes,
  };
}

export function renderTempJobRoot(locationPath: string, checkpointId: string): string {
  if (!/^[a-f0-9-]{8,80}$/i.test(checkpointId)) throw new Error("Checkpoint id 無效。");
  return path.join(path.resolve(locationPath), `.scenerywalker-${checkpointId}.resume`);
}
