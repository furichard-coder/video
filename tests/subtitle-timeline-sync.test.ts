import { describe, expect, it } from "vitest";
import type { IntroSuggestion, ProjectManifest, SourceAsset, SubtitleCue } from "../src/shared/domain";
import { syncSubtitlesToTimeline } from "../src/shared/subtitle-timeline-sync";

function image(id: string): SourceAsset {
  return {
    id,
    sourcePath: `C:\\media\\${id}.jpg`,
    sourceIdentity: id,
    fileName: `${id}.jpg`,
    extension: ".jpg",
    kind: "IMAGE",
    sizeBytes: 1,
    fileCreatedAt: "2026-01-01T00:00:00.000Z",
    fileModifiedAt: "2026-01-01T00:00:00.000Z",
    addedAt: "2026-01-01T00:00:00.000Z",
    addedOrder: 0,
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewCacheKey: id,
    metadataState: "READY",
    imageDurationMs: 5_000,
  };
}

function project(order: string[], cues: SubtitleCue[] = [], introSegments: IntroSuggestion[] = []): ProjectManifest {
  const sources = [image("a"), image("b"), image("c")];
  return {
    schemaVersion: 17,
    id: "sync",
    name: "字幕同步",
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewerVersion: "preview-v3",
    sortMode: "MANUAL_ORDER",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sources,
    timelineOrder: order,
    timelineTransitionSeconds: 0.3,
    pendingAssetIds: [],
    excludedMainAssetIds: [],
    recentMainRemovals: [],
    introSegments,
    introTargetDurationMs: 90_000,
    introSegmentMaxDurationMs: 15_000,
    colorSettings: { introPresetId: "NATURAL", applyToMain: false },
    introExcludedSegmentIds: [],
    recentIntroRemovals: [],
    placementDecisions: [],
    mediaInsertions: [],
    photoSoundEffect: {
      id: "x",
      displayName: "x",
      sourceProject: "x",
      sourceUrl: "https://example.com/x",
      licenseUrl: "https://example.com/license",
      sha256: "0".repeat(64),
      volumePercent: 70,
    },
    bgmTracks: [],
    sourceAudioVolumePercent: 100,
    aiStoryContext: {
      topic: "",
      locations: [],
      people: [],
      storySummary: "",
      audiencePromise: "",
      subtitleLanguage: "zh",
    },
    subtitleCues: cues,
    timelineRevision: 1,
    subtitleTimelineRevision: 1,
    mainTimelineRevision: 1,
    introTimelineRevision: 1,
    mainSubtitleReviewRevision: 1,
    introSubtitleReviewRevision: 1,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  };
}

describe("subtitle timeline synchronization", () => {
  it("moves Main cues with their photos after drag reordering", () => {
    const previous = project(
      ["a", "b"],
      [
        { id: "a-cue", startMs: 1_000, endMs: 2_000, text: "照片 A", timelineScope: "MAIN", reviewStatus: "CONFIRMED" },
        { id: "b-cue", startMs: 5_200, endMs: 6_200, text: "照片 B", timelineScope: "MAIN", reviewStatus: "CONFIRMED" },
      ],
    );
    const next = { ...structuredClone(previous), timelineOrder: ["b", "a"] };
    const result = syncSubtitlesToTimeline(previous, next, ["MAIN"]);
    expect(result.cues).toEqual([
      expect.objectContaining({
        id: "b-cue",
        startMs: 500,
        endMs: 1_500,
        sourceAssetId: "b",
        sourceInMs: 500,
        sourceOutMs: 1_500,
      }),
      expect.objectContaining({
        id: "a-cue",
        startMs: 5_700,
        endMs: 6_700,
        sourceAssetId: "a",
        sourceInMs: 1_000,
        sourceOutMs: 2_000,
      }),
    ]);
    expect(result.fullyMapped.MAIN).toBe(true);
  });

  it("shifts following subtitles when a new photo is inserted", () => {
    const previous = project(
      ["a", "b"],
      [
        {
          id: "b-cue",
          startMs: 5_200,
          endMs: 6_200,
          text: "照片 B",
          timelineScope: "MAIN",
          reviewStatus: "CONFIRMED",
          sourceAssetId: "b",
          sourceInMs: 500,
        },
      ],
    );
    const next = { ...structuredClone(previous), timelineOrder: ["a", "c", "b"] };
    const [cue] = syncSubtitlesToTimeline(previous, next, ["MAIN"]).cues;
    expect(cue).toMatchObject({ id: "b-cue", startMs: 9_900, endMs: 10_900 });
  });

  it("shifts following Main subtitles when a photo display duration changes", () => {
    const previous = project(
      ["a", "b"],
      [
        {
          id: "b-cue",
          startMs: 5_200,
          endMs: 6_200,
          text: "照片 B",
          timelineScope: "MAIN",
          reviewStatus: "CONFIRMED",
          sourceAssetId: "b",
          sourceInMs: 500,
        },
      ],
    );
    const next = structuredClone(previous);
    next.sources = next.sources.map((source) => (source.id === "a" ? { ...source, imageDurationMs: 7_000 } : source));
    const [cue] = syncSubtitlesToTimeline(previous, next, ["MAIN"]).cues;
    expect(cue).toMatchObject({ id: "b-cue", startMs: 7_200, endMs: 8_200, sourceAssetId: "b", sourceInMs: 500 });
  });

  it("uses the selected 0.3 to 0.7 second transition when recalculating", () => {
    const previous = project(
      ["a", "b"],
      [
        {
          id: "b-cue",
          startMs: 5_200,
          endMs: 6_200,
          text: "照片 B",
          timelineScope: "MAIN",
          reviewStatus: "CONFIRMED",
          sourceAssetId: "b",
          sourceInMs: 500,
        },
      ],
    );
    const next = { ...structuredClone(previous), timelineTransitionSeconds: 0.7 as const };
    const [cue] = syncSubtitlesToTimeline(previous, next, ["MAIN"], 0.3, 0.7).cues;
    expect(cue).toMatchObject({ startMs: 4_800, endMs: 5_800 });
  });

  it("keeps Intro cues attached to their stable segment after reordering", () => {
    const first = { id: "intro-a", assetId: "a", fileName: "a.jpg", inMs: 0, outMs: 5_000, score: 80, reasons: ["A"] };
    const second = { id: "intro-b", assetId: "b", fileName: "b.jpg", inMs: 0, outMs: 5_000, score: 70, reasons: ["B"] };
    const previous = project(
      [],
      [
        {
          id: "intro-cue",
          startMs: 5_100,
          endMs: 6_100,
          text: "片頭 B",
          timelineScope: "INTRO",
          reviewStatus: "CONFIRMED",
          sourceAssetId: "b",
          sourceInMs: 400,
        },
      ],
      [first, second],
    );
    const next = { ...structuredClone(previous), introSegments: [second, first] };
    const [cue] = syncSubtitlesToTimeline(previous, next, ["INTRO"]).cues;
    expect(cue).toMatchObject({ id: "intro-cue", startMs: 400, endMs: 1_400, sourceAssetId: "b" });
  });

  it("shifts following Intro subtitles when an earlier segment display duration changes", () => {
    const first = { id: "intro-a", assetId: "a", fileName: "a.jpg", inMs: 0, outMs: 5_000, score: 80, reasons: ["A"] };
    const second = { id: "intro-b", assetId: "b", fileName: "b.jpg", inMs: 0, outMs: 5_000, score: 70, reasons: ["B"] };
    const previous = project(
      [],
      [
        {
          id: "intro-cue",
          startMs: 5_100,
          endMs: 6_100,
          text: "片頭 B",
          timelineScope: "INTRO",
          reviewStatus: "CONFIRMED",
          sourceAssetId: "b",
          sourceInMs: 400,
        },
      ],
      [first, second],
    );
    const next = { ...structuredClone(previous), introSegments: [{ ...first, outMs: 3_000 }, second] };
    const [cue] = syncSubtitlesToTimeline(previous, next, ["INTRO"]).cues;
    expect(cue).toMatchObject({ id: "intro-cue", startMs: 3_100, endMs: 4_100, sourceAssetId: "b", sourceInMs: 400 });
  });
});
