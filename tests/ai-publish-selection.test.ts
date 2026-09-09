import { describe, expect, it } from "vitest";
import type { ProjectManifest, SourceAsset } from "../src/shared/domain";
import { selectPublishVisualCandidates } from "../src/main/services/ai-publish-assets";

function source(id: string, fileName: string): SourceAsset {
  return {
    id: id.repeat(64), sourcePath: `C:\\Media\\${fileName}`, sourceIdentity: `${id}i`.repeat(64).slice(0, 64), fileName, extension: ".mp4", kind: "VIDEO", sizeBytes: 100,
    fileCreatedAt: "2026-09-01T00:00:00.000Z", fileModifiedAt: "2026-09-01T00:00:00.000Z", addedAt: "2026-09-01T00:00:00.000Z", addedOrder: 0,
    sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewCacheKey: `${id}c`.repeat(64).slice(0, 64), metadataState: "READY", mediaInfo: { durationMs: 30_000, width: 1920, height: 1080 },
  };
}

describe("AI publish visual candidate selection", () => {
  it("prioritizes the selected Intro time ranges before Main timeline frames", () => {
    const introA = source("a", "片頭人物.mp4"); const introB = source("b", "片頭景觀.mp4"); const main = source("c", "正片內容.mp4");
    const project = {
      schemaVersion: 16, id: "publish-selection", name: "AI 發布候選", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewerVersion: "preview-v3", sortMode: "MANUAL_ORDER", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
      sources: [introA, introB, main], timelineOrder: [main.id], pendingAssetIds: [], excludedMainAssetIds: [], recentMainRemovals: [],
      introSegments: [{ id: "intro-a", assetId: introA.id, fileName: introA.fileName, inMs: 2_000, outMs: 8_000, score: 90, reasons: ["人物"] }, { id: "intro-b", assetId: introB.id, fileName: introB.fileName, inMs: 10_000, outMs: 16_000, score: 88, reasons: ["景觀"] }], introTargetDurationMs: 12_000, introSegmentMaxDurationMs: 15_000, introExcludedSegmentIds: [], recentIntroRemovals: [],
      placementDecisions: [], mediaInsertions: [], bgmTracks: [], sourceAudioVolumePercent: 100, subtitleCues: [], timelineRevision: 1, subtitleTimelineRevision: 1, audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
    } as ProjectManifest;
    expect(selectPublishVisualCandidates(project)).toEqual([
      expect.objectContaining({ candidateId: "thumbnail-1", assetId: introA.id, sourceTimeMs: 5_000, origin: "INTRO" }),
      expect.objectContaining({ candidateId: "thumbnail-2", assetId: introB.id, sourceTimeMs: 13_000, origin: "INTRO" }),
      expect.objectContaining({ candidateId: "thumbnail-3", assetId: main.id, sourceTimeMs: 15_000, origin: "MAIN" }),
    ]);
  });
});
