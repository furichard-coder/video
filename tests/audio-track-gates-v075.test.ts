import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildInsertionAudioPostArguments } from "../src/main/services/insertion-audio-render";
import { runProcess } from "../src/main/services/process-runner";
import type { AudioTrackGates, BgmTrack, InsertionAudioPlan } from "../src/shared/domain";

let root: string;
let base: string;
let bgm: string;

const processing = {
  mode: "ORIGINAL_STEREO" as const, preset: "NATURAL" as const, codec: "AAC" as const, bitrateKbps: 192,
  sampleRate: 48_000 as const, surroundStrengthPercent: 65, lfeStrengthPercent: 45, lfeCutoffHz: 100 as const,
  loudnessTargetLufs: -16, truePeakCeilingDb: -1.5, stereoWidthPercent: 100, eqLowDb: 0, eqPresenceDb: 0,
};
const protection = {
  enabled: false, autoDuckVoiceAndSuddenSounds: false, preserveDistantCrowdAmbience: true,
  preserveSceneMatchedSounds: true, eqEnabled: false, maxDuckingDb: 3, eqReductionDb: 1, peakCeilingDb: -1 as const,
};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "v075-gates-"));
  base = path.join(root, "base.mkv");
  bgm = path.join(root, "bgm.wav");
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2", "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "flac", "-shortest", "-y", base,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2",
    "-c:a", "pcm_s16le", "-y", bgm,
  ]);
});

afterAll(async () => rm(root, { recursive: true, force: true }));

function plan(gates: AudioTrackGates, cueDurationMs?: number): InsertionAudioPlan {
  return {
    version: "insertion-audio-plan-v1", timelineDurationMs: 2_000, transitionMs: 300,
    items: [{
      instanceId: "main:clip", scope: "MAIN", assetId: "clip", fileName: "clip.mp4", kind: "VIDEO",
      timelineStartMs: 500, timelineEndMs: 1_500, durationMs: 1_000, sourceInMs: 500, sourceOutMs: 1_500,
      hasSourceAudio: true, gates, sfxEnabled: false, bgmEnabled: false, continuousWithPrevious: false,
      usesLoop: false, fadeMs: 180,
    }],
    bgmRanges: [],
    sfxEvents: cueDurationMs === undefined ? [] : [{
      instanceId: "MAIN_START_CUE", scope: "MAIN", timelineStartMs: 250,
      sfxId: "SCENERYWALKER_MAIN_START_CHIME_V1", displayName: "正片開始提示音（SFX）",
      volumePercent: 70, durationMs: cueDurationMs, source: "SYNTHETIC_MAIN_CUE",
    }],
    warnings: [],
  };
}

const music: BgmTrack = {
  id: "music", sourcePath: "", fileName: "bgm.wav", sizeBytes: 1, durationMs: 2_000,
  sourceInMs: 0, sourceOutMs: 2_000, timelineInMs: 0, timelineOutMs: 2_000,
  fadeInMs: 0, fadeOutMs: 0, volumePercent: 35, sourcePolicy: "READ_ONLY", addedAt: "",
};

async function render(name: string, gates: AudioTrackGates, cueDurationMs?: number) {
  const output = path.join(root, `${name}.mp4`);
  const script = path.join(root, `${name}.txt`);
  const post = buildInsertionAudioPostArguments({
    baseMasterPath: base, outputPath: output, durationMs: 2_000, baseHasAudio: true,
    plan: plan(gates, cueDurationMs), tracks: [], additionalBgmTracks: [{ ...music, sourcePath: bgm }],
    audioProcessing: processing, audioProtection: protection, filterScriptPath: script,
  });
  await writeFile(script, post.filterScript);
  await runProcess("ffmpeg", post.args);
  return { output, post };
}

async function bandMean(file: string, frequency: number, start = 0.75, duration = 0.5): Promise<number> {
  const measured = await runProcess("ffmpeg", [
    "-hide_banner", "-nostats", "-ss", String(start), "-t", String(duration), "-i", file,
    "-map", "0:a:0", "-af", `bandpass=f=${frequency}:w=80,volumedetect`, "-f", "null", "-",
  ]);
  return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(measured.stderr)?.[1]);
}

async function videoHash(file: string): Promise<string> {
  const result = await runProcess("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-"]);
  return result.stdout.trim();
}

describe("v0.75 canonical audio track gates", () => {
  it("mutes only Original over the exact range while BGM continues and video packets remain identical", async () => {
    const all = { original: true, voice: true, bgm: true, sfx: true };
    const baseline = await render("all", all);
    const originalOff = await render("original-off", { ...all, original: false });
    expect(await bandMean(originalOff.output, 220)).toBeLessThan((await bandMean(baseline.output, 220)) - 12);
    expect(await bandMean(originalOff.output, 660)).toBeGreaterThan(-45);
    expect(await videoHash(originalOff.output)).toBe(await videoHash(baseline.output));
    expect(originalOff.post.filterScript).toContain("0.025");
  }, 30_000);

  it("BGM OFF does not mute source or reset its playhead, and Voice OFF is inert when no voice track exists", async () => {
    const baseline = await render("baseline-2", { original: true, voice: true, bgm: true, sfx: true });
    const gated = await render("bgm-voice-off", { original: true, voice: false, bgm: false, sfx: true });
    expect(Math.abs((await bandMean(gated.output, 220)) - (await bandMean(baseline.output, 220)))).toBeLessThan(3);
    expect(await bandMean(gated.output, 660)).toBeLessThan((await bandMean(baseline.output, 660)) - 10);
    expect(gated.post.filterScript).toContain("(0.525-t)/0.025");
    expect(await videoHash(gated.output)).toBe(await videoHash(baseline.output));
  }, 30_000);

  it("renders the global Main cue independently from clip SFX gates at default and custom durations", async () => {
    const off = { original: true, voice: true, bgm: true, sfx: false };
    const defaultCue = await render("cue-650", off, 650);
    const customCue = await render("cue-1200", off, 1_200);
    expect(defaultCue.post.filterScript).toContain("duration=0.65");
    expect(customCue.post.filterScript).toContain("duration=1.2");
    expect(defaultCue.post.sfxInputCount).toBe(0);
    expect(await videoHash(customCue.output)).toBe(await videoHash(defaultCue.output));
  }, 30_000);
});
