import { statfs } from "node:fs/promises";
import path from "node:path";
import type { ConcatRenderEstimate, PreviewResolution, RenderVideoCodec } from "../../shared/domain";

export const MINIMUM_RENDER_RESERVE_BYTES = 1024 ** 3;

const VIDEO_MEGABITS_PER_SECOND: Record<PreviewResolution, { h265: number; h264: number }> = {
  "360P": { h265: 0.65, h264: 1.0 },
  "480P": { h265: 1.2, h264: 1.8 },
  "720P": { h265: 3.5, h264: 5.5 },
  "4K": { h265: 20, h264: 35 },
};

const REALTIME_FACTOR: Record<PreviewResolution, Record<RenderVideoCodec, number>> = {
  "360P": { H265_QSV: 0.25, H264_QSV: 0.2, H265: 0.9, H264: 0.5 },
  "480P": { H265_QSV: 0.35, H264_QSV: 0.28, H265: 1.2, H264: 0.7 },
  "720P": { H265_QSV: 0.65, H264_QSV: 0.45, H265: 2.0, H264: 1.1 },
  "4K": { H265_QSV: 2.8, H264_QSV: 1.8, H265: 8.0, H264: 4.0 },
};

function finiteDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60_000) throw new Error("預估片長無效。");
  return Math.round(value);
}

export function buildRenderEstimate(
  outputPath: string,
  currentFreeBytes: number,
  expectedDurationMs: number,
  resolution: PreviewResolution,
  videoCodec: RenderVideoCodec,
): ConcatRenderEstimate {
  const durationMs = finiteDuration(expectedDurationMs);
  if (!Number.isFinite(currentFreeBytes) || currentFreeBytes < 0) throw new Error("無法取得有效的磁碟剩餘空間。");
  const isH265 = videoCodec === "H265" || videoCodec === "H265_QSV";
  const videoMbps = VIDEO_MEGABITS_PER_SECOND[resolution][isH265 ? "h265" : "h264"];
  const audioMbps = 0.192;
  const estimatedOutputBytes = Math.ceil((((durationMs / 1000) * (videoMbps + audioMbps) * 1_000_000) / 8) * 1.08);
  const estimatedRenderTimeMs = Math.ceil(20_000 + durationMs * REALTIME_FACTOR[resolution][videoCodec]);
  const estimatedFreeAfterBytes = Math.max(0, Math.floor(currentFreeBytes - estimatedOutputBytes));
  const canRender = currentFreeBytes - estimatedOutputBytes >= MINIMUM_RENDER_RESERVE_BYTES;
  return {
    outputPath,
    driveRoot: path.parse(outputPath).root,
    currentFreeBytes: Math.floor(currentFreeBytes),
    estimatedOutputBytes,
    estimatedRenderTimeMs,
    estimatedFreeAfterBytes,
    minimumReserveBytes: MINIMUM_RENDER_RESERVE_BYTES,
    canRender,
    ...(canRender
      ? {}
      : { warning: "預估輸出後磁碟餘量將低於 1 GB。請先清理硬碟空間或改選其他磁碟；本次不會開始轉檔。" }),
  };
}

export async function estimateRenderOnDisk(
  outputPath: string,
  expectedDurationMs: number,
  resolution: PreviewResolution,
  videoCodec: RenderVideoCodec,
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
  return buildRenderEstimate(path.resolve(outputPath), currentFreeBytes, expectedDurationMs, resolution, videoCodec);
}
