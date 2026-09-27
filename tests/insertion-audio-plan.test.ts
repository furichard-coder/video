import { describe, expect, it } from "vitest";
import type { AudioTrackGates, InsertionAudioSettings, ProjectManifest, SourceAsset } from "../src/shared/domain";
import { buildInsertionAudioPlan, normalizeInsertionAudioSettings } from "../src/shared/insertion-audio-plan";

const audio = (trackId?: string, sfxEnabled = true, trackGates?: AudioTrackGates): InsertionAudioSettings => ({
  ...(trackGates ? { trackGates } : {}),
  sfxEnabled,
  sfxId: "DUNES_CAMERA_SHUTTER_CLICK_14671",
  sfxVolumePercent: 70,
  bgmTrackId: trackId,
  bgmVolumePercent: 28,
  fadeMs: 180,
  loopCrossfadeMs: 120,
});

function asset(id: string, kind: "VIDEO" | "IMAGE", durationMs: number, audioCodec?: string): SourceAsset {
  return {
    id,
    sourcePath: `C:/${id}.${kind === "VIDEO" ? "mp4" : "jpg"}`,
    sourceIdentity: id,
    fileName: id,
    extension: kind === "VIDEO" ? ".mp4" : ".jpg",
    kind,
    sizeBytes: 1,
    fileCreatedAt: "",
    fileModifiedAt: "",
    addedAt: "",
    addedOrder: 0,
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewCacheKey: id,
    metadataState: "READY",
    mediaInfo: { durationMs, audioCodec },
    ...(kind === "IMAGE" ? { imageDurationMs: durationMs } : {}),
  };
}

function fixture(): ProjectManifest {
  const sources = [
    asset("anchor", "VIDEO", 20_000, "aac"),
    asset("a", "IMAGE", 3_000),
    asset("b", "IMAGE", 4_000),
    asset("c", "VIDEO", 6_000, "aac"),
    asset("d", "IMAGE", 3_000),
  ];
  return {
    schemaVersion: 20,
    id: "p",
    name: "test",
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewerVersion: "preview-v5-orientation-planar-safe",
    sortMode: "MANUAL_ORDER",
    createdAt: "",
    updatedAt: "",
    sources,
    timelineOrder: ["anchor"],
    timelineTransitionSeconds: 0.3,
    pendingAssetIds: [],
    excludedMainAssetIds: [],
    recentMainRemovals: [],
    introSegments: [],
    introTargetDurationMs: 90_000,
    introSegmentMaxDurationMs: 15_000,
    colorSettings: { introPresetId: "NATURAL", applyToMain: false },
    introExcludedSegmentIds: [],
    recentIntroRemovals: [],
    placementDecisions: [],
    mediaInsertions: ["a", "b", "c", "d"].map((id, index) => ({
      id: `i-${id}`,
      anchorVideoAssetId: "anchor",
      insertedAssetId: id,
      atMs: 5_000,
      sourceInMs: 0,
      sourceOutMs: sources.find((item) => item.id === id)!.mediaInfo!.durationMs!,
      sequenceIndex: index,
      previousPlacement: "PENDING" as const,
      previousTimelineIndex: 1,
      createdAt: "",
      insertionAudio: audio("music", id !== "c"),
    })),
    mainStartCue: { enabled: true, durationMs: 650 },
    photoSoundEffect: {
      id: "DUNES_CAMERA_SHUTTER_CLICK_14671",
      displayName: "相机快门效果音（SFX）",
      sourceProject: "licensed",
      sourceUrl: "",
      licenseUrl: "",
      sha256: "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93",
      volumePercent: 70,
    },
    bgmTracks: [{
      id: "music",
      sourcePath: "C:/music.mp3",
      fileName: "music.mp3",
      sizeBytes: 1,
      durationMs: 5_000,
      sourceInMs: 0,
      sourceOutMs: 5_000,
      timelineInMs: 0,
      timelineOutMs: 5_000,
      fadeInMs: 0,
      fadeOutMs: 0,
      volumePercent: 35,
      sourcePolicy: "READ_ONLY",
      addedAt: "",
    }],
    sourceAudioVolumePercent: 100,
    aiStoryContext: { topic: "", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh-TW" },
    subtitleCues: [],
    timelineRevision: 1,
    subtitleTimelineRevision: 1,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  };
}

describe("canonical insertion audio plan", () => {
  it("supports all four independent SFX/BGM combinations", () => {
    expect(normalizeInsertionAudioSettings(audio(undefined, false), "IMAGE")).toMatchObject({ sfxEnabled: false, bgmTrackId: undefined });
    expect(normalizeInsertionAudioSettings(audio(undefined, true), "IMAGE")).toMatchObject({ sfxEnabled: true, bgmTrackId: undefined });
    expect(normalizeInsertionAudioSettings(audio("music", false), "IMAGE", new Set(["music"]))).toMatchObject({ sfxEnabled: false, bgmTrackId: "music" });
    expect(normalizeInsertionAudioSettings(audio("music", true), "IMAGE", new Set(["music"]))).toMatchObject({ sfxEnabled: true, bgmTrackId: "music" });
  });

  it("merges A3+B4+C6+D3 into one continuous 16 second range without transitions", () => {
    const plan = buildInsertionAudioPlan(fixture(), { purpose: "CONCAT", transitionSeconds: 0, prependIntro: false });
    const inserted = plan.items.filter((item) => item.instanceId.startsWith("i-"));
    expect(inserted).toHaveLength(4);
    expect(plan.bgmRanges).toHaveLength(1);
    expect(plan.bgmRanges[0]).toMatchObject({ durationMs: 16_000, memberInstanceIds: ["i-a", "i-b", "i-c", "i-d"], usesLoop: true });
    expect(plan.bgmRanges[0].loopStrategy).toBe("CROSSFADE");
    expect(inserted.map((item) => item.continuousWithPrevious)).toEqual([false, true, true, true]);
    expect(inserted.map((item) => item.bgmSourcePositionMs)).toEqual([0, 3_000, 2_120, 3_240]);
    expect(plan.sfxEvents.map((item) => item.instanceId)).toEqual(["i-a", "i-b", "i-d"]);
  });

  it("uses actual transition overlap and keeps source-video audio independent", () => {
    const plan = buildInsertionAudioPlan(fixture(), { purpose: "CONCAT", transitionSeconds: 0.3, prependIntro: false });
    expect(plan.bgmRanges[0].durationMs).toBe(15_100);
    expect(plan.items.find((item) => item.instanceId === "i-c")?.hasSourceAudio).toBe(true);
    expect(plan.sfxEvents.some((event) => event.instanceId === "i-c")).toBe(false);
  });

  it("splits ranges when the track changes or BGM is disabled", () => {
    const project = fixture();
    project.bgmTracks.push({ ...project.bgmTracks[0], id: "music-2", fileName: "music-2.mp3" });
    project.mediaInsertions[1].insertionAudio = audio("music-2");
    project.mediaInsertions[2].insertionAudio = audio(undefined, false);
    const plan = buildInsertionAudioPlan(project, { purpose: "CONCAT", transitionSeconds: 0, prependIntro: false });
    expect(plan.bgmRanges.map((range) => range.bgmTrackId)).toEqual(["music", "music-2", "music"]);
    expect(plan.items.find((item) => item.instanceId === "i-c")?.bgmEnabled).toBe(false);
  });

  it("keeps one configured BGM playhead across a clip-level silent gate", () => {
    const project = fixture();
    project.mediaInsertions[1].insertionAudio = audio("music", true, {
      original: true, voice: true, bgm: false, sfx: true,
    });
    const plan = buildInsertionAudioPlan(project, { purpose: "CONCAT", transitionSeconds: 0, prependIntro: false });
    const inserted = plan.items.filter((item) => item.instanceId.startsWith("i-"));
    expect(plan.bgmRanges).toHaveLength(1);
    expect(plan.bgmRanges[0].memberInstanceIds).toEqual(["i-a", "i-b", "i-c", "i-d"]);
    expect(inserted[1]).toMatchObject({ bgmEnabled: false, bgmTrackId: "music", bgmSourcePositionMs: 3_000 });
    expect(inserted[2]).toMatchObject({ bgmEnabled: true, bgmSourcePositionMs: 2_120 });
  });

  it("keeps repeated Intro occurrences of one asset independent", () => {
    const project = fixture();
    project.introSegments = [
      { id: "intro-a", assetId: "a", fileName: "a", inMs: 0, outMs: 3_000, score: 1, reasons: [], insertionAudio: audio("music", true) },
      { id: "intro-b", assetId: "a", fileName: "a", inMs: 0, outMs: 3_000, score: 1, reasons: [], insertionAudio: audio(undefined, false) },
    ];
    const plan = buildInsertionAudioPlan(project, { purpose: "INTRO", transitionSeconds: 0 });
    expect(plan.items.map((item) => [item.instanceId, item.sfxEnabled, item.bgmEnabled])).toEqual([
      ["intro-a", true, true],
      ["intro-b", false, false],
    ]);
  });

  it("keeps the global Main-start cue independent from per-clip SFX gates and preserves duration", () => {
    const project = fixture();
    project.sources[0].mainAudioGates = { original: true, voice: false, bgm: false, sfx: false };
    const options = {
      purpose: "CONCAT" as const,
      transitionSeconds: 0 as const,
      prependIntro: true,
      mainStartCard: {
        durationSeconds: 4, line1: "漫步風光", line2: "旅程開始", line1FontSize1080p: 114,
        line2FontSize1080p: 90, lineGap1080p: 122, overlayOpacityPercent: 62, transitionStyle: "HARD_CUT" as const,
      },
    };
    const plan = buildInsertionAudioPlan(project, options);
    expect(plan.sfxEvents.find((event) => event.sfxId === "SCENERYWALKER_MAIN_START_CHIME_V1")).toMatchObject({
      scope: "MAIN", durationMs: 650, source: "SYNTHETIC_MAIN_CUE",
    });
    expect(plan.items.find((item) => item.assetId === "anchor")?.gates).toMatchObject({ voice: false, bgm: false, sfx: false });
    const duration = plan.timelineDurationMs;
    project.mainStartCue.enabled = false;
    const withoutCue = buildInsertionAudioPlan(project, options);
    expect(withoutCue.timelineDurationMs).toBe(duration);
    expect(withoutCue.sfxEvents.some((event) => event.sfxId === "SCENERYWALKER_MAIN_START_CHIME_V1")).toBe(false);
  });
});
