import { describe, expect, it } from "vitest";
import { finalInsertionAudioSignature, pictureBaseRenderSignature } from "../src/main/services/concat-render";
import type { ConcatRenderRequest, InsertionAudioPlan, ProjectManifest } from "../src/shared/domain";

const request = {
  outputToken: "test",
  orderedAssetIds: ["video"],
  clipSelections: [{ assetId: "video", inMs: 0, outMs: 2_000 }],
  transitionSeconds: 0.3,
  resolution: "1080P",
  videoCodec: "H264",
  purpose: "CONCAT",
  includeBgm: true,
  bgmScopes: { intro: true, main: true },
  audioProcessing: {
    mode: "ORIGINAL_STEREO",
    preset: "NATURAL",
    codec: "AAC",
    bitrateKbps: 192,
    sampleRate: 48_000,
    surroundStrengthPercent: 65,
    lfeStrengthPercent: 45,
    lfeCutoffHz: 100,
    loudnessTargetLufs: -16,
    truePeakCeilingDb: -1.5,
    stereoWidthPercent: 100,
    eqLowDb: 0,
    eqPresenceDb: 0,
  },
} as ConcatRenderRequest;

const project = {
  id: "project",
  updatedAt: "2026-09-17T00:00:00.000Z",
  sources: [
    {
      id: "video",
      sourcePath: "C:/video.mp4",
      fileName: "video.mp4",
      kind: "VIDEO",
      mainAudioGates: { original: true, voice: true, bgm: true, sfx: true },
    },
  ],
  mediaInsertions: [],
  introSegments: [],
  bgmTracks: [{ id: "music", sourcePath: "C:/music.mp3" }],
  mainStartCue: { enabled: true, durationMs: 650 },
} as unknown as ProjectManifest;

const plan = {
  version: "insertion-audio-plan-v1",
  timelineDurationMs: 2_000,
  transitionMs: 300,
  items: [
    {
      instanceId: "MAIN:video:0:2000",
      scope: "MAIN",
      assetId: "video",
      fileName: "video.mp4",
      kind: "VIDEO",
      timelineStartMs: 0,
      timelineEndMs: 2_000,
      durationMs: 2_000,
      sourceInMs: 0,
      sourceOutMs: 2_000,
      hasSourceAudio: true,
      gates: { original: true, voice: true, bgm: true, sfx: true },
      sfxEnabled: false,
      bgmEnabled: false,
      continuousWithPrevious: false,
      usesLoop: false,
      fadeMs: 180,
    },
  ],
  bgmRanges: [],
  sfxEvents: [],
  warnings: [],
} as InsertionAudioPlan;

describe("v0.75 audio-only checkpoint signatures", () => {
  it("reuses the picture/base master for track-gate, cue and global-BGM changes", () => {
    const base = pictureBaseRenderSignature(project, request);
    const changed = structuredClone(project);
    changed.sources[0].mainAudioGates = { original: false, voice: false, bgm: false, sfx: false };
    changed.mainStartCue = { enabled: false, durationMs: 1_200 };
    changed.bgmTracks = [{ ...changed.bgmTracks[0], sourceInMs: 500, sourceOutMs: 1_500 } as never];
    expect(pictureBaseRenderSignature(changed, { ...request, includeBgm: false })).toBe(base);

    const gatedPlan = structuredClone(plan);
    gatedPlan.items[0].gates.original = false;
    expect(finalInsertionAudioSignature(base, gatedPlan, request)).not.toBe(
      finalInsertionAudioSignature(base, plan, request),
    );
  });

  it("does not re-key picture media when only TEMP location or storage estimates change", () => {
    const original = pictureBaseRenderSignature(project, {
      ...request,
      renderTemporaryFolder: "E:\\temp\\SceneryWalker",
      tempLocations: [{ id: "primary", path: "E:\\temp\\SceneryWalker", role: "PRIMARY", enabled: true }],
      tempLocationSelection: "PRIMARY",
      estimatedPeakDiskBytes: 100,
    });
    const fallback = pictureBaseRenderSignature(project, {
      ...request,
      renderTemporaryFolder: "C:\\Users\\test\\AppData\\Local\\Temp\\SceneryWalker",
      tempLocations: [
        {
          id: "fallback",
          path: "C:\\Users\\test\\AppData\\Local\\Temp\\SceneryWalker",
          role: "FALLBACK",
          enabled: true,
        },
      ],
      tempLocationSelection: "FALLBACK",
      estimatedPeakDiskBytes: 200,
    });
    expect(fallback).toBe(original);
  });
});
