export const MAIN_START_CUE_FREQUENCIES_HZ = [659.25, 783.99] as const;
export const MAIN_START_CUE_BASE_GAINS = [0.07, 0.055] as const;

export interface MainStartCueSpec {
  durationSeconds: number;
  secondDelaySeconds: number;
  secondToneSeconds: number;
  fadeOutSeconds: number;
}

/** One deterministic cue timing model shared by WebAudio preview and FFmpeg render. */
export function mainStartCueSpec(durationMs: number): MainStartCueSpec {
  const durationSeconds = Math.max(0.1, Math.min(3, durationMs / 1_000));
  const secondDelaySeconds = Math.min(0.14, Math.max(0.04, durationSeconds * 0.22));
  const secondToneSeconds = Math.max(0.08, durationSeconds - secondDelaySeconds);
  return {
    durationSeconds,
    secondDelaySeconds,
    secondToneSeconds,
    fadeOutSeconds: Math.min(0.08, durationSeconds / 2),
  };
}
