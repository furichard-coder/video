import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceAsset } from "../src/shared/domain";
import { ProjectStore } from "../src/main/services/project-store";
import { mainRenderSelections, retainedRangesForAsset } from "../src/shared/editing-rules";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-app-store-"));
  tempRoots.push(root);
  return root;
}

function asset(sourcePath: string, idChar = "a"): SourceAsset {
  return {
    id: idChar.repeat(64),
    sourcePath,
    sourceIdentity: "b".repeat(64),
    fileName: path.basename(sourcePath),
    extension: ".mp4",
    kind: "VIDEO",
    sizeBytes: 4,
    fileCreatedAt: "2026-01-01T00:00:00.000Z",
    fileModifiedAt: "2026-01-01T00:00:00.000Z",
    addedAt: "2026-01-01T00:00:00.000Z",
    addedOrder: 0,
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewCacheKey: "c".repeat(64),
    metadataState: "PENDING",
  };
}

function photo(sourcePath: string, idChar = "p"): SourceAsset {
  return { ...asset(sourcePath, idChar), fileName: path.basename(sourcePath), extension: ".jpg", kind: "IMAGE", mediaInfo: { width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, isPortrait: true }, metadataState: "READY" };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectStore", () => {
  it("undoes and redoes project-only changes while never deleting source files", async () => {
    const root = await tempRoot(); const sourcePath = path.join(root, "復原來源.mp4"); await writeFile(sourcePath, "irreplaceable-source");
    const store = new ProjectStore(path.join(root, "app-data")); await store.initialize();
    await store.addAssets([asset(sourcePath)]);
    expect(store.getHistoryState()).toMatchObject({ canUndo: true, canRedo: false });
    expect((await store.undo()).sources).toHaveLength(0);
    expect(await readFile(sourcePath, "utf8")).toBe("irreplaceable-source");
    expect(store.getHistoryState()).toMatchObject({ canUndo: false, canRedo: true });
    expect((await store.redo()).sources).toHaveLength(1);
    await store.setSortMode("FILE_NAME");
    expect(store.getHistoryState().canRedo).toBe(false);
    expect(await readFile(sourcePath, "utf8")).toBe("irreplaceable-source");
  });

  it("persists and restores the source manifest", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source.mp4");
    await writeFile(sourcePath, "safe");
    const store = new ProjectStore(root);
    await store.initialize();
    await store.addAssets([asset(sourcePath)]);
    await store.setSortMode("FILE_NAME");

    const restored = new ProjectStore(root);
    const project = await restored.initialize();
    expect(project.sortMode).toBe("FILE_NAME");
    expect(project.sources).toHaveLength(1);
    expect(project.sources[0].sourcePolicy).toBe("READ_ONLY");
  });

  it("persists the last AI music suggestions with the project and restores them after reopen", async () => {
    const dataRoot = path.join(await tempRoot(), "app-data");
    const store = new ProjectStore(dataRoot); await store.initialize();
    const result = {
      provider: "OPENAI_API" as const,
      accountName: "測試 OpenAI",
      generatedAt: "2026-09-08T12:00:00.000Z",
      topicSummary: "河內旅行｜城市步行",
      suggestions: [1, 2, 3].map((index) => ({ id: `music-${index}`, platform: "YOUTUBE" as const, title: `曲目 ${index}`, artist: "測試作者", reason: "適合城市步行", auditionUrl: `https://www.youtube.com/watch?v=music${index}`, evidenceUrl: `https://www.youtube.com/watch?v=music${index}`, rightsStatus: "REVIEW_REQUIRED" as const })),
      royaltyFreeOnly: false,
      warnings: ["逐首確認授權"],
    };
    await store.setMusicSuggestionResult(result);
    expect((await new ProjectStore(dataRoot).initialize()).musicSuggestionResult).toEqual(result);
  });

  it("removes only the main reference, preserves settings, and never deletes the source", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source.mp4");
    await writeFile(sourcePath, "safe");
    const store = new ProjectStore(path.join(root, "app-data"));
    await store.initialize();
    const source = { ...asset(sourcePath), metadataState: "READY" as const, mediaInfo: { durationMs: 5_000 }, volumeSegments: [{ id: "gain", startMs: 100, endMs: 500, volumePercent: 120 }] };
    await store.addAssets([source]);
    const removed = await store.removeMainAsset(source.id);

    expect(removed.sources).toHaveLength(1);
    expect(removed.sources[0].volumeSegments).toHaveLength(1);
    expect(removed.timelineOrder).toEqual([]);
    expect(removed.excludedMainAssetIds).toEqual([source.id]);
    expect(removed.timelineRevision).toBeGreaterThan(removed.subtitleTimelineRevision);
    expect(await readFile(sourcePath, "utf8")).toBe("safe");
    const removedReopen = new ProjectStore(path.join(root, "app-data"));
    const persistedRemoval = await removedReopen.initialize();
    expect(persistedRemoval.timelineOrder).toEqual([]); expect(persistedRemoval.recentMainRemovals[0].assetId).toBe(source.id);
    const restored = await store.restoreMainAsset(source.id);
    expect(restored.timelineOrder).toEqual([source.id]);
    expect(restored.sources[0].volumeSegments).toHaveLength(1);
    const reopened = new ProjectStore(path.join(root, "app-data"));
    expect((await reopened.initialize()).timelineOrder).toEqual([source.id]);
  });

  it("persists preview IN/OUT only in the manifest", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source.mp4");
    await writeFile(sourcePath, "safe");
    const store = new ProjectStore(path.join(root, "app-data"));
    await store.initialize();
    await store.addAssets([{ ...asset(sourcePath), metadataState: "READY", mediaInfo: { durationMs: 10_000 } }]);
    const updated = await store.setPreviewRange("a".repeat(64), 1_500, 8_500);

    expect(updated.asset.previewRange).toEqual({ inMs: 1_500, outMs: 8_500 });
    const restored = new ProjectStore(path.join(root, "app-data"));
    await restored.initialize();
    expect(restored.getProject().sources[0].previewRange).toEqual({ inMs: 1_500, outMs: 8_500 });
    expect(await readFile(sourcePath, "utf8")).toBe("safe");
  });

  it("defaults photos to five seconds, persists three-to-seven-second changes, and never changes source bytes", async () => {
    const root = await tempRoot(); const sourcePath = path.join(root, "直式照片.jpg");
    await writeFile(sourcePath, "safe-photo");
    const store = new ProjectStore(path.join(root, "app-data")); await store.initialize();
    let project = await store.addAssets([photo(sourcePath)]);
    expect(project.sources[0].imageDurationMs).toBe(5_000);
    const revision = project.timelineRevision;
    project = (await store.setImageDuration(project.sources[0].id, 7_000)).project;
    expect(project.sources[0].imageDurationMs).toBe(7_000);
    expect(project.timelineRevision).toBe(revision + 1);
    await expect(store.setImageDuration(project.sources[0].id, 2_999)).rejects.toThrow(/3 秒到 7 秒/);
    await expect(store.setImageDuration(project.sources[0].id, 7_001)).rejects.toThrow(/3 秒到 7 秒/);
    expect((await new ProjectStore(path.join(root, "app-data")).initialize()).sources[0].imageDurationMs).toBe(7_000);
    expect(await readFile(sourcePath, "utf8")).toBe("safe-photo");
  });

  it("saves a named complete project file, keeps it current, and restores the active project on reopen", async () => {
    const root = await tempRoot(); const dataRoot = path.join(root, "app-data"); const projectPath = path.join(root, "我的 河內專案.swproj");
    const store = new ProjectStore(dataRoot); await store.initialize();
    await store.addAssets([asset(path.join(root, "clip.mp4")), photo(path.join(root, "photo.jpg"))]);
    const saved = await store.saveProjectAs(projectPath, "我的 河內專案");
    expect(saved.filePath).toBe(path.resolve(projectPath));
    expect(saved.project.name).toBe("我的 河內專案");
    await store.setSortMode("FILE_NAME");
    const external = JSON.parse(await readFile(projectPath, "utf8"));
    expect(external).toMatchObject({ schemaVersion: 15, name: "我的 河內專案", sortMode: "FILE_NAME", sourcePolicy: "READ_ONLY", sourceAudioVolumePercent: 100, introSegmentMaxDurationMs: 15_000 });
    expect(external.sources).toHaveLength(2);
    expect((await readdir(root)).filter((name) => name.includes(".partial"))).toEqual([]);

    const reopened = new ProjectStore(dataRoot); const restored = await reopened.initialize();
    expect(restored).toMatchObject({ id: saved.project.id, name: "我的 河內專案", sortMode: "FILE_NAME" });
    expect(reopened.getProjectFileState().filePath).toBe(path.resolve(projectPath));
  });

  it("opens an explicitly selected old project and leaves the current project unchanged when the file is invalid", async () => {
    const root = await tempRoot(); const store = new ProjectStore(path.join(root, "app-data")); await store.initialize();
    await store.addAssets([asset(path.join(root, "current.mp4"))]);
    const oldPath = path.join(root, "舊專案.swproj");
    const oldProject = { ...store.getProject(), id: "old-project", name: "舊專案", sources: [photo(path.join(root, "old.jpg"), "o")], timelineOrder: ["o".repeat(64)], pendingAssetIds: [] };
    await writeFile(oldPath, JSON.stringify(oldProject), "utf8");
    const opened = await store.openProject(oldPath);
    expect(opened.project).toMatchObject({ id: "old-project", name: "舊專案" });
    expect(opened.project.sources[0].imageDurationMs).toBe(5_000);

    const invalidPath = path.join(root, "損壞.swproj"); const invalidBytes = "{\"schemaVersion\":999,\"important\":true}";
    await writeFile(invalidPath, invalidBytes, "utf8");
    await expect(store.openProject(invalidPath)).rejects.toThrow(/不相容/);
    expect(store.getProject().id).toBe("old-project");
    expect(await readFile(invalidPath, "utf8")).toBe(invalidBytes);
  });

  it("migrates a v0.4 schema-1 manifest without losing sources", async () => {
    const root = await tempRoot();
    const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const legacy = {
      schemaVersion: 1, id: "legacy", name: "舊專案", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
      previewerVersion: "preview-v1", sortMode: "ADDED_ORDER", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      sources: [asset(path.join(root, "舊 來源.mp4"))],
    };
    await writeFile(manifestPath, JSON.stringify(legacy), "utf8");
    const store = new ProjectStore(root);
    const migrated = await store.initialize();
    expect(migrated.schemaVersion).toBe(15);
    expect(migrated.sources).toHaveLength(1);
    expect(migrated.timelineOrder).toEqual([legacy.sources[0].id]);
    expect(migrated.sources[0].volumeSegments).toEqual([]);
    expect(migrated.sources[0].mainExclusionRanges).toEqual([]);
    expect(migrated.excludedMainAssetIds).toEqual([]);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).schemaVersion).toBe(15);
  });

  it("migrates schema 2 to schema 10 and preserves every existing edit field", async () => {
    const root = await tempRoot(); const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const source = { ...asset(path.join(root, "schema2.mp4")), volumeSegments: [{ id: "gain", startMs: 0, endMs: 500, volumePercent: 120 }] };
    const schema2 = {
      schemaVersion: 2, id: "schema2", name: "既有專案", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewerVersion: "preview-v1",
      sortMode: "MANUAL_ORDER", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sources: [source], timelineOrder: [source.id], pendingAssetIds: [],
      placementDecisions: [{ assetId: source.id, action: "END", decidedAt: "2026-01-01T00:00:00.000Z" }], bgmTracks: [], subtitleCues: [], timelineRevision: 4, subtitleTimelineRevision: 4, audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
    };
    await writeFile(manifestPath, JSON.stringify(schema2), "utf8");
    const migrated = await new ProjectStore(root).initialize();
    expect(migrated).toMatchObject({ schemaVersion: 15, timelineOrder: [source.id], timelineRevision: 4, subtitleTimelineRevision: 4, sourceAudioVolumePercent: 100, mainTimelineRevision: 4, introTimelineRevision: 4, mainSubtitleReviewRevision: 4, introSubtitleReviewRevision: 4, introTargetDurationMs: 90_000, introSegmentMaxDurationMs: 15_000, colorSettings: { introPresetId: "NATURAL", applyToMain: false } });
    expect(migrated.sources[0].volumeSegments).toEqual(source.volumeSegments);
    expect(migrated.sources[0].mainExclusionRanges).toEqual([]);
    expect(migrated.introSegments).toEqual([]); expect(migrated.recentMainRemovals).toEqual([]);
  });

  it("migrates a schema-3 photo to the current schema with the five-second and shutter defaults", async () => {
    const root = await tempRoot(); const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const legacyPhoto = photo(path.join(root, "legacy-photo.jpg")); delete legacyPhoto.imageDurationMs;
    const schema3 = {
      schemaVersion: 3, id: "schema3-photo", name: "舊照片專案", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewerVersion: "preview-v1",
      sortMode: "MANUAL_ORDER", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sources: [legacyPhoto], timelineOrder: [legacyPhoto.id], pendingAssetIds: [],
      excludedMainAssetIds: [], recentMainRemovals: [], introSegments: [], introExcludedSegmentIds: [], recentIntroRemovals: [], placementDecisions: [], bgmTracks: [], subtitleCues: [], timelineRevision: 1, subtitleTimelineRevision: 1, audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
    };
    await writeFile(manifestPath, JSON.stringify(schema3), "utf8");
    const migrated = await new ProjectStore(root).initialize();
    expect(migrated.schemaVersion).toBe(15);
    expect(migrated.sources[0].imageDurationMs).toBe(5_000);
    expect(migrated.sources[0].photoSoundEnabled).toBe(true);
    expect(migrated.mediaInsertions).toEqual([]);
    expect(migrated.photoSoundEffect.id).toBe("DUNES_CAMERA_SHUTTER_CLICK_14671");
  });

  it("migrates schema 5 to current schema without losing legacy subtitles", async () => {
    const root = await tempRoot(); const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const source = { ...asset(path.join(root, "legacy-ai.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 3_000 } };
    const schema5 = {
      schemaVersion: 5, id: "schema5", name: "舊字幕專案", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewerVersion: "preview-v1",
      sortMode: "MANUAL_ORDER", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sources: [source], timelineOrder: [source.id], pendingAssetIds: [],
      excludedMainAssetIds: [], recentMainRemovals: [], introSegments: [], introExcludedSegmentIds: [], recentIntroRemovals: [], placementDecisions: [], photoInsertions: [], bgmTracks: [],
      subtitleCues: [{ id: "legacy-cue", startMs: 0, endMs: 1_000, text: "既有字幕" }], timelineRevision: 2, subtitleTimelineRevision: 2, audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
    };
    await writeFile(manifestPath, JSON.stringify(schema5), "utf8");
    const migrated = await new ProjectStore(root).initialize();
    expect(migrated.schemaVersion).toBe(15);
    expect(migrated.aiStoryContext).toEqual({ topic: "", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh" });
    expect(migrated.subtitleCues).toEqual([expect.objectContaining({ id: "legacy-cue", text: "既有字幕", origin: "MANUAL", reviewStatus: "CONFIRMED" })]);
  });

  it("migrates schema 10 while preserving an existing Intro segment longer than the new 15-second default", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "legacy-intro.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 60_000 } };
    await store.addAssets([source]);
    await store.setIntroSegmentMaxDuration(22_000);
    await store.setIntroSegments([{ id: "legacy-20", assetId: source.id, fileName: source.fileName, inMs: 5_000, outMs: 25_000, score: 60, reasons: ["舊片頭"] }]);
    const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    raw.schemaVersion = 10; delete raw.introSegmentMaxDurationMs;
    await writeFile(manifestPath, JSON.stringify(raw), "utf8");
    const migrated = await new ProjectStore(root).initialize();
    expect(migrated.schemaVersion).toBe(15);
    expect(migrated.introSegmentMaxDurationMs).toBe(20_000);
    expect(migrated.introSegments[0]).toMatchObject({ inMs: 5_000, outMs: 25_000 });
  });

  it("rejects an unknown schema without overwriting the manifest", async () => {
    const root = await tempRoot(); const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const raw = JSON.stringify({ schemaVersion: 999, sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", sources: [{ irreplaceable: true }] });
    await writeFile(manifestPath, raw, "utf8");
    await expect(new ProjectStore(root).initialize()).rejects.toThrow(/schema 不相容/);
    expect(await readFile(manifestPath, "utf8")).toBe(raw);
  });

  it("validates volume automation and clips it explicitly when IN/OUT shrinks", async () => {
    const root = await tempRoot();
    const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "audio.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 10_000, audioCodec: "aac" } };
    await store.addAssets([source]);
    const updated = await store.setVolumeSegments(source.id, [
      { id: "mute", startMs: 1_000, endMs: 2_000, volumePercent: 0 },
      { id: "normal", startMs: 2_000, endMs: 3_000, volumePercent: 100 },
      { id: "boost", startMs: 5_000, endMs: 9_000, volumePercent: 200 },
    ]);
    expect(updated.volumeSegments?.map((segment) => segment.volumePercent)).toEqual([0, 100, 200]);
    await expect(store.setVolumeSegments(source.id, [{ id: "bad", startMs: 0, endMs: 1000, volumePercent: 301 }])).rejects.toThrow(/0% 到 300%/);
    await expect(store.setVolumeSegments(source.id, [{ id: "one", startMs: 0, endMs: 2000, volumePercent: 100 }, { id: "two", startMs: 1900, endMs: 3000, volumePercent: 100 }])).rejects.toThrow(/不可重疊/);
    const clipped = await store.setPreviewRange(source.id, 1_500, 7_000);
    expect(clipped.adjustedVolumeSegmentCount).toBe(2);
    expect(clipped.asset.volumeSegments).toEqual([
      { id: "mute", startMs: 1_500, endMs: 2_000, volumePercent: 0 },
      { id: "normal", startMs: 2_000, endMs: 3_000, volumePercent: 100 },
      { id: "boost", startMs: 5_000, endMs: 7_000, volumePercent: 200 },
    ]);
  });

  it("persists local zoom settings and safely clips them when IN/OUT shrinks", async () => {
    const root = await tempRoot();
    const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "zoom.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 10_000, videoCodec: "h264" } };
    await store.addAssets([source]);
    const saved = await store.setZoomSegments(source.id, [
      { id: "wide", startMs: 1_000, endMs: 3_000, zoomPercent: 125, centerXPercent: 25, centerYPercent: 75 },
      { id: "detail", startMs: 6_000, endMs: 9_000, zoomPercent: 300, centerXPercent: 60, centerYPercent: 40 },
    ]);
    expect(saved.asset.zoomSegments).toHaveLength(2);
    expect(saved.project.subtitleTimelineRevision).not.toBe(saved.project.timelineRevision);
    await expect(store.setZoomSegments(source.id, [{ id: "bad", startMs: 0, endMs: 1_000, zoomPercent: 401, centerXPercent: 50, centerYPercent: 50 }])).rejects.toThrow(/100% 到 400%/);
    const clipped = await store.setPreviewRange(source.id, 2_000, 8_000);
    expect(clipped.adjustedZoomSegmentCount).toBe(2);
    expect(clipped.asset.zoomSegments).toEqual([
      { id: "wide", startMs: 2_000, endMs: 3_000, zoomPercent: 125, centerXPercent: 25, centerYPercent: 75, enhancementPreset: "BALANCED" },
      { id: "detail", startMs: 6_000, endMs: 8_000, zoomPercent: 300, centerXPercent: 60, centerYPercent: 40, enhancementPreset: "BALANCED" },
    ]);
    const reopened = new ProjectStore(root); const restored = await reopened.initialize();
    expect(restored.schemaVersion).toBe(15);
    expect(restored.sources[0].zoomSegments).toEqual(clipped.asset.zoomSegments);
  });

  it("places supplemental assets one by one and persists manual reordering", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const a = asset(path.join(root, "a.mp4"), "a"); const b = asset(path.join(root, "b.mp4"), "b"); const c = asset(path.join(root, "c.mp4"), "c");
    await store.addAssets([a]);
    let project = await store.addAssets([b, c]);
    expect(project.timelineOrder).toEqual([a.id]); expect(project.pendingAssetIds).toEqual([b.id, c.id]);
    project = await store.placeAsset(b.id, { action: "AFTER", anchorAssetId: a.id });
    project = await store.placeAsset(c.id, { action: "BEFORE", anchorAssetId: b.id });
    expect(project.timelineOrder).toEqual([a.id, c.id, b.id]);
    project = await store.moveTimelineAsset(b.id, 0);
    expect(project.timelineOrder).toEqual([b.id, a.id, c.id]); expect(project.sortMode).toBe("MANUAL_ORDER");
    const restored = new ProjectStore(root); expect((await restored.initialize()).timelineOrder).toEqual([b.id, a.id, c.id]);
  });

  it("marks saved subtitles for review after timeline or trim changes", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "source.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 5_000 } };
    await store.addAssets([source]);
    let project = await store.setSubtitleCues([{ id: "cue", startMs: 0, endMs: 1000, text: "字幕" }]);
    expect(project.subtitleTimelineRevision).toBe(project.timelineRevision);
    project = (await store.setPreviewRange(source.id, 0, 4_000)).project;
    expect(project.subtitleTimelineRevision).not.toBe(project.timelineRevision);
    await expect(store.setSubtitleCues([{ id: "late", startMs: 3500, endMs: 4500, text: "超出" }])).rejects.toThrow(/超出目前影片/);
  });

  it("keeps Intro and Main subtitle timebases independent", async () => {
    const root = await tempRoot(); const sourcePath = path.join(root, "subtitle-scopes.mp4"); await writeFile(sourcePath, "safe");
    const store = new ProjectStore(path.join(root, "app-data")); await store.initialize();
    const source = { ...asset(sourcePath), metadataState: "READY" as const, mediaInfo: { durationMs: 5_000 } };
    await store.addAssets([source]);
    await store.setIntroSegments([{ id: "subtitle-intro", assetId: source.id, fileName: source.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["事件"] }]);
    const updated = await store.setSubtitleCues([
      { id: "intro-cue", startMs: 0, endMs: 2_000, text: "片頭字幕", timelineScope: "INTRO" },
      { id: "main-cue", startMs: 0, endMs: 2_000, text: "正片字幕", timelineScope: "MAIN" },
    ]);
    expect(updated.subtitleCues.map((cue) => cue.timelineScope)).toEqual(["INTRO", "MAIN"]);
    await expect(store.setSubtitleCues([{ id: "late-intro", startMs: 2_000, endMs: 3_500, text: "超出片頭", timelineScope: "INTRO" }])).rejects.toThrow(/所選片頭/);
  });

  it("sorts and merges main exclusions, clips them after IN/OUT changes, and persists them", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "exclude.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 10_000 } };
    await store.addAssets([source]);
    const saved = await store.setMainExclusionRanges(source.id, [
      { id: "later", startMs: 4_000, endMs: 5_000 },
      { id: "first", startMs: 2_000, endMs: 3_000 },
      { id: "adjacent", startMs: 3_000, endMs: 4_000 },
      { id: "overlap", startMs: 4_500, endMs: 6_000 },
    ]);
    expect(saved.mergedRangeCount).toBe(3);
    expect(saved.asset.mainExclusionRanges).toEqual([{ id: "first", startMs: 2_000, endMs: 6_000 }]);
    expect(retainedRangesForAsset(saved.asset)).toEqual([{ inMs: 0, outMs: 2_000 }, { inMs: 6_000, outMs: 10_000 }]);
    const clipped = await store.setPreviewRange(source.id, 3_000, 5_000);
    expect(clipped.adjustedMainExclusionRangeCount).toBe(1);
    expect(clipped.asset.mainExclusionRanges).toEqual([{ id: "first", startMs: 3_000, endMs: 5_000 }]);
    expect(retainedRangesForAsset(clipped.asset)).toEqual([]);
    const reopened = new ProjectStore(root); const restored = await reopened.initialize();
    expect(restored.sources[0].mainExclusionRanges).toEqual([{ id: "first", startMs: 3_000, endMs: 5_000 }]);
    await expect(store.setMainExclusionRanges(source.id, [{ id: "bad", startMs: 2_000, endMs: 4_000 }])).rejects.toThrow(/目前 IN／OUT/);
  });

  it("keeps Main and Intro references independent and only restores an explicitly removed segment", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "intro.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 8_000 } };
    await store.addAssets([source]);
    const first = { id: "intro-1", assetId: source.id, fileName: source.fileName, inMs: 0, outMs: 3_000, score: 80, reasons: ["測試"], origin: "AI" as const };
    const second = { id: "intro-2", assetId: source.id, fileName: source.fileName, inMs: 4_000, outMs: 7_000, score: 75, reasons: ["測試"], origin: "AI" as const };
    await store.setIntroSegments([first, second]);
    let project = await store.removeIntroSegment(first.id);
    expect(project.introSegments).toEqual([second]);
    expect(project.timelineOrder).toEqual([source.id]);
    project = await store.setIntroSegments([first, second]);
    expect(project.introSegments).toEqual([second]);
    const removedReopen = new ProjectStore(root); const persistedRemoval = await removedReopen.initialize();
    expect(persistedRemoval.introSegments).toEqual([second]); expect(persistedRemoval.recentIntroRemovals[0].segment.id).toBe(first.id);
    project = await store.removeMainAsset(source.id);
    expect(project.introSegments).toEqual([second]);
    project = await store.restoreIntroSegment(first.id);
    expect(project.introSegments).toEqual([first, second]);
    expect(project.timelineOrder).toEqual([]);
    const reopened = new ProjectStore(root);
    expect((await reopened.initialize()).introSegments).toEqual([first, second]);
  });

  it("keeps over-limit Intro review ranges while enforcing source, minimum, and count safety", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "long-intro.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 60_000 } };
    await store.addAssets([source]);
    const segment = (id: string, inMs: number, outMs: number) => ({ id, assetId: source.id, fileName: source.fileName, inMs, outMs, score: 70, reasons: ["測試"] });
    await expect(store.setIntroSegments([segment("short", 0, 2_999)])).rejects.toThrow(/至少需要 3 秒/);
    const longReviewRange = await store.setIntroSegments([segment("long", 5_000, 30_000)]);
    expect(longReviewRange.introSegments[0]).toMatchObject({ inMs: 5_000, outMs: 30_000 });
    expect((await new ProjectStore(root).initialize()).introSegments[0]).toMatchObject({ inMs: 5_000, outMs: 30_000 });
    await expect(store.setIntroSegments([segment("past-source", 40_000, 65_000)])).rejects.toThrow(/不可超出來源/);
    await store.setIntroTargetDuration(180_000);
    await expect(store.setIntroSegments(Array.from({ length: 51 }, (_, index) => segment(`count-${index}`, 0, 3_000)))).rejects.toThrow(/最多只能保留 50 段/);
    await store.setIntroSegmentMaxDuration(22_000);
    await store.setIntroTargetDuration(240_000);
    const overThreeMinutes = await store.setIntroSegments(Array.from({ length: 9 }, (_, index) => segment(`total-${index}`, 0, 22_000)));
    expect(overThreeMinutes.introSegments).toHaveLength(9);
    expect(overThreeMinutes.introSegments.reduce((sum, item) => sum + item.outMs - item.inMs, 0)).toBe(198_000);
    const accepted = await store.setIntroSegments(Array.from({ length: 50 }, (_, index) => segment(`ok-${index}`, 0, 3_000)));
    expect(accepted.introSegments).toHaveLength(50);
  });

  it("applies one Intro segment maximum and distributes the target duration evenly", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const source = { ...asset(path.join(root, "balanced-intro.mp4")), metadataState: "READY" as const, mediaInfo: { durationMs: 90_000 } };
    await store.addAssets([source]);
    await store.setIntroTargetDuration(36_000);
    await store.setIntroSegments([
      { id: "one", assetId: source.id, fileName: source.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["人物"] },
      { id: "two", assetId: source.id, fileName: source.fileName, inMs: 20_000, outMs: 30_000, score: 80, reasons: ["事件"] },
      { id: "three", assetId: source.id, fileName: source.fileName, inMs: 50_000, outMs: 65_000, score: 70, reasons: ["故事"] },
    ]);
    const balanced = await store.setIntroSegmentMaxDuration(12_000);
    expect(balanced.introSegmentMaxDurationMs).toBe(12_000);
    expect(balanced.introSegments.map((segment) => segment.outMs - segment.inMs)).toEqual([12_000, 12_000, 12_000]);
    expect(balanced.timelineRevision).toBeGreaterThan(1);
    const reopened = await new ProjectStore(root).initialize();
    expect(reopened.introSegmentMaxDurationMs).toBe(12_000);
    expect(reopened.introSegments.map((segment) => segment.outMs - segment.inMs)).toEqual([12_000, 12_000, 12_000]);
  });

  it("inserts a photo inside a retained video range, persists it, and restores the former order without touching sources", async () => {
    const root = await tempRoot(); const dataRoot = path.join(root, "app-data");
    const videoPath = path.join(root, "影片.mp4"); const photoPath = path.join(root, "照片.jpg");
    await writeFile(videoPath, "video-source"); await writeFile(photoPath, "photo-source");
    const video = { ...asset(videoPath, "v"), metadataState: "READY" as const, mediaInfo: { durationMs: 10_000, videoCodec: "h264", audioCodec: "aac" } };
    const still = photo(photoPath, "p");
    const store = new ProjectStore(dataRoot); await store.initialize();
    let project = await store.addAssets([video, still]);
    const priorPhotoIndex = project.timelineOrder.indexOf(still.id);
    project = await store.addMediaInsertion(video.id, still.id, 4_000);
    expect(project.timelineOrder).not.toContain(still.id);
    expect(project.mediaInsertions).toEqual([expect.objectContaining({ anchorVideoAssetId: video.id, insertedAssetId: still.id, atMs: 4_000, sourceInMs: 0, sourceOutMs: 5_000, previousTimelineIndex: priorPhotoIndex })]);
    expect(mainRenderSelections(project)).toEqual([
      { assetId: video.id, inMs: 0, outMs: 4_000 },
      { assetId: still.id, inMs: 0, outMs: 5_000, mediaInsertionId: project.mediaInsertions[0].id },
      { assetId: video.id, inMs: 4_000, outMs: 10_000 },
    ]);
    const reopened = new ProjectStore(dataRoot); const restored = await reopened.initialize();
    expect(restored.mediaInsertions[0]).toMatchObject({ insertedAssetId: still.id, atMs: 4_000 });
    await expect(store.setPreviewRange(video.id, 5_000, 10_000)).rejects.toThrow(/素材安插點/);
    expect(store.getProject().mediaInsertions[0].atMs).toBe(4_000);
    project = await store.updateMediaInsertion(project.mediaInsertions[0].id, 6_000, { inMs: 0, outMs: 5_000 });
    expect(project.mediaInsertions[0].atMs).toBe(6_000);
    project = await store.setPhotoSoundEnabled(still.id, false);
    expect(project.sources.find((item) => item.id === still.id)?.photoSoundEnabled).toBe(false);
    await expect(store.setPhotoSoundEnabled(still.id, "false" as unknown as boolean)).rejects.toThrow(/設定無效/);
    expect(store.getProject().sources.find((item) => item.id === still.id)?.photoSoundEnabled).toBe(false);
    project = await store.removeMediaInsertion(project.mediaInsertions[0].id);
    expect(project.mediaInsertions).toEqual([]);
    expect(project.timelineOrder[priorPhotoIndex]).toBe(still.id);
    expect(await readFile(videoPath, "utf8")).toBe("video-source");
    expect(await readFile(photoPath, "utf8")).toBe("photo-source");
  });

  it("inserts a newly imported pending-folder asset and returns it to pending when cancelled", async () => {
    const root = await tempRoot(); const dataRoot = path.join(root, "app-data");
    const hostPath = path.join(root, "主資料夾", "host.mp4"); const supplementPath = path.join(root, "另一個資料夾", "新照片.png");
    await mkdir(path.dirname(hostPath), { recursive: true }); await mkdir(path.dirname(supplementPath), { recursive: true });
    await writeFile(hostPath, "host-source"); await writeFile(supplementPath, "new-photo-source");
    const host = { ...asset(hostPath, "h"), metadataState: "READY" as const, mediaInfo: { durationMs: 10_000 } };
    const supplement = photo(supplementPath, "n");
    const store = new ProjectStore(dataRoot); await store.initialize(); await store.addAssets([host]);
    let project = await store.addAssets([supplement]);
    expect(project.pendingAssetIds).toEqual([supplement.id]);
    project = await store.addMediaInsertion(host.id, supplement.id, 5_000);
    expect(project.pendingAssetIds).toEqual([]);
    expect(project.mediaInsertions[0]).toMatchObject({ insertedAssetId: supplement.id, previousPlacement: "PENDING", previousPendingIndex: 0 });
    expect(mainRenderSelections(project).map((clip) => clip.assetId)).toEqual([host.id, supplement.id, host.id]);
    const reopenedStore = new ProjectStore(dataRoot); const reopened = await reopenedStore.initialize();
    expect(reopened.mediaInsertions[0].previousPlacement).toBe("PENDING");
    const cancelled = await reopenedStore.removeMediaInsertion(reopened.mediaInsertions[0].id);
    expect(cancelled.timelineOrder).toEqual([host.id]);
    expect(cancelled.pendingAssetIds).toEqual([supplement.id]);
    expect(await readFile(hostPath, "utf8")).toBe("host-source"); expect(await readFile(supplementPath, "utf8")).toBe("new-photo-source");
  });

  it("rejects media insertion near a cut, inside an excluded region, or with an already inserted asset while allowing consecutive items", async () => {
    const root = await tempRoot(); const store = new ProjectStore(root); await store.initialize();
    const video = { ...asset(path.join(root, "clip.mp4"), "v"), metadataState: "READY" as const, mediaInfo: { durationMs: 8_000 } };
    const first = photo(path.join(root, "one.jpg"), "p"); const second = photo(path.join(root, "two.jpg"), "q");
    await store.addAssets([video, first, second]);
    await expect(store.addMediaInsertion(video.id, first.id, 700)).rejects.toThrow(/0.75 秒/);
    await store.setMainExclusionRanges(video.id, [{ id: "excluded", startMs: 3_000, endMs: 4_000 }]);
    await expect(store.addMediaInsertion(video.id, first.id, 3_500)).rejects.toThrow(/素材安插點/);
    await store.addMediaInsertion(video.id, first.id, 1_500);
    await expect(store.addMediaInsertion(video.id, first.id, 6_000)).rejects.toThrow(/已安插/);
    const inserted = await store.addMediaInsertion(video.id, second.id, 1_500);
    expect(inserted.mediaInsertions).toHaveLength(2);
    expect(mainRenderSelections(inserted).filter((clip) => clip.mediaInsertionId).map((clip) => clip.assetId)).toEqual([first.id, second.id]);
  });

  it("inserts a trimmed video and a photo at the same point, reorders the chain, and restores it on reopen", async () => {
    const root = await tempRoot(); const dataRoot = path.join(root, "app-data");
    const hostPath = path.join(root, "主影片.mp4"); const insertedPath = path.join(root, "補充影片.MOV"); const photoPath = path.join(root, "接續照片.jpg");
    await writeFile(hostPath, "host-source"); await writeFile(insertedPath, "inserted-video-source"); await writeFile(photoPath, "photo-source");
    const host = { ...asset(hostPath, "h"), metadataState: "READY" as const, mediaInfo: { durationMs: 12_000, videoCodec: "h264" } };
    const insertedVideo = { ...asset(insertedPath, "i"), extension: ".mov", metadataState: "READY" as const, mediaInfo: { durationMs: 9_000, videoCodec: "hevc" } };
    const still = photo(photoPath, "s");
    const store = new ProjectStore(dataRoot); await store.initialize(); await store.addAssets([host, insertedVideo, still]);
    const originalOrder = store.getProject().timelineOrder;

    let project = await store.addMediaInsertion(host.id, insertedVideo.id, 5_000, { inMs: 1_250, outMs: 6_500 });
    project = await store.addMediaInsertion(host.id, still.id, 5_000);
    expect(project.timelineOrder).toEqual([host.id]);
    expect(mainRenderSelections(project)).toEqual([
      { assetId: host.id, inMs: 0, outMs: 5_000 },
      { assetId: insertedVideo.id, inMs: 1_250, outMs: 6_500, mediaInsertionId: project.mediaInsertions[0].id },
      { assetId: still.id, inMs: 0, outMs: 5_000, mediaInsertionId: project.mediaInsertions[1].id },
      { assetId: host.id, inMs: 5_000, outMs: 12_000 },
    ]);

    project = await store.moveMediaInsertion(project.mediaInsertions[1].id, 0);
    expect(mainRenderSelections(project).filter((clip) => clip.mediaInsertionId).map((clip) => clip.assetId)).toEqual([still.id, insertedVideo.id]);
    project = await store.updateMediaInsertion(project.mediaInsertions.find((item) => item.insertedAssetId === insertedVideo.id)!.id, 5_000, { inMs: 2_000, outMs: 4_000 });
    expect(mainRenderSelections(project).find((clip) => clip.assetId === insertedVideo.id)).toMatchObject({ inMs: 2_000, outMs: 4_000 });
    await expect(store.updateMediaInsertion(project.mediaInsertions.find((item) => item.insertedAssetId === insertedVideo.id)!.id, 5_000, { inMs: 2_000, outMs: 2_700 })).rejects.toThrow(/至少保留 0.75 秒/);
    await expect(store.updateMediaInsertion(project.mediaInsertions.find((item) => item.insertedAssetId === insertedVideo.id)!.id, 5_000, { inMs: 0, outMs: 9_001 })).rejects.toThrow(/來源影片內/);

    const restored = await new ProjectStore(dataRoot).initialize();
    expect(restored.mediaInsertions).toHaveLength(2);
    expect(mainRenderSelections(restored).filter((clip) => clip.mediaInsertionId).map((clip) => clip.assetId)).toEqual([still.id, insertedVideo.id]);
    const restoredStore = new ProjectStore(dataRoot); await restoredStore.initialize();
    let restoredProject = await restoredStore.removeMediaInsertion(restored.mediaInsertions.find((item) => item.insertedAssetId === insertedVideo.id)!.id);
    restoredProject = await restoredStore.removeMediaInsertion(restoredProject.mediaInsertions[0].id);
    expect(restoredProject.timelineOrder).toEqual(originalOrder);
    expect(await readFile(hostPath, "utf8")).toBe("host-source");
    expect(await readFile(insertedPath, "utf8")).toBe("inserted-video-source");
    expect(await readFile(photoPath, "utf8")).toBe("photo-source");
  });

  it("migrates legacy photo insertions to schema 10 media insertions without losing their order", async () => {
    const root = await tempRoot(); const manifestPath = path.join(root, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const host = { ...asset(path.join(root, "legacy-host.mp4"), "h"), metadataState: "READY" as const, mediaInfo: { durationMs: 10_000 } };
    const still = { ...photo(path.join(root, "legacy-photo.jpg"), "p"), imageDurationMs: 7_000 };
    const legacy = {
      schemaVersion: 7, id: "legacy-photo-insertion", name: "舊安插專案", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewerVersion: "preview-v1",
      sortMode: "MANUAL_ORDER", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sources: [host, still], timelineOrder: [host.id], pendingAssetIds: [],
      excludedMainAssetIds: [], recentMainRemovals: [], introSegments: [], introExcludedSegmentIds: [], recentIntroRemovals: [], placementDecisions: [],
      photoInsertions: [{ id: "legacy-insertion", anchorVideoAssetId: host.id, photoAssetId: still.id, atMs: 4_000, previousTimelineIndex: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
      photoSoundEffect: { id: "legacy", displayName: "快門", sourceProject: "前案", sourceUrl: "https://example.com", licenseUrl: "https://example.com/license", sha256: "a".repeat(64), volumePercent: 70 },
      bgmTracks: [], sourceAudioVolumePercent: 100, aiStoryContext: { topic: "", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh" }, subtitleCues: [], timelineRevision: 2, subtitleTimelineRevision: 2, audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
    };
    await writeFile(manifestPath, JSON.stringify(legacy), "utf8");
    const migrated = await new ProjectStore(root).initialize();
    expect(migrated).toMatchObject({ schemaVersion: 15, timelineOrder: [host.id], introSegmentMaxDurationMs: 15_000 });
    expect(migrated.mediaInsertions).toEqual([expect.objectContaining({ id: "legacy-insertion", anchorVideoAssetId: host.id, insertedAssetId: still.id, atMs: 4_000, sourceInMs: 0, sourceOutMs: 7_000, sequenceIndex: 0, previousPlacement: "TIMELINE" })]);
    expect(mainRenderSelections(migrated).map((clip) => clip.assetId)).toEqual([host.id, still.id, host.id]);
  });
});
