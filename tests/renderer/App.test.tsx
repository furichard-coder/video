// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHOTO_SOUND_PREVIEW_URL, type AppApi, type ExternalPlayerSettingsSnapshot, type ProjectManifest, type SourceAsset } from "../../src/shared/domain";
import { App } from "../../src/renderer/App";
import { UI_TEXT_SIZE_STORAGE_KEY, UI_ZOOM_STORAGE_KEY } from "../../src/renderer/ui-preferences";

const video: SourceAsset = {
  id: "a".repeat(64),
  sourcePath: "C:\\Media\\clip01.mp4",
  sourceIdentity: "b".repeat(64),
  fileName: "clip01.mp4",
  extension: ".mp4",
  kind: "VIDEO",
  sizeBytes: 123456,
  fileCreatedAt: "2026-08-01T01:00:00.000Z",
  fileModifiedAt: "2026-08-01T01:00:00.000Z",
  addedAt: "2026-08-01T01:00:00.000Z",
  addedOrder: 0,
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewCacheKey: "c".repeat(64),
  metadataState: "READY",
  mediaInfo: { width: 1920, height: 1080, durationMs: 12_000, frameRate: "30000/1001", videoCodec: "h264" },
};

const project: ProjectManifest = {
  schemaVersion: 13,
  id: "project",
  name: "測試專案",
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewerVersion: "preview-v3",
  sortMode: "SMART_SEQUENCE",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  sources: [video],
  timelineOrder: [video.id],
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
  photoSoundEffect: {
    id: "DUNES_CAMERA_SHUTTER_CLICK_14671",
    displayName: "沙丘前案相機快門（Camera Shutter Click）",
    sourceProject: "草漯沙丘地質公園 YT長片",
    sourceUrl: "https://pixabay.com/sound-effects/technology-camera-shutter-click-14671/",
    licenseUrl: "https://pixabay.com/service/license-summary/",
    sha256: "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93",
    volumePercent: 70,
  },
  bgmTracks: [],
  sourceAudioVolumePercent: 80,
  aiStoryContext: { topic: "測試旅行", locations: ["河內"], people: ["主持人"], storySummary: "步行探索城市", audiencePromise: "看見旅程重點", subtitleLanguage: "zh" },
  subtitleCues: [],
  timelineRevision: 1,
  subtitleTimelineRevision: 1,
  audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
};

const secondVideo: SourceAsset = {
  ...video,
  id: "d".repeat(64),
  sourceIdentity: "e".repeat(64),
  sourcePath: "C:\\Media\\clip02.mp4",
  fileName: "clip02.mp4",
  addedOrder: 1,
  previewCacheKey: "f".repeat(64),
  mediaInfo: { ...video.mediaInfo, durationMs: 8_000 },
};

const photo: SourceAsset = {
  ...video,
  id: "1".repeat(64),
  sourceIdentity: "2".repeat(64),
  sourcePath: "C:\\Media\\直式照片.HEIC",
  fileName: "直式照片.HEIC",
  extension: ".heic",
  kind: "IMAGE",
  addedOrder: 1,
  previewCacheKey: "3".repeat(64),
  imageDurationMs: 5_000,
  mediaInfo: { width: 1920, height: 1080, displayWidth: 1080, displayHeight: 1920, rotationDegrees: 90, isPortrait: true },
};

class ImmediateIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
  root = null;
  rootMargin = "0px";
  thresholds = [0];
}

function mockApi(initialProject: ProjectManifest = project): AppApi {
  let currentIntroSegments = structuredClone(initialProject.introSegments);
  let currentIntroTargetDurationMs = initialProject.introTargetDurationMs;
  const playerSnapshot: ExternalPlayerSettingsSnapshot = {
    settings: { schemaVersion: 1, defaultPlayerId: "SYSTEM_DEFAULT", extensionOverrides: {}, customPlayers: [], updatedAt: "2026-08-29T00:00:00.000Z" },
    players: [{ id: "SYSTEM_DEFAULT", label: "Windows 系統預設播放器", kind: "SYSTEM", available: true }],
  };
  return {
    getAppInfo: vi.fn(async () => ({ version: "0.16.0", productName: "SceneryWalker 素材整理" })),
    confirmAppClose: vi.fn(),
    onAppCloseRequested: vi.fn(),
    clearAppCloseRequestedListeners: vi.fn(),
    getUserPreferences: vi.fn(async () => ({ schemaVersion: 1 as const, viewMode: "GRID" as const, renderDefaults: { transitionSeconds: 0.3 as const, resolution: "480P" as const, prependIntro: true, autoUpload: true, introPreviewIncludeBgm: false, mainPreviewIncludeBgm: true, mainStartCard: { durationSeconds: 3, line1: "漫步風光", line2: "旅程開始", line1FontSize1080p: 114, line2FontSize1080p: 90, lineGap1080p: 122, overlayOpacityPercent: 62, transitionStyle: "DISSOLVE" as const } }, youtubeUploadDefaults: { privacyStatus: "unlisted" as const }, voiceInputLanguage: "zh-TW" as const, subtitleBurnInDefaults: { enabled: false, tracks: [{ language: "zh-TW" as const, position: "BOTTOM" as const, fontSize1080p: 48 }] }, subtitleGenerationScope: { intro: false, main: true }, subtitlePreviewStyle: { verticalPositionPercent: 82, fontSizePx: 28, textColor: "#FFFFFF", shadowEnabled: true, outlineWidthPx: 2 }, musicSuggestionDefaults: { includeTikTokTrending: false, royaltyFreeOnly: false }, lastDirectories: {}, updatedAt: "2026-09-04T00:00:00.000Z" })),
    updateUserPreferences: vi.fn(async (update) => ({ schemaVersion: 1 as const, viewMode: update.viewMode ?? "GRID" as const, renderDefaults: { transitionSeconds: update.renderDefaults?.transitionSeconds ?? 0.3 as const, resolution: update.renderDefaults?.resolution ?? "480P" as const, prependIntro: update.renderDefaults?.prependIntro ?? true, autoUpload: update.renderDefaults?.autoUpload ?? true, introPreviewIncludeBgm: update.renderDefaults?.introPreviewIncludeBgm ?? false, mainPreviewIncludeBgm: update.renderDefaults?.mainPreviewIncludeBgm ?? true, mainStartCard: update.renderDefaults?.mainStartCard ?? { durationSeconds: 3, line1: "漫步風光", line2: "旅程開始", line1FontSize1080p: 114, line2FontSize1080p: 90, lineGap1080p: 122, overlayOpacityPercent: 62, transitionStyle: "DISSOLVE" as const } }, youtubeUploadDefaults: { privacyStatus: update.youtubeUploadDefaults?.privacyStatus ?? "unlisted" as const }, voiceInputLanguage: update.voiceInputLanguage ?? "zh-TW" as const, subtitleBurnInDefaults: update.subtitleBurnInDefaults ?? { enabled: false, tracks: [{ language: "zh-TW" as const, position: "BOTTOM" as const, fontSize1080p: 48 }] }, subtitleGenerationScope: update.subtitleGenerationScope ?? { intro: false, main: true }, subtitlePreviewStyle: update.subtitlePreviewStyle ?? { verticalPositionPercent: 82, fontSizePx: 28, textColor: "#FFFFFF", shadowEnabled: true, outlineWidthPx: 2 }, musicSuggestionDefaults: { includeTikTokTrending: update.musicSuggestionDefaults?.includeTikTokTrending ?? false, royaltyFreeOnly: update.musicSuggestionDefaults?.royaltyFreeOnly ?? false }, lastDirectories: {}, updatedAt: "2026-09-04T00:00:00.000Z" })),
    getProject: vi.fn(async () => structuredClone(initialProject)),
    getProjectHistoryState: vi.fn(async () => ({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 })),
    undoProject: vi.fn(async () => structuredClone(initialProject)),
    redoProject: vi.fn(async () => structuredClone(initialProject)),
    getProjectFileState: vi.fn(async () => ({})),
    saveProject: vi.fn(async () => ({ project: structuredClone(initialProject), filePath: "C:\\專案\\測試專案.swproj" })),
    saveProjectAs: vi.fn(async () => ({ project: structuredClone(initialProject), filePath: "C:\\專案\\測試專案.swproj" })),
    openProject: vi.fn(async () => null),
    chooseFiles: vi.fn(),
    chooseFolder: vi.fn(),
    chooseIntroFiles: vi.fn(async () => ({ cancelled: true, addedCount: 0, duplicateCount: 0, unsupportedCount: 0, errors: [], project: structuredClone(initialProject), addedAssetIds: [] })),
    cancelImport: vi.fn(async () => undefined),
    removeMainAsset: vi.fn(async (assetId) => ({ ...structuredClone(initialProject), timelineOrder: [], excludedMainAssetIds: [assetId], recentMainRemovals: [{ assetId, previousTimelineIndex: 0, wasPending: false, previousSortMode: "SMART_SEQUENCE" as const, removedAt: "2026-08-30T00:00:00.000Z" }], timelineRevision: initialProject.timelineRevision + 1 })),
    restoreMainAsset: vi.fn(async () => structuredClone(initialProject)),
    setIntroSegments: vi.fn(async (segments) => { currentIntroSegments = structuredClone(segments); return { ...structuredClone(initialProject), introSegments: currentIntroSegments, introTargetDurationMs: currentIntroTargetDurationMs }; }),
    setIntroTargetDuration: vi.fn(async (introTargetDurationMs) => { currentIntroTargetDurationMs = introTargetDurationMs; return { ...structuredClone(initialProject), introSegments: structuredClone(currentIntroSegments), introTargetDurationMs }; }),
    setIntroSegmentMaxDuration: vi.fn(async (introSegmentMaxDurationMs) => ({ ...structuredClone(initialProject), introSegments: structuredClone(currentIntroSegments), introSegmentMaxDurationMs })),
    setProjectColorSettings: vi.fn(async (colorSettings) => ({ ...structuredClone(initialProject), colorSettings })),
    removeIntroSegment: vi.fn(async (segmentId) => ({ ...structuredClone(initialProject), introSegments: initialProject.introSegments.filter((item) => item.id !== segmentId) })),
    restoreIntroSegment: vi.fn(async () => structuredClone(initialProject)),
    setPreviewRange: vi.fn(async (_assetId, range) => ({ asset: { ...structuredClone(video), previewRange: range }, adjustedVolumeSegmentCount: 0, adjustedMainExclusionRangeCount: 0, adjustedZoomSegmentCount: 0, project: { ...structuredClone(initialProject), sources: [{ ...structuredClone(video), previewRange: range }] } })),
    setImageDuration: vi.fn(async (assetId, durationMs) => { const source = initialProject.sources.find((item) => item.id === assetId)!; const updated = { ...structuredClone(source), imageDurationMs: durationMs }; return { asset: updated, project: { ...structuredClone(initialProject), sources: initialProject.sources.map((item) => item.id === assetId ? updated : structuredClone(item)), timelineRevision: initialProject.timelineRevision + 1 } }; }),
    setPhotoSoundEnabled: vi.fn(async (assetId, enabled) => ({ ...structuredClone(initialProject), sources: initialProject.sources.map((item) => item.id === assetId ? { ...structuredClone(item), photoSoundEnabled: enabled } : structuredClone(item)), timelineRevision: initialProject.timelineRevision + 1 })),
    addMediaInsertion: vi.fn(async (anchorVideoAssetId, insertedAssetId, atMs, sourceRange) => ({ ...structuredClone(initialProject), timelineOrder: initialProject.timelineOrder.filter((id) => id !== insertedAssetId), pendingAssetIds: initialProject.pendingAssetIds.filter((id) => id !== insertedAssetId), mediaInsertions: [{ id: "media-insertion", anchorVideoAssetId, insertedAssetId, atMs, sourceInMs: sourceRange?.inMs ?? 0, sourceOutMs: sourceRange?.outMs ?? 5_000, sequenceIndex: 0, previousPlacement: initialProject.pendingAssetIds.includes(insertedAssetId) ? "PENDING" as const : "TIMELINE" as const, previousTimelineIndex: 1, createdAt: "2026-09-02T00:00:00.000Z" }], timelineRevision: initialProject.timelineRevision + 1 })),
    updateMediaInsertion: vi.fn(async (insertionId, atMs, sourceRange) => ({ ...structuredClone(initialProject), mediaInsertions: initialProject.mediaInsertions.map((item) => item.id === insertionId ? { ...item, atMs, sourceInMs: sourceRange.inMs, sourceOutMs: sourceRange.outMs } : item), timelineRevision: initialProject.timelineRevision + 1 })),
    removeMediaInsertion: vi.fn(async () => structuredClone(initialProject)),
    moveMediaInsertion: vi.fn(async () => structuredClone(initialProject)),
    setVolumeSegments: vi.fn(async (_assetId, segments) => ({ ...structuredClone(video), volumeSegments: segments })),
    setZoomSegments: vi.fn(async (_assetId, segments) => ({ asset: { ...structuredClone(video), zoomSegments: segments }, project: { ...structuredClone(initialProject), sources: [{ ...structuredClone(video), zoomSegments: segments }], timelineRevision: initialProject.timelineRevision + 1 } })),
    setMainExclusionRanges: vi.fn(async (_assetId, ranges) => ({ asset: { ...structuredClone(video), mainExclusionRanges: ranges }, mergedRangeCount: 0, project: { ...structuredClone(initialProject), sources: [{ ...structuredClone(video), mainExclusionRanges: ranges }], timelineRevision: initialProject.timelineRevision + 1 } })),
    placeAsset: vi.fn(async () => structuredClone(initialProject)),
    moveTimelineAsset: vi.fn(async () => structuredClone(initialProject)),
    setSortMode: vi.fn(async (sortMode) => ({ ...structuredClone(project), sortMode })),
    ensureMetadata: vi.fn(async (assetId) => structuredClone(initialProject.sources.find((item) => item.id === assetId) ?? video)),
    ensurePreview: vi.fn(async (assetId, variant) => ({
      assetId,
      variant,
      url: `preview-media://cache/${assetId}/${variant.toLowerCase()}`,
      cacheStatus: "HIT" as const,
    })),
    ensureClipPreview: vi.fn(async (assetId, inMs, outMs) => ({ assetId, variant: "VIDEO_CLIP_PROXY" as const, url: `preview-media://cache/${assetId}/video_clip_proxy/test`, cacheStatus: "HIT" as const, sourceStartMs: inMs, sourceEndMs: outMs })),
    cancelPreview: vi.fn(async () => undefined),
    cancelClipPreview: vi.fn(async () => undefined),
    chooseConcatOutput: vi.fn(async () => ({ token: "output-token", displayPath: "C:\\Output\\preview.mp4" })),
    prepareConcatOutput: vi.fn(async () => ({ token: "automatic-output-token", displayPath: "C:\\Output\\auto-preview.mp4", automatic: true })),
    startConcatRender: vi.fn(async (request) => ({
      jobId: "render-job",
      outputPath: "C:\\Output\\preview.mp4",
      sizeBytes: 456_789,
      expectedDurationMs: 19_500,
      transitionSeconds: request.transitionSeconds,
      resolution: request.resolution,
      purpose: request.purpose ?? "CONCAT",
    })),
    cancelConcatRender: vi.fn(async () => undefined),
    revealConcatOutput: vi.fn(async () => undefined),
    playConcatOutput: vi.fn(async () => ({ status: "OPENED" as const, target: "ORIGINAL" as const, playerLabel: "VLC" })),
    copyPreviewOutputPath: vi.fn(async () => undefined),
    getPreviewOutputHistory: vi.fn(async () => ({ schemaVersion: 1 as const, outputs: [] })),
    chooseExistingPreviewOutputs: vi.fn(async () => ({ cancelled: true, addedCount: 0, duplicateCount: 0, errors: [], history: { schemaVersion: 1 as const, outputs: [] } })),
    removePreviewOutputRecord: vi.fn(async () => ({ schemaVersion: 1 as const, outputs: [] })),
    analyzeIntro: vi.fn(async () => ({ analyzerVersion: "test", analyzedAssetCount: 0, cacheHits: 0, generatedAt: new Date().toISOString(), suggestions: [] })),
    cancelIntroAnalysis: vi.fn(async () => undefined),
    getAiSettings: vi.fn(async () => ({ schemaVersion: 1 as const, activeAccountId: "openai-default", accounts: [{ id: "openai-default", name: "OpenAI API（預設帳號）", provider: "OPENAI" as const, visionModel: "gpt-5.6-terra", transcriptionModel: "gpt-4o-transcribe-diarize", credentialStatus: "MISSING" as const, updatedAt: "2026-09-02T00:00:00.000Z" }], encryptionAvailable: true, codexLoginReusable: false as const })),
    saveAiAccount: vi.fn(async () => window.sourceApp.getAiSettings()),
    setActiveAiAccount: vi.fn(async () => window.sourceApp.getAiSettings()),
    removeAiAccount: vi.fn(async () => window.sourceApp.getAiSettings()),
    testAiAccount: vi.fn(async (accountId) => ({ ok: true, accountId, providerLabel: "OpenAI API", message: "連線成功" })),
    transcribeVoiceInput: vi.fn(async (request) => ({ text: "河內旅行特色", language: request.language, segmentCount: 1 })),
    getTranslationSettings: vi.fn(async () => ({ schemaVersion: 1 as const, googleCloudConfigured: false, encryptionAvailable: true })),
    updateTranslationSettings: vi.fn(async (update) => ({ schemaVersion: 1 as const, googleCloudConfigured: Boolean(update.googleCloudApiKey) && !update.clearGoogleCloudApiKey, encryptionAvailable: true })),
    testGoogleTranslation: vi.fn(async () => ({ ok: true, message: "Google 翻譯測試成功" })),
    setAiStoryContext: vi.fn(async (context) => ({ ...structuredClone(initialProject), aiStoryContext: context })),
    generateAiSubtitles: vi.fn(async () => ({ project: structuredClone(initialProject), generatedCount: 0, transcribedCount: 0, visualOnlyCount: 0, skippedConfirmedCount: 0, accountName: "OpenAI API（預設帳號）", analysisVersion: "test" })),
    buildSubtitleIntroPreview: vi.fn(async (includeBgm = false) => ({ cacheKey: "9".repeat(64), cacheStatus: "CREATED" as const, durationMs: 3_000, url: `preview-media://subtitle/${"9".repeat(64)}`, outputPath: "C:\\Output\\intro-subtitle-preview-480p.mp4", sizeBytes: 123_456, bgmIncluded: includeBgm })),
    cancelSubtitleIntroPreview: vi.fn(async () => undefined),
    cancelAiSubtitles: vi.fn(async () => undefined),
    getExternalPlayerSettings: vi.fn(async () => structuredClone(playerSnapshot)),
    updateExternalPlayerSettings: vi.fn(async (update) => ({ ...structuredClone(playerSnapshot), settings: { ...playerSnapshot.settings, ...update } })),
    chooseCustomPlayer: vi.fn(async () => null),
    removeCustomPlayer: vi.fn(async () => structuredClone(playerSnapshot)),
    openExternalMedia: vi.fn(async (_assetId, target) => ({ status: "OPENED" as const, target, playerLabel: "Windows 系統預設播放器" })),
    chooseBgmFiles: vi.fn(async () => ({ cancelled: true, addedCount: 0, errors: [], project: structuredClone(initialProject) })),
    addBgmYoutubeReferences: vi.fn(async () => ({ cancelled: false, addedCount: 0, errors: [], project: structuredClone(initialProject) })),
    resolveBgmReference: vi.fn(async () => null),
    sequenceBgmTracks: vi.fn(async () => structuredClone(initialProject)),
    setSourceAudioVolume: vi.fn(async (sourceAudioVolumePercent) => ({ ...structuredClone(initialProject), sourceAudioVolumePercent })),
    updateBgmTrack: vi.fn(async () => structuredClone(initialProject)),
    removeBgmTrack: vi.fn(async () => structuredClone(initialProject)),
    moveBgmTrack: vi.fn(async () => structuredClone(initialProject)),
    playBgmTrack: vi.fn(async () => ({ status: "OPENED" as const, target: "ORIGINAL" as const, playerLabel: "VLC" })),
    revealBgmTrack: vi.fn(async () => undefined),
    copyBgmTrackPath: vi.fn(async () => undefined),
    openYoutubeAudioLibrary: vi.fn(async () => undefined),
    generateMusicSuggestions: vi.fn(async ({ includeTikTokTrending, royaltyFreeOnly }) => ({ provider: "OPENAI_API" as const, accountName: "測試 OpenAI", generatedAt: "2026-09-08T10:00:00.000Z", topicSummary: "測試旅行｜河內", royaltyFreeOnly, suggestions: [{ id: "yt-suggestion", platform: "YOUTUBE" as const, title: "City Walk", artist: "Test Artist", reason: "適合城市步行節奏", auditionUrl: "https://www.youtube.com/watch?v=abc123XYZ", evidenceUrl: "https://www.youtube.com/watch?v=abc123XYZ", rightsStatus: "REVIEW_REQUIRED" as const }, ...(includeTikTokTrending ? [{ id: "tt-suggestion", platform: "TIKTOK" as const, title: "Recent Trend", reason: "近期旅遊熱門節奏", auditionUrl: "https://ads.tiktok.com/business/creativecenter/song/sample/pc/en", evidenceUrl: "https://ads.tiktok.com/business/creativecenter/song/sample/pc/en", observedAt: "2026-09-08", trendEvidence: "Creative Center 近期趨勢", rightsStatus: "REVIEW_REQUIRED" as const }] : [])], warnings: ["逐首確認授權"] })),
    cancelMusicSuggestions: vi.fn(async () => undefined),
    openMusicSuggestion: vi.fn(async () => undefined),
    setSubtitleCues: vi.fn(async (cues) => ({ ...structuredClone(initialProject), subtitleCues: cues })),
    chooseSubtitleInput: vi.fn(async () => null),
    chooseSubtitleOutput: vi.fn(async () => ({ token: "srt-token", displayPath: "C:\\Output\\captions.srt" })),
    exportSubtitles: vi.fn(async () => ({ outputPath: "C:\\Output\\captions.srt", cueCount: 1 })),
    cancelSubtitleExport: vi.fn(async () => undefined),
    getYoutubeSettings: vi.fn(async () => ({ schemaVersion: 1 as const, preferredBrowser: "CHROME" as const, targetChannelName: "漫步風光", clientConfigured: false, connected: false, encryptionAvailable: true, browsers: [{ id: "CHROME" as const, label: "Google Chrome", available: true }, { id: "EDGE" as const, label: "Microsoft Edge", available: true }] })),
    updateYoutubeSettings: vi.fn(async (update) => ({ schemaVersion: 1 as const, ...update, clientConfigured: false, connected: false, encryptionAvailable: true, browsers: [{ id: "CHROME" as const, label: "Google Chrome", available: true }, { id: "EDGE" as const, label: "Microsoft Edge", available: true }] })),
    chooseYoutubeOAuthClient: vi.fn(async () => null),
    connectYoutube: vi.fn(async () => window.sourceApp.getYoutubeSettings()),
    cancelYoutubeConnect: vi.fn(async () => undefined),
    disconnectYoutube: vi.fn(async () => window.sourceApp.getYoutubeSettings()),
    uploadYoutubeVideo: vi.fn(async (request) => ({ videoId: "abc12345", videoUrl: "https://youtu.be/abc12345", title: request.title, requestedPrivacyStatus: request.privacyStatus, channelId: "channel", channelTitle: "漫步風光" })),
    cancelYoutubeUpload: vi.fn(async () => undefined),
    openYoutubeVideo: vi.fn(async () => undefined),
    openPlatformUpload: vi.fn(async (_jobId, platform) => ({ platform, outputPath: "C:\\Output\\preview.mp4", uploadUrl: platform === "BILIBILI" ? "https://member.bilibili.com/platform/upload/video/frame" : "https://www.tiktok.com/tiktokstudio/upload", message: "已開啟官方投稿頁" })),
    openPlatformPortal: vi.fn(async (platform) => ({ platform, uploadUrl: platform === "BILIBILI" ? "https://member.bilibili.com/platform/upload/video/frame" : "https://www.tiktok.com/tiktokstudio/upload", message: "已開啟官方登入／投稿頁" })),
    onImportProgress: vi.fn(),
    clearImportProgressListeners: vi.fn(),
    onConcatProgress: vi.fn(),
    clearConcatProgressListeners: vi.fn(),
    onIntroAnalysisProgress: vi.fn(),
    clearIntroAnalysisProgressListeners: vi.fn(),
    onAiAnalysisProgress: vi.fn(),
    clearAiAnalysisProgressListeners: vi.fn(),
    onSubtitlePreviewProgress: vi.fn(),
    clearSubtitlePreviewProgressListeners: vi.fn(),
    onYoutubeUploadProgress: vi.fn(),
    clearYoutubeUploadProgressListeners: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
  document.documentElement.style.removeProperty("zoom");
  delete document.documentElement.dataset.uiTextSize;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: ImmediateIntersectionObserver });
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: ImmediateIntersectionObserver });
  Object.defineProperty(window, "sourceApp", { configurable: true, value: mockApi() });
});

afterEach(() => cleanup());

describe("App source workflow", () => {
  it("shows the app version and supports screen plus keyboard undo/redo", async () => {
    const api = mockApi();
    vi.mocked(api.getProjectHistoryState).mockResolvedValue({ canUndo: true, canRedo: true, undoCount: 2, redoCount: 1 });
    vi.mocked(api.undoProject).mockResolvedValue({ ...structuredClone(project), name: "復原後" });
    vi.mocked(api.redoProject).mockResolvedValue({ ...structuredClone(project), name: "重做後" });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    expect(await screen.findByLabelText("軟體版本 0.16.0")).toHaveTextContent("版本 v0.16.0");
    const undo = screen.getByRole("button", { name: "↶ 復原" });
    const redo = screen.getByRole("button", { name: "↷ 重做" });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);
    await waitFor(() => expect(api.undoProject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/專案：復原後/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(api.redoProject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/專案：重做後/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(api.undoProject).toHaveBeenCalledTimes(2));
    expect(redo).toHaveAttribute("title", "重做下一步（Ctrl+Y）");
  });

  it("changes text and overall UI zoom from Settings, supports Ctrl shortcuts, and restores both", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: /把素材放進來/ });
    expect(document.documentElement).toHaveStyle({ fontSize: "18px" });

    fireEvent.click(screen.getByRole("button", { name: "Aa 設定" }));
    const dialog = await screen.findByRole("dialog", { name: "介面顯示設定" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /清楚/ }));
    expect(document.documentElement).toHaveStyle({ fontSize: "20px" });
    expect(window.localStorage.getItem(UI_TEXT_SIZE_STORAGE_KEY)).toBe("20");
    expect(within(dialog).getByText("河內旅行影片_001.MOV")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "放大介面" }));
    expect(document.documentElement).toHaveStyle({ zoom: "1.1" });
    expect(window.localStorage.getItem(UI_ZOOM_STORAGE_KEY)).toBe("110");
    fireEvent.keyDown(window, { key: "ArrowDown", ctrlKey: true });
    expect(document.documentElement).toHaveStyle({ zoom: "1" });
    fireEvent.wheel(window, { deltaY: -100, ctrlKey: true });
    expect(document.documentElement).toHaveStyle({ zoom: "1.1" });

    cleanup();
    render(<App />);
    await screen.findByRole("heading", { name: /把素材放進來/ });
    expect(document.documentElement).toHaveStyle({ fontSize: "20px" });
    expect(document.documentElement).toHaveStyle({ zoom: "1.1" });
  });

  it("keeps grid cards compact by showing read-only protection once globally", async () => {
    render(<App />);
    const card = await screen.findByRole("article", { name: `影片 ${video.fileName}，順序 1` });
    expect(screen.getByText(/來源唯讀保護/)).toBeInTheDocument();
    expect(within(card).queryByText(video.sourcePath)).not.toBeInTheDocument();
    expect(within(card).queryByText(/Preview 僅供檢視/)).not.toBeInTheDocument();
  });

  it("keeps the trailing time and sequence visible when adjacent grid filenames share a prefix and date", async () => {
    const first = { ...structuredClone(video), fileName: "VID_20260718_104425_001.MOV" };
    const middle = { ...structuredClone(secondVideo), fileName: "VID_20260718_105000_002.MOV" };
    const last = { ...structuredClone(video), id: "9".repeat(64), sourceIdentity: "8".repeat(64), previewCacheKey: "7".repeat(64), fileName: "VID_20260718_105329_003.MOV", addedOrder: 2 };
    const sequenceProject = { ...structuredClone(project), sources: [first, middle, last], timelineOrder: [first.id, middle.id, last.id] };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: mockApi(sequenceProject) });
    render(<App />);
    const card = await screen.findByRole("article", { name: `影片 ${middle.fileName}，順序 2` });
    expect(within(card).getByTitle(middle.fileName)).toHaveClass("prefer-filename-end");
  });

  it("visually marks saved clip, volume, and insertion settings on the grid card", async () => {
    const configured = {
      ...structuredClone(video),
      previewRange: { inMs: 1_000, outMs: 11_000 },
      mainExclusionRanges: [{ id: "exclude", startMs: 2_000, endMs: 3_000 }],
      zoomSegments: [{ id: "zoom", startMs: 4_000, endMs: 7_000, zoomPercent: 120, centerXPercent: 50, centerYPercent: 50, enhancementPreset: "BALANCED" as const }],
      volumeSegments: [{ id: "volume", startMs: 1_000, endMs: 4_000, volumePercent: 120 }],
    };
    const insertion = { id: "inserted", anchorVideoAssetId: configured.id, insertedAssetId: photo.id, atMs: 5_000, sourceInMs: 0, sourceOutMs: 5_000, sequenceIndex: 0, previousPlacement: "TIMELINE" as const, previousTimelineIndex: 1, createdAt: "2026-09-06T00:00:00.000Z" };
    const configuredProject = { ...structuredClone(project), sources: [configured, photo], timelineOrder: [configured.id], mediaInsertions: [insertion] };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: mockApi(configuredProject) });
    render(<App />);
    const card = await screen.findByRole("article", { name: `影片 ${configured.fileName}，順序 1` });
    expect(within(card).getByRole("button", { name: /刪除／排除部分片段，已儲存設定/ })).toHaveClass("is-configured", "clip-tool-button");
    expect(within(card).getByRole("button", { name: /音量區段，已儲存設定/ })).toHaveClass("is-configured", "volume-tool-button");
    expect(within(card).getByRole("button", { name: /於影片時段插入照片或影片，已儲存設定/ })).toHaveClass("is-configured", "insertion-tool-button");
  });

  it("long-press drags grid cards, updates sequence numbers live, and persists manual order", async () => {
    const twoVideoProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id] };
    const reorderedProject = { ...structuredClone(twoVideoProject), timelineOrder: [secondVideo.id, video.id], sortMode: "MANUAL_ORDER" as const, timelineRevision: 2 };
    const api = mockApi(twoVideoProject);
    vi.mocked(api.moveTimelineAsset).mockResolvedValue(reorderedProject);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    const firstCard = await screen.findByRole("article", { name: `影片 ${video.fileName}，順序 1` });
    const secondCard = screen.getByRole("article", { name: `影片 ${secondVideo.fileName}，順序 2` });
    fireEvent.pointerDown(firstCard, { button: 0 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 310)); });
    expect(firstCard).toHaveClass("is-drag-armed");

    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: vi.fn(), getData: vi.fn(), types: ["text/plain"] };
    fireEvent.dragStart(firstCard, { dataTransfer });
    fireEvent.dragEnter(secondCard, { dataTransfer });
    expect(await screen.findByRole("article", { name: `影片 ${secondVideo.fileName}，順序 1` })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: `影片 ${video.fileName}，順序 2` })).toBeInTheDocument();

    fireEvent.drop(secondCard, { dataTransfer });
    await waitFor(() => expect(api.moveTimelineAsset).toHaveBeenCalledWith(video.id, 1));
    expect(await screen.findByText(/已將素材移到第 2 項/)).toBeInTheDocument();
  });

  it("shows a five-second photo default, saves a three-to-seven-second choice, and enlarges portrait media without cropping", async () => {
    const imageProject = { ...structuredClone(project), sources: [photo], timelineOrder: [photo.id] };
    const api = mockApi(imageProject);
    const sevenSecondPhoto = { ...structuredClone(photo), imageDurationMs: 7_000 };
    vi.mocked(api.setImageDuration).mockResolvedValue({ asset: sevenSecondPhoto, project: { ...structuredClone(imageProject), sources: [sevenSecondPhoto], timelineRevision: imageProject.timelineRevision + 1 } });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    const duration = await screen.findByRole("combobox", { name: `${photo.fileName} 照片顯示時間` });
    expect(duration).toHaveValue("5000");
    expect(screen.getAllByText("5 秒").length).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelector(".thumb-button img")).not.toBeNull());
    fireEvent.change(duration, { target: { value: "7000" } });
    await waitFor(() => expect(api.setImageDuration).toHaveBeenCalledWith(photo.id, 7_000));
    await waitFor(() => expect(duration).toHaveValue("7000"));
    expect(await screen.findByText(/照片顯示時間已設為 7 秒/)).toBeInTheDocument();
    const shutter = screen.getByRole("checkbox", { name: /預設相機快門音效/ });
    expect(shutter).toBeChecked();
    fireEvent.click(shutter);
    await waitFor(() => expect(api.setPhotoSoundEnabled).toHaveBeenCalledWith(photo.id, false));

    fireEvent.click(screen.getByRole("button", { name: `預覽 ${photo.fileName}` }));
    const dialog = await screen.findByRole("dialog", { name: `預覽 ${photo.fileName}` });
    const enlarged = await within(dialog).findByRole("img", { name: photo.fileName });
    expect(enlarged).toHaveStyle({ aspectRatio: "1080 / 1920" });
    expect(enlarged.parentElement).toHaveClass("preview-image-shell");
  });

  it("inserts a project photo at a chosen video time from the grid without duplicating it", async () => {
    const imageProject = { ...structuredClone(project), sources: [video, photo], timelineOrder: [video.id, photo.id] };
    const api = mockApi(imageProject);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: /於影片時段插入照片或影片/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: `於影片時段插入照片或影片 ${video.fileName}` });
    expect(within(dialog).getByRole("combobox", { name: "選擇要安插的素材" })).toHaveValue(photo.id);
    fireEvent.change(within(dialog).getByLabelText("主影片安插時間－秒數"), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "確認安插素材" }));
    await waitFor(() => expect(api.addMediaInsertion).toHaveBeenCalledWith(video.id, photo.id, 4_000, undefined));
    expect(await within(dialog).findByText(/不會在正片中重複播放/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/直式照片\.HEIC/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox", { name: `${photo.fileName} 照片顯示時間` })).not.toBeInTheDocument();
  });

  it("inserts a trimmed video with independent IN/OUT handles using a minute:second insertion time", async () => {
    const longHost = { ...structuredClone(video), mediaInfo: { ...video.mediaInfo!, durationMs: 120_000 } };
    const mediaProject = { ...structuredClone(project), sources: [longHost, secondVideo, photo], timelineOrder: [video.id, secondVideo.id, photo.id] };
    const api = mockApi(mediaProject);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: /於影片時段插入照片或影片/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: `於影片時段插入照片或影片 ${video.fileName}` });
    expect(within(dialog).getByRole("combobox", { name: "選擇要安插的素材" })).toHaveValue(secondVideo.id);
    const inHandle = within(dialog).getByLabelText("片段起點"); const outHandle = within(dialog).getByLabelText("片段停止點");
    fireEvent.change(inHandle, { target: { value: "1000" } });
    fireEvent.change(outHandle, { target: { value: "4000" } });
    fireEvent.change(within(dialog).getByLabelText("主影片安插時間－分鐘"), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText("主影片安插時間－秒數"), { target: { value: "5.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "確認安插素材" }));
    await waitFor(() => expect(api.addMediaInsertion).toHaveBeenCalledWith(video.id, secondVideo.id, 65_500, { inMs: 1_000, outMs: 4_000 }));
  });

  it("switches insertion candidates by source folder and imports another folder without auto-placing it", async () => {
    const host = { ...structuredClone(video), sourcePath: "C:\\主素材\\clip01.mp4" };
    const sameFolderVideo = { ...structuredClone(secondVideo), sourcePath: "C:\\主素材\\clip02.mp4" };
    const otherFolderPhoto = { ...structuredClone(photo), sourcePath: "C:\\照片資料夾\\直式照片.HEIC" };
    const folderProject = { ...structuredClone(project), sources: [host, sameFolderVideo, otherFolderPhoto], timelineOrder: [host.id, sameFolderVideo.id], pendingAssetIds: [otherFolderPhoto.id] };
    const newlyImported = { ...structuredClone(photo), id: "7".repeat(64), sourceIdentity: "8".repeat(64), sourcePath: "D:\\其他旅程\\新安插照片.png", fileName: "新安插照片.png", extension: ".png", previewCacheKey: "9".repeat(64) };
    const afterFolderImport = { ...structuredClone(folderProject), sources: [...folderProject.sources, newlyImported], pendingAssetIds: [otherFolderPhoto.id, newlyImported.id] };
    const api = mockApi(folderProject);
    vi.mocked(api.chooseFolder).mockResolvedValue({ cancelled: false, addedCount: 1, duplicateCount: 0, unsupportedCount: 0, errors: [], project: afterFolderImport, addedAssetIds: [newlyImported.id] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: /於影片時段插入照片或影片/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: `於影片時段插入照片或影片 ${host.fileName}` });
    const folderSelector = within(dialog).getByLabelText("切換安插來源資料夾");
    expect(within(folderSelector).getAllByRole("option").map((option) => option.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/主素材/), expect.stringMatching(/照片資料夾/)]));
    fireEvent.change(folderSelector, { target: { value: "C:/照片資料夾" } });
    expect(within(dialog).getByRole("combobox", { name: "選擇要安插的素材" })).toHaveValue(otherFolderPhoto.id);
    expect(within(dialog).getByText(/新加入素材確認安插前不會混入正片/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "切換／加入其他資料夾…" }));
    await waitFor(() => expect(api.chooseFolder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(folderSelector).toHaveValue("D:/其他旅程"));
    expect(within(dialog).getByRole("combobox", { name: "選擇要安插的素材" })).toHaveValue(newlyImported.id);
    expect(within(dialog).getByText(/已從另一個資料夾唯讀加入 1 項/)).toBeInTheDocument();
    expect(screen.getByText(/待決定區 · 2 項/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("主影片安插時間－秒數"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "確認安插素材" }));
    await waitFor(() => expect(api.addMediaInsertion).toHaveBeenCalledWith(host.id, newlyImported.id, 5_000, undefined));
  });

  it("uses the saved photo duration in the overall preview timer", async () => {
    const sevenSecondPhoto = { ...structuredClone(photo), imageDurationMs: 7_000 };
    const api = mockApi({ ...structuredClone(project), sources: [sevenSecondPhoto], timelineOrder: [sevenSecondPhoto.id] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    const timerSpy = vi.spyOn(window, "setTimeout");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /總體預覽/ }));
    const playlist = await screen.findByRole("dialog", { name: "總體預覽" });
    await within(playlist).findByRole("img", { name: photo.fileName });
    expect(playlist.querySelector("audio")).toHaveAttribute("src", PHOTO_SOUND_PREVIEW_URL);
    await waitFor(() => expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 7_000));
    timerSpy.mockRestore();
  });

  it("saves a named project from the top-left File menu and opens an old project", async () => {
    const api = mockApi();
    const saved = { ...structuredClone(project), name: "河內 2026" };
    const opened = { ...structuredClone(project), id: "old", name: "舊河內專案" };
    vi.mocked(api.saveProjectAs).mockResolvedValue({ project: saved, filePath: "C:\\專案\\河內 2026.swproj" });
    vi.mocked(api.openProject).mockResolvedValue({ project: opened, filePath: "C:\\專案\\舊河內專案.swproj" });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "檔案 ▾" }));
    expect(screen.getByRole("menuitem", { name: "儲存專案" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "另存專案…" }));
    await waitFor(() => expect(api.saveProjectAs).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/專案「河內 2026」已安全儲存/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "檔案 ▾" }));
    expect(screen.getByRole("menuitem", { name: "儲存專案" })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "開啟舊專案…" }));
    await waitFor(() => expect(api.openProject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已開啟專案「舊河內專案」/)).toBeInTheDocument();
    expect(screen.getByText(/專案：舊河內專案/)).toBeInTheDocument();
  });

  it("shows read-only status, metadata and opens a playable overall preview", async () => {
    render(<App />);
    expect(await screen.findByText("來源唯讀保護已開啟")).toBeInTheDocument();
    expect(await screen.findByText("clip01.mp4")).toBeInTheDocument();
    expect(screen.getByText("1920 × 1080")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /總體預覽/ })));
    expect(await screen.findByRole("dialog", { name: "總體預覽" })).toBeInTheDocument();
    expect(await screen.findByLabelText("等比例播放 clip01.mp4")).not.toHaveAttribute("controls");
    expect(screen.getByText(/不會合併、剪輯或輸出來源/)).toBeInTheDocument();
  });

  it("removes an item only from the project list", async () => {
    render(<App />);
    const remove = await screen.findByRole("button", { name: /從正片移除 clip01/ });
    await act(async () => fireEvent.click(remove));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/磁碟來源檔、proxy cache/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消，保留正片" })).toHaveFocus();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /確認從正片移除/ })));
    expect(window.sourceApp.removeMainAsset).toHaveBeenCalledWith(video.id);
    expect(await screen.findByText(/來源檔、proxy 與 Intro 引用仍保留/)).toBeInTheDocument();
    expect(screen.getByText("正片清單目前為空")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "撤銷，恢復正片" })));
    expect(window.sourceApp.restoreMainAsset).toHaveBeenCalledWith(video.id);
    expect(await screen.findByText(/已恢復 clip01.mp4/)).toBeInTheDocument();
  });

  it("offers exactly three dissolve durations and four preview resolutions before OK starts render", async () => {
    const twoVideoProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id] };
    const api = mockApi(twoVideoProject);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    const openRender = await screen.findByRole("button", { name: /產出串連預覽/ });
    await act(async () => fireEvent.click(openRender));
    expect(await screen.findByRole("dialog", { name: "產出串連預覽" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("交接疊化秒數")).getAllByRole("button")).toHaveLength(3);
    expect(within(screen.getByLabelText("預覽解析度")).getAllByRole("button")).toHaveLength(4);

    const confirmButton = screen.getByRole("button", { name: "OK，開始產出" });
    await waitFor(() => expect(confirmButton).toBeEnabled());
    expect(api.prepareConcatOutput).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ })));
    await waitFor(() => expect(confirmButton).toBeEnabled());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "0.5秒" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /360p/ })));
    await act(async () => fireEvent.click(confirmButton));

    await waitFor(() => expect(api.startConcatRender).toHaveBeenCalledWith({
      outputToken: "output-token",
      orderedAssetIds: [video.id, secondVideo.id],
      clipSelections: [
        { assetId: video.id, inMs: 0, outMs: 12_000 },
        { assetId: secondVideo.id, inMs: 0, outMs: 8_000 },
      ],
      transitionSeconds: 0.5,
      resolution: "360P",
      purpose: "CONCAT",
      prependIntro: false,
      subtitleBurnIn: { enabled: false, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }] },
      includeBgm: true,
    }));
    expect(await screen.findByText("串連預覽已完成")).toBeInTheDocument();
  });

  it("uses an automatic last-folder output and lets this MP4 explicitly exclude MP3 music", async () => {
    const api = mockApi();
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    const dialog = await screen.findByRole("dialog", { name: "產出串連預覽" });
    expect(await within(dialog).findByText("C:\\Output\\auto-preview.mp4")).toBeInTheDocument();
    const includeMusic = within(dialog).getByRole("checkbox", { name: "這次 MP4 嵌入 MP3 配樂" });
    expect(includeMusic).toBeChecked();
    fireEvent.click(includeMusic);
    expect(includeMusic).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "OK，開始產出" }));
    await waitFor(() => expect(api.startConcatRender).toHaveBeenCalledWith(expect.objectContaining({
      outputToken: "automatic-output-token",
      includeBgm: false,
    })));
    expect(api.updateUserPreferences).toHaveBeenCalledWith({ renderDefaults: { mainPreviewIncludeBgm: false } });
  });

  it("shows prior Main preview file-name links at the bottom and opens them externally", async () => {
    const api = mockApi();
    vi.mocked(api.getPreviewOutputHistory).mockResolvedValue({ schemaVersion: 1, outputs: [
      { jobId: "main-old", outputPath: "C:\\輸出\\大雪山正片.mp4", fileName: "大雪山正片.mp4", purpose: "CONCAT", origin: "APP_RENDERED", createdAt: "2026-09-05T01:00:00Z", sizeBytes: 50_000, resolution: "4K", exists: true },
      { jobId: "intro-old", outputPath: "C:\\輸出\\大雪山片頭.mp4", fileName: "大雪山片頭.mp4", purpose: "INTRO", origin: "APP_RENDERED", createdAt: "2026-09-05T02:00:00Z", sizeBytes: 20_000, resolution: "720P", exists: true },
    ] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    const dialog = await screen.findByRole("dialog", { name: "產出串連預覽" });
    const history = within(dialog).getByRole("region", { name: "曾經輸出的正片預覽" });
    const link = await within(history).findByRole("button", { name: "大雪山正片.mp4" });
    expect(within(history).queryByText("大雪山片頭.mp4")).not.toBeInTheDocument();
    fireEvent.click(link);
    await waitFor(() => expect(api.playConcatOutput).toHaveBeenCalledWith("main-old"));
  });

  it("shows prior Intro preview links only on the Intro output page", async () => {
    const segment = { id: "intro-history", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 5_000, score: 80, reasons: ["事件"] };
    const introProject = { ...structuredClone(project), introSegments: [segment] };
    const api = mockApi(introProject);
    vi.mocked(api.getPreviewOutputHistory).mockResolvedValue({ schemaVersion: 1, outputs: [
      { jobId: "intro-old", outputPath: "C:\\輸出\\以前片頭.mp4", fileName: "以前片頭.mp4", purpose: "INTRO", origin: "APP_RENDERED", createdAt: "2026-09-05T02:00:00Z", sizeBytes: 20_000, resolution: "4K", exists: true },
    ] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.click(within(studio).getByRole("button", { name: "產出 Intro 預覽" }));
    const output = await screen.findByRole("dialog", { name: "產出 Intro 預覽" });
    const history = within(output).getByRole("region", { name: "曾經輸出的片頭預覽" });
    const link = await within(history).findByRole("button", { name: "以前片頭.mp4" });
    fireEvent.click(link);
    await waitFor(() => expect(api.playConcatOutput).toHaveBeenCalledWith("intro-old"));
  });

  it("burns up to two independently styled subtitle languages into the concat request", async () => {
    const subtitleProject = { ...structuredClone(project), subtitleCues: [{ id: "cue", startMs: 0, endMs: 2_000, text: "歡迎來到河內", reviewStatus: "CONFIRMED" as const }] };
    const api = mockApi(subtitleProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    const dialog = await screen.findByRole("dialog", { name: "產出串連預覽" });
    const toggle = within(dialog).getByRole("checkbox", { name: /將字幕永久嵌入/ });
    expect(toggle).toBeEnabled(); fireEvent.click(toggle);
    fireEvent.click(within(dialog).getByRole("button", { name: /加入第二種語言/ }));
    fireEvent.change(within(dialog).getByLabelText("第 2 種字幕語言"), { target: { value: "en" } });
    fireEvent.change(within(dialog).getByLabelText("第 1 種字幕文字大小"), { target: { value: "56" } });
    expect(within(dialog).queryByRole("button", { name: /加入第二種語言/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /選擇儲存位置/ }));
    const renderButton = within(dialog).getByRole("button", { name: "OK，開始產出" });
    await waitFor(() => expect(renderButton).toBeEnabled()); fireEvent.click(renderButton);
    await waitFor(() => expect(api.startConcatRender).toHaveBeenCalledWith(expect.objectContaining({ subtitleBurnIn: { enabled: true, tracks: [
      { language: "zh-TW", position: "BOTTOM", fontSize1080p: 56 }, { language: "en", position: "TOP", fontSize1080p: 42 },
    ] } })));
  });

  it("allows turning off a persisted subtitle burn-in choice when subtitles are unavailable", async () => {
    const api = mockApi();
    const persistedPreferences = await api.getUserPreferences();
    persistedPreferences.subtitleBurnInDefaults.enabled = true;
    vi.mocked(api.getUserPreferences).mockResolvedValue(persistedPreferences);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    const dialog = await screen.findByRole("dialog", { name: "產出串連預覽" });
    const toggle = await within(dialog).findByRole("checkbox", { name: /將字幕永久嵌入/ });
    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(api.updateUserPreferences).toHaveBeenCalledWith(expect.objectContaining({ subtitleBurnInDefaults: expect.objectContaining({ enabled: false }) })));
  });

  it("offers a safe unlisted YouTube upload after Main preview completion", async () => {
    const api = mockApi();
    vi.mocked(api.getYoutubeSettings).mockResolvedValue({ schemaVersion: 1, preferredBrowser: "CHROME", targetChannelName: "漫步風光", clientConfigured: true, connected: true, encryptionAvailable: true, channelId: "channel", channelTitle: "漫步風光", browsers: [{ id: "CHROME", label: "Google Chrome", available: true }, { id: "EDGE", label: "Microsoft Edge", available: true }] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK，開始產出" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK，開始產出" }));
    fireEvent.click(await screen.findByRole("button", { name: "上傳 YouTube 預覽" }));
    const upload = await screen.findByRole("dialog", { name: "上傳正片預覽到 YouTube" });
    expect(within(upload).getByRole("radio", { name: /不公開（預設）/ })).toBeChecked();
    fireEvent.click(within(upload).getByRole("radio", { name: "不是兒童內容" }));
    fireEvent.click(within(upload).getByRole("button", { name: "確認並開始上傳" }));
    await waitFor(() => expect(api.uploadYoutubeVideo).toHaveBeenCalledWith(expect.objectContaining({ jobId: "render-job", privacyStatus: "unlisted", madeForKids: false })));
    expect(await within(upload).findByText("影片已交給 YouTube 處理")).toBeInTheDocument();
    fireEvent.click(within(upload).getByRole("button", { name: "用設定的瀏覽器觀看" }));
    expect(api.openYoutubeVideo).toHaveBeenCalledWith("abc12345");
  });

  it("can cancel the default 60-second YouTube preparation without removing the completed MP4", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    expect(screen.getByRole("checkbox", { name: /輸出後自動準備 YouTube 上傳/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK，開始產出" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK，開始產出" }));
    expect(await screen.findByText(/60 秒後開啟 YouTube 上傳確認/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消自動上傳" }));
    expect(await screen.findByText(/已取消 60 秒自動上傳準備/)).toBeInTheDocument();
    expect(api.uploadYoutubeVideo).not.toHaveBeenCalled();
    expect(screen.getByText("C:\\Output\\preview.mp4")).toBeInTheDocument();
  });

  it("does not start the upload countdown when the option is unchecked before render", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    const automatic = screen.getByRole("checkbox", { name: /輸出後自動準備 YouTube 上傳/ });
    fireEvent.click(automatic); expect(automatic).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK，開始產出" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK，開始產出" }));
    expect(await screen.findByText("串連預覽已完成")).toBeInTheDocument();
    expect(screen.queryByText(/秒後開啟 YouTube 上傳確認/)).not.toBeInTheDocument();
    expect(api.uploadYoutubeVideo).not.toHaveBeenCalled();
  });

  it("defaults to placing confirmed Intro clips before Main and allows opting out", async () => {
    const intro = { id: "intro-combined", assetId: video.id, fileName: video.fileName, inMs: 1_000, outMs: 4_000, score: 91, reasons: ["人物與故事"] };
    const introProject = { ...structuredClone(project), introSegments: [intro] };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    const prompt = await screen.findByRole("dialog", { name: "正片開始提示頁設定" });
    expect(within(prompt).getByRole("button", { name: "3 秒" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(prompt).getByRole("button", { name: "5 秒" }));
    fireEvent.change(within(prompt).getByLabelText("第一行文字"), { target: { value: "草漯沙丘" } });
    fireEvent.change(within(prompt).getByLabelText("提示頁背景來源"), { target: { value: intro.id } });
    expect(within(prompt).getByText(/已選片頭第 1 段/)).toBeInTheDocument();
    fireEvent.click(within(prompt).getByRole("button", { name: "儲存提示頁設定" }));
    const combine = screen.getByRole("checkbox", { name: /自動串接已確認片頭＋正片/ });
    expect(combine).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK，開始產出" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK，開始產出" }));
    await waitFor(() => expect(api.startConcatRender).toHaveBeenCalledWith(expect.objectContaining({
      prependIntro: true,
      mainStartCard: expect.objectContaining({ durationSeconds: 5, line1: "草漯沙丘", line2: "旅程開始", transitionStyle: "DISSOLVE", backgroundIntroSegmentId: intro.id }),
      orderedAssetIds: [video.id, video.id],
      clipSelections: [
        { assetId: video.id, inMs: 1_000, outMs: 4_000 },
        { assetId: video.id, inMs: 0, outMs: 12_000 },
      ],
    })));
  });

  it("shows the linked YouTube channel without ever requesting its password", async () => {
    const api = mockApi();
    vi.mocked(api.getYoutubeSettings).mockResolvedValue({ schemaVersion: 1, preferredBrowser: "CHROME", targetChannelName: "漫步風光", clientConfigured: true, connected: true, encryptionAvailable: true, channelId: "UC-scene-walker", channelTitle: "漫步風光", browsers: [{ id: "CHROME", label: "Google Chrome", available: true }, { id: "EDGE", label: "Microsoft Edge", available: true }] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "平台上傳設定" }));
    const dialog = await screen.findByRole("dialog", { name: "平台上傳設定" });
    expect(within(dialog).getByText("漫步風光")).toBeInTheDocument();
    expect(within(dialog).getByText(/頻道 ID：UC-scene-walker/)).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    expect(within(dialog).getByText(/本 App 不收集、不顯示也不保存密碼/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /開啟 BiliBili 官方登入/ }));
    await waitFor(() => expect(api.openPlatformPortal).toHaveBeenCalledWith("BILIBILI"));
  });

  it("lists persisted and manually imported prior previews and removes only their history record", async () => {
    const api = mockApi();
    const prior = { jobId: "prior-preview", outputPath: "D:\\舊預覽\\河內 完成.mp4", fileName: "河內 完成.mp4", purpose: "CONCAT" as const, origin: "APP_RENDERED" as const, createdAt: "2026-09-04T08:00:00.000Z", sizeBytes: 1_234_567, durationMs: 20_000, resolution: "480P" as const, exists: true, projectName: "河內" };
    vi.mocked(api.getPreviewOutputHistory).mockResolvedValue({ schemaVersion: 1, outputs: [prior] });
    vi.mocked(api.removePreviewOutputRecord).mockResolvedValue({ schemaVersion: 1, outputs: [] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /預覽檔案庫/ }));
    const dialog = await screen.findByRole("dialog", { name: "預覽成品紀錄" });
    expect(within(dialog).getByText("河內 完成.mp4")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "▶ 播放" }));
    await waitFor(() => expect(api.playConcatOutput).toHaveBeenCalledWith("prior-preview"));
    fireEvent.click(within(dialog).getByRole("button", { name: "從清單移除紀錄" }));
    expect(within(dialog).getByText(/磁碟 MP4 不會刪除/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "確認移除紀錄" }));
    await waitFor(() => expect(api.removePreviewOutputRecord).toHaveBeenCalledWith("prior-preview"));
    expect(await within(dialog).findByText(/磁碟上的 MP4 沒有刪除或修改/)).toBeInTheDocument();
  });

  it("hands a completed Main preview to the official BiliBili and TikTok upload pages", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK，開始產出" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK，開始產出" }));
    fireEvent.click(await screen.findByRole("button", { name: "前往 BiliBili 投稿" }));
    await waitFor(() => expect(api.openPlatformUpload).toHaveBeenCalledWith("render-job", "BILIBILI"));
    expect(await screen.findByText("已開啟官方投稿頁")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "前往 TikTok 投稿" }));
    await waitFor(() => expect(api.openPlatformUpload).toHaveBeenCalledWith("render-job", "TIKTOK"));
    expect(screen.getByText(/仍需您在平台上確認後發布/)).toBeInTheDocument();
  });

  it("explains that a cancelled render can still be a finalized shorter MP4", async () => {
    const api = mockApi();
    vi.mocked(api.startConcatRender).mockResolvedValue({ jobId: "cancelled-job", outputPath: "C:\\Output\\short.mp4", sizeBytes: 20_000, expectedDurationMs: 2_000, plannedDurationMs: 12_000, cancelled: true, transitionSeconds: 0.3, resolution: "480P", purpose: "CONCAT" });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /產出串連預覽/ }));
    fireEvent.click(screen.getByRole("button", { name: /選擇儲存位置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "OK，開始產出" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "OK，開始產出" }));
    expect(await screen.findByText("已停止產出並完成較短的可播放 MP4")).toBeInTheDocument();
    expect(screen.getByText(/安全寫完 MPEG-4 尾端並驗證可播放/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "▶ 播放完成檔" }));
    expect(api.playConcatOutput).toHaveBeenCalledWith("cancelled-job");
  });

  it("plays a proxy in the grid and persists the dual-handle IN/OUT range", async () => {
    const api = mockApi();
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    const inHandle = await screen.findByLabelText("片段起點");
    fireEvent.change(inHandle, { target: { value: "2000" } });
    await waitFor(() => expect(inHandle).toHaveValue("2000"));
    fireEvent.pointerUp(inHandle);
    await waitFor(() => expect(api.setPreviewRange).toHaveBeenCalledWith(video.id, { inMs: 2000, outMs: 12_000 }));

    fireEvent.click(screen.getByRole("button", { name: "▶ 網格播放" }));
    await waitFor(() => expect(document.querySelector("video.inline-video")).toBeInTheDocument());
    expect(api.ensurePreview).toHaveBeenCalledWith(video.id, "VIDEO_PROXY");
  });

  it("provides a precise enlarged seek head and creates Main exclusions from the current play position", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /刪除／排除部分片段/ }));
    const dialog = await screen.findByRole("dialog", { name: `預覽 ${video.fileName}` });
    const seekHead = await within(dialog).findByLabelText("放大預覽播放頭");
    fireEvent.change(seekHead, { target: { value: "2500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /新增排除區段/ }));
    expect(within(dialog).getByLabelText("排除 1 開始－分鐘")).toHaveValue(0);
    expect(within(dialog).getByLabelText("排除 1 開始－秒數")).toHaveValue(2.5);
    fireEvent.change(seekHead, { target: { value: "4000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "目前設為結束" }));
    expect(within(dialog).getByLabelText("排除 1 結束－秒數")).toHaveValue(4);
    const player = dialog.querySelector("video")!;
    expect(player).not.toHaveAttribute("controls");
    expect(player).toHaveStyle({ aspectRatio: "1920 / 1080" });
    expect(player.parentElement).toHaveClass("preview-video-shell");
    fireEvent.play(player); expect(within(dialog).getByRole("button", { name: "暫停放大預覽" })).toBeInTheDocument();
    fireEvent.pause(player); expect(within(dialog).getByRole("button", { name: "播放放大預覽" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存排除區段" }));
    await waitFor(() => expect(api.setMainExclusionRanges).toHaveBeenCalledWith(video.id, [expect.objectContaining({ startMs: 2_500, endMs: 4_000 })]));
    expect(await within(dialog).findByText(/來源與代理檔均未修改/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除正片排除區段 1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存排除區段" }));
    await waitFor(() => expect(api.setMainExclusionRanges).toHaveBeenLastCalledWith(video.id, []));
    fireEvent.click(within(dialog).getByRole("button", { name: /新增排除區段/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "一鍵清除排除區段" }));
    await waitFor(() => expect(api.setMainExclusionRanges).toHaveBeenLastCalledWith(video.id, []));
    fireEvent.click(within(dialog).getByRole("button", { name: /新增排除區段/ }));
    fireEvent.change(within(dialog).getByLabelText("排除 1 開始－秒數"), { target: { value: "6" } });
    vi.mocked(api.setMainExclusionRanges).mockRejectedValueOnce(new Error("結束時間必須晚於開始時間"));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存排除區段" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("結束時間必須晚於開始時間");
  });

  it("keeps a portrait enlarged preview at its 9:16 display ratio with controls outside the picture", async () => {
    const portrait = { ...structuredClone(video), fileName: "portrait.mov", extension: ".mov", mediaInfo: { ...video.mediaInfo, width: 1920, height: 1080, displayWidth: 1080, displayHeight: 1920, rotationDegrees: 90, isPortrait: true } };
    const portraitProject = { ...structuredClone(project), sources: [portrait], timelineOrder: [portrait.id] };
    const api = mockApi(portraitProject); vi.mocked(api.ensureMetadata).mockResolvedValue(portrait);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "▶ 網格播放" }));
    fireEvent.click(await screen.findByRole("button", { name: "放大" }));
    const dialog = await screen.findByRole("dialog", { name: `預覽 ${portrait.fileName}` });
    const player = await within(dialog).findByLabelText(`放大播放 ${portrait.fileName}`);
    expect(player).not.toHaveAttribute("controls");
    expect(player).toHaveStyle({ aspectRatio: "1080 / 1920" });
    expect(within(dialog).getByLabelText("放大預覽播放頭")).toBeInTheDocument();
  });

  it("saves the merged source range with zero-based enlargement, adds it to Intro, and opens 4K output", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /刪除／排除部分片段/ }));
    const dialog = await screen.findByRole("dialog", { name: `預覽 ${video.fileName}` });
    fireEvent.click(within(dialog).getByRole("button", { name: /新增片段時段/ }));
    expect(within(dialog).getByLabelText("局部放大 1 倍數")).toHaveValue(0);
    fireEvent.change(within(dialog).getByLabelText("局部放大 1 倍數"), { target: { value: "75" } });
    fireEvent.change(within(dialog).getByLabelText("局部放大 1 中心 X"), { target: { value: "35" } });
    fireEvent.change(within(dialog).getByLabelText("局部放大 1 中心 Y"), { target: { value: "65" } });
    expect(within(dialog).getByRole("checkbox", { name: /儲存後直接加入片頭/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /儲存後開啟此時段的 4K MP4/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存片段設定" }));
    await waitFor(() => expect(api.setZoomSegments).toHaveBeenCalledWith(video.id, [expect.objectContaining({ startMs: 0, endMs: 3_000, zoomPercent: 175, centerXPercent: 35, centerYPercent: 65 })]));
    await waitFor(() => expect(api.setIntroSegments).toHaveBeenCalledWith([expect.objectContaining({ assetId: video.id, inMs: 0, outMs: 3_000, origin: "MANUAL" })]));
    const added = await screen.findByRole("dialog", { name: "片頭片段加入成功" });
    expect(within(added).getByText("已加入片頭第 1 順位")).toBeInTheDocument();
    fireEvent.click(within(added).getByRole("button", { name: "留在片段設定" }));
    const output = await screen.findByRole("dialog", { name: "輸出最高 4K 時間段" });
    expect(within(output).getByRole("button", { name: /4K/ })).toBeDisabled();
    expect(within(output).getByText(/從原始來源重新編碼並套用局部放大/)).toBeInTheDocument();
  });

  it("shows locally analyzed intro suggestions with adjustable clips and four output sizes", async () => {
    const twoVideoProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id] };
    const api = mockApi(twoVideoProject);
    vi.mocked(api.analyzeIntro).mockResolvedValue({
      analyzerVersion: "intro-local-sampler-v1",
      analyzedAssetCount: 2,
      cacheHits: 1,
      generatedAt: "2026-08-29T00:00:00.000Z",
      suggestions: [{
        id: "suggestion-1",
        assetId: video.id,
        fileName: video.fileName,
        inMs: 1000,
        outMs: 6000,
        score: 82,
        reasons: ["動態明確", "曝光平衡"],
      }],
    });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.click(within(studio).getByRole("button", { name: "開始分析" }));
    await waitFor(() => expect(api.setIntroTargetDuration).toHaveBeenCalledWith(90_000));
    expect(api.analyzeIntro).toHaveBeenCalledWith([video.id, secondVideo.id], 90_000, 15_000);
    expect(await within(studio).findByText(/精彩分數 82/)).toBeInTheDocument();
    expect(within(studio).getByLabelText("片段起點")).toHaveValue("1000");
    fireEvent.click(within(studio).getByRole("button", { name: "產出 Intro 預覽" }));
    const outputDialog = await screen.findByRole("dialog", { name: "產出 Intro 預覽" });
    expect(within(within(outputDialog).getByLabelText("預覽解析度")).getAllByRole("button")).toHaveLength(4);
  });

  it("saves one maximum for every Intro segment and offers equalized adjustment", async () => {
    const first = { id: "intro-a", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 5_000, score: 80, reasons: ["人物"] };
    const second = { id: "intro-b", assetId: video.id, fileName: video.fileName, inMs: 6_000, outMs: 12_000, score: 75, reasons: ["事件"] };
    const introProject = { ...structuredClone(project), introSegments: [first, second] };
    const api = mockApi(introProject);
    vi.mocked(api.setIntroSegmentMaxDuration).mockResolvedValue({ ...introProject, introSegmentMaxDurationMs: 10_000, introSegments: [{ ...first, outMs: 10_000 }, { ...second, inMs: 2_000, outMs: 12_000 }] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    expect(within(studio).getByLabelText("片頭每段最高秒數")).toHaveValue(15);
    fireEvent.change(within(studio).getByLabelText("片頭每段最高秒數"), { target: { value: "10" } });
    fireEvent.click(within(studio).getByRole("button", { name: "套用上限並均衡" }));
    await waitFor(() => expect(api.setIntroSegmentMaxDuration).toHaveBeenCalledWith(10_000));
    expect(await within(studio).findByText(/每段限制在 10 秒內/)).toBeInTheDocument();
  });

  it("saves an Intro text brief and analyzes only the chosen base video", async () => {
    const twoVideoProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id] };
    const api = mockApi(twoVideoProject);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.change(within(studio).getByLabelText("片頭 AI 文字指示"), { target: { value: "優先呈現人物抵達森林與養護事件" } });
    fireEvent.change(within(studio).getByLabelText("片頭優先基底素材"), { target: { value: secondVideo.id } });
    fireEvent.click(within(studio).getByRole("button", { name: "開始分析" }));
    await waitFor(() => expect(api.setAiStoryContext).toHaveBeenCalledWith(expect.objectContaining({ introPrompt: "優先呈現人物抵達森林與養護事件", introBaseAssetId: secondVideo.id })));
    await waitFor(() => expect(api.analyzeIntro).toHaveBeenCalledWith([secondVideo.id], 90_000, 15_000));
  });

  it("keeps an AI Intro material preview at the source display ratio", async () => {
    const portrait = { ...structuredClone(video), fileName: "片頭直式素材.MOV", extension: ".mov", mediaInfo: { ...video.mediaInfo!, displayWidth: 1080, displayHeight: 1920, rotationDegrees: 90, isPortrait: true }, zoomSegments: [{ id: "intro-focus", startMs: 1_500, endMs: 3_500, zoomPercent: 150, centerXPercent: 40, centerYPercent: 60 }] };
    const segment = { id: "portrait-intro", assetId: portrait.id, fileName: portrait.fileName, inMs: 1_000, outMs: 4_000, score: 88, reasons: ["人物事件"] };
    const introProject = { ...structuredClone(project), sources: [portrait], timelineOrder: [portrait.id], introSegments: [segment] };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    const player = await within(studio).findByLabelText(`片頭素材預覽 ${portrait.fileName}`);
    expect(player).toHaveStyle({ aspectRatio: "1080 / 1920" });
    expect(player).toHaveClass("intro-material-preview");
    expect(player).toHaveAttribute("src", `source-media://asset/${portrait.id}?key=${portrait.previewCacheKey}`);
    fireEvent.timeUpdate(player, { target: { currentTime: 2 } });
    await waitFor(() => expect(player).toHaveStyle({ transform: "scale(1.5)", transformOrigin: "40% 60%" }));
    expect(api.ensureClipPreview).not.toHaveBeenCalled();
    expect(api.ensurePreview).not.toHaveBeenCalledWith(portrait.id, "VIDEO_PROXY");
    expect(api.analyzeIntro).not.toHaveBeenCalled();
  });

  it("manually adds a photo, reorders Intro segments, and persists the selected color look for Main", async () => {
    const first = { id: "manual-video", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 3_000, score: 0, reasons: ["手動"], origin: "MANUAL" as const };
    const second = { id: "manual-photo", assetId: photo.id, fileName: photo.fileName, inMs: 0, outMs: 5_000, score: 0, reasons: ["手動"], origin: "MANUAL" as const };
    const introProject = { ...structuredClone(project), sources: [video, photo], timelineOrder: [video.id, photo.id], introSegments: [first, second] };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.click(within(studio).getAllByRole("button", { name: "↓ 往後" })[0]);
    await waitFor(() => expect(api.setIntroSegments).toHaveBeenCalledWith([expect.objectContaining({ id: second.id }), expect.objectContaining({ id: first.id })]));
    fireEvent.click(within(studio).getByRole("button", { name: /暖陽金色/ }));
    await waitFor(() => expect(api.setProjectColorSettings).toHaveBeenCalledWith({ introPresetId: "WARM_GOLDEN", applyToMain: false }));
    fireEvent.click(within(studio).getByRole("checkbox", { name: /沿用相同色彩到後面的正片/ }));
    await waitFor(() => expect(api.setProjectColorSettings).toHaveBeenLastCalledWith({ introPresetId: "WARM_GOLDEN", applyToMain: true }));
  });

  it("reorders confirmed Intro segments by mouse drag and persists the dropped order", async () => {
    const first = { id: "drag-intro-one", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["第一段"] };
    const second = { id: "drag-intro-two", assetId: secondVideo.id, fileName: secondVideo.fileName, inMs: 1_000, outMs: 4_000, score: 80, reasons: ["第二段"] };
    const introProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id], introSegments: [first, second] };
    const api = mockApi(introProject);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    const dragButtons = within(studio).getAllByRole("button", { name: /選擇並拖曳片頭第/ });
    const targetCard = dragButtons[1].closest("li")!;
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn(() => "drag-intro-one") };
    fireEvent.dragStart(dragButtons[0], { dataTransfer });
    fireEvent.dragEnter(targetCard, { dataTransfer });
    fireEvent.drop(targetCard, { dataTransfer });
    await waitFor(() => expect(api.setIntroSegments).toHaveBeenCalledWith([
      expect.objectContaining({ id: second.id }),
      expect.objectContaining({ id: first.id }),
    ]));
    expect(await within(studio).findByText(/已用滑鼠調整片頭順序/)).toBeInTheDocument();
  });

  it("adds a project photo to an empty Intro with the safe five-second default", async () => {
    const sourceProject = { ...structuredClone(project), sources: [video, photo], timelineOrder: [video.id, photo.id] };
    const api = mockApi(sourceProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.change(within(studio).getByLabelText("專案既有片頭素材"), { target: { value: photo.id } });
    fireEvent.click(within(studio).getByRole("button", { name: "加入既有素材" }));
    await waitFor(() => expect(api.setIntroSegments).toHaveBeenCalledWith([expect.objectContaining({ assetId: photo.id, inMs: 0, outMs: 5_000, origin: "MANUAL" })]));
  });

  it("removes only one Intro segment, keeps Main and same-source siblings, and restores it explicitly", async () => {
    const introOne = { id: "intro-one", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 1_000, score: 80, reasons: ["測試"] };
    const introTwo = { id: "intro-two", assetId: video.id, fileName: video.fileName, inMs: 2_000, outMs: 3_000, score: 75, reasons: ["測試"] };
    const introProject = { ...structuredClone(project), introSegments: [introOne, introTwo] };
    const api = mockApi(introProject);
    vi.mocked(api.removeIntroSegment).mockResolvedValue({ ...introProject, introSegments: [introTwo], introExcludedSegmentIds: [introOne.id], recentIntroRemovals: [{ segment: introOne, previousIndex: 0, removedAt: "2026-08-30T00:00:00.000Z" }], timelineRevision: 2 });
    vi.mocked(api.restoreIntroSegment).mockResolvedValue({ ...introProject, timelineRevision: 3 });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.click(within(studio).getAllByRole("button", { name: /從片頭移除/ })[0]);
    await waitFor(() => expect(api.removeIntroSegment).toHaveBeenCalledWith(introOne.id));
    expect(within(studio).getAllByRole("button", { name: /從片頭移除/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: `從正片移除 ${video.fileName}` })).toBeInTheDocument();
    fireEvent.click(within(studio).getByRole("button", { name: "恢復片頭區段" }));
    await waitFor(() => expect(api.restoreIntroSegment).toHaveBeenCalledWith(introOne.id));
    expect(api.analyzeIntro).not.toHaveBeenCalled();
  });

  it("blocks Main output when exclusions consume every effective frame while keeping the source card", async () => {
    const fullyExcluded = { ...structuredClone(video), mainExclusionRanges: [{ id: "all", startMs: 0, endMs: 12_000 }] };
    const emptyOutputProject = { ...structuredClone(project), sources: [fullyExcluded] };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: mockApi(emptyOutputProject) }); render(<App />);
    expect(await screen.findByText(/有效範圍已全部排除/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /產出串連預覽/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: `從正片移除 ${video.fileName}` })).toBeInTheDocument();
  });

  it("saves a case-insensitive .mp4 player override from the settings page", async () => {
    const api = mockApi();
    const settings: ExternalPlayerSettingsSnapshot = {
      settings: { schemaVersion: 1, defaultPlayerId: "SYSTEM_DEFAULT", extensionOverrides: {}, customPlayers: [], updatedAt: "2026-08-29T00:00:00.000Z" },
      players: [
        { id: "SYSTEM_DEFAULT", label: "Windows 系統預設播放器", kind: "SYSTEM", available: true },
        { id: "VLC", label: "VLC media player", kind: "KNOWN", available: true, executablePath: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" },
      ],
    };
    vi.mocked(api.getExternalPlayerSettings).mockResolvedValue(settings);
    vi.mocked(api.updateExternalPlayerSettings).mockImplementation(async (update) => ({ ...settings, settings: { ...settings.settings, ...update } }));
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /播放設定/ }));
    const dialog = await screen.findByRole("dialog", { name: "外部播放器設定" });
    fireEvent.change(within(dialog).getByLabelText(".mp4 播放器"), { target: { value: "VLC" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "儲存設定" }));
    await waitFor(() => expect(api.updateExternalPlayerSettings).toHaveBeenCalledWith({ defaultPlayerId: "SYSTEM_DEFAULT", extensionOverrides: { ".mp4": "VLC" } }));
    expect(await within(dialog).findByText(/設定已保存/)).toBeInTheDocument();
  });

  it("opens the read-only-intent original directly with a left click on the grid external-player action", async () => {
    const api = mockApi();
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: `從縮圖以外部播放器直接播放 ${video.fileName}` }));
    await waitFor(() => expect(api.openExternalMedia).toHaveBeenCalledWith(video.id, "ORIGINAL"));
    expect(screen.queryByRole("dialog", { name: /以外部播放器開啟/ })).not.toBeInTheDocument();
    expect(await screen.findByText(/唯讀意圖原檔；實際來源保護仍取決於外部播放器/)).toBeInTheDocument();
  });

  it("opens a grid video thumbnail directly in the configured external player while leaving other controls unchanged", async () => {
    const api = mockApi();
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: `從縮圖以外部播放器直接播放 ${video.fileName}` }));
    await waitFor(() => expect(api.openExternalMedia).toHaveBeenCalledWith(video.id, "ORIGINAL"));
    expect(screen.queryByRole("dialog", { name: `預覽 ${video.fileName}` })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "▶ 網格播放" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /音量區段/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /於影片時段插入照片或影片/ })).toBeEnabled();
  });

  it("opens the original proxy/original choice only from a right click", async () => {
    const api = mockApi();
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<App />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: `從縮圖以外部播放器直接播放 ${video.fileName}` }));
    const dialog = await screen.findByRole("dialog", { name: /以外部播放器開啟 clip01.mp4/ });
    expect(within(dialog).getByRole("radio", { name: /App cache proxy/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("radio", { name: /唯讀意圖開啟原檔/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "開啟觀看" }));
    await waitFor(() => expect(api.openExternalMedia).toHaveBeenCalledWith(video.id, "ORIGINAL"));
    expect(within(dialog).getByText(/來源保護仍取決於外部播放器/)).toBeInTheDocument();
  });

  it("edits multiple clip volume regions with percent controls", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /音量區段/ }));
    const dialog = await screen.findByRole("dialog", { name: /音量區段 clip01/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /新增音量區段/ }));
    expect(within(dialog).getByText(/素材原音預設 80%/)).toBeInTheDocument();
    const startMinute = within(dialog).getByLabelText("開始時間－分鐘");
    const startSecond = within(dialog).getByLabelText("開始時間－秒數");
    const endMinute = within(dialog).getByLabelText("結束時間－分鐘");
    startMinute.focus();
    fireEvent.keyDown(startMinute, { key: "Enter" });
    expect(startSecond).toHaveFocus();
    fireEvent.keyDown(startSecond, { key: "Enter" });
    expect(endMinute).toHaveFocus();
    fireEvent.change(startSecond, { target: { value: "1.25" } });
    fireEvent.change(within(dialog).getByLabelText("結束時間－秒數"), { target: { value: "4.5" } });
    const volume = within(dialog).getByLabelText("音量百分比"); fireEvent.change(volume, { target: { value: "200" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "儲存音量設定" }));
    await waitFor(() => expect(api.setVolumeSegments).toHaveBeenCalledWith(video.id, [expect.objectContaining({ startMs: 1_250, endMs: 4_500, volumePercent: 200 })]));
  });

  it("clamps split minute/second volume inputs to the source duration", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /音量區段/ }));
    const dialog = await screen.findByRole("dialog", { name: /音量區段 clip01/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /新增音量區段/ }));
    fireEvent.change(within(dialog).getByLabelText("開始時間－分鐘"), { target: { value: "75" } });
    expect(within(dialog).getByLabelText("開始時間－分鐘")).toHaveValue(0);
    expect(within(dialog).getByLabelText("開始時間－秒數")).toHaveValue(12);
  });

  it("asks for placement of each supplemental import and records an after-anchor decision", async () => {
    const api = mockApi(); const imported = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id], pendingAssetIds: [secondVideo.id] };
    vi.mocked(api.chooseFiles).mockResolvedValue({ cancelled: false, addedCount: 1, duplicateCount: 0, unsupportedCount: 0, errors: [], project: imported, addedAssetIds: [secondVideo.id] });
    vi.mocked(api.placeAsset).mockResolvedValue({ ...imported, timelineOrder: [video.id, secondVideo.id], pendingAssetIds: [], sortMode: "MANUAL_ORDER" });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /選擇多個檔案/ }));
    const dialog = await screen.findByRole("dialog", { name: /安插位置 clip02/ });
    fireEvent.click(within(dialog).getByRole("radio", { name: /指定素材之後/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "確認位置" }));
    await waitFor(() => expect(api.placeAsset).toHaveBeenCalledWith(secondVideo.id, { action: "AFTER", anchorAssetId: video.id }));
  });

  it("persists manual movement and exposes BGM and SRT workflows", async () => {
    const bgm = { id: "bgm", sourcePath: "C:\\音樂\\旅行 配樂.mp3", fileName: "旅行 配樂.mp3", sizeBytes: 1000, durationMs: 10_000, sourceInMs: 0, sourceOutMs: 10_000, timelineInMs: 0, timelineOutMs: 10_000, fadeInMs: 1000, fadeOutMs: 1000, volumePercent: 100, sourcePolicy: "READ_ONLY" as const, addedAt: "2026-08-29T00:00:00.000Z" };
    const twoVideoProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id], bgmTracks: [bgm] };
    const api = mockApi(twoVideoProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    const upButtons = await screen.findAllByRole("button", { name: /上移/ }); fireEvent.click(upButtons[1]);
    await waitFor(() => expect(api.moveTimelineAsset).toHaveBeenCalledWith(secondVideo.id, 0));
    fireEvent.click(screen.getByRole("button", { name: /配樂 \(1\)/ }));
    let dialog = await screen.findByRole("dialog", { name: "配樂與混音" });
    expect(within(dialog).getByLabelText("素材原音音量")).toHaveValue(80);
    const percentages = within(dialog).getAllByRole("spinbutton"); fireEvent.change(percentages.at(-1)!, { target: { value: "200" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存此曲" }));
    await waitFor(() => expect(api.updateBgmTrack).toHaveBeenCalledWith(expect.objectContaining({ volumePercent: 200 })));
    fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    fireEvent.click(screen.getByRole("button", { name: /CC 字幕/ })); dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    fireEvent.click(within(dialog).getByRole("button", { name: /新增人工字幕/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /匯出 1 筆已確認 SRT/ }));
    await waitFor(() => expect(api.exportSubtitles).toHaveBeenCalledWith("srt-token", ["MAIN"]));
  });

  it("plays, reveals and copies the path of a ready local MP3 without changing it", async () => {
    const bgm = { id: "bgm-path", sourcePath: "C:\\音樂 資料夾\\旅行 配樂.mp3", fileName: "旅行 配樂.mp3", sizeBytes: 1000, durationMs: 10_000, sourceInMs: 0, sourceOutMs: 10_000, timelineInMs: 0, timelineOutMs: 10_000, fadeInMs: 0, fadeOutMs: 0, volumePercent: 35, sourcePolicy: "READ_ONLY" as const, addedAt: "2026-09-07T00:00:00.000Z", resolutionStatus: "READY" as const };
    const api = mockApi({ ...structuredClone(project), bgmTracks: [bgm] });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^♫ 配樂/ }));
    const dialog = await screen.findByRole("dialog", { name: "配樂與混音" });
    fireEvent.click(within(dialog).getByRole("button", { name: "▶ 播放" }));
    await waitFor(() => expect(api.playBgmTrack).toHaveBeenCalledWith(bgm.id));
    fireEvent.click(within(dialog).getByRole("button", { name: "開啟位置" }));
    await waitFor(() => expect(api.revealBgmTrack).toHaveBeenCalledWith(bgm.id));
    fireEvent.click(within(dialog).getByRole("button", { name: "複製路徑" }));
    await waitFor(() => expect(api.copyBgmTrackPath).toHaveBeenCalledWith(bgm.id));
  });

  it("builds an Intro 480P preview with the persisted BGM and source-audio mix", async () => {
    const segment = { id: "bgm-intro", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["人物事件"] };
    const bgm = { id: "bgm-intro-track", sourcePath: "C:\\音樂\\intro.mp3", fileName: "intro.mp3", sizeBytes: 1000, durationMs: 10_000, sourceInMs: 1_000, sourceOutMs: 4_000, timelineInMs: 0, timelineOutMs: 3_000, fadeInMs: 500, fadeOutMs: 500, volumePercent: 35, sourcePolicy: "READ_ONLY" as const, addedAt: "2026-09-07T00:00:00.000Z", resolutionStatus: "READY" as const };
    const introProject = { ...structuredClone(project), introSegments: [segment], bgmTracks: [bgm], sourceAudioVolumePercent: 80 };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    fireEvent.click(within(studio).getByRole("checkbox", { name: /看片頭時套用配樂/ }));
    await waitFor(() => expect(api.buildSubtitleIntroPreview).toHaveBeenCalledWith(true));
    expect(await within(studio).findByLabelText("片頭配樂同步 480P 預覽")).toHaveAttribute("src", expect.stringMatching(/^preview-media:\/\/subtitle\//));
    expect(api.updateUserPreferences).toHaveBeenCalledWith({ renderDefaults: { introPreviewIncludeBgm: true } });
  });

  it("queues mixed YouTube music references without downloading and requires a rights confirmation", async () => {
    const pending = { id: "yt-bgm", sourcePath: "", fileName: "YouTube 參考 · abc123XYZ", sizeBytes: 0, durationMs: 0, sourceInMs: 0, sourceOutMs: 0, timelineInMs: 0, timelineOutMs: 0, fadeInMs: 0, fadeOutMs: 0, volumePercent: 35, sourcePolicy: "READ_ONLY" as const, addedAt: "2026-09-03T00:00:00.000Z", sourceKind: "YOUTUBE_REFERENCE" as const, resolutionStatus: "NEEDS_LOCAL_FILE" as const, sourceUrl: "https://www.youtube.com/watch?v=abc123XYZ", rightsConfirmed: false };
    const pendingProject = { ...structuredClone(project), bgmTracks: [pending] };
    const api = mockApi();
    vi.mocked(api.addBgmYoutubeReferences).mockResolvedValue({ cancelled: false, addedCount: 1, errors: [], project: pendingProject });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^♫ 配樂/ }));
    const dialog = await screen.findByRole("dialog", { name: "配樂與混音" });
    fireEvent.change(within(dialog).getByLabelText("YouTube 配樂參考連結"), { target: { value: "https://youtu.be/abc123XYZ" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "加入連結參考" }));
    await waitFor(() => expect(api.addBgmYoutubeReferences).toHaveBeenCalledWith(["https://youtu.be/abc123XYZ"]));
    expect(await within(dialog).findByText(/待指定授權 MP3/)).toBeInTheDocument();
    const resolve = within(dialog).getByRole("button", { name: /指定本機授權 MP3/ });
    expect(resolve).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /我確認將指定的 MP3/ }));
    expect(resolve).toBeEnabled();
    fireEvent.click(resolve);
    await waitFor(() => expect(api.resolveBgmReference).toHaveBeenCalledWith("yt-bgm", true));
  });

  it("generates theme-based YouTube suggestions, persists the TikTok trend option, and opens audition links safely", async () => {
    const api = mockApi();
    let persistedProject = structuredClone(project);
    vi.mocked(api.generateMusicSuggestions).mockImplementation(async ({ includeTikTokTrending, royaltyFreeOnly }) => {
      const result = { provider: "OPENAI_API" as const, accountName: "測試 OpenAI", generatedAt: "2026-09-08T10:00:00.000Z", topicSummary: "測試旅行｜河內", royaltyFreeOnly, suggestions: [{ id: "yt-suggestion", platform: "YOUTUBE" as const, title: "City Walk", artist: "Test Artist", reason: "適合城市步行節奏", auditionUrl: "https://www.youtube.com/watch?v=abc123XYZ", evidenceUrl: "https://www.youtube.com/watch?v=abc123XYZ", rightsStatus: "REVIEW_REQUIRED" as const }, ...(includeTikTokTrending ? [{ id: "tt-suggestion", platform: "TIKTOK" as const, title: "Recent Trend", reason: "近期旅遊熱門節奏", auditionUrl: "https://ads.tiktok.com/business/creativecenter/song/sample/pc/en", evidenceUrl: "https://ads.tiktok.com/business/creativecenter/song/sample/pc/en", observedAt: "2026-09-08", trendEvidence: "Creative Center 近期趨勢", rightsStatus: "REVIEW_REQUIRED" as const }] : [])], warnings: ["逐首確認授權"] };
      persistedProject = { ...structuredClone(project), musicSuggestionResult: result };
      return result;
    });
    vi.mocked(api.getProject).mockImplementation(async () => structuredClone(persistedProject));
    vi.mocked(api.addBgmYoutubeReferences).mockImplementation(async () => ({ cancelled: false, addedCount: 1, errors: [], project: structuredClone(persistedProject) }));
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^♫ 配樂/ }));
    const dialog = await screen.findByRole("dialog", { name: "配樂與混音" });
    const tiktok = within(dialog).getByRole("checkbox", { name: /AI 同時搜尋 TikTok／抖音/ });
    fireEvent.click(tiktok);
    await waitFor(() => expect(api.updateUserPreferences).toHaveBeenCalledWith({ musicSuggestionDefaults: { includeTikTokTrending: true } }));
    fireEvent.click(within(dialog).getByRole("button", { name: "產生多個試聽建議" }));
    await waitFor(() => expect(api.generateMusicSuggestions).toHaveBeenCalledWith({ includeTikTokTrending: true, royaltyFreeOnly: false }));
    expect(await within(dialog).findByText(/City Walk/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Recent Trend/)).toBeInTheDocument();
    const auditionButtons = within(dialog).getAllByRole("button", { name: "▶ 開啟試聽" });
    fireEvent.click(auditionButtons[0]);
    await waitFor(() => expect(api.openMusicSuggestion).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123XYZ"));
    fireEvent.click(within(dialog).getByRole("button", { name: "加入參考" }));
    await waitFor(() => expect(api.addBgmYoutubeReferences).toHaveBeenCalledWith(["https://www.youtube.com/watch?v=abc123XYZ"]));
    expect(within(dialog).getByText(/只供試聽與選曲/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    fireEvent.click(await screen.findByRole("button", { name: /^♫ 配樂/ }));
    const reopened = await screen.findByRole("dialog", { name: "配樂與混音" });
    expect(await within(reopened).findByText(/City Walk/)).toBeInTheDocument();
  });

  it("configures an encrypted OpenAI API profile plus Codex subtitle fallback and saves story context", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 帳號／故事/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 帳號與故事設定" });
    expect(within(dialog).getByText(/知識型字幕可自動改用這台電腦的 Codex/)).toBeInTheDocument();
    expect(within(dialog).getByText(/不讀取、不複製登入 token/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("影片主題"), { target: { value: "河內人物旅行故事" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "儲存故事背景" }));
    await waitFor(() => expect(api.setAiStoryContext).toHaveBeenCalledWith(expect.objectContaining({ topic: "河內人物旅行故事", locations: ["河內"], people: ["主持人"] })));
    fireEvent.change(within(dialog).getByLabelText("OpenAI API Key"), { target: { value: "sk-ui-123456789012345678901234567890" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "儲存並使用" }));
    await waitFor(() => expect(api.saveAiAccount).toHaveBeenCalledWith(expect.objectContaining({ id: "openai-default", provider: "OPENAI", makeActive: true, apiKey: "sk-ui-123456789012345678901234567890" })));
    expect(within(dialog).getByText(/ChatGPT／Codex 登入與 API 額度是分開的/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Google Cloud Translation API Key"), { target: { value: "AIza-ui-123456789012345678901234" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存 Google 後援" }));
    await waitFor(() => expect(api.updateTranslationSettings).toHaveBeenCalledWith({ googleCloudApiKey: "AIza-ui-123456789012345678901234" }));
  });

  it("generates AI subtitle drafts with synchronized evidence and exports only after confirmation", async () => {
    const draft = { id: "ai-draft", startMs: 500, endMs: 1_500, text: "我們抵達河內老城", origin: "AI_SPEECH" as const, reviewStatus: "CONFIRMED" as const, sourceAssetId: video.id, sourceInMs: 500, sourceOutMs: 1_500, speaker: "A", visualSummary: "主持人在街道步行", eventSummary: "抵達老城", peopleSummary: ["主持人"], locationSummary: ["河內老城"], topicRelevanceScore: 95, transcriptVisualMatchScore: 90, aiConfidence: 88, aiWarnings: ["街道名稱需人工確認"] };
    const generatedProject = { ...structuredClone(project), subtitleCues: [draft] };
    const api = mockApi(); vi.mocked(api.generateAiSubtitles).mockResolvedValue({ project: generatedProject, generatedCount: 1, transcribedCount: 1, visualOnlyCount: 0, skippedConfirmedCount: 0, accountName: "河內 OpenAI", analysisVersion: "openai-story-match-v1" });
    vi.mocked(api.setSubtitleCues).mockImplementation(async (cues) => ({ ...structuredClone(project), subtitleCues: cues }));
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    expect(within(dialog).getByRole("checkbox", { name: "同時分析素材語音" })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "AI 知識型字幕草稿" }));
    expect(api.generateAiSubtitles).toHaveBeenCalledWith({ includeSpeechTranscription: false, scopes: ["MAIN"] });
    expect((await within(dialog).findAllByText("我們抵達河內老城")).length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByText("抵達老城")).toBeInTheDocument();
    expect(within(dialog).getByText("河內老城")).toBeInTheDocument();
    expect(within(dialog).getByText("街道名稱需人工確認")).toBeInTheDocument();
    await waitFor(() => expect(api.ensurePreview).toHaveBeenCalledWith(video.id, "VIDEO_PROXY"));
    fireEvent.click(within(dialog).getByRole("button", { name: /確認時間、畫面與文字/ }));
    expect(within(dialog).getByRole("button", { name: /匯出 1 筆已確認 SRT/ })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存字幕" }));
    await waitFor(() => expect(api.setSubtitleCues).toHaveBeenCalledWith([expect.objectContaining({ id: "ai-draft", reviewStatus: "CONFIRMED" })]));
    fireEvent.click(within(dialog).getByRole("button", { name: /匯出 1 筆已確認 SRT/ }));
    await waitFor(() => expect(api.exportSubtitles).toHaveBeenCalledWith("srt-token", ["MAIN"]));
  });

  it("targets Intro subtitles, builds a 480P synchronized preview, and persists overlay styling", async () => {
    const segment = { id: "subtitle-intro", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["人物事件"] };
    const introCue = { id: "intro-ai", startMs: 0, endMs: 2_000, text: "河內人物故事開場", timelineScope: "INTRO" as const, origin: "AI_VISUAL" as const, reviewStatus: "CONFIRMED" as const, sourceAssetId: video.id, sourceInMs: 0, sourceOutMs: 2_000 };
    const introProject = { ...structuredClone(project), introSegments: [segment], introTargetDurationMs: 3_000 };
    const generatedProject = { ...structuredClone(introProject), subtitleCues: [introCue] };
    const api = mockApi(introProject); vi.mocked(api.generateAiSubtitles).mockResolvedValue({ project: generatedProject, generatedCount: 1, transcribedCount: 0, visualOnlyCount: 1, skippedConfirmedCount: 0, accountName: "河內 OpenAI", analysisVersion: "openai-story-match-v1" });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "片頭字幕" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "正片字幕" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "AI 知識型字幕草稿" }));
    await waitFor(() => expect(api.generateAiSubtitles).toHaveBeenCalledWith({ includeSpeechTranscription: false, scopes: ["INTRO"] }));
    await waitFor(() => expect(api.buildSubtitleIntroPreview).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByLabelText("480P 片頭字幕同步預覽")).toHaveAttribute("src", expect.stringMatching(/^preview-media:\/\/subtitle\//));
    expect((await within(dialog).findAllByText("河內人物故事開場")).length).toBeGreaterThanOrEqual(2);
    fireEvent.change(within(dialog).getByLabelText("字幕高低位置"), { target: { value: "70" } });
    fireEvent.change(within(dialog).getByLabelText("字幕文字大小"), { target: { value: "36" } });
    fireEvent.change(within(dialog).getByLabelText("字幕文字顏色"), { target: { value: "#ffe066" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "字幕陰影" }));
    fireEvent.change(within(dialog).getByLabelText("字幕外框寬度"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "儲存顯示格式" }));
    await waitFor(() => expect(api.updateUserPreferences).toHaveBeenCalledWith({ subtitlePreviewStyle: { verticalPositionPercent: 70, fontSizePx: 36, textColor: "#FFE066", shadowEnabled: false, outlineWidthPx: 3 } }));
  });

  it("deletes the selected subtitle with Delete and persists the removal", async () => {
    const cue = { id: "delete-me", startMs: 0, endMs: 2_000, text: "可刪除字幕", timelineScope: "MAIN" as const, origin: "MANUAL" as const, reviewStatus: "CONFIRMED" as const };
    const api = mockApi({ ...structuredClone(project), subtitleCues: [cue] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    expect(within(dialog).getAllByText("可刪除字幕").length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(api.setSubtitleCues).toHaveBeenCalledWith([]));
    expect(await within(dialog).findByText(/已刪除該筆字幕並保存/)).toBeInTheDocument();
  });

  it("supports Shift range selection, batch unconfirm, and batch delete", async () => {
    const cues = [
      { id: "range-1", startMs: 0, endMs: 500, text: "第一筆", timelineScope: "MAIN" as const, origin: "MANUAL" as const, reviewStatus: "CONFIRMED" as const },
      { id: "range-2", startMs: 600, endMs: 1_100, text: "第二筆", timelineScope: "MAIN" as const, origin: "MANUAL" as const, reviewStatus: "CONFIRMED" as const },
      { id: "range-3", startMs: 1_200, endMs: 1_700, text: "第三筆", timelineScope: "MAIN" as const, origin: "MANUAL" as const, reviewStatus: "CONFIRMED" as const },
    ];
    const api = mockApi({ ...structuredClone(project), subtitleCues: cues });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.setSubtitleCues).mockImplementation(async (next) => ({ ...structuredClone(project), subtitleCues: next }));
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    const first = within(dialog).getByRole("button", { name: /第一筆/ });
    const third = within(dialog).getByRole("button", { name: /第三筆/ });
    fireEvent.click(first);
    fireEvent.click(third, { shiftKey: true });
    expect(within(dialog).getByRole("toolbar", { name: "字幕批次操作" })).toHaveTextContent("已選 3 筆");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消確認" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存字幕" }));
    await waitFor(() => expect(api.setSubtitleCues).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "range-1", reviewStatus: "DRAFT" }), expect.objectContaining({ id: "range-2", reviewStatus: "DRAFT" }), expect.objectContaining({ id: "range-3", reviewStatus: "DRAFT" }),
    ])));
    fireEvent.click(within(dialog).getByRole("button", { name: "刪除選取" }));
    await waitFor(() => expect(api.setSubtitleCues).toHaveBeenCalledWith([]));
  });

  it("makes an exhausted API project unmistakable and explains why local Intro selection could still work", async () => {
    const segment = { id: "local-only-intro", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["本機候選"], analysisMode: "LOCAL_SIGNAL_ONLY" as const };
    const introProject = { ...structuredClone(project), introSegments: [segment] };
    const api = mockApi(introProject);
    vi.mocked(api.generateAiSubtitles).mockRejectedValue(new Error("AI 字幕尚未開始分析，因為目前帳號無法實際呼叫故事模型：這把 Key 所屬的 OpenAI API project 沒有可用 API 額度。（代碼 credit_balance_exhausted；Request ID req_test_quota）"));
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "片頭字幕" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "正片字幕" }));
    expect(within(dialog).getByText(/其中 0 段曾完成 OpenAI/)).toHaveTextContent("本機畫面統計備援");
    fireEvent.click(within(dialog).getByRole("button", { name: "AI 知識型字幕草稿" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("AI 字幕沒有產出");
    expect(alert).toHaveTextContent("credit_balance_exhausted");
    expect(alert).toHaveTextContent("片頭代理成功只代表本機 MP4 已完成");
    expect(within(alert).getByRole("button", { name: "開啟 AI 帳號設定" })).toBeEnabled();
  });

  it("imports an SRT and keeps every cue editable by time and text", async () => {
    const imported = [
      { id: "srt-1", startMs: 1_000, endMs: 3_000, text: "森林步道", origin: "IMPORTED_SRT" as const, reviewStatus: "CONFIRMED" as const },
      { id: "srt-2", startMs: 4_000, endMs: 6_000, text: "環境養護", origin: "IMPORTED_SRT" as const, reviewStatus: "CONFIRMED" as const },
    ];
    const api = mockApi();
    vi.mocked(api.chooseSubtitleInput).mockResolvedValue({ filePath: "C:\\字幕\\森林.srt", fileName: "森林.srt", cues: imported });
    vi.mocked(api.setSubtitleCues).mockResolvedValue({ ...structuredClone(project), subtitleCues: imported });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    fireEvent.click(within(dialog).getByRole("button", { name: /匯入 SRT/ }));
    await waitFor(() => expect(api.chooseSubtitleInput).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText(/已匯入 森林.srt 的 2 筆字幕/)).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("森林步道")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByDisplayValue("森林步道"), { target: { value: "森林步道與生態養護" } });
    expect(within(dialog).getByDisplayValue("森林步道與生態養護")).toBeInTheDocument();
    expect(within(dialog).getAllByText("匯入 SRT")).toHaveLength(2);
  });

  it("forces every non-rejected subtitle back to draft after a timeline revision", async () => {
    const reviewProject = { ...structuredClone(project), subtitleCues: [{ id: "old", startMs: 0, endMs: 1_000, text: "舊時間字幕", origin: "MANUAL" as const, reviewStatus: "CONFIRMED" as const }], subtitleTimelineRevision: 0, timelineRevision: 2 };
    const api = mockApi(reviewProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /CC 字幕/ }));
    const dialog = await screen.findByRole("dialog", { name: "AI 字幕審核與 SRT" });
    expect(within(dialog).getByText(/全部字幕時間需要重新複核/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /匯出 0 筆已確認 SRT/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /確認時間、畫面與文字/ }));
    expect(within(dialog).getByRole("button", { name: /匯出 1 筆已確認 SRT/ })).toBeEnabled();
  });

  it("uses the read-only original for an Intro loop first and offers a short proxy only after a codec error", async () => {
    const segment = { id: "original-loop", assetId: video.id, fileName: video.fileName, inMs: 2_000, outMs: 5_000, score: 80, reasons: ["事件"] };
    const introProject = { ...structuredClone(project), introSegments: [segment] };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    const player = await within(studio).findByLabelText(`片頭素材預覽 ${video.fileName}`);
    expect(player).toHaveAttribute("src", `source-media://asset/${video.id}?key=${video.previewCacheKey}`);
    expect(within(studio).getByRole("radio", { name: "整體循環" })).toBeChecked();
    expect(within(studio).getByText("原始素材 · 唯讀播放 · 整體循環")).toBeInTheDocument();
    expect(api.ensureClipPreview).not.toHaveBeenCalled();
    fireEvent.play(player);
    await waitFor(() => expect(within(studio).getByRole("button", { name: /暫停/ })).toBeInTheDocument());
    fireEvent.timeUpdate(player, { target: { currentTime: 5 } });
    expect((player as HTMLVideoElement).currentTime).toBe(2);
    fireEvent.error(player);
    fireEvent.click(await within(studio).findByRole("button", { name: "改用快速短代理" }));
    await waitFor(() => expect(api.ensureClipPreview).toHaveBeenCalledWith(video.id, 2_000, 5_000));
    expect(await within(studio).findByText("快速短代理 · fallback · 整體循環")).toBeInTheDocument();
  });

  it("plays every Intro segment in order, wraps after the last, and offers single-segment looping", async () => {
    const first = { id: "loop-first", assetId: video.id, fileName: video.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["人物"] };
    const second = { id: "loop-second", assetId: secondVideo.id, fileName: secondVideo.fileName, inMs: 1_000, outMs: 4_000, score: 85, reasons: ["事件"] };
    const introProject = { ...structuredClone(project), sources: [video, secondVideo], timelineOrder: [video.id, secondVideo.id], introSegments: [first, second] };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    expect(within(studio).getByRole("radio", { name: "整體循環" })).toBeChecked();
    const firstPlayer = await within(studio).findByLabelText(`片頭素材預覽 ${video.fileName}`);
    fireEvent.play(firstPlayer);
    await waitFor(() => expect(within(studio).getByRole("button", { name: /暫停/ })).toBeInTheDocument());
    fireEvent.timeUpdate(firstPlayer, { target: { currentTime: 3 } });
    const secondPlayer = await within(studio).findByLabelText(`片頭素材預覽 ${secondVideo.fileName}`);
    fireEvent.play(secondPlayer);
    await waitFor(() => expect(within(studio).getByRole("button", { name: /暫停/ })).toBeInTheDocument());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)); });
    fireEvent.timeUpdate(secondPlayer, { target: { currentTime: 4 } });
    expect(await within(studio).findByLabelText(`片頭素材預覽 ${video.fileName}`)).toBeInTheDocument();
    fireEvent.click(within(studio).getByRole("radio", { name: "單段循環" }));
    expect(within(studio).getByText("原始素材 · 唯讀播放 · 單段循環")).toBeInTheDocument();
  });

  it("shows a red warning above three minutes without blocking Intro output", async () => {
    const longVideo = { ...structuredClone(video), mediaInfo: { ...video.mediaInfo!, durationMs: 60_000 } };
    const segments = Array.from({ length: 9 }, (_, index) => ({ id: `long-${index}`, assetId: longVideo.id, fileName: longVideo.fileName, inMs: 0, outMs: 22_000, score: 80, reasons: ["測試"] }));
    const longIntroProject = { ...structuredClone(project), sources: [longVideo], introSegments: segments, introTargetDurationMs: 240_000, introSegmentMaxDurationMs: 22_000 };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: mockApi(longIntroProject) }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    expect(within(studio).getByRole("alert")).toHaveTextContent("已超過 3 分鐘，仍可繼續使用");
    expect(within(studio).getByRole("button", { name: "產出 Intro 預覽" })).toBeEnabled();
    expect(studio.querySelector(".is-duration-warning")).not.toBeNull();
  });

  it("keeps an over-limit Intro review range, warns in orange, and confirms a capped output", async () => {
    const longVideo = { ...structuredClone(video), mediaInfo: { ...video.mediaInfo!, durationMs: 40_000 } };
    const segment = { id: "over-limit-review", assetId: longVideo.id, fileName: longVideo.fileName, inMs: 2_000, outMs: 20_000, score: 88, reasons: ["人物事件"] };
    const introProject = { ...structuredClone(project), sources: [longVideo], introSegments: [segment], introSegmentMaxDurationMs: 12_000 };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: mockApi(introProject) }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 精彩片頭/ }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    expect(within(studio).getByText(/目前檢看片段為 0:18/)).toBeInTheDocument();
    expect(studio.querySelector(".is-over-duration-limit")).not.toBeNull();
    fireEvent.click(within(studio).getByRole("button", { name: "產出 Intro 預覽" }));
    const warning = await screen.findByRole("alertdialog", { name: "有片段超過每段輸出上限" });
    expect(within(warning).getByText((_text, element) => element?.tagName === "P" && Boolean(element.textContent?.includes("保留所選 IN 起點")))).toBeInTheDocument();
    expect(within(warning).getByRole("button", { name: "返回調整" })).toHaveFocus();
    fireEvent.click(within(warning).getByRole("button", { name: /是，以 0:12 上限產出/ }));
    const output = await screen.findByRole("dialog", { name: "產出 Intro 預覽" });
    expect(within(output).getByText(/有 1 段檢看片段超時/)).toBeInTheDocument();
    expect(within(output).getByText("0:02 → 0:14")).toBeInTheDocument();
  });

  it("saves the recommended zoom enhancement, inserts its range at the chosen Intro rank, and opens 4K output", async () => {
    const existing = { id: "existing-intro", assetId: video.id, fileName: video.fileName, inMs: 6_000, outMs: 9_000, score: 70, reasons: ["既有"] };
    const introProject = { ...structuredClone(project), introSegments: [existing], introTargetDurationMs: 180_000 };
    const api = mockApi(introProject); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "刪除／排除部分片段" }));
    const dialog = await screen.findByRole("dialog", { name: `預覽 ${video.fileName}` });
    fireEvent.click(within(dialog).getByRole("button", { name: /新增片段時段/ }));
    expect(within(dialog).getByLabelText("局部放大 1 畫質優化")).toHaveValue("BALANCED");
    fireEvent.change(within(dialog).getByLabelText("局部放大 1 畫質優化"), { target: { value: "DETAIL" } });
    expect(within(dialog).getByRole("checkbox", { name: /儲存後直接加入片頭/ })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("加入片頭順位"), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /儲存後開啟此時段的 4K MP4/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存片段設定" }));
    await waitFor(() => expect(api.setZoomSegments).toHaveBeenCalledWith(video.id, [expect.objectContaining({ enhancementPreset: "DETAIL", startMs: 0, endMs: 3_000 })]));
    await waitFor(() => expect(api.setIntroTargetDuration).toHaveBeenCalledWith(183_000));
    await waitFor(() => expect(api.setIntroSegments).toHaveBeenCalledWith([expect.objectContaining({ inMs: 0, outMs: 3_000, origin: "MANUAL" }), expect.objectContaining({ id: existing.id })]));
    expect(vi.mocked(api.setIntroTargetDuration).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.setIntroSegments).mock.invocationCallOrder[0]);
    const added = await screen.findByRole("dialog", { name: "片頭片段加入成功" });
    expect(added).toHaveTextContent("已加入片頭第 1 順位");
    expect(added).toHaveTextContent("片頭時間上限同步調整為 3:03");
    expect(await screen.findByRole("dialog", { name: "輸出最高 4K 時間段" })).toBeInTheDocument();
    fireEvent.click(within(added).getByRole("button", { name: "前往片頭確認" }));
    const studio = await screen.findByRole("dialog", { name: "AI 精彩片頭建議" });
    expect(within(studio).getAllByRole("button", { name: /從片頭移除/ })).toHaveLength(2);
  });

  it("shows a friendly second close confirmation and defaults focus to continuing", async () => {
    const api = mockApi(); Object.defineProperty(window, "sourceApp", { configurable: true, value: api }); render(<App />);
    await screen.findByText("素材清單");
    const callback = vi.mocked(api.onAppCloseRequested).mock.calls[0][0];
    act(() => callback());
    const dialog = screen.getByRole("dialog", { name: "再次確認關閉軟體" });
    expect(within(dialog).getByRole("button", { name: "繼續剪輯" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "確定關閉" }));
    expect(api.confirmAppClose).toHaveBeenCalledTimes(1);
  });
});
