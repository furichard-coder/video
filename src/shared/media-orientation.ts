export const ORIENTATION_NORMALIZER_VERSION = "orientation-v2-planar-safe" as const;

export type QuarterTurnDegrees = 0 | 90 | 180 | 270;

export interface OrientationMetadata {
  width?: number;
  height?: number;
  rotationDegrees?: number;
}

export interface CanonicalMediaOrientation {
  codedWidth?: number;
  codedHeight?: number;
  rotationDegrees: QuarterTurnDegrees;
  displayWidth?: number;
  displayHeight?: number;
  isPortrait: boolean;
  /**
   * Filter that turns raw coded pixels into upright display pixels. FFmpeg's
   * input autorotation must be disabled whenever this chain is used.
   */
  ffmpegFilter?: string;
}

/** Normalize ffprobe Display Matrix rotations, including negative values. */
export function normalizeDisplayRotation(value: unknown): QuarterTurnDegrees {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((numeric % 360) + 360) % 360;
  const nearestQuarter = (Math.round(normalized / 90) * 90) % 360;
  return nearestQuarter as QuarterTurnDegrees;
}

/**
 * ffprobe describes the display matrix transform. To physically normalize raw
 * coded pixels, FFmpeg must apply its inverse exactly once.
 */
export function orientationNormalizationFilter(rotationDegrees: unknown): string | undefined {
  switch (normalizeDisplayRotation(rotationDegrees)) {
    case 90:
      return "transpose=cclock";
    case 180:
      return "hflip,vflip";
    case 270:
      return "transpose=clock";
    default:
      return undefined;
  }
}

export function resolveMediaOrientation(metadata: OrientationMetadata): CanonicalMediaOrientation {
  const codedWidth = Number.isFinite(metadata.width) && Number(metadata.width) > 0 ? Number(metadata.width) : undefined;
  const codedHeight =
    Number.isFinite(metadata.height) && Number(metadata.height) > 0 ? Number(metadata.height) : undefined;
  const rotationDegrees = normalizeDisplayRotation(metadata.rotationDegrees);
  const swapsAxes = rotationDegrees === 90 || rotationDegrees === 270;
  const displayWidth = swapsAxes ? codedHeight : codedWidth;
  const displayHeight = swapsAxes ? codedWidth : codedHeight;
  return {
    codedWidth,
    codedHeight,
    rotationDegrees,
    displayWidth,
    displayHeight,
    isPortrait: Boolean(displayWidth && displayHeight && displayHeight > displayWidth),
    ffmpegFilter: orientationNormalizationFilter(rotationDegrees),
  };
}
