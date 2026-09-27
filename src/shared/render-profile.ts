import type { PreviewResolution } from "./domain";

export interface RenderDimensions {
  width: number;
  height: number;
}

export interface ResolutionProfile {
  id: PreviewResolution;
  label: string;
  landscape: RenderDimensions;
  pixels: number;
}

/** One source of truth for render, preview geometry, subtitles and estimates. */
export const RESOLUTION_PROFILES: Record<PreviewResolution, ResolutionProfile> = {
  "360P": { id: "360P", label: "360p", landscape: { width: 640, height: 360 }, pixels: 640 * 360 },
  "480P": { id: "480P", label: "480p", landscape: { width: 854, height: 480 }, pixels: 854 * 480 },
  "720P": { id: "720P", label: "720p", landscape: { width: 1280, height: 720 }, pixels: 1280 * 720 },
  "1080P": { id: "1080P", label: "1080p", landscape: { width: 1920, height: 1080 }, pixels: 1920 * 1080 },
  "1440P": { id: "1440P", label: "1440p（2K）", landscape: { width: 2560, height: 1440 }, pixels: 2560 * 1440 },
  "4K": { id: "4K", label: "4K", landscape: { width: 3840, height: 2160 }, pixels: 3840 * 2160 },
};

export const OUTPUT_RESOLUTIONS = Object.keys(RESOLUTION_PROFILES) as PreviewResolution[];

export function outputDimensions(resolution: PreviewResolution, portrait = false): RenderDimensions {
  const dimensions = RESOLUTION_PROFILES[resolution].landscape;
  return portrait ? { width: dimensions.height, height: dimensions.width } : { ...dimensions };
}

export function outputAspectRatio(portrait = false): number {
  return portrait ? 9 / 16 : 16 / 9;
}
