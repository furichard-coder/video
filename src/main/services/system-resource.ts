import { readdir, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RenderModeResourceEstimate, RenderRuntimePolicy, SystemResourceSnapshot } from "../../shared/domain";
import { RENDER_RESOURCE_PROFILES } from "../../shared/render-resource";
import { runProcess } from "./process-runner";

const GIB = 1024 ** 3;
const MINIMUM_STAGE_INPUTS = 3;

interface WindowsMemoryJson {
  availableBytes?: number;
  committedBytes?: number;
  commitLimit?: number;
  pagefileTotalMb?: number;
  pagefileUsedMb?: number;
  pagefilePeakMb?: number;
  ffmpegWorkingSetBytes?: number;
  ffmpegPrivateBytes?: number;
  cpuUsagePercent?: number;
  gpuUsagePercent?: number;
  gpuEncodeUsagePercent?: number;
  gpuDecodeUsagePercent?: number;
  gpuComputeUsagePercent?: number;
  vramUsedBytes?: number;
  vramTotalBytes?: number;
  diskReadBytesPerSecond?: number;
  diskWriteBytesPerSecond?: number;
}

async function diskSpaceFor(targetPath: string): Promise<{ freeBytes: number; capacityBytes: number }> {
  const targetDirectory = path.extname(targetPath) ? path.dirname(path.resolve(targetPath)) : path.resolve(targetPath);
  const disk = await statfs(targetDirectory);
  return {
    freeBytes: Number(disk.bavail) * Number(disk.bsize),
    capacityBytes: Number(disk.blocks) * Number(disk.bsize),
  };
}

async function workingBytes(targetPath: string): Promise<number> {
  try {
    const item = await stat(targetPath);
    if (item.isFile()) return item.size;
    if (!item.isDirectory()) return 0;
    const children = await readdir(targetPath, { withFileTypes: true });
    return (await Promise.all(children.map((child) => workingBytes(path.join(targetPath, child.name))))).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
  } catch {
    return 0;
  }
}

async function windowsMemory(ffmpegPids: number[] = []): Promise<WindowsMemoryJson | undefined> {
  if (process.platform !== "win32") return undefined;
  const safePids = ffmpegPids.filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, 16);
  const pidLiteral = safePids.length ? `@(${safePids.join(",")})` : "@()";
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory",
    "$pages=@(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)",
    `$pids=${pidLiteral}`,
    "$procs=@($pids|ForEach-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue})",
    "$cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\"",
    "$disk=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\"",
    "$gpu=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)",
    "$gpu3d=[math]::Min(100,[double](($gpu|Where-Object{$_.Name -match 'engtype_3D'}|Measure-Object UtilizationPercentage -Sum).Sum))",
    "$gpuEnc=[math]::Min(100,[double](($gpu|Where-Object{$_.Name -match 'engtype_VideoEncode'}|Measure-Object UtilizationPercentage -Sum).Sum))",
    "$gpuDec=[math]::Min(100,[double](($gpu|Where-Object{$_.Name -match 'engtype_VideoDecode'}|Measure-Object UtilizationPercentage -Sum).Sum))",
    "$gpuCompute=[math]::Min(100,[double](($gpu|Where-Object{$_.Name -match 'engtype_(Compute|CUDA)'}|Measure-Object UtilizationPercentage -Sum).Sum))",
    "$gpuMem=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)",
    "$vramUsed=[double](($gpuMem|Measure-Object DedicatedUsage -Sum).Sum)",
    "$vramTotal=[double](($gpuMem|Measure-Object DedicatedLimit -Maximum).Maximum)",
    "$gpuPct=[math]::Max($gpuCompute,[math]::Max($gpu3d,[math]::Max($gpuEnc,$gpuDec)))",
    "$result=[ordered]@{availableBytes=[double]$m.AvailableBytes;committedBytes=[double]$m.CommittedBytes;commitLimit=[double]$m.CommitLimit;pagefileTotalMb=[double](($pages|Measure-Object AllocatedBaseSize -Sum).Sum);pagefileUsedMb=[double](($pages|Measure-Object CurrentUsage -Sum).Sum);pagefilePeakMb=[double](($pages|Measure-Object PeakUsage -Sum).Sum);ffmpegWorkingSetBytes=[double](($procs|Measure-Object WorkingSet64 -Sum).Sum);ffmpegPrivateBytes=[double](($procs|Measure-Object PrivateMemorySize64 -Sum).Sum);cpuUsagePercent=[double]$cpu.PercentProcessorTime;gpuUsagePercent=$gpuPct;gpuEncodeUsagePercent=$gpuEnc;gpuDecodeUsagePercent=$gpuDec;gpuComputeUsagePercent=$gpuCompute;vramUsedBytes=$vramUsed;vramTotalBytes=$vramTotal;diskReadBytesPerSecond=[double]$disk.DiskReadBytesPersec;diskWriteBytesPerSecond=[double]$disk.DiskWriteBytesPersec}",
    "$result|ConvertTo-Json -Compress",
  ].join(";");
  try {
    const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return JSON.parse(result.stdout.trim()) as WindowsMemoryJson;
  } catch {
    return undefined;
  }
}

export async function captureSystemResources(
  outputPath: string,
  options: {
    appWorkingSetBytes?: number;
    ffmpegPid?: number;
    ffmpegPids?: number[];
    currentJobs?: number;
    ffmpegFps?: number;
    ffmpegSpeed?: number;
    encoderName?: string;
    decoderName?: string;
    workingPaths?: string[];
    /** Selected render work volume, which may intentionally differ from OS TEMP. */
    tempPath?: string;
  } = {},
): Promise<SystemResourceSnapshot> {
  const tempPath = options.tempPath ? path.resolve(options.tempPath) : os.tmpdir();
  const [memory, tempDrive, outputDrive, renderWorkingBytes] = await Promise.all([
    windowsMemory(options.ffmpegPids ?? (options.ffmpegPid ? [options.ffmpegPid] : [])),
    diskSpaceFor(tempPath),
    diskSpaceFor(outputPath),
    Promise.all((options.workingPaths ?? []).map((item) => workingBytes(item))).then((items) =>
      items.reduce((sum, bytes) => sum + bytes, 0),
    ),
  ]);
  const totalRamBytes = os.totalmem();
  const availableRamBytes = memory?.availableBytes || os.freemem();
  const appWorkingSetBytes = options.appWorkingSetBytes ?? process.memoryUsage().rss;
  return {
    capturedAt: new Date().toISOString(),
    totalRamBytes,
    availableRamBytes,
    appWorkingSetBytes,
    otherProgramsRamBytes: Math.max(0, totalRamBytes - availableRamBytes - appWorkingSetBytes),
    ...(memory?.committedBytes ? { committedBytes: memory.committedBytes } : {}),
    ...(memory?.commitLimit ? { commitLimitBytes: memory.commitLimit } : {}),
    pagefileEnabled: Boolean(memory?.pagefileTotalMb),
    pagefileTotalBytes: Math.max(0, memory?.pagefileTotalMb ?? 0) * 1024 ** 2,
    pagefileUsedBytes: Math.max(0, memory?.pagefileUsedMb ?? 0) * 1024 ** 2,
    pagefilePeakUsedBytes: Math.max(0, memory?.pagefilePeakMb ?? 0) * 1024 ** 2,
    tempPath,
    tempDriveFreeBytes: tempDrive.freeBytes,
    tempDriveCapacityBytes: tempDrive.capacityBytes,
    outputDriveFreeBytes: outputDrive.freeBytes,
    outputDriveCapacityBytes: outputDrive.capacityBytes,
    ...(renderWorkingBytes ? { renderWorkingBytes } : {}),
    ...(memory?.ffmpegWorkingSetBytes ? { ffmpegWorkingSetBytes: memory.ffmpegWorkingSetBytes } : {}),
    ...(memory?.ffmpegPrivateBytes ? { ffmpegPrivateBytes: memory.ffmpegPrivateBytes } : {}),
    ...(Number.isFinite(memory?.cpuUsagePercent) ? { cpuUsagePercent: memory!.cpuUsagePercent } : {}),
    ...(Number.isFinite(memory?.gpuUsagePercent) ? { gpuUsagePercent: memory!.gpuUsagePercent } : {}),
    ...(Number.isFinite(memory?.gpuEncodeUsagePercent) ? { gpuEncodeUsagePercent: memory!.gpuEncodeUsagePercent } : {}),
    ...(Number.isFinite(memory?.gpuDecodeUsagePercent) ? { gpuDecodeUsagePercent: memory!.gpuDecodeUsagePercent } : {}),
    ...(Number.isFinite(memory?.gpuComputeUsagePercent)
      ? { gpuComputeUsagePercent: memory!.gpuComputeUsagePercent }
      : {}),
    ...(Number.isFinite(memory?.vramUsedBytes) ? { vramUsedBytes: memory!.vramUsedBytes } : {}),
    ...(Number.isFinite(memory?.vramTotalBytes) && memory!.vramTotalBytes! > 0
      ? { vramTotalBytes: memory!.vramTotalBytes }
      : {}),
    ...(Number.isFinite(memory?.diskReadBytesPerSecond)
      ? { diskReadBytesPerSecond: memory!.diskReadBytesPerSecond }
      : {}),
    ...(Number.isFinite(memory?.diskWriteBytesPerSecond)
      ? { diskWriteBytesPerSecond: memory!.diskWriteBytesPerSecond }
      : {}),
    ...(options.currentJobs !== undefined ? { currentJobs: options.currentJobs } : {}),
    ...(options.ffmpegFps !== undefined ? { ffmpegFps: options.ffmpegFps } : {}),
    ...(options.ffmpegSpeed !== undefined ? { ffmpegSpeed: options.ffmpegSpeed } : {}),
    ...(options.encoderName ? { encoderName: options.encoderName } : {}),
    ...(options.decoderName ? { decoderName: options.decoderName } : {}),
  };
}

export function buildRuntimeRenderPolicy(
  lowMemoryMode: boolean,
  selectedEstimate: RenderModeResourceEstimate,
  totalRamBytes: number,
  availableRamBytes: number,
  visualInputCount: number,
  systemLoad: { cpuUsagePercent?: number; gpuUsagePercent?: number } = {},
  highSpeedMode = false,
  maximumRenderRamGiB?: number,
  maximumRenderTempGiB?: number | "AUTO",
): RenderRuntimePolicy {
  const resourceProfile = selectedEstimate.resourceProfile ?? (lowMemoryMode ? "LOW_DISK" : highSpeedMode ? "HIGH_SPEED" : "BALANCED");
  const profile = RENDER_RESOURCE_PROFILES[resourceProfile];
  lowMemoryMode = resourceProfile === "LOW_DISK";
  highSpeedMode = resourceProfile === "HIGH_SPEED";
  // Windows reports nominal 24/32 GiB installations slightly below the label.
  const minimumReserve = totalRamBytes >= 31 * GIB ? 8 * GIB : totalRamBytes >= 20 * GIB ? 6 * GIB : 4 * GIB;
  const systemSafetyReserveBytes = Math.max(minimumReserve, totalRamBytes * 0.18);
  const safeAvailableBudget = Math.max(1 * GIB, availableRamBytes - systemSafetyReserveBytes);
  const safeTotalBudget = Math.max(1 * GIB, totalRamBytes - systemSafetyReserveBytes);
  const tierCap = lowMemoryMode
    ? 6 * GIB
    : highSpeedMode
      ? totalRamBytes >= 31 * GIB
        ? 20 * GIB
        : 14 * GIB
      : totalRamBytes >= 31 * GIB
        ? 18 * GIB
        : totalRamBytes >= 23 * GIB
          ? safeAvailableBudget >= 14 * GIB
            ? 14 * GIB
            : 10 * GIB
          : 8 * GIB;
  const explicitRamCap = Number.isFinite(maximumRenderRamGiB)
    ? Math.max(4, Math.min(64, Number(maximumRenderRamGiB))) * GIB
    : Infinity;
  const renderRamBudgetBytes = Math.max(1 * GIB, Math.min(safeTotalBudget, safeAvailableBudget, tierCap, explicitRamCap));
  const estimatedVariableRam = Math.max(256 * 1024 ** 2, selectedEstimate.estimatedPeakRamBytes - 384 * 1024 ** 2);
  const estimatedPerInputBytes = estimatedVariableRam / Math.max(1, visualInputCount);
  const budgetInputCount = Math.max(
    MINIMUM_STAGE_INPUTS,
    Math.floor(Math.max(256 * 1024 ** 2, renderRamBudgetBytes - 512 * 1024 ** 2) / estimatedPerInputBytes),
  );
  const lowMemoryLimit = renderRamBudgetBytes < 4 * GIB ? 3 : renderRamBudgetBytes < 5 * GIB ? 4 : 6;
  const maxVisualInputsPerStage = Math.min(
    profile.maxInputsPerStage,
    lowMemoryMode
      ? Math.min(lowMemoryLimit, Math.max(MINIMUM_STAGE_INPUTS, visualInputCount))
      : Math.min(10, Math.max(lowMemoryLimit + 1, Math.min(10, budgetInputCount))),
  );
  // Start with one representative wave. The measured throughput/pressure gate
  // may probe 2..4 later; the longer 4K xfade benchmark showed that assuming two
  // workers up front doubled pressure for only ~4% aggregate throughput gain.
  const policyJobCeiling = lowMemoryMode ? 1 : totalRamBytes >= 20 * GIB && renderRamBudgetBytes >= 8 * GIB ? 4 : 2;
  const estimatedRamPerJobBytes = Math.max(
    512 * 1024 ** 2,
    (selectedEstimate.estimatedPeakRamBytes - 384 * 1024 ** 2) / Math.max(1, policyJobCeiling),
  );
  const maximumParallelJobs = Math.min(profile.maximumJobs, lowMemoryMode ? 1 : highSpeedMode ? 4 : policyJobCeiling);
  const initialParallelJobs = 1;
  const filterComplexThreads = lowMemoryMode
    ? renderRamBudgetBytes < 4 * GIB
      ? 1
      : 2
    : renderRamBudgetBytes < 6 * GIB
      ? 2
      : 4;
  return {
    mode: lowMemoryMode ? "LOW_MEMORY" : highSpeedMode ? "HIGH_SPEED" : "NORMAL",
    resourceProfile,
    maxVisualInputsPerStage,
    initialParallelJobs,
    maximumParallelJobs,
    filterComplexThreads,
    encoderThreads: Math.max(1, Math.min(filterComplexThreads, os.cpus().length || 1)),
    systemSafetyReserveBytes: Math.ceil(systemSafetyReserveBytes),
    renderRamBudgetBytes: Math.ceil(renderRamBudgetBytes),
    pauseNewStageBelowAvailableBytes: 2 * GIB,
    estimatedRamPerJobBytes: Math.ceil(estimatedRamPerJobBytes),
    estimatedWorkingBytesPerJob: Math.ceil(
      selectedEstimate.estimatedTemporaryBytes / Math.max(1, selectedEstimate.intermediateJobCount || 1),
    ),
    minimumCommitHeadroomBytes: Math.ceil(Math.max(2 * GIB, estimatedRamPerJobBytes * 1.2)),
    minimumOutputFreeBytes: 1 * GIB,
    ...(maximumRenderTempGiB !== "AUTO" && Number.isFinite(maximumRenderTempGiB)
      ? { maximumRenderTempBytes: Math.max(20, Number(maximumRenderTempGiB)) * GIB }
      : {}),
  };
}

export function resourceWarnings(
  snapshot: SystemResourceSnapshot,
  estimate: RenderModeResourceEstimate,
  policy: RenderRuntimePolicy,
): string[] {
  const warnings = [...estimate.warnings];
  if (snapshot.availableRamBytes < policy.systemSafetyReserveBytes + estimate.estimatedPeakRamBytes) {
    warnings.push(
      "目前可用記憶體可能不足以完成本次轉檔。建議先關閉瀏覽器、遊戲、Adobe、其他剪輯軟體或大型應用程式；仍可自行選擇繼續。",
    );
  }
  if (!snapshot.pagefileEnabled)
    warnings.push("Windows Pagefile／虛擬記憶體目前未啟用，Commit Limit 會偏低，記憶體配置失敗風險較高。");
  else if (
    snapshot.commitLimitBytes &&
    snapshot.committedBytes &&
    snapshot.commitLimitBytes - snapshot.committedBytes < estimate.estimatedPeakRamBytes
  ) {
    warnings.push("Windows 剩餘 Commit 額度低於本次預估 RAM 峰值；即使磁碟仍有空間，也可能配置記憶體失敗。");
  }
  if (snapshot.tempDriveFreeBytes < estimate.estimatedTemporaryBytes + 1024 ** 3)
    warnings.push("TEMP 所在磁碟的安全餘量不足；本次中繼檔實際位於輸出旁，但其他程式的 TEMP 寫入仍可能受影響。");
  const advisoryDiskMargin = Math.max(20 * GIB, (snapshot.outputDriveCapacityBytes ?? 0) * 0.05);
  if (snapshot.outputDriveFreeBytes < estimate.estimatedTemporaryBytes + advisoryDiskMargin)
    warnings.push(
      `輸出磁碟低於建議的「工作檔＋${Math.ceil(advisoryDiskMargin / GIB)} GB 安全餘量」；這是警告而非估算式封鎖，請避免其他程式同時大量寫入。`,
    );
  return [...new Set(warnings)];
}
