export type OutputCanvasAspect = "LANDSCAPE_16_9" | "PORTRAIT_9_16";

export interface OutputCanvasProfile {
  aspect: OutputCanvasAspect;
  width: number;
  height: number;
  cssAspectRatio: string;
}

export function outputCanvasProfile(
  aspect: OutputCanvasAspect,
  resolution: PreviewResolution = "1080P",
): OutputCanvasProfile {
  const portrait = aspect === "PORTRAIT_9_16";
  const { width, height } = outputDimensions(resolution, portrait);
  return { aspect, width, height, cssAspectRatio: portrait ? "9 / 16" : "16 / 9" };
}

/** Mirrors the existing FFmpeg canvas policy without changing its output. */
export function usesBlurredCanvas(sourceIsPortrait: boolean, outputAspect: OutputCanvasAspect): boolean {
  return sourceIsPortrait || outputAspect === "PORTRAIT_9_16";
}
import type { PreviewResolution } from "./domain";
import { outputDimensions } from "./render-profile";
