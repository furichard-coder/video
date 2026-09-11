import { describe, expect, it } from "vitest";
import type { ProjectManifest, SourceAsset, SubtitleBurnInOptions } from "../src/shared/domain";
import { buildSubtitleAss, escapeFfmpegFilterPath, wrapSubtitleText } from "../src/main/services/subtitle-burn-in";

const asset: SourceAsset = {
  id: "a".repeat(64),
  sourcePath: "C:\\來源 資料\\影片.mp4",
  sourceIdentity: "b".repeat(64),
  fileName: "影片.mp4",
  extension: ".mp4",
  kind: "VIDEO",
  sizeBytes: 100,
  fileCreatedAt: "2026-01-01T00:00:00Z",
  fileModifiedAt: "2026-01-01T00:00:00Z",
  addedAt: "2026-01-01T00:00:00Z",
  addedOrder: 0,
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewCacheKey: "c".repeat(64),
  metadataState: "READY",
  mediaInfo: { durationMs: 10_000, width: 1920, height: 1080 },
};
const project = {
  schemaVersion: 13,
  id: "p",
  name: "test",
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewerVersion: "preview-v3",
  sortMode: "MANUAL_ORDER",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  sources: [asset],
  timelineOrder: [asset.id],
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
  mediaInsertions: [],
  photoSoundEffect: {} as never,
  bgmTracks: [],
  aiStoryContext: {
    topic: "",
    locations: [],
    people: [],
    storySummary: "",
    audiencePromise: "",
    subtitleLanguage: "zh",
  },
  subtitleCues: [
    {
      id: "cue",
      startMs: 1_000,
      endMs: 3_000,
      text: "這是一段非常非常長的繁體中文字幕，需要自動換行",
      reviewStatus: "CONFIRMED",
    },
  ],
  timelineRevision: 2,
  subtitleTimelineRevision: 2,
  audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
} satisfies ProjectManifest;

describe("subtitle ASS burn-in", () => {
  it("renders two independently positioned and sized languages with automatic wrapping", () => {
    const result = buildSubtitleAss(
      project,
      [{ assetId: asset.id, inMs: 0, outMs: 10_000 }],
      0,
      0.3,
      "360P",
      {
        enabled: true,
        tracks: [
          { language: "zh-TW", position: "BOTTOM", fontSize1080p: 72 },
          { language: "en", position: "TOP", fontSize1080p: 36 },
        ],
      },
      {
        byLanguage: {
          "zh-TW": [project.subtitleCues[0].text],
          en: ["This is a deliberately long English subtitle that should wrap automatically for the viewer"],
        },
        providers: ["ORIGINAL", "OPENAI"],
      },
    );
    expect(result.languages).toEqual(["zh-TW", "en"]);
    expect(result.eventCount).toBe(2);
    expect(result.content).toContain("Microsoft JhengHei");
    expect(result.content).toContain("Arial");
    expect(result.content).toContain("\\an2\\pos");
    expect(result.content).toContain("\\an8\\pos");
    expect(result.content).toContain("\\N");
  });

  it("shares preview style profile with burn-in output", () => {
    const result = buildSubtitleAss(
      project,
      [{ assetId: asset.id, inMs: 0, outMs: 10_000 }],
      0,
      0.3,
      "480P",
      {
        enabled: true,
        tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
        styleProfile: {
          verticalPositionPercent: 24,
          fontSizePx: 36,
          textColor: "#FFE066",
          shadowEnabled: false,
          outlineWidthPx: 3,
        },
      },
      { byLanguage: { "zh-TW": ["樣式一致"] }, providers: ["ORIGINAL"] },
    );
    expect(result.content).toContain("&H0066E0FF");
    expect(result.content).toContain(",36,&H0066E0FF");
    expect(result.content).toContain(",3,0,2,");
    expect(result.content).toContain("\\an8\\pos");

    const fourK = buildSubtitleAss(
      project,
      [{ assetId: asset.id, inMs: 0, outMs: 10_000 }],
      0,
      0.3,
      "4K",
      {
        enabled: true,
        tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
        styleProfile: {
          verticalPositionPercent: 24,
          fontSizePx: 36,
          textColor: "#FFE066",
          shadowEnabled: false,
          outlineWidthPx: 3,
        },
      },
      { byLanguage: { "zh-TW": ["樣式一致"] }, providers: ["ORIGINAL"] },
    );
    expect(fourK.content).toContain(",162,&H0066E0FF");
  });

  it("uses the 480p preview size only for the primary track and preserves translated-track sizing", () => {
    const result = buildSubtitleAss(
      project,
      [{ assetId: asset.id, inMs: 0, outMs: 10_000 }],
      0,
      0.3,
      "480P",
      {
        enabled: true,
        tracks: [
          { language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 },
          { language: "en", position: "TOP", fontSize1080p: 42 },
        ],
        styleProfile: {
          verticalPositionPercent: 82,
          fontSizePx: 36,
          textColor: "#FFFFFF",
          shadowEnabled: true,
          outlineWidthPx: 2,
        },
      },
      { byLanguage: { "zh-TW": ["字幕頁預覽"], en: ["Independent translation"] }, providers: ["ORIGINAL", "OPENAI"] },
    );
    expect(result.content).toContain("Style: Lang1,Microsoft JhengHei,36,");
    expect(result.content).toContain("Style: Lang2,Arial,19,");
    expect(result.content).toContain("Dialogue: 0,0:00:01.00,0:00:03.00,Lang1");
    expect(result.content).toContain("\\an2\\pos");
    expect(result.content).toContain("Dialogue: 1,0:00:01.00,0:00:03.00,Lang2");
    expect(result.content).toContain("\\an8\\pos");
  });

  it("honors the manual per-line character override from the style profile", () => {
    const options = (maxCharactersPerLine?: number): SubtitleBurnInOptions => ({
      enabled: true,
      tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
      styleProfile: {
        verticalPositionPercent: 82,
        fontSizePx: 36,
        textColor: "#FFFFFF",
        shadowEnabled: true,
        outlineWidthPx: 2,
        ...(maxCharactersPerLine === undefined ? {} : { maxCharactersPerLine }),
      },
    });
    const translations = {
      byLanguage: { "zh-TW": [project.subtitleCues[0].text] },
      providers: ["ORIGINAL"],
    } as never;
    const countBreaks = (content: string) => content.split("\\N").length - 1;
    const clips = [{ assetId: asset.id, inMs: 0, outMs: 10_000 }] as never;
    const auto = buildSubtitleAss(project, clips, 0, 0.3, "480P", options(), translations);
    const narrow = buildSubtitleAss(project, clips, 0, 0.3, "480P", options(6), translations);
    expect(countBreaks(auto.content)).toBe(1);
    expect(countBreaks(narrow.content)).toBeGreaterThanOrEqual(3);
  });

  it("breaks lines identically across output resolutions", () => {
    const styleProfile = {
      verticalPositionPercent: 82,
      fontSizePx: 36,
      textColor: "#FFFFFF",
      shadowEnabled: true,
      outlineWidthPx: 2,
    };
    const translations = {
      byLanguage: { "zh-TW": [project.subtitleCues[0].text] },
      providers: ["ORIGINAL"],
    } as never;
    const clips = [{ assetId: asset.id, inMs: 0, outMs: 10_000 }] as never;
    const countBreaks = (content: string) => content.split("\\N").length - 1;
    const at480 = buildSubtitleAss(
      project,
      clips,
      0,
      0.3,
      "480P",
      {
        enabled: true,
        tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
        styleProfile,
      },
      translations,
    );
    const at4k = buildSubtitleAss(
      project,
      clips,
      0,
      0.3,
      "4K",
      {
        enabled: true,
        tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
        styleProfile,
      },
      translations,
    );
    expect(countBreaks(at4k.content)).toBe(countBreaks(at480.content));
    expect(countBreaks(at4k.content)).toBeGreaterThanOrEqual(1);
  });

  it("blocks stale timeline subtitles and escapes Chinese/spaced Windows paths", () => {
    expect(() =>
      buildSubtitleAss(
        { ...project, subtitleTimelineRevision: 1 },
        [{ assetId: asset.id, inMs: 0, outMs: 10_000 }],
        0,
        0.3,
        "480P",
        { enabled: true, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }] },
        { byLanguage: { "zh-TW": ["字幕"] }, providers: ["ORIGINAL"] },
      ),
    ).toThrow(/複核/);
    expect(escapeFfmpegFilterPath("C:\\字幕 cache\\測試.ass")).toContain("C\\:/字幕 cache/測試.ass");
    expect(wrapSubtitleText("ABCDEFGHIJK", 4)).toEqual(["ABCD", "EFGH", "IJK"]);
  });

  it("rejects more than two, duplicate, or out-of-range subtitle track settings", () => {
    const translations = {
      byLanguage: { "zh-TW": ["字幕"], en: ["Text"], ja: ["字幕"] },
      providers: ["ORIGINAL"] as const,
    };
    const build = (tracks: Array<{ language: "zh-TW" | "en" | "ja"; position: "BOTTOM"; fontSize1080p: number }>) =>
      buildSubtitleAss(
        project,
        [{ assetId: asset.id, inMs: 0, outMs: 10_000 }],
        0,
        0.3,
        "480P",
        { enabled: true, tracks },
        translations,
      );
    expect(() =>
      build([
        { language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 },
        { language: "en", position: "BOTTOM", fontSize1080p: 42 },
        { language: "ja", position: "BOTTOM", fontSize1080p: 42 },
      ]),
    ).toThrow(/一至兩種/);
    expect(() =>
      build([
        { language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 },
        { language: "zh-TW", position: "BOTTOM", fontSize1080p: 42 },
      ]),
    ).toThrow(/不可重複/);
    expect(() => build([{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 12 }])).toThrow(/24–96/);
  });

  it("maps Intro and Main cues onto their independent output sections", () => {
    const introProject = {
      ...project,
      introSegments: [
        {
          id: "intro",
          assetId: asset.id,
          fileName: asset.fileName,
          inMs: 0,
          outMs: 3_000,
          score: 90,
          reasons: ["事件"],
        },
      ],
      subtitleCues: [
        {
          id: "intro-cue",
          startMs: 0,
          endMs: 1_000,
          text: "片頭",
          timelineScope: "INTRO" as const,
          reviewStatus: "CONFIRMED" as const,
        },
        {
          id: "main-cue",
          startMs: 0,
          endMs: 1_000,
          text: "正片",
          timelineScope: "MAIN" as const,
          reviewStatus: "CONFIRMED" as const,
        },
      ],
    };
    const result = buildSubtitleAss(
      introProject,
      [
        { assetId: asset.id, inMs: 0, outMs: 3_000 },
        { assetId: asset.id, inMs: 0, outMs: 10_000 },
      ],
      1,
      0.3,
      "480P",
      { enabled: true, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }] },
      { byLanguage: { "zh-TW": ["片頭", "正片"] }, providers: ["ORIGINAL"] },
    );
    expect(result.content).toContain("0:00:00.00,0:00:01.00");
    expect(result.content).toContain("0:00:02.70,0:00:03.70");
  });

  it("burns only Intro cues for an Intro-only preview", () => {
    const introProject = {
      ...project,
      introSegments: [
        {
          id: "intro",
          assetId: asset.id,
          fileName: asset.fileName,
          inMs: 0,
          outMs: 3_000,
          score: 90,
          reasons: ["事件"],
        },
      ],
      subtitleCues: [
        {
          id: "intro-cue",
          startMs: 400,
          endMs: 1_400,
          text: "片頭測試字幕",
          timelineScope: "INTRO" as const,
          reviewStatus: "CONFIRMED" as const,
        },
        {
          id: "main-cue",
          startMs: 0,
          endMs: 1_000,
          text: "正片不應出現",
          timelineScope: "MAIN" as const,
          reviewStatus: "CONFIRMED" as const,
        },
      ],
    };
    const result = buildSubtitleAss(
      introProject,
      [{ assetId: asset.id, inMs: 0, outMs: 3_000 }],
      1,
      0.3,
      "480P",
      { enabled: true, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }] },
      { byLanguage: { "zh-TW": ["片頭測試字幕"] }, providers: ["ORIGINAL"] },
      undefined,
      "INTRO",
    );
    expect(result.eventCount).toBe(1);
    expect(result.content).toContain("片頭測試字幕");
    expect(result.content).not.toContain("正片不應出現");
  });

  it("shifts Main subtitles past the inserted start prompt without moving Intro subtitles", () => {
    const introProject = {
      ...project,
      introSegments: [
        {
          id: "intro",
          assetId: asset.id,
          fileName: asset.fileName,
          inMs: 0,
          outMs: 3_000,
          score: 90,
          reasons: ["事件"],
        },
      ],
      subtitleCues: [
        {
          id: "intro-cue",
          startMs: 0,
          endMs: 1_000,
          text: "片頭",
          timelineScope: "INTRO" as const,
          reviewStatus: "CONFIRMED" as const,
        },
        {
          id: "main-cue",
          startMs: 0,
          endMs: 1_000,
          text: "正片",
          timelineScope: "MAIN" as const,
          reviewStatus: "CONFIRMED" as const,
        },
      ],
    };
    const result = buildSubtitleAss(
      introProject,
      [
        { assetId: asset.id, inMs: 0, outMs: 3_000 },
        { assetId: asset.id, inMs: 0, outMs: 10_000 },
      ],
      1,
      0.3,
      "480P",
      { enabled: true, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }] },
      { byLanguage: { "zh-TW": ["片頭", "正片"] }, providers: ["ORIGINAL"] },
      {
        durationSeconds: 3,
        line1: "草漯沙丘",
        line2: "旅程開始",
        line1FontSize1080p: 114,
        line2FontSize1080p: 90,
        lineGap1080p: 122,
        overlayOpacityPercent: 62,
        transitionStyle: "DISSOLVE",
      },
    );
    expect(result.content).toContain("0:00:00.00,0:00:01.00");
    expect(result.content).toContain("0:00:05.40,0:00:06.40");
  });
});
