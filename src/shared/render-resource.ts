import type { PreviewResolution } from "./domain";

export type RenderResourceProfile = "LOW_DISK" | "BALANCED" | "HIGH_SPEED";

export interface RenderResourceProfileDefinition {
  id: RenderResourceProfile;
  label: string;
  maxInputsPerStage: number;
  initialJobs: number;
  maximumJobs: number;
  defaultRamGiB: number;
  defaultTempGiB: number | "AUTO";
  intermediateMbps: Record<PreviewResolution, number>;
}

const lowDiskRates: Record<PreviewResolution, number> = {
  "360P": 2.2,
  "480P": 3.8,
  "720P": 9,
  "1080P": 18,
  "1440P": 28,
  "4K": 45,
};

export const RENDER_RESOURCE_PROFILES: Record<RenderResourceProfile, RenderResourceProfileDefinition> = {
  LOW_DISK: {
    id: "LOW_DISK",
    label: "低磁碟空間",
    maxInputsPerStage: 4,
    initialJobs: 1,
    maximumJobs: 1,
    defaultRamGiB: 8,
    defaultTempGiB: 100,
    intermediateMbps: lowDiskRates,
  },
  BALANCED: {
    id: "BALANCED",
    label: "平衡",
    maxInputsPerStage: 8,
    initialJobs: 1,
    maximumJobs: 2,
    defaultRamGiB: 10,
    defaultTempGiB: 150,
    intermediateMbps: Object.fromEntries(
      Object.entries(lowDiskRates).map(([key, value]) => [key, value * 1.22]),
    ) as Record<PreviewResolution, number>,
  },
  HIGH_SPEED: {
    id: "HIGH_SPEED",
    label: "高速",
    maxInputsPerStage: 10,
    initialJobs: 1,
    maximumJobs: 4,
    defaultRamGiB: 12,
    defaultTempGiB: 200,
    intermediateMbps: Object.fromEntries(
      Object.entries(lowDiskRates).map(([key, value]) => [key, value * 1.44]),
    ) as Record<PreviewResolution, number>,
  },
};

export function resourceProfileFromLegacy(input: {
  resourceProfile?: RenderResourceProfile;
  lowMemorySegmented?: boolean;
  highSpeedMode?: boolean;
}): RenderResourceProfile {
  if (input.resourceProfile && input.resourceProfile in RENDER_RESOURCE_PROFILES) return input.resourceProfile;
  if (input.highSpeedMode === true) return "HIGH_SPEED";
  if (input.lowMemorySegmented === true) return "LOW_DISK";
  return "BALANCED";
}

export function estimatedIntermediateBytes(
  durationMs: number,
  resolution: PreviewResolution,
  profile: RenderResourceProfile,
): number {
  const mbps = RENDER_RESOURCE_PROFILES[profile].intermediateMbps[resolution];
  // Includes 192 kbps AAC and 8% container/rate-control headroom.
  return Math.ceil((((Math.max(0, durationMs) / 1000) * (mbps + 0.192) * 1_000_000) / 8) * 1.08);
}

export function intermediateBitrateArgs(resolution: PreviewResolution, profile: RenderResourceProfile): {
  bitrate: string;
  maxrate: string;
  bufsize: string;
} {
  const mbps = RENDER_RESOURCE_PROFILES[profile].intermediateMbps[resolution];
  const text = (value: number) => `${Math.max(1, Math.round(value * 10) / 10)}M`;
  return { bitrate: text(mbps), maxrate: text(mbps * 1.18), bufsize: text(mbps * 2) };
}
