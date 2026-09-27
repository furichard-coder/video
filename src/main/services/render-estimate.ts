import { statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import path from "node:path";
import type {
  ConcatRenderEstimate,
  PreviewResolution,
  RenderClipSelection,
  RenderEstimateWarningLevel,
  RenderModeResourceEstimate,
  RenderVideoCodec,
  SourceAsset,
  TransitionDurationSec,
} from "../../shared/domain";
import { RESOLUTION_PROFILES } from "../../shared/render-profile";
import { estimatePeakDiskUsage } from "./render-disk-space";
import {
  RENDER_RESOURCE_PROFILES,
  estimatedIntermediateBytes,
  resourceProfileFromLegacy,
  type RenderResourceProfile,
} from "../../shared/render-resource";

export const MINIMUM_RENDER_RESERVE_BYTES = 1024 ** 3;
export const MINIMUM_RENDER_SAFETY_MARGIN_BYTES = 20 * 1024 ** 3;
export const RENDER_SAFETY_MARGIN_DISK_RATIO = 0.05;

const VIDEO_MEGABITS_PER_SECOND: Record<PreviewResolution, { h265: number; h264: number }> = {
  "360P": { h265: 0.65, h264: 1.0 },
  "480P": { h265: 1.2, h264: 1.8 },
  "720P": { h265: 3.5, h264: 5.5 },
  "1080P": { h265: 7, h264: 10 },
  "1440P": { h265: 11.5, h264: 18 },
  "4K": { h265: 20, h264: 35 },
};

const REALTIME_FACTOR: Record<PreviewResolution, Record<RenderVideoCodec, number>> = {
  "360P": { H264_NVENC: 0.16, H265_NVENC: 0.22, H265_QSV: 0.25, H264_QSV: 0.2, H265: 0.9, H264: 0.5 },
  "480P": { H264_NVENC: 0.22, H265_NVENC: 0.3, H265_QSV: 0.35, H264_QSV: 0.28, H265: 1.2, H264: 0.7 },
  "720P": { H264_NVENC: 0.36, H265_NVENC: 0.55, H265_QSV: 0.65, H264_QSV: 0.45, H265: 2.0, H264: 1.1 },
  "1080P": { H264_NVENC: 0.55, H265_NVENC: 0.82, H265_QSV: 0.95, H264_QSV: 0.68, H265: 3.1, H264: 1.75 },
  "1440P": { H264_NVENC: 0.82, H265_NVENC: 1.2, H265_QSV: 1.45, H264_QSV: 1.0, H265: 4.8, H264: 2.65 },
  "4K": { H264_NVENC: 1.45, H265_NVENC: 2.25, H265_QSV: 2.8, H264_QSV: 1.8, H265: 8.0, H264: 4.0 },
};
const OUTPUT_FPS = 30_000 / 1_001;
const LOW_MEMORY_INPUT_LIMIT = 6;

export interface RenderEstimateWorkloadInput {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  isPhoto: boolean;
  isInsertion: boolean;
  isGenerated: boolean;
}

export interface RenderEstimateWorkload {
  inputs: RenderEstimateWorkloadInput[];
  expectedDurationMs: number;
  transitionSeconds: number;
}

function finiteDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60_000) throw new Error("預估片長無效。");
  return Math.round(value);
}

function parseFrameRate(value?: string): number {
  if (!value) return OUTPUT_FPS;
  const [numerator, denominator = "1"] = value.split("/");
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : OUTPUT_FPS;
}

function finitePositive(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) && value! > 0 && value! <= maximum ? value! : fallback;
}

function codecDecodeFactor(codec: string): number {
  const normalized = codec.toLowerCase();
  if (normalized.includes("av1")) return 1.65;
  if (normalized.includes("hevc") || normalized.includes("h265")) return 1.35;
  if (normalized.includes("vp9")) return 1.25;
  if (normalized.includes("prores")) return 1.12;
  return 1;
}

export function buildRenderEstimateWorkload(
  assets: SourceAsset[],
  orderedAssetIds: string[] | undefined,
  clipSelections: RenderClipSelection[] | undefined,
  expectedDurationMs: number,
  transitionSeconds: TransitionDurationSec | undefined,
  generatedInputCount = 0,
): RenderEstimateWorkload {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const selections: RenderClipSelection[] = clipSelections?.length
    ? clipSelections
    : (orderedAssetIds ?? []).map((assetId) => {
        const asset = byId.get(assetId);
        const outMs =
          asset?.kind === "IMAGE"
            ? (asset.imageDurationMs ?? 5_000)
            : (asset?.previewRange?.outMs ?? asset?.mediaInfo?.durationMs ?? 0);
        return {
          assetId,
          inMs: asset?.previewRange?.inMs ?? 0,
          outMs,
        };
      });
  const inputs = selections.flatMap((selection) => {
    const asset = byId.get(selection.assetId);
    if (!asset) return [];
    const fallback = RESOLUTION_PROFILES["720P"].landscape;
    return [
      {
        durationMs: finitePositive(selection.outMs - selection.inMs, 1, 24 * 60 * 60_000),
        width: finitePositive(asset.mediaInfo?.displayWidth ?? asset.mediaInfo?.width, fallback.width, 16_384),
        height: finitePositive(asset.mediaInfo?.displayHeight ?? asset.mediaInfo?.height, fallback.height, 16_384),
        fps: asset.kind === "IMAGE" ? OUTPUT_FPS : parseFrameRate(asset.mediaInfo?.frameRate),
        codec: asset.kind === "IMAGE" ? "image" : (asset.mediaInfo?.videoCodec ?? "unknown"),
        isPhoto: asset.kind === "IMAGE",
        isInsertion: Boolean(selection.mediaInsertionId),
        isGenerated: false,
      },
    ];
  });
  const generatedDurationMs = Math.max(1, Math.min(7_000, finiteDuration(expectedDurationMs)));
  for (let index = 0; index < Math.max(0, Math.min(10, Math.floor(generatedInputCount))); index += 1) {
    inputs.push({
      durationMs: generatedDurationMs,
      width: 1920,
      height: 1080,
      fps: OUTPUT_FPS,
      codec: "generated",
      isPhoto: true,
      isInsertion: false,
      isGenerated: true,
    });
  }
  return {
    inputs,
    expectedDurationMs: finiteDuration(expectedDurationMs),
    transitionSeconds: transitionSeconds ?? 0.3,
  };
}

function outputSizeBytes(durationMs: number, resolution: PreviewResolution, videoCodec: RenderVideoCodec): number {
  const isH265 = videoCodec === "H265" || videoCodec === "H265_QSV" || videoCodec === "H265_NVENC";
  const videoMbps = VIDEO_MEGABITS_PER_SECOND[resolution][isH265 ? "h265" : "h264"];
  return Math.ceil((((durationMs / 1000) * (videoMbps + 0.192) * 1_000_000) / 8) * 1.08);
}

function mergedDurationMs(durations: number[], transitionMs: number): number {
  return Math.max(
    1,
    durations.reduce((sum, value) => sum + value, 0) - transitionMs * Math.max(0, durations.length - 1),
  );
}

function simulateSegmentStages(
  inputDurations: number[],
  transitionMs: number,
  resolution: PreviewResolution,
  maximumInputs = LOW_MEMORY_INPUT_LIMIT,
  parallelJobs = 1,
  resourceProfile: RenderResourceProfile = "BALANCED",
): {
  intermediateJobCount: number;
  intermediateWorkMs: number;
  peakIntermediateBytes: number;
  finalIntermediateBytes: number;
  concurrentPartialPeakBytes: number;
  finalInputCount: number;
} {
  let current = inputDurations.map((durationMs) => ({ durationMs, bytes: 0 }));
  let peakIntermediateBytes = 0;
  let liveBytes = 0;
  let concurrentPartialPeakBytes = 0;
  let intermediateJobCount = 0;
  let intermediateWorkMs = 0;
  while (current.length > maximumInputs) {
    const next: typeof current = [];
    const groups: typeof current[] = [];
    for (let index = 0; index < current.length; index += maximumInputs) groups.push(current.slice(index, index + maximumInputs));
    for (let waveStart = 0; waveStart < groups.length; waveStart += Math.max(1, parallelJobs)) {
      const wave = groups.slice(waveStart, waveStart + Math.max(1, parallelJobs));
      const outputs = wave.map((group) => {
      const durationMs = mergedDurationMs(
        group.map((item) => item.durationMs),
        transitionMs,
      );
      const bytes = estimatedIntermediateBytes(durationMs, resolution, resourceProfile);
      return { group, durationMs, bytes };
      });
      const waveBytes = outputs.reduce((sum, item) => sum + item.bytes, 0);
      concurrentPartialPeakBytes = Math.max(concurrentPartialPeakBytes, waveBytes);
      // Partial files coexist with their inputs only until validation. Each
      // output then becomes the sole durable resume artifact for that group.
      peakIntermediateBytes = Math.max(peakIntermediateBytes, liveBytes + waveBytes);
      for (const output of outputs) {
        liveBytes -= output.group.reduce((sum, item) => sum + item.bytes, 0);
        liveBytes += output.bytes;
        next.push({ durationMs: output.durationMs, bytes: output.bytes });
      }
      peakIntermediateBytes = Math.max(peakIntermediateBytes, liveBytes);
      intermediateJobCount += outputs.length;
      intermediateWorkMs += outputs.reduce((sum, item) => sum + item.durationMs, 0);
    }
    current = next;
  }
  return {
    intermediateJobCount,
    intermediateWorkMs,
    peakIntermediateBytes,
    finalIntermediateBytes: current.reduce((sum, item) => sum + item.bytes, 0),
    concurrentPartialPeakBytes,
    finalInputCount: current.length,
  };
}

function warningLevelFor(ramRatio: number, diskRatio: number, diskCanRender: boolean): RenderEstimateWarningLevel {
  if (!diskCanRender || ramRatio >= 1 || diskRatio >= 1) return "DANGER";
  if (ramRatio >= 0.75 || diskRatio >= 0.8) return "WARNING";
  return "NONE";
}

function buildModeEstimate(
  lowMemorySegmented: boolean,
  outputPath: string,
  outputBytes: number,
  currentFreeBytes: number,
  availableRamBytes: number,
  workload: RenderEstimateWorkload,
  resolution: PreviewResolution,
  videoCodec: RenderVideoCodec,
  maximumInputs: number,
  parallelJobs = 1,
  tempPath = process.env.TEMP || path.dirname(outputPath),
  currentTempFreeBytes = currentFreeBytes,
  resourceProfile: RenderResourceProfile = lowMemorySegmented ? "LOW_DISK" : "BALANCED",
): RenderModeResourceEstimate {
  const output = RESOLUTION_PROFILES[resolution].landscape;
  const outputPixels = output.width * output.height;
  const inputs = workload.inputs.length
    ? workload.inputs
    : [
        {
          durationMs: workload.expectedDurationMs,
          width: output.width,
          height: output.height,
          fps: OUTPUT_FPS,
          codec: "unknown",
          isPhoto: false,
          isInsertion: false,
          isGenerated: false,
        },
      ];
  const boundedMaximumInputs = Math.max(3, Math.floor(maximumInputs));
  const usesSegmentedPipeline = inputs.length > boundedMaximumInputs;
  const stage = usesSegmentedPipeline
    ? simulateSegmentStages(
        inputs.map((item) => item.durationMs),
        workload.transitionSeconds * 1000,
        resolution,
        boundedMaximumInputs,
        parallelJobs,
        resourceProfile,
      )
    : { intermediateJobCount: 0, intermediateWorkMs: 0, peakIntermediateBytes: 0, finalIntermediateBytes: 0, concurrentPartialPeakBytes: 0, finalInputCount: inputs.length };
  // The real grouper normally caps batches at six; a generated Main-start card
  // may keep both adjacent clips in the same boundary batch, making seven the
  // conservative peak for that one case.
  const segmentedConcurrencyLimit = inputs.some((input) => input.isGenerated)
    ? boundedMaximumInputs + 1
    : boundedMaximumInputs;
  const perProcessInputs = usesSegmentedPipeline ? Math.min(segmentedConcurrencyLimit, inputs.length) : inputs.length;
  const boundedParallelJobs = usesSegmentedPipeline
    ? Math.max(1, Math.min(Math.floor(parallelJobs), stage.intermediateJobCount || 1))
    : 1;
  const sortedInputRam = inputs
    .map((input) => {
      const sourcePixels = Math.max(1, input.width * input.height);
      const fpsQueueFactor = Math.max(0.7, Math.min(2.5, input.fps / OUTPUT_FPS));
      const frameQueue = input.isPhoto ? 2 : 7;
      return sourcePixels * 1.5 * frameQueue * fpsQueueFactor * codecDecodeFactor(input.codec) + 8 * 1024 ** 2;
    })
    .sort((a, b) => b - a);
  const leafInputRam = sortedInputRam.slice(0, perProcessInputs).reduce((sum, bytes) => sum + bytes, 0);
  const normalizedFinalRam = usesSegmentedPipeline
    ? stage.finalInputCount * (outputPixels * 1.5 * 7 + 8 * 1024 ** 2)
    : 0;
  const filterFrames = outputPixels * 1.5 * (18 + perProcessInputs * (usesSegmentedPipeline ? 2 : 3));
  const perJobPeakRam = 384 * 1024 ** 2 + Math.max(leafInputRam, normalizedFinalRam) + filterFrames;
  // Parallel workers share the Electron/service base but each owns its decoder,
  // filter and encoder queues. The 0.82 factor avoids double-counting shared
  // filesystem/cache overhead while remaining conservative for FFmpeg frames.
  const estimatedPeakRamBytes = Math.ceil(perJobPeakRam + Math.max(0, boundedParallelJobs - 1) * perJobPeakRam * 0.82);

  const weightedDecode =
    inputs.reduce(
      (sum, input) =>
        sum +
        input.durationMs *
          Math.max(0.35, (input.width * input.height) / outputPixels) *
          Math.max(0.5, input.fps / OUTPUT_FPS) *
          codecDecodeFactor(input.codec),
      0,
    ) /
    Math.max(
      1,
      inputs.reduce((sum, input) => sum + input.durationMs, 0),
    );
  const decodeFactor = Math.max(0.75, Math.min(2.75, weightedDecode));
  const graphFactor =
    1 + Math.max(0, inputs.length - 1) * 0.012 + inputs.filter((item) => item.isInsertion).length * 0.02;
  const baseRenderMs =
    workload.expectedDurationMs * REALTIME_FACTOR[resolution][videoCodec] * decodeFactor * graphFactor;
  const intermediateCodec = videoCodec.endsWith("_NVENC")
    ? "H264_NVENC"
    : videoCodec.endsWith("_QSV")
      ? "H264_QSV"
      : "H264";
  const stagedRenderMs =
    (stage.intermediateWorkMs * REALTIME_FACTOR[resolution][intermediateCodec] * Math.max(0.8, decodeFactor * 0.85)) /
      Math.max(1, boundedParallelJobs * 0.82) +
    stage.intermediateJobCount * 8_000;
  const estimatedRenderTimeMs = Math.ceil(20_000 + baseRenderMs + stagedRenderMs);
  // The base master keeps the v0.79 quality-mode encode. Its size is not
  // strictly bounded by a bitrate setting, so add headroom to the comparable
  // intermediate estimate and keep runtime disk monitoring as the hard guard.
  const referenceMasterVideoBytes = estimatedIntermediateBytes(
    workload.expectedDurationMs,
    resolution,
    resourceProfile,
  );
  const flacMasterAudioBytes = (workload.expectedDurationMs / 1_000) * 250_000;
  const estimatedReusableMasterBytes = Math.ceil(
    Math.max(outputBytes, referenceMasterVideoBytes * 1.25) + flacMasterAudioBytes,
  );
  const audioTemporaryBytes = Math.ceil((workload.expectedDurationMs / 1_000) * 192_000 + 512 * 1024 ** 2);
  const concurrentPartialBytes = stage.concurrentPartialPeakBytes;
  const diskBreakdown = estimatePeakDiskUsage({
    remainingIntermediateBytes: stage.finalIntermediateBytes,
    concurrentPartialBytes,
    segmentBuildPeakBytes: stage.peakIntermediateBytes,
    audioTemporaryBytes,
    estimatedFinalOutputBytes: outputBytes,
    reusableBaseMasterBytes: estimatedReusableMasterBytes,
    currentFreeBytes,
    currentTempFreeBytes,
    currentOutputFreeBytes: currentFreeBytes,
    tempPath,
    outputPath,
  });
  const estimatedTemporaryBytes = diskBreakdown.peakWorkingBytes;
  const estimatedFreeAfterBytes = Math.max(0, Math.floor(currentFreeBytes - outputBytes));
  const tempPeak = diskBreakdown.tempPeakBytes ?? estimatedTemporaryBytes;
  const outputPeak = diskBreakdown.outputPeakBytes ?? estimatedTemporaryBytes;
  const canRender =
    currentTempFreeBytes - tempPeak >= MINIMUM_RENDER_RESERVE_BYTES &&
    currentFreeBytes - outputPeak >= MINIMUM_RENDER_RESERVE_BYTES;
  const ramRatio = estimatedPeakRamBytes / Math.max(1, availableRamBytes);
  const diskRatio = Math.max(
    tempPeak / Math.max(1, currentTempFreeBytes - MINIMUM_RENDER_RESERVE_BYTES),
    outputPeak / Math.max(1, currentFreeBytes - MINIMUM_RENDER_RESERVE_BYTES),
  );
  const warnings: string[] = [];
  if (!canRender) warnings.push("預估工作檔會使輸出磁碟餘量低於 1 GB；開始轉檔時仍會阻擋，以免留下不完整影片。");
  else if (diskRatio >= 0.8) warnings.push("預估 SSD 工作空間接近目前可用容量，請留意其他程式同時寫入磁碟。");
  if (ramRatio >= 1) warnings.push("預估 RAM 峰值高於目前可用記憶體，可能大量使用虛擬記憶體或失敗；仍可選擇此模式。");
  else if (ramRatio >= 0.75) warnings.push("預估 RAM 峰值已接近目前可用記憶體；仍可選擇此模式。");
  return {
    resourceProfile,
    lowMemorySegmented,
    usesSegmentedPipeline,
    estimatedOutputBytes: outputBytes,
    estimatedTemporaryBytes,
    estimatedReusableMasterBytes,
    estimatedPeakRamBytes,
    estimatedRenderTimeMs,
    estimatedFreeAfterBytes,
    maximumSimultaneousInputs: perProcessInputs * boundedParallelJobs,
    maximumParallelJobs: boundedParallelJobs,
    intermediateJobCount: stage.intermediateJobCount,
    warningLevel: warningLevelFor(ramRatio, diskRatio, canRender),
    warnings,
    canRender,
    diskBreakdown,
  };
}

export function buildRenderEstimate(
  outputPath: string,
  currentFreeBytes: number,
  expectedDurationMs: number,
  resolution: PreviewResolution,
  videoCodec: RenderVideoCodec,
  lowMemorySegmented = false,
  workload?: RenderEstimateWorkload,
  availableRamBytes = freemem(),
  totalRamBytes = totalmem(),
  stageLimits: { lowMemory: number; normal: number; highSpeed?: number } = {
    lowMemory: LOW_MEMORY_INPUT_LIMIT,
    normal: 16,
  },
  parallelJobs: { lowMemory: number; normal: number; highSpeed?: number } = { lowMemory: 1, normal: 1 },
  diskCapacityBytes = currentFreeBytes,
  tempPath = process.env.TEMP || path.dirname(outputPath),
  currentTempFreeBytes = currentFreeBytes,
  selectedResourceProfile?: RenderResourceProfile,
): ConcatRenderEstimate {
  const durationMs = finiteDuration(expectedDurationMs);
  if (!Number.isFinite(currentFreeBytes) || currentFreeBytes < 0) throw new Error("無法取得有效的磁碟剩餘空間。");
  const effectiveWorkload = workload ?? { inputs: [], expectedDurationMs: durationMs, transitionSeconds: 0.3 };
  const estimatedOutputBytes = outputSizeBytes(durationMs, resolution, videoCodec);
  const lowDiskDefinition = RENDER_RESOURCE_PROFILES.LOW_DISK;
  const balancedDefinition = RENDER_RESOURCE_PROFILES.BALANCED;
  const highSpeedDefinition = RENDER_RESOURCE_PROFILES.HIGH_SPEED;
  const lowMemory = buildModeEstimate(
    true,
    outputPath,
    estimatedOutputBytes,
    currentFreeBytes,
    availableRamBytes,
    effectiveWorkload,
    resolution,
    videoCodec,
    Math.min(stageLimits.lowMemory, lowDiskDefinition.maxInputsPerStage),
    Math.min(parallelJobs.lowMemory, lowDiskDefinition.maximumJobs),
    tempPath,
    currentTempFreeBytes,
    "LOW_DISK",
  );
  const normal = buildModeEstimate(
    false,
    outputPath,
    estimatedOutputBytes,
    currentFreeBytes,
    availableRamBytes,
    effectiveWorkload,
    resolution,
    videoCodec,
    Math.min(stageLimits.normal, balancedDefinition.maxInputsPerStage),
    Math.min(parallelJobs.normal, balancedDefinition.maximumJobs),
    tempPath,
    currentTempFreeBytes,
    "BALANCED",
  );
  const highSpeed = buildModeEstimate(
    false,
    outputPath,
    estimatedOutputBytes,
    currentFreeBytes,
    availableRamBytes,
    effectiveWorkload,
    resolution,
    videoCodec,
    Math.min(stageLimits.highSpeed ?? highSpeedDefinition.maxInputsPerStage, highSpeedDefinition.maxInputsPerStage),
    Math.min(parallelJobs.highSpeed ?? highSpeedDefinition.maximumJobs, highSpeedDefinition.maximumJobs),
    tempPath,
    currentTempFreeBytes,
    "HIGH_SPEED",
  );
  const activeProfile = selectedResourceProfile ?? resourceProfileFromLegacy({ lowMemorySegmented });
  const selected = activeProfile === "LOW_DISK" ? lowMemory : activeProfile === "HIGH_SPEED" ? highSpeed : normal;
  const totalInputDuration = effectiveWorkload.inputs.reduce((sum, item) => sum + item.durationMs, 0);
  const weighted = (key: "fps" | "width" | "height") =>
    effectiveWorkload.inputs.reduce((sum, item) => sum + item[key] * item.durationMs, 0) /
    Math.max(1, totalInputDuration);
  const warning = selected.warnings.join(" ") || undefined;
  const safetyMarginBytes = Math.ceil(
    Math.max(MINIMUM_RENDER_SAFETY_MARGIN_BYTES, selected.estimatedTemporaryBytes * 0.2, Math.max(0, diskCapacityBytes) * RENDER_SAFETY_MARGIN_DISK_RATIO),
  );
  const selectedDisk = selected.diskBreakdown;
  const requiredFreeBytes = selectedDisk?.requiredPeakFreeBytes ?? selected.estimatedTemporaryBytes + safetyMarginBytes;
  const tempBelowReserve = Boolean(
    selectedDisk?.tempRequiredFreeBytes && currentTempFreeBytes < selectedDisk.tempRequiredFreeBytes,
  );
  const outputBelowReserve = Boolean(
    selectedDisk?.outputRequiredFreeBytes && currentFreeBytes < selectedDisk.outputRequiredFreeBytes,
  );
  const safetyWarning =
    tempBelowReserve || outputBelowReserve
      ? `Render TEMP 或輸出磁碟低於「各自峰值＋至少 ${Math.ceil(safetyMarginBytes / 1024 ** 3)} GB 安全餘量」；可自行確認後繼續，但有後段磁碟不足風險。`
      : undefined;
  return {
    outputPath,
    driveRoot: path.parse(outputPath).root,
    currentFreeBytes: Math.floor(currentFreeBytes),
    estimatedOutputBytes,
    estimatedTemporaryBytes: selected.estimatedTemporaryBytes,
    estimatedRenderTimeMs: selected.estimatedRenderTimeMs,
    estimatedFreeAfterBytes: selected.estimatedFreeAfterBytes,
    minimumReserveBytes: MINIMUM_RENDER_RESERVE_BYTES,
    safetyMarginBytes,
    requiredFreeBytes,
    canRender: selected.canRender,
    ...(warning || safetyWarning ? { warning: [warning, safetyWarning].filter(Boolean).join(" ") } : {}),
    currentAvailableRamBytes: Math.floor(availableRamBytes),
    totalRamBytes: Math.floor(totalRamBytes),
    modeEstimates: { lowMemory, normal, lowDisk: lowMemory, balanced: normal, highSpeed },
    workload: {
      visualInputCount: effectiveWorkload.inputs.length,
      insertedInputCount: effectiveWorkload.inputs.filter((item) => item.isInsertion).length,
      photoInputCount: effectiveWorkload.inputs.filter((item) => item.isPhoto).length,
      videoInputCount: effectiveWorkload.inputs.filter((item) => !item.isPhoto).length,
      sourceDurationMs: totalInputDuration || durationMs,
      weightedSourceFps: effectiveWorkload.inputs.length ? weighted("fps") : OUTPUT_FPS,
      weightedSourceWidth: effectiveWorkload.inputs.length
        ? weighted("width")
        : RESOLUTION_PROFILES[resolution].landscape.width,
      weightedSourceHeight: effectiveWorkload.inputs.length
        ? weighted("height")
        : RESOLUTION_PROFILES[resolution].landscape.height,
      transitionSeconds: effectiveWorkload.transitionSeconds,
    },
  };
}

export async function estimateRenderOnDisk(
  outputPath: string,
  expectedDurationMs: number,
  resolution: PreviewResolution,
  videoCodec: RenderVideoCodec,
  lowMemorySegmented = false,
  workload?: RenderEstimateWorkload,
): Promise<ConcatRenderEstimate> {
  const targetDirectory = path.dirname(path.resolve(outputPath));
  let disk;
  try {
    disk = await statfs(targetDirectory);
  } catch (error) {
    throw new Error(
      `無法讀取輸出磁碟的剩餘空間，為避免不完整影片，本次不會開始轉檔：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const currentFreeBytes = Number(disk.bavail) * Number(disk.bsize);
  return buildRenderEstimate(
    path.resolve(outputPath),
    currentFreeBytes,
    expectedDurationMs,
    resolution,
    videoCodec,
    lowMemorySegmented,
    workload,
  );
}
