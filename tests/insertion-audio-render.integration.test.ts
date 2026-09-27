import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConcatFilterGraph, type BgmRenderInput } from "../src/main/services/concat-render";
import { buildInsertionAudioPostArguments } from "../src/main/services/insertion-audio-render";
import { runProcess } from "../src/main/services/process-runner";
import type { BgmTrack, InsertionAudioPlan } from "../src/shared/domain";

let root: string;
let silentVideo: string;
let sourceAudioVideo: string;
let bgm: string;
let shutter: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "insertion-audio-render-"));
  silentVideo = path.join(root, "silent.mp4");
  sourceAudioVideo = path.join(root, "source-audio.mp4");
  bgm = path.join(root, "short-bgm.wav");
  shutter = path.join(root, "shutter.wav");
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", silentVideo,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1",
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-y", sourceAudioVideo,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.45",
    "-c:a", "pcm_s16le", "-y", bgm,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=1800:sample_rate=48000:duration=0.12",
    "-af", "afade=t=out:st=0.07:d=0.05", "-c:a", "pcm_s16le", "-y", shutter,
  ]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function range(): BgmRenderInput {
  return {
    id: "insertion-range",
    sourcePath: bgm,
    fileName: "short-bgm.wav",
    sizeBytes: 1,
    durationMs: 450,
    sourceInMs: 0,
    sourceOutMs: 450,
    timelineInMs: 0,
    timelineOutMs: 1_700,
    fadeInMs: 30,
    fadeOutMs: 30,
    volumePercent: 28,
    sourcePolicy: "READ_ONLY",
    addedAt: "2026-09-15T00:00:00.000Z",
    loop: true,
    sourceSpanMs: 450,
    loopCrossfadeMs: 100,
    loopStrategy: "CROSSFADE",
  };
}

describe("canonical insertion audio FFmpeg mix", () => {
  it("uses one post-audio pass with video stream copy and final DSP after source+BGM+SFX mix", async () => {
    const plan: InsertionAudioPlan = {
      version: "insertion-audio-plan-v1",
      timelineDurationMs: 1_000,
      transitionMs: 300,
      items: [],
      bgmRanges: [{
        id: "main:photo:bgm",
        scope: "MAIN",
        bgmTrackId: "bgm",
        bgmTrackIndex: 1,
        bgmTrackName: "short-bgm.wav",
        timelineStartMs: 0,
        timelineEndMs: 1_000,
        durationMs: 1_000,
        sourceInMs: 0,
        sourceSpanMs: 450,
        volumePercent: 28,
        fadeInMs: 30,
        fadeOutMs: 30,
        loopCrossfadeMs: 100,
        usesLoop: true,
        loopStrategy: "CROSSFADE",
        memberInstanceIds: ["photo"],
      }],
      sfxEvents: [{
        instanceId: "photo",
        scope: "MAIN",
        timelineStartMs: 500,
        sfxId: "DUNES_CAMERA_SHUTTER_CLICK_14671",
        displayName: "快門",
        volumePercent: 70,
      }],
      warnings: [],
    };
    const track: BgmTrack = {
      id: "bgm", sourcePath: bgm, fileName: "short-bgm.wav", sizeBytes: 1, durationMs: 450,
      sourceInMs: 0, sourceOutMs: 450, timelineInMs: 0, timelineOutMs: 1_000,
      fadeInMs: 30, fadeOutMs: 30, volumePercent: 28, sourcePolicy: "READ_ONLY",
      addedAt: "2026-09-15T00:00:00.000Z",
    };
    const output = path.join(root, "post-mixed.mp4");
    const script = path.join(root, "post-mixed.filter.txt");
    const post = buildInsertionAudioPostArguments({
      baseMasterPath: sourceAudioVideo,
      outputPath: output,
      durationMs: 1_000,
      baseHasAudio: true,
      plan,
      tracks: [track],
      shutterPath: shutter,
      audioProcessing: {
        mode: "VIRTUAL_SURROUND_5_1", preset: "NATURAL", codec: "AAC", bitrateKbps: 384,
        sampleRate: 48_000, surroundStrengthPercent: 65, lfeStrengthPercent: 45, lfeCutoffHz: 100,
        loudnessTargetLufs: -16, truePeakCeilingDb: -1.5, stereoWidthPercent: 100, eqLowDb: 0, eqPresenceDb: 0,
      },
      audioProtection: {
        enabled: true, autoDuckVoiceAndSuddenSounds: true, preserveDistantCrowdAmbience: true,
        preserveSceneMatchedSounds: true, eqEnabled: true, maxDuckingDb: 3, eqReductionDb: 1, peakCeilingDb: -1,
      },
      filterScriptPath: script,
    });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(script, post.filterScript));
    expect(post.args).toContain("copy");
    expect(post.args.join(" ")).not.toMatch(/-c:v (?!copy)/);
    expect(post.filterScript).toContain("amix=inputs=3");
    expect(post.filterScript.indexOf("amix=inputs=3")).toBeLessThan(post.filterScript.indexOf("asplit=6"));
    expect(post.filterScript).toContain("acrossfade=d=0.1");
    await runProcess("ffmpeg", post.args);
    const probe = await runProcess("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,channel_layout", "-of", "json", output]);
    expect(probe.stdout).toContain('"channels": 6');
  }, 30_000);

  it("uses a real bounded acrossfade loop and keeps SFX as an independent mix input", () => {
    const plan = buildConcatFilterGraph(
      [
        { sourcePath: silentVideo, durationMs: 1_000, hasAudio: false },
        { sourcePath: sourceAudioVideo, durationMs: 1_000, hasAudio: true },
      ],
      0.3,
      "360P",
      [range()],
      100,
      false,
      { enabled: false, autoDuckVoiceAndSuddenSounds: false, preserveDistantCrowdAmbience: true, preserveSceneMatchedSounds: true, eqEnabled: false, maxDuckingDb: 3, eqReductionDb: 1, peakCeilingDb: -1 },
      {
        timedSfxInputs: [{ instanceId: "photo-a", scope: "MAIN", timelineStartMs: 850, sfxId: "DUNES_CAMERA_SHUTTER_CLICK_14671", displayName: "快門", volumePercent: 70 }],
      },
    );
    expect(plan.expectedDurationMs).toBe(1_700);
    expect(plan.filterGraph.match(/acrossfade=d=0\.1:c1=tri:c2=tri/g)?.length).toBeGreaterThanOrEqual(3);
    expect(plan.filterGraph).toContain("[sfx0]");
    expect(plan.filterGraph).toContain("amix=inputs=3");
    expect(plan.filterGraph).toContain("alimiter=limit=0.95");
  });

  it("renders source+BGM+SFX together, loops without a silence gap, and keeps the master below clipping", async () => {
    const plan = buildConcatFilterGraph(
      [
        { sourcePath: silentVideo, durationMs: 1_000, hasAudio: false },
        { sourcePath: sourceAudioVideo, durationMs: 1_000, hasAudio: true },
      ],
      0.3,
      "360P",
      [range()],
      100,
      false,
      { enabled: false, autoDuckVoiceAndSuddenSounds: false, preserveDistantCrowdAmbience: true, preserveSceneMatchedSounds: true, eqEnabled: false, maxDuckingDb: 3, eqReductionDb: 1, peakCeilingDb: -1 },
      {
        timedSfxInputs: [{ instanceId: "photo-a", scope: "MAIN", timelineStartMs: 850, sfxId: "DUNES_CAMERA_SHUTTER_CLICK_14671", displayName: "快門", volumePercent: 70 }],
      },
    );
    const output = path.join(root, "mixed.mkv");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", silentVideo, "-i", sourceAudioVideo, "-i", bgm, "-i", shutter,
      "-filter_complex", plan.filterGraph,
      "-map", `[${plan.videoOutputLabel}]`, "-map", `[${plan.audioOutputLabel}]`,
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le", "-shortest", output,
    ]);
    const silence = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-i", output, "-map", "0:a:0", "-af", "silencedetect=noise=-52dB:d=0.04", "-f", "null", "-",
    ]);
    expect(silence.stderr).not.toContain("silence_duration");
    const meter = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-i", output, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
    ]);
    const peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(meter.stderr)?.[1]);
    expect(peak).toBeLessThanOrEqual(-0.3);
    const shutterBand = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-ss", "0.86", "-t", "0.07", "-i", output, "-map", "0:a:0",
      "-af", "bandpass=f=1800:w=220,volumedetect", "-f", "null", "-",
    ]);
    const baselineBand = await runProcess("ffmpeg", [
      "-hide_banner", "-nostats", "-ss", "0.55", "-t", "0.07", "-i", output, "-map", "0:a:0",
      "-af", "bandpass=f=1800:w=220,volumedetect", "-f", "null", "-",
    ]);
    const shutterMean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(shutterBand.stderr)?.[1]);
    const baselineMean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(baselineBand.stderr)?.[1]);
    expect(shutterMean).toBeGreaterThan(baselineMean + 8);
  }, 30_000);
});
