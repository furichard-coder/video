import { describe, expect, it } from "vitest";
import { buildTimelinePlan } from "../src/shared/timeline-plan";
import type { ProjectManifest } from "../src/shared/domain";

function project(): ProjectManifest {
  return {
    schemaVersion: 14,
    id: "p",
    name: "p",
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewerVersion: "ffmpeg-preview-v1",
    sortMode: "CAPTURE_TIME",
    createdAt: "",
    updatedAt: "",
    sources: [],
    timelineOrder: [],
    pendingAssetIds: [],
    excludedMainAssetIds: [],
    recentMainRemovals: [],
    introSegments: [],
    introTargetDurationMs: 0,
    introSegmentMaxDurationMs: 15000,
    colorSettings: { introPresetId: "NATURAL", applyToMain: false },
    introExcludedSegmentIds: [],
    recentIntroRemovals: [],
    placementDecisions: [],
    mediaInsertions: [],
    photoSoundEffect: {
      id: "dunes-shutter-v1",
      displayName: "",
      sourceProject: "",
      sourceUrl: "",
      licenseUrl: "",
      sha256: "",
      volumePercent: 70,
    },
    bgmTracks: [],
    aiStoryContext: {
      topic: "",
      locations: [],
      people: [],
      storySummary: "",
      audiencePromise: "",
      subtitleLanguage: "zh-TW",
    },
    subtitleCues: [],
    timelineRevision: 0,
    subtitleTimelineRevision: 0,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  };
}

describe("canonical timeline plan", () => {
  it("computes deterministic output positions and overlap", () => {
    const p = project();
    p.sources = [
      {
        id: "a",
        kind: "VIDEO",
        fileName: "a.mp4",
        sourcePath: "C:/a",
        sizeBytes: 1,
        modifiedAt: "",
        addedAt: "",
        sourcePolicy: "READ_ONLY",
        mediaInfo: { durationMs: 10_000 },
      },
      {
        id: "b",
        kind: "VIDEO",
        fileName: "b.mp4",
        sourcePath: "C:/b",
        sizeBytes: 1,
        modifiedAt: "",
        addedAt: "",
        sourcePolicy: "READ_ONLY",
        mediaInfo: { durationMs: 5_000 },
      },
    ] as never;
    p.timelineOrder = ["a", "b"];
    const plan = buildTimelinePlan(p, { transitionSeconds: 0.5 });
    expect(plan.durationMs).toBe(14_500);
    expect(plan.clips.map((c) => [c.outputStartMs, c.outputEndMs])).toEqual([
      [0, 10_000],
      [9_500, 14_500],
    ]);
  });

  it("handles long chains and Intro before Main without changing source ranges", () => {
    const p = project();
    p.sources = Array.from({ length: 20 }, (_, index) => ({
      id: `asset-${index}`,
      kind: "VIDEO",
      fileName: `${index}.mp4`,
      sourcePath: `C:/${index}.mp4`,
      sizeBytes: 1,
      modifiedAt: "",
      addedAt: "",
      sourcePolicy: "READ_ONLY",
      mediaInfo: { durationMs: 2_000 },
    })) as never;
    p.timelineOrder = p.sources.map((item) => item.id);
    p.introSegments = [
      { id: "intro", assetId: "asset-0", fileName: "0.mp4", inMs: 0, outMs: 2_000, score: 1, reasons: [] },
    ];
    const plan = buildTimelinePlan(p, { includeIntro: true, transitionSeconds: 0.7 });
    expect(plan.clips).toHaveLength(21);
    expect(plan.durationMs).toBe(2_000 + 20 * 2_000 - 20 * 700);
    expect(plan.clips[0].scope).toBe("INTRO");
    expect(plan.clips[1].scope).toBe("MAIN");
  });
});
