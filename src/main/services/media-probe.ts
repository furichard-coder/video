import type { BasicMediaInfo } from "../../shared/domain";
import { runProcess } from "./process-runner";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    tags?: Record<string, string>;
  };
}

function parseCaptureTime(output: ProbeOutput): string | undefined {
  const tags = [output.format?.tags, ...(output.streams ?? []).map((stream) => stream.tags)];
  const preferredKeys = [
    "datetimeoriginal",
    "date_time_original",
    "com.apple.quicktime.creationdate",
    "creation_time",
    "date",
  ];

  for (const key of preferredKeys) {
    for (const group of tags) {
      if (!group) continue;
      const match = Object.entries(group).find(([name]) => name.toLowerCase() === key);
      if (!match) continue;
      const parsed = new Date(match[1]);
      if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
    }
  }
  return undefined;
}

function positiveNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class MediaProbe {
  constructor(private readonly executable = process.env.FFPROBE_PATH || "ffprobe") {}

  async probe(sourcePath: string, signal?: AbortSignal): Promise<BasicMediaInfo> {
    const { stdout } = await runProcess(
      this.executable,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", sourcePath],
      signal,
    );
    const output = JSON.parse(stdout) as ProbeOutput;
    const video = output.streams?.find((stream) => stream.codec_type === "video");
    const audio = output.streams?.find((stream) => stream.codec_type === "audio");
    const durationSeconds = positiveNumber(video?.duration) ?? positiveNumber(output.format?.duration);
    const rawRotation =
      video?.side_data_list?.find((item) => Number.isFinite(item.rotation))?.rotation ??
      Number(video?.tags?.rotate ?? 0);
    const rotationDegrees = Number.isFinite(rawRotation) ? ((Math.round(rawRotation) % 360) + 360) % 360 : 0;
    const swapsAxes = rotationDegrees === 90 || rotationDegrees === 270;
    const displayWidth = swapsAxes ? video?.height : video?.width;
    const displayHeight = swapsAxes ? video?.width : video?.height;

    return {
      width: video?.width,
      height: video?.height,
      durationMs: durationSeconds ? Math.round(durationSeconds * 1000) : undefined,
      frameRate: video?.avg_frame_rate || video?.r_frame_rate,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
      captureTime: parseCaptureTime(output),
      rotationDegrees,
      displayWidth,
      displayHeight,
      isPortrait: Boolean(displayWidth && displayHeight && displayHeight > displayWidth),
    };
  }
}
