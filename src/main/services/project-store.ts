import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BGM_VOLUME_PERCENT, DEFAULT_IMAGE_DURATION_MS, DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS, DEFAULT_INTRO_TARGET_DURATION_MS, DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT, DEFAULT_ZOOM_ENHANCEMENT_PRESET, DUNES_SHUTTER_EFFECT_ID, DUNES_SHUTTER_EFFECT_SHA256, INTRO_MAX_SEGMENT_MS, INTRO_MAX_SEGMENTS, INTRO_MIN_SEGMENT_MS, MANIFEST_SCHEMA_VERSION, MAX_IMAGE_DURATION_MS, MAX_MIX_VOLUME_PERCENT, MIN_IMAGE_DURATION_MS, PREVIEWER_VERSION, type AiStoryContext, type BgmTrack, type ImageDurationUpdateResult, type IntroAnalysisResult, type IntroSuggestion, type MainExclusionRange, type MainExclusionRangeUpdateResult, type MediaInsertion, type MusicSuggestionResult, type PlacementRequest, type PreviewRange, type PreviewRangeUpdateResult, type ProjectColorSettings, type ProjectFileResult, type ProjectFileState, type ProjectHistoryState, type ProjectManifest, type RemovedIntroSegment, type RemovedMainAsset, type SortMode, type SourceAsset, type SubtitleCue, type SubtitleTimelineScope, type VolumeSegment, type ZoomEnhancementPreset, type ZoomSegment, type ZoomSegmentUpdateResult } from "../../shared/domain";
import { clipMainExclusionRanges, clipVolumeSegments, clipZoomSegments, imageDurationMs, mainRenderSelections, normalizeMainExclusionRanges, validateBgmTrack, validateImageDurationMs, validateMediaInsertion, validatePercent, validateSubtitleCues, validateVolumeSegments, validateZoomSegments } from "../../shared/editing-rules";
import { sortAssets } from "../../shared/sorting";
import { DEFAULT_PROJECT_COLOR_SETTINGS, normalizeProjectColorSettings } from "../../shared/color-presets";
import { balanceIntroSegments, normalizeIntroSegmentMaxDuration } from "../../shared/intro-duration";
import { finalizePartialOutput } from "./atomic-output";

function clone<T>(value: T): T { return structuredClone(value); }

function defaultPhotoSoundEffect(): ProjectManifest["photoSoundEffect"] {
  return {
    id: DUNES_SHUTTER_EFFECT_ID,
    displayName: "沙丘前案相機快門（Camera Shutter Click）",
    sourceProject: "草漯沙丘地質公園 YT長片",
    sourceUrl: "https://pixabay.com/sound-effects/technology-camera-shutter-click-14671/",
    licenseUrl: "https://pixabay.com/service/license-summary/",
    sha256: DUNES_SHUTTER_EFFECT_SHA256,
    volumePercent: 70,
  };
}

function defaultAiStoryContext(): AiStoryContext {
  return { topic: "", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh" };
}

function normalizeTextList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 50) : [];
}

function normalizeAiStoryContext(value: unknown): AiStoryContext {
  const input = value && typeof value === "object" ? value as Partial<AiStoryContext> : {};
  const text = (item: unknown, maximum: number) => typeof item === "string" ? item.trim().slice(0, maximum) : "";
  const language = text(input.subtitleLanguage, 12) || "zh";
  if (!/^[a-zA-Z-]{2,12}$/.test(language)) throw new Error("字幕語言代碼無效，例如 zh、zh-TW 或 en。");
  const introPrompt = text(input.introPrompt, 1_000);
  const introBaseAssetId = text(input.introBaseAssetId, 128);
  return {
    topic: text(input.topic, 200),
    locations: normalizeTextList(input.locations),
    people: normalizeTextList(input.people),
    storySummary: text(input.storySummary, 2_000),
    audiencePromise: text(input.audiencePromise, 500),
    subtitleLanguage: language,
    ...(introPrompt ? { introPrompt } : {}),
    ...(introBaseAssetId ? { introBaseAssetId } : {}),
  };
}

function normalizeIntroTargetDuration(value: unknown): number {
  const durationMs = Math.round(Number(value));
  if (!Number.isFinite(durationMs) || durationMs < INTRO_MIN_SEGMENT_MS) {
    throw new Error("片頭目標總長至少需要 0:03。" );
  }
  return durationMs;
}

function createProject(): ProjectManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION, id: randomUUID(), name: "我的素材專案",
    sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER", previewerVersion: PREVIEWER_VERSION,
    sortMode: "SMART_SEQUENCE", createdAt: now, updatedAt: now, sources: [], timelineOrder: [], pendingAssetIds: [],
    excludedMainAssetIds: [], recentMainRemovals: [], introSegments: [], introTargetDurationMs: DEFAULT_INTRO_TARGET_DURATION_MS, introSegmentMaxDurationMs: DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS, colorSettings: DEFAULT_PROJECT_COLOR_SETTINGS, introExcludedSegmentIds: [], recentIntroRemovals: [],
    placementDecisions: [], mediaInsertions: [], photoSoundEffect: defaultPhotoSoundEffect(), bgmTracks: [], sourceAudioVolumePercent: DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT, aiStoryContext: defaultAiStoryContext(), subtitleCues: [], timelineRevision: 0, subtitleTimelineRevision: 0,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  };
}

function looksLikeProject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.schemaVersion === 1 || candidate.schemaVersion === 2 || candidate.schemaVersion === 3 || candidate.schemaVersion === 4 || candidate.schemaVersion === 5 || candidate.schemaVersion === 6 || candidate.schemaVersion === 7 || candidate.schemaVersion === 8 || candidate.schemaVersion === 9 || candidate.schemaVersion === 10 || candidate.schemaVersion === 11 || candidate.schemaVersion === 12 || candidate.schemaVersion === 13) && candidate.sourcePolicy === "READ_ONLY" && candidate.previewPolicy === "DERIVED_CACHE_ONLY_NOT_MASTER" && Array.isArray(candidate.sources);
}

function normalizeZoomEnhancementPreset(value: unknown): ZoomEnhancementPreset {
  return value === "OFF" || value === "DETAIL" || value === "DENOISE" || value === "BALANCED" ? value : DEFAULT_ZOOM_ENHANCEMENT_PRESET;
}

function migrateProject(raw: Record<string, unknown>): ProjectManifest {
  const sources = (raw.sources as SourceAsset[]).map((asset) => ({
    ...asset,
    imageDurationMs: asset.kind === "IMAGE" ? (() => { try { return validateImageDurationMs(asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS); } catch { return DEFAULT_IMAGE_DURATION_MS; } })() : undefined,
    photoSoundEnabled: asset.kind === "IMAGE" ? asset.photoSoundEnabled !== false : undefined,
    volumeSegments: Array.isArray(asset.volumeSegments) ? asset.volumeSegments.map((segment) => ({ ...segment, volumePercent: Math.max(0, Math.min(MAX_MIX_VOLUME_PERCENT, Number.isFinite(segment.volumePercent) ? segment.volumePercent : DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT)) })) : [],
    mainExclusionRanges: Array.isArray(asset.mainExclusionRanges) ? asset.mainExclusionRanges : [],
    zoomSegments: Array.isArray(asset.zoomSegments) ? asset.zoomSegments.map((segment) => ({ ...segment, enhancementPreset: normalizeZoomEnhancementPreset(segment.enhancementPreset) })) : [],
  }));
  const sourceIds = new Set(sources.map((asset) => asset.id));
  const sourceById = new Map(sources.map((asset) => [asset.id, asset]));
  type LegacyInsertion = Partial<MediaInsertion> & { photoAssetId?: string };
  const rawInsertions = Array.isArray(raw.mediaInsertions) ? raw.mediaInsertions as LegacyInsertion[] : Array.isArray(raw.photoInsertions) ? raw.photoInsertions as LegacyInsertion[] : [];
  const insertedOnce = new Set<string>();
  const mediaInsertions = rawInsertions.flatMap((item, index): MediaInsertion[] => {
    const insertedAssetId = typeof item.insertedAssetId === "string" ? item.insertedAssetId : item.photoAssetId;
    const anchor = typeof item.anchorVideoAssetId === "string" ? sourceById.get(item.anchorVideoAssetId) : undefined;
    const inserted = typeof insertedAssetId === "string" ? sourceById.get(insertedAssetId) : undefined;
    if (!item || typeof item.id !== "string" || !item.id || anchor?.kind !== "VIDEO" || !inserted || inserted.id === anchor.id || !Number.isFinite(item.atMs) || insertedOnce.has(inserted.id)) return [];
    let sourceInMs = 0; let sourceOutMs = 0;
    if (inserted.kind === "IMAGE") sourceOutMs = imageDurationMs(inserted);
    else {
      const durationMs = inserted.mediaInfo?.durationMs;
      if (!durationMs) return [];
      sourceInMs = Number.isFinite(item.sourceInMs) ? Math.max(0, Math.round(item.sourceInMs!)) : inserted.previewRange?.inMs ?? 0;
      sourceOutMs = Number.isFinite(item.sourceOutMs) ? Math.min(durationMs, Math.round(item.sourceOutMs!)) : inserted.previewRange?.outMs ?? durationMs;
      if (sourceOutMs - sourceInMs < 100) return [];
    }
    insertedOnce.add(inserted.id);
    return [{
      id: item.id,
      anchorVideoAssetId: anchor.id,
      insertedAssetId: inserted.id,
      atMs: Math.round(item.atMs!),
      sourceInMs,
      sourceOutMs,
      sequenceIndex: Number.isInteger(item.sequenceIndex) ? item.sequenceIndex! : index,
      previousPlacement: item.previousPlacement === "PENDING" ? "PENDING" : "TIMELINE",
      previousTimelineIndex: Number.isInteger(item.previousTimelineIndex) ? item.previousTimelineIndex! : 0,
      previousPendingIndex: Number.isInteger(item.previousPendingIndex) ? item.previousPendingIndex : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
    }];
  });
  const insertedMediaIds = new Set(mediaInsertions.map((item) => item.insertedAssetId));
  const excludedMainAssetIds = Array.isArray(raw.excludedMainAssetIds)
    ? [...new Set(raw.excludedMainAssetIds.filter((id): id is string => typeof id === "string" && sourceIds.has(id)))]
    : [];
  const excludedMainIds = new Set(excludedMainAssetIds);
  const rawOrder = Array.isArray(raw.timelineOrder) ? raw.timelineOrder.filter((id): id is string => typeof id === "string" && sourceIds.has(id) && !excludedMainIds.has(id) && !insertedMediaIds.has(id)) : [];
  const order = [...new Set(rawOrder)];
  const rawPending = Array.isArray(raw.pendingAssetIds) ? raw.pendingAssetIds.filter((id): id is string => typeof id === "string" && sourceIds.has(id) && !excludedMainIds.has(id) && !insertedMediaIds.has(id) && !order.includes(id)) : [];
  const pending = [...new Set(rawPending)];
  const activeSources = sources.filter((asset) => !excludedMainIds.has(asset.id) && !insertedMediaIds.has(asset.id));
  if (order.length === 0 && pending.length === 0 && activeSources.length > 0) order.push(...sortAssets(activeSources, (raw.sortMode as SortMode | undefined) ?? "SMART_SEQUENCE").map((asset) => asset.id));
  else for (const asset of activeSources) if (!order.includes(asset.id) && !pending.includes(asset.id)) pending.push(asset.id);
  const recentMainRemovals = Array.isArray(raw.recentMainRemovals)
    ? (raw.recentMainRemovals as RemovedMainAsset[]).filter((item) => item && excludedMainIds.has(item.assetId) && sourceIds.has(item.assetId))
    : [];
  const introExcludedSegmentIds = Array.isArray(raw.introExcludedSegmentIds)
    ? [...new Set(raw.introExcludedSegmentIds.filter((id): id is string => typeof id === "string"))]
    : [];
  const introSegments = Array.isArray(raw.introSegments)
    ? (raw.introSegments as IntroSuggestion[]).filter((item) => item && sourceIds.has(item.assetId) && !introExcludedSegmentIds.includes(item.id))
    : [];
  const recentIntroRemovals = Array.isArray(raw.recentIntroRemovals)
    ? (raw.recentIntroRemovals as RemovedIntroSegment[]).filter((item) => item?.segment && sourceIds.has(item.segment.assetId) && introExcludedSegmentIds.includes(item.segment.id))
    : [];
  const longestExistingIntroMs = introSegments.reduce((maximum, segment) => Math.max(maximum, segment.outMs - segment.inMs), 0);
  const introSegmentMaxDurationMs = (() => {
    try { return normalizeIntroSegmentMaxDuration(raw.introSegmentMaxDurationMs ?? Math.max(DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS, longestExistingIntroMs)); }
    catch { return Math.max(DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS, Math.min(INTRO_MAX_SEGMENT_MS, longestExistingIntroMs)); }
  })();
  const bgmTracks = Array.isArray(raw.bgmTracks) ? (raw.bgmTracks as BgmTrack[]).map((track) => ({
    ...track,
    sourceKind: track.sourceKind ?? "LOCAL_FILE" as const,
    resolutionStatus: track.resolutionStatus ?? (track.sourcePath ? "READY" : "NEEDS_LOCAL_FILE") as "READY" | "NEEDS_LOCAL_FILE",
    volumePercent: Math.max(0, Math.min(MAX_MIX_VOLUME_PERCENT, Number.isFinite(track.volumePercent) ? track.volumePercent : DEFAULT_BGM_VOLUME_PERCENT)),
  })) : [];
  const sourceAudioVolumePercent = Number.isFinite(raw.sourceAudioVolumePercent)
    ? Math.max(0, Math.min(MAX_MIX_VOLUME_PERCENT, Number(raw.sourceAudioVolumePercent)))
    : DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT;
  return {
    ...(raw as unknown as ProjectManifest), schemaVersion: MANIFEST_SCHEMA_VERSION, previewerVersion: PREVIEWER_VERSION, sources,
    timelineOrder: order, pendingAssetIds: pending,
    excludedMainAssetIds, recentMainRemovals, introSegments, introTargetDurationMs: (() => { try { return normalizeIntroTargetDuration(raw.introTargetDurationMs ?? DEFAULT_INTRO_TARGET_DURATION_MS); } catch { return DEFAULT_INTRO_TARGET_DURATION_MS; } })(), introSegmentMaxDurationMs, colorSettings: normalizeProjectColorSettings(raw.colorSettings), introExcludedSegmentIds, recentIntroRemovals,
    placementDecisions: Array.isArray(raw.placementDecisions) ? raw.placementDecisions as ProjectManifest["placementDecisions"] : [],
    mediaInsertions,
    photoSoundEffect: defaultPhotoSoundEffect(),
    bgmTracks,
    sourceAudioVolumePercent,
    aiStoryContext: normalizeAiStoryContext(raw.aiStoryContext),
    subtitleCues: Array.isArray(raw.subtitleCues) ? (raw.subtitleCues as SubtitleCue[]).map((cue) => ({ ...cue, timelineScope: cue.timelineScope === "INTRO" ? "INTRO" : "MAIN", origin: cue.origin ?? "MANUAL", reviewStatus: cue.reviewStatus ?? "CONFIRMED" })) : [],
    timelineRevision: Number.isInteger(raw.timelineRevision) ? raw.timelineRevision as number : 0,
    subtitleTimelineRevision: Number.isInteger(raw.subtitleTimelineRevision) ? raw.subtitleTimelineRevision as number : 0,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  };
}

export class ProjectStore {
  private current: ProjectManifest = createProject();
  private writeChain: Promise<void> = Promise.resolve();
  private activeProjectPath?: string;
  private undoStack: ProjectManifest[] = [];
  private redoStack: ProjectManifest[] = [];
  private readonly historyLimit = 50;
  readonly manifestPath: string;
  readonly sessionPath: string;

  constructor(private readonly dataRoot: string) {
    this.manifestPath = path.join(dataRoot, "projects", "default", "project.source-manifest.json");
    this.sessionPath = path.join(dataRoot, "projects", "active-project.json");
  }

  async initialize(): Promise<ProjectManifest> {
    await mkdir(path.dirname(this.manifestPath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.manifestPath, "utf8"));
      if (!looksLikeProject(parsed)) throw new Error("manifest schema 不相容");
      const migrated = parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION || parsed.previewerVersion !== PREVIEWER_VERSION ||
        !Array.isArray(parsed.excludedMainAssetIds) || !Array.isArray(parsed.recentMainRemovals) ||
        !Array.isArray(parsed.introSegments) || !Number.isFinite(parsed.introTargetDurationMs) || !Number.isFinite(parsed.introSegmentMaxDurationMs) || !parsed.colorSettings || !Array.isArray(parsed.introExcludedSegmentIds) || !Array.isArray(parsed.recentIntroRemovals) ||
        !Array.isArray(parsed.mediaInsertions) || !parsed.photoSoundEffect || !parsed.aiStoryContext || !Number.isFinite(parsed.sourceAudioVolumePercent) ||
        (parsed.sources as Partial<SourceAsset>[]).some((asset) => !Array.isArray(asset.zoomSegments) || asset.zoomSegments.some((segment) => !segment.enhancementPreset));
      this.current = migrateProject(parsed);
      if (migrated) await this.writeProjectFile(this.manifestPath, this.current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      this.current = createProject();
      await this.writeProjectFile(this.manifestPath, this.current);
    }
    try {
      const session = JSON.parse(await readFile(this.sessionPath, "utf8")) as { filePath?: unknown };
      if (typeof session.filePath === "string" && session.filePath.trim()) {
        const resolved = path.resolve(session.filePath);
        const opened = await this.readProjectFile(resolved);
        this.current = opened;
        this.activeProjectPath = resolved;
        await this.writeProjectFile(this.manifestPath, opened);
      }
    } catch {
      this.activeProjectPath = undefined;
    }
    this.clearHistory();
    return this.getProject();
  }

  getProject(): ProjectManifest { return clone(this.current); }
  getHistoryState(): ProjectHistoryState { return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, undoCount: this.undoStack.length, redoCount: this.redoStack.length }; }
  getProjectFileState(): ProjectFileState { return { filePath: this.activeProjectPath }; }
  getAsset(assetId: string): SourceAsset | undefined { const asset = this.current.sources.find((item) => item.id === assetId); return asset ? clone(asset) : undefined; }

  async saveProject(): Promise<ProjectFileResult> {
    if (!this.activeProjectPath) throw new Error("此專案尚未命名儲存，請先使用「另存專案」。");
    const project = await this.queueProjectFileOperation(async () => {
      const next = { ...clone(this.current), updatedAt: new Date().toISOString() };
      await this.persistProject(next, this.activeProjectPath);
      this.current = next;
      return this.getProject();
    });
    return { project, filePath: this.activeProjectPath };
  }

  async saveProjectAs(filePath: string, projectName: string): Promise<ProjectFileResult> {
    const resolved = path.resolve(filePath);
    const name = projectName.trim();
    if (!name) throw new Error("專案名稱不可空白。");
    const project = await this.queueProjectFileOperation(async () => {
      const next = { ...clone(this.current), name, updatedAt: new Date().toISOString() };
      await this.persistProject(next, resolved);
      await this.writeSessionPointer(resolved);
      this.current = next;
      this.activeProjectPath = resolved;
      this.clearHistory();
      return this.getProject();
    });
    return { project, filePath: resolved };
  }

  async openProject(filePath: string): Promise<ProjectFileResult> {
    const resolved = path.resolve(filePath);
    const project = await this.queueProjectFileOperation(async () => {
      const opened = await this.readProjectFile(resolved);
      await this.writeProjectFile(this.manifestPath, opened);
      await this.writeSessionPointer(resolved);
      this.current = opened;
      this.activeProjectPath = resolved;
      this.clearHistory();
      return this.getProject();
    });
    return { project, filePath: resolved };
  }

  async addAssets(assets: SourceAsset[]): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const existing = new Set(project.sources.map((asset) => asset.id));
      const isInitialBatch = project.sources.length === 0;
      for (const input of assets) {
        if (existing.has(input.id)) continue;
        const asset = { ...input, imageDurationMs: input.kind === "IMAGE" ? validateImageDurationMs(input.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS) : undefined, photoSoundEnabled: input.kind === "IMAGE" ? input.photoSoundEnabled !== false : undefined, volumeSegments: input.volumeSegments ?? [], mainExclusionRanges: input.mainExclusionRanges ?? [], zoomSegments: input.zoomSegments ?? [] };
        project.sources.push(asset); existing.add(asset.id);
        if (isInitialBatch) project.timelineOrder.push(asset.id); else project.pendingAssetIds.push(asset.id);
      }
      if (isInitialBatch && assets.length > 0) {
        project.timelineOrder = sortAssets(project.sources, project.sortMode).map((asset) => asset.id);
        this.bumpTimeline(project);
      }
    });
  }

  async updateAsset(asset: SourceAsset): Promise<SourceAsset> {
    await this.mutate((project) => {
      const index = project.sources.findIndex((item) => item.id === asset.id);
      if (index < 0) throw new Error("找不到來源項目。");
      project.sources[index] = { ...asset, imageDurationMs: asset.kind === "IMAGE" ? validateImageDurationMs(asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS) : undefined, photoSoundEnabled: asset.kind === "IMAGE" ? asset.photoSoundEnabled !== false : undefined, volumeSegments: asset.volumeSegments ?? [], mainExclusionRanges: asset.mainExclusionRanges ?? [], zoomSegments: asset.zoomSegments ?? [] };
    }, false);
    return clone(this.getAsset(asset.id)!);
  }

  async removeMainAsset(assetId: string): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (!project.sources.some((asset) => asset.id === assetId)) throw new Error("找不到來源項目。");
      if (project.excludedMainAssetIds.includes(assetId)) return;
      const previousTimelineIndex = project.timelineOrder.indexOf(assetId);
      const wasPending = project.pendingAssetIds.includes(assetId);
      if (previousTimelineIndex < 0 && !wasPending) throw new Error("素材目前不在正片或待決定清單中。");
      const record: RemovedMainAsset = {
        assetId,
        previousTimelineIndex: previousTimelineIndex >= 0 ? previousTimelineIndex : null,
        wasPending,
        previousSortMode: project.sortMode,
        removedAt: new Date().toISOString(),
      };
      project.timelineOrder = project.timelineOrder.filter((id) => id !== assetId);
      project.pendingAssetIds = project.pendingAssetIds.filter((id) => id !== assetId);
      project.excludedMainAssetIds.push(assetId);
      project.recentMainRemovals = [...project.recentMainRemovals.filter((item) => item.assetId !== assetId), record];
      this.bumpTimeline(project);
    });
  }

  async restoreMainAsset(assetId: string): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const record = project.recentMainRemovals.find((item) => item.assetId === assetId);
      if (!record || !project.excludedMainAssetIds.includes(assetId) || !project.sources.some((asset) => asset.id === assetId)) throw new Error("找不到可恢復的正片素材。");
      project.excludedMainAssetIds = project.excludedMainAssetIds.filter((id) => id !== assetId);
      project.recentMainRemovals = project.recentMainRemovals.filter((item) => item.assetId !== assetId);
      if (record.wasPending) project.pendingAssetIds.push(assetId);
      else {
        const index = Math.max(0, Math.min(project.timelineOrder.length, record.previousTimelineIndex ?? project.timelineOrder.length));
        project.timelineOrder.splice(index, 0, assetId);
        project.sortMode = record.previousSortMode;
      }
      this.bumpTimeline(project);
    });
  }

  async setIntroSegments(segments: IntroSuggestion[]): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (!Array.isArray(segments)) throw new Error("片頭片段格式無效。");
      const normalized = this.validateIntroSegments(project, segments).filter((item) => !project.introExcludedSegmentIds.includes(item.id));
      if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error("片頭片段不可重複。");
      if (JSON.stringify(project.introSegments) === JSON.stringify(normalized)) return;
      project.introSegments = normalized;
      this.bumpTimeline(project);
    });
  }

  async setIntroTargetDuration(durationMs: number): Promise<ProjectManifest> {
    return this.mutate((project) => {
      project.introTargetDurationMs = normalizeIntroTargetDuration(durationMs);
    });
  }

  async setIntroSegmentMaxDuration(durationMs: number): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const maximumMs = normalizeIntroSegmentMaxDuration(durationMs);
      const balanced = balanceIntroSegments(project.introSegments, project.sources, project.introTargetDurationMs, maximumMs);
      const rangesChanged = balanced.some((segment, index) => segment.inMs !== project.introSegments[index]?.inMs || segment.outMs !== project.introSegments[index]?.outMs);
      project.introSegmentMaxDurationMs = maximumMs;
      project.introSegments = balanced;
      if (rangesChanged) this.bumpTimeline(project);
    });
  }

  async setProjectColorSettings(settings: ProjectColorSettings): Promise<ProjectManifest> {
    return this.mutate((project) => {
      project.colorSettings = normalizeProjectColorSettings(settings);
    });
  }

  async removeIntroSegment(segmentId: string): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const index = project.introSegments.findIndex((item) => item.id === segmentId);
      if (index < 0) throw new Error("找不到要從片頭移除的區段。");
      const record: RemovedIntroSegment = { segment: clone(project.introSegments[index]), previousIndex: index, removedAt: new Date().toISOString() };
      project.introSegments.splice(index, 1);
      if (!project.introExcludedSegmentIds.includes(segmentId)) project.introExcludedSegmentIds.push(segmentId);
      project.recentIntroRemovals = [...project.recentIntroRemovals.filter((item) => item.segment.id !== segmentId), record];
      this.bumpTimeline(project);
    });
  }

  async restoreIntroSegment(segmentId: string): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const record = project.recentIntroRemovals.find((item) => item.segment.id === segmentId);
      if (!record || !project.sources.some((asset) => asset.id === record.segment.assetId)) throw new Error("找不到可恢復的片頭區段。");
      const [segment] = this.validateIntroSegments(project, [record.segment]);
      project.introExcludedSegmentIds = project.introExcludedSegmentIds.filter((id) => id !== segmentId);
      project.recentIntroRemovals = project.recentIntroRemovals.filter((item) => item.segment.id !== segmentId);
      if (!project.introSegments.some((item) => item.id === segmentId)) {
        project.introSegments.splice(Math.max(0, Math.min(project.introSegments.length, record.previousIndex)), 0, segment);
      }
      this.bumpTimeline(project);
    });
  }

  async setPreviewRange(assetId: string, inMs: number, outMs: number): Promise<PreviewRangeUpdateResult> {
    let result!: Omit<PreviewRangeUpdateResult, "project">;
    const project = await this.mutate((project) => {
      const index = project.sources.findIndex((item) => item.id === assetId);
      if (index < 0) throw new Error("找不到來源項目。");
      const asset = project.sources[index]; const durationMs = asset.mediaInfo?.durationMs;
      if (asset.kind !== "VIDEO" || !durationMs) throw new Error("影片時長尚未就緒，無法設定起點與停止點。");
      const normalizedIn = Math.round(inMs); const normalizedOut = Math.round(outMs);
      if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || normalizedIn < 0 || normalizedOut > durationMs || normalizedOut - normalizedIn < 100) throw new Error("裁切範圍必須位於影片內，且至少保留 0.1 秒。");
      const previewRange = { inMs: normalizedIn, outMs: normalizedOut };
      const clipped = clipVolumeSegments(asset.volumeSegments ?? [], previewRange);
      const clippedExclusions = clipMainExclusionRanges(asset.mainExclusionRanges ?? [], previewRange);
      const clippedZooms = clipZoomSegments(asset.zoomSegments ?? [], previewRange);
      const updated = { ...asset, previewRange, volumeSegments: clipped.segments, mainExclusionRanges: clippedExclusions.ranges, zoomSegments: clippedZooms.segments };
      const nextSources = project.sources.map((item, itemIndex) => itemIndex === index ? updated : item);
      for (const insertion of project.mediaInsertions.filter((item) => item.anchorVideoAssetId === asset.id)) {
        validateMediaInsertion(insertion, nextSources, project.mediaInsertions, insertion.id);
      }
      project.sources[index] = updated; result = { asset: clone(updated), adjustedVolumeSegmentCount: clipped.adjustedCount, adjustedMainExclusionRangeCount: clippedExclusions.adjustedCount, adjustedZoomSegmentCount: clippedZooms.adjustedCount };
      this.bumpTimeline(project);
    });
    return { ...result, project };
  }

  async setImageDuration(assetId: string, durationMs: number): Promise<ImageDurationUpdateResult> {
    let updated!: SourceAsset;
    const project = await this.mutate((project) => {
      const index = project.sources.findIndex((item) => item.id === assetId);
      if (index < 0) throw new Error("找不到來源項目。");
      const asset = project.sources[index];
      if (asset.kind !== "IMAGE") throw new Error("只有照片可以設定顯示時間。");
      updated = { ...asset, imageDurationMs: validateImageDurationMs(durationMs) };
      project.sources[index] = updated;
      this.bumpTimeline(project);
    });
    return { asset: clone(updated), project };
  }

  async setPhotoSoundEnabled(assetId: string, enabled: boolean): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (typeof enabled !== "boolean") throw new Error("相機快門音效設定無效。");
      const index = project.sources.findIndex((item) => item.id === assetId);
      if (index < 0 || project.sources[index].kind !== "IMAGE") throw new Error("只有照片可以設定相機快門音效。");
      project.sources[index] = { ...project.sources[index], photoSoundEnabled: enabled };
      this.bumpTimeline(project);
    });
  }

  async addMediaInsertion(anchorVideoAssetId: string, insertedAssetId: string, atMs: number, sourceRange?: PreviewRange): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (!project.timelineOrder.includes(anchorVideoAssetId)) throw new Error("素材只能安插到目前正片順序中的影片。");
      const inserted = project.sources.find((item) => item.id === insertedAssetId);
      if (!inserted) throw new Error("找不到要安插的素材。");
      if (project.mediaInsertions.some((item) => item.insertedAssetId === insertedAssetId)) throw new Error("這個素材已安插到影片時段中。");
      const currentTimelineIndex = project.timelineOrder.indexOf(insertedAssetId);
      const currentPendingIndex = project.pendingAssetIds.indexOf(insertedAssetId);
      if ((currentTimelineIndex < 0 && currentPendingIndex < 0) || project.excludedMainAssetIds.includes(insertedAssetId)) throw new Error("請先把照片或影片加入正片或待決定清單，再設定影片內安插時間。");
      const previousPlacement = currentTimelineIndex >= 0 ? "TIMELINE" as const : "PENDING" as const;
      const previousTimelineIndex = previousPlacement === "TIMELINE" ? this.virtualTimelineOrder(project).indexOf(insertedAssetId) : project.timelineOrder.length;
      const defaultRange = inserted.kind === "IMAGE"
        ? { inMs: 0, outMs: imageDurationMs(inserted) }
        : inserted.previewRange ?? { inMs: 0, outMs: inserted.mediaInfo?.durationMs ?? 0 };
      const normalized = validateMediaInsertion({ anchorVideoAssetId, insertedAssetId, atMs, sourceInMs: sourceRange?.inMs ?? defaultRange.inMs, sourceOutMs: sourceRange?.outMs ?? defaultRange.outMs }, project.sources, project.mediaInsertions);
      if (previousPlacement === "TIMELINE") project.timelineOrder.splice(currentTimelineIndex, 1);
      else project.pendingAssetIds.splice(currentPendingIndex, 1);
      project.mediaInsertions.push({ id: randomUUID(), anchorVideoAssetId, insertedAssetId, ...normalized, sequenceIndex: project.mediaInsertions.filter((item) => item.anchorVideoAssetId === anchorVideoAssetId).length, previousPlacement, previousTimelineIndex, previousPendingIndex: previousPlacement === "PENDING" ? currentPendingIndex : undefined, createdAt: new Date().toISOString() });
      project.sortMode = "MANUAL_ORDER";
      this.bumpTimeline(project);
    });
  }

  async updateMediaInsertion(insertionId: string, atMs: number, sourceRange: PreviewRange): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const index = project.mediaInsertions.findIndex((item) => item.id === insertionId);
      if (index < 0) throw new Error("找不到素材安插設定。");
      const current = project.mediaInsertions[index];
      const normalized = validateMediaInsertion({ ...current, atMs, sourceInMs: sourceRange.inMs, sourceOutMs: sourceRange.outMs }, project.sources, project.mediaInsertions, current.id);
      project.mediaInsertions[index] = { ...current, ...normalized };
      this.bumpTimeline(project);
    });
  }

  async removeMediaInsertion(insertionId: string): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const index = project.mediaInsertions.findIndex((item) => item.id === insertionId);
      if (index < 0) throw new Error("找不到素材安插設定。");
      const [insertion] = project.mediaInsertions.splice(index, 1);
      if (!project.timelineOrder.includes(insertion.insertedAssetId) && !project.pendingAssetIds.includes(insertion.insertedAssetId) && !project.excludedMainAssetIds.includes(insertion.insertedAssetId)) {
        if (insertion.previousPlacement === "PENDING") {
          const restoreIndex = Math.max(0, Math.min(project.pendingAssetIds.length, insertion.previousPendingIndex ?? project.pendingAssetIds.length));
          project.pendingAssetIds.splice(restoreIndex, 0, insertion.insertedAssetId);
        } else {
          const stillHiddenBefore = project.mediaInsertions.filter((item) => item.previousPlacement !== "PENDING" && item.previousTimelineIndex < insertion.previousTimelineIndex).length;
          const restoreIndex = insertion.previousTimelineIndex - stillHiddenBefore;
          project.timelineOrder.splice(Math.max(0, Math.min(project.timelineOrder.length, restoreIndex)), 0, insertion.insertedAssetId);
        }
      }
      this.resequenceMediaInsertions(project, insertion.anchorVideoAssetId);
      this.bumpTimeline(project);
    });
  }

  async moveMediaInsertion(insertionId: string, toIndex: number): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const insertion = project.mediaInsertions.find((item) => item.id === insertionId);
      if (!insertion) throw new Error("找不到素材安插設定。");
      const siblings = project.mediaInsertions.filter((item) => item.anchorVideoAssetId === insertion.anchorVideoAssetId).sort((left, right) => left.atMs - right.atMs || left.sequenceIndex - right.sequenceIndex || left.createdAt.localeCompare(right.createdAt));
      const fromIndex = siblings.findIndex((item) => item.id === insertionId);
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= siblings.length) throw new Error("安插素材順序超出範圍。");
      const [moved] = siblings.splice(fromIndex, 1); siblings.splice(toIndex, 0, moved);
      siblings.forEach((item, index) => { const projectIndex = project.mediaInsertions.findIndex((candidate) => candidate.id === item.id); project.mediaInsertions[projectIndex] = { ...item, sequenceIndex: index }; });
      this.bumpTimeline(project);
    });
  }

  async setVolumeSegments(assetId: string, segments: VolumeSegment[]): Promise<SourceAsset> {
    let updated!: SourceAsset;
    await this.mutate((project) => {
      const index = project.sources.findIndex((item) => item.id === assetId);
      if (index < 0) throw new Error("找不到來源項目。");
      const asset = project.sources[index]; const durationMs = asset.mediaInfo?.durationMs;
      if (asset.kind !== "VIDEO" || !durationMs) throw new Error("影片時長尚未就緒，無法設定音量區段。");
      updated = { ...asset, volumeSegments: validateVolumeSegments(segments, asset.previewRange ?? { inMs: 0, outMs: durationMs }) };
      project.sources[index] = updated;
    });
    return clone(updated);
  }

  async setMainExclusionRanges(assetId: string, ranges: MainExclusionRange[]): Promise<MainExclusionRangeUpdateResult> {
    let updated!: SourceAsset; let mergedRangeCount = 0;
    const project = await this.mutate((project) => {
      const index = project.sources.findIndex((item) => item.id === assetId);
      if (index < 0) throw new Error("找不到來源項目。");
      const asset = project.sources[index]; const durationMs = asset.mediaInfo?.durationMs;
      if (asset.kind !== "VIDEO" || !durationMs) throw new Error("影片時長尚未就緒，無法設定正片排除區段。");
      const normalized = normalizeMainExclusionRanges(ranges, asset.previewRange ?? { inMs: 0, outMs: durationMs });
      mergedRangeCount = Math.max(0, ranges.length - normalized.length);
      updated = { ...asset, mainExclusionRanges: normalized };
      const nextSources = project.sources.map((item, itemIndex) => itemIndex === index ? updated : item);
      for (const insertion of project.mediaInsertions.filter((item) => item.anchorVideoAssetId === asset.id)) {
        validateMediaInsertion(insertion, nextSources, project.mediaInsertions, insertion.id);
      }
      project.sources[index] = updated;
      this.bumpTimeline(project);
    });
    return { asset: clone(updated), mergedRangeCount, project };
  }

  async setZoomSegments(assetId: string, segments: ZoomSegment[]): Promise<ZoomSegmentUpdateResult> {
    let updated!: SourceAsset;
    const project = await this.mutate((project) => {
      const index = project.sources.findIndex((item) => item.id === assetId);
      if (index < 0) throw new Error("找不到來源項目。");
      const asset = project.sources[index]; const durationMs = asset.mediaInfo?.durationMs;
      if (asset.kind !== "VIDEO" || !durationMs) throw new Error("影片時長尚未就緒，無法設定局部放大區段。");
      updated = { ...asset, zoomSegments: validateZoomSegments(segments, asset.previewRange ?? { inMs: 0, outMs: durationMs }) };
      project.sources[index] = updated;
      this.bumpTimeline(project);
    });
    return { asset: clone(updated), project };
  }

  async placeAsset(assetId: string, placement: PlacementRequest): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (!project.sources.some((asset) => asset.id === assetId)) throw new Error("找不到待安插素材。");
      if (project.excludedMainAssetIds.includes(assetId)) throw new Error("素材已從正片移除，請先從最近移除區恢復。");
      if (!(["FRONT", "END", "BEFORE", "AFTER", "PENDING"] as const).includes(placement.action)) throw new Error("安插位置選項無效。");
      project.timelineOrder = project.timelineOrder.filter((id) => id !== assetId);
      project.pendingAssetIds = project.pendingAssetIds.filter((id) => id !== assetId);
      if (placement.action === "PENDING") project.pendingAssetIds.push(assetId);
      else {
        let index = placement.action === "FRONT" ? 0 : project.timelineOrder.length;
        if (placement.action === "BEFORE" || placement.action === "AFTER") {
          const anchorIndex = project.timelineOrder.indexOf(placement.anchorAssetId ?? "");
          if (anchorIndex < 0) throw new Error("安插位置的參考素材不存在。");
          index = anchorIndex + (placement.action === "AFTER" ? 1 : 0);
        }
        project.timelineOrder.splice(index, 0, assetId); project.sortMode = "MANUAL_ORDER"; this.bumpTimeline(project);
      }
      project.placementDecisions.push({ assetId, action: placement.action, anchorAssetId: placement.anchorAssetId, decidedAt: new Date().toISOString() });
    });
  }

  async moveTimelineAsset(assetId: string, toIndex: number): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const fromIndex = project.timelineOrder.indexOf(assetId);
      if (fromIndex < 0) throw new Error("素材不在已排定順序中。");
      const normalized = Math.max(0, Math.min(project.timelineOrder.length - 1, Math.round(toIndex)));
      if (normalized === fromIndex) return;
      project.timelineOrder.splice(fromIndex, 1); project.timelineOrder.splice(normalized, 0, assetId);
      project.sortMode = "MANUAL_ORDER"; this.bumpTimeline(project);
    });
  }

  async setSortMode(sortMode: SortMode): Promise<ProjectManifest> {
    return this.mutate((project) => {
      project.sortMode = sortMode;
      if (sortMode !== "MANUAL_ORDER") {
        const placed = project.sources.filter((asset) => project.timelineOrder.includes(asset.id));
        project.timelineOrder = sortAssets(placed, sortMode).map((asset) => asset.id); this.bumpTimeline(project);
      }
    });
  }

  async addBgmTracks(tracks: BgmTrack[]): Promise<ProjectManifest> { return this.mutate((project) => { for (const track of tracks) project.bgmTracks.push(validateBgmTrack(track)); }); }
  async resolveBgmTrack(trackId: string, resolved: BgmTrack): Promise<ProjectManifest> { return this.mutate((project) => {
    const index = project.bgmTracks.findIndex((track) => track.id === trackId);
    if (index < 0) throw new Error("找不到待補音檔的 YouTube 配樂參考。");
    if (project.bgmTracks[index].resolutionStatus !== "NEEDS_LOCAL_FILE") throw new Error("這個配樂項目已經有可用的本機音檔。");
    project.bgmTracks[index] = validateBgmTrack({ ...resolved, id: trackId, sourceUrl: project.bgmTracks[index].sourceUrl, rightsConfirmed: true });
    let cursor = 0;
    for (const track of project.bgmTracks) {
      if (track.resolutionStatus === "NEEDS_LOCAL_FILE") { track.timelineInMs = cursor; track.timelineOutMs = cursor; continue; }
      const span = track.sourceOutMs - track.sourceInMs;
      track.timelineInMs = cursor; track.timelineOutMs = cursor + span; cursor += span;
    }
  }); }
  async updateBgmTrack(track: BgmTrack): Promise<ProjectManifest> { return this.mutate((project) => {
    const index = project.bgmTracks.findIndex((item) => item.id === track.id); if (index < 0) throw new Error("找不到配樂項目。");
    const existing = project.bgmTracks[index];
    project.bgmTracks[index] = validateBgmTrack({
      ...existing,
      sourceInMs: track.sourceInMs, sourceOutMs: track.sourceOutMs, timelineInMs: track.timelineInMs, timelineOutMs: track.timelineOutMs,
      fadeInMs: track.fadeInMs, fadeOutMs: track.fadeOutMs, volumePercent: track.volumePercent,
    });
  }); }
  async removeBgmTrack(trackId: string): Promise<ProjectManifest> { return this.mutate((project) => { project.bgmTracks = project.bgmTracks.filter((track) => track.id !== trackId); }); }
  async moveBgmTrack(trackId: string, toIndex: number): Promise<ProjectManifest> { return this.mutate((project) => {
    const fromIndex = project.bgmTracks.findIndex((track) => track.id === trackId); if (fromIndex < 0) throw new Error("找不到配樂項目。");
    const [track] = project.bgmTracks.splice(fromIndex, 1); project.bgmTracks.splice(Math.max(0, Math.min(project.bgmTracks.length, Math.round(toIndex))), 0, track);
    let cursor = 0;
    for (const item of project.bgmTracks) {
      item.timelineInMs = cursor;
      if (item.resolutionStatus === "NEEDS_LOCAL_FILE") { item.timelineOutMs = cursor; continue; }
      item.timelineOutMs = cursor + item.sourceOutMs - item.sourceInMs; cursor = item.timelineOutMs;
    }
  }); }
  async sequenceBgmTracks(): Promise<ProjectManifest> { return this.mutate((project) => {
    if (project.bgmTracks.some((track) => track.resolutionStatus === "NEEDS_LOCAL_FILE")) throw new Error("仍有 YouTube 參考尚未指定自有或已授權的本機 MP3，無法連續排列。");
    let cursor = 0;
    for (const track of project.bgmTracks) {
      const span = track.sourceOutMs - track.sourceInMs;
      track.timelineInMs = cursor; track.timelineOutMs = cursor + span; cursor += span;
    }
  }); }
  async setSourceAudioVolume(volumePercent: number): Promise<ProjectManifest> { return this.mutate((project) => {
    project.sourceAudioVolumePercent = validatePercent(volumePercent, "素材原音音量");
  }); }
  async setSubtitleCues(cues: SubtitleCue[]): Promise<ProjectManifest> { return this.mutate((project) => {
    const normalized = validateSubtitleCues(cues);
    const mainDurationMs = mainRenderSelections(project).reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
    const introDurationMs = project.introSegments.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
    if (normalized.some((cue) => cue.timelineScope === "INTRO" ? cue.endMs > introDurationMs : cue.endMs > mainDurationMs)) throw new Error("字幕時間超出目前影片或所選片頭總時間，請調整 cue 或先完成影片順序。");
    project.subtitleCues = normalized; project.subtitleTimelineRevision = project.timelineRevision;
  }); }

  async replaceAiSubtitleDrafts(cues: SubtitleCue[], scopes: SubtitleTimelineScope[] = ["MAIN"]): Promise<ProjectManifest> { return this.mutate((project) => {
    if (!Array.isArray(cues) || cues.some((cue) => (cue.reviewStatus !== "DRAFT" && cue.reviewStatus !== "CONFIRMED") || (cue.origin !== "AI_SPEECH" && cue.origin !== "AI_VISUAL"))) throw new Error("AI 字幕格式無效。");
    const selectedScopes = new Set(scopes);
    const preserved = project.subtitleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" || !selectedScopes.has(cue.timelineScope ?? "MAIN"));
    const normalized = validateSubtitleCues([...preserved, ...cues]);
    const mainDurationMs = mainRenderSelections(project).reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
    const introDurationMs = project.introSegments.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0);
    if (normalized.some((cue) => cue.timelineScope === "INTRO" ? cue.endMs > introDurationMs : cue.endMs > mainDurationMs)) throw new Error("AI 字幕時間超出所選片頭或正片總時間。");
    project.subtitleCues = normalized;
    project.subtitleTimelineRevision = project.timelineRevision;
  }); }

  async setAiStoryContext(context: AiStoryContext): Promise<ProjectManifest> {
    return this.mutate((project) => {
      const normalized = normalizeAiStoryContext(context);
      if (normalized.introBaseAssetId && !project.sources.some((asset) => asset.id === normalized.introBaseAssetId && asset.kind === "VIDEO")) throw new Error("指定的片頭基底影片不存在或不是影片。");
      project.aiStoryContext = normalized;
    });
  }

  async setMusicSuggestionResult(result: MusicSuggestionResult): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (!result || typeof result !== "object" || !Array.isArray(result.suggestions)) throw new Error("AI 配樂建議格式無效。");
      project.musicSuggestionResult = structuredClone(result);
    }, false);
  }

  async setIntroAnalysisResult(result: IntroAnalysisResult): Promise<ProjectManifest> {
    return this.mutate((project) => {
      if (!result || typeof result !== "object" || !Array.isArray(result.suggestions)) throw new Error("AI 片頭分析結果格式無效。");
      project.introAnalysisResult = structuredClone(result);
    }, false);
  }

  async undo(): Promise<ProjectManifest> {
    return this.restoreHistory("UNDO");
  }

  async redo(): Promise<ProjectManifest> {
    return this.restoreHistory("REDO");
  }

  private resequenceMediaInsertions(project: ProjectManifest, anchorVideoAssetId: string): void {
    project.mediaInsertions
      .filter((item) => item.anchorVideoAssetId === anchorVideoAssetId)
      .sort((left, right) => left.atMs - right.atMs || left.sequenceIndex - right.sequenceIndex || left.createdAt.localeCompare(right.createdAt))
      .forEach((item, index) => { item.sequenceIndex = index; });
  }

  private virtualTimelineOrder(project: ProjectManifest): string[] {
    const order = [...project.timelineOrder];
    for (const insertion of project.mediaInsertions.filter((item) => item.previousPlacement !== "PENDING").sort((left, right) => left.previousTimelineIndex - right.previousTimelineIndex || left.sequenceIndex - right.sequenceIndex)) {
      order.splice(Math.max(0, Math.min(order.length, insertion.previousTimelineIndex)), 0, insertion.insertedAssetId);
    }
    return order;
  }

  private bumpTimeline(project: ProjectManifest): void { project.timelineRevision += 1; }
  private validateIntroSegments(project: ProjectManifest, segments: IntroSuggestion[]): IntroSuggestion[] {
    if (!Array.isArray(segments) || segments.length > INTRO_MAX_SEGMENTS) throw new Error(`片頭最多只能保留 ${INTRO_MAX_SEGMENTS} 段。`);
    const normalized = segments.map((segment) => {
      const asset = project.sources.find((item) => item.id === segment?.assetId);
      if (!segment || typeof segment.id !== "string" || !segment.id || !asset) throw new Error("片頭片段包含不存在的影片或照片來源。");
      const inMs = Math.round(segment.inMs); const outMs = Math.round(segment.outMs);
      const durationMs = asset.kind === "IMAGE" ? Math.max(MAX_IMAGE_DURATION_MS, asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS) : asset.mediaInfo?.durationMs;
      const clipDurationMs = outMs - inMs;
      const invalidImageDuration = asset.kind === "IMAGE" && (inMs !== 0 || clipDurationMs < MIN_IMAGE_DURATION_MS || clipDurationMs > MAX_IMAGE_DURATION_MS);
      if (!Number.isFinite(segment.inMs) || !Number.isFinite(segment.outMs) || inMs < 0 || clipDurationMs < INTRO_MIN_SEGMENT_MS || invalidImageDuration || (durationMs !== undefined && outMs > durationMs + 50)) {
        throw new Error(asset.kind === "IMAGE" ? `「${asset.fileName}」的片頭照片必須從 0:00 開始並顯示 3 到 ${MAX_IMAGE_DURATION_MS / 1000} 秒。` : `「${asset.fileName}」的片頭選取範圍至少需要 3 秒，且不可超出來源；超過每段輸出上限只會警示。`);
      }
      return { ...segment, fileName: asset.fileName, inMs, outMs, origin: segment.origin === "MANUAL" ? "MANUAL" as const : "AI" as const, score: Number.isFinite(segment.score) ? segment.score : 0, reasons: Array.isArray(segment.reasons) ? segment.reasons.filter((reason): reason is string => typeof reason === "string") : [] };
    });
    return normalized;
  }
  private async mutate(mutator: (project: ProjectManifest) => void, recordHistory = true): Promise<ProjectManifest> {
    let result!: ProjectManifest;
    const operation = this.writeChain.then(async () => {
      const previous = clone(this.current);
      const next = clone(this.current);
      mutator(next);
      const comparablePrevious = { ...previous, updatedAt: "" };
      const comparableNext = { ...next, updatedAt: "" };
      if (JSON.stringify(comparablePrevious) === JSON.stringify(comparableNext)) { result = this.getProject(); return; }
      next.updatedAt = new Date().toISOString();
      await this.persistProject(next);
      if (recordHistory) {
        this.undoStack.push(previous);
        if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
        this.redoStack = [];
      }
      this.current = next;
      result = this.getProject();
    });
    this.writeChain = operation.catch(() => undefined); await operation; return result;
  }

  private async restoreHistory(direction: "UNDO" | "REDO"): Promise<ProjectManifest> {
    let result!: ProjectManifest;
    const operation = this.writeChain.then(async () => {
      const source = direction === "UNDO" ? this.undoStack : this.redoStack;
      const destination = direction === "UNDO" ? this.redoStack : this.undoStack;
      const snapshot = source.pop();
      if (!snapshot) throw new Error(direction === "UNDO" ? "沒有可復原的上一步修改。" : "沒有可重做的下一步修改。");
      destination.push(clone(this.current));
      if (destination.length > this.historyLimit) destination.shift();
      const restored = { ...clone(snapshot), updatedAt: new Date().toISOString() };
      try {
        await this.persistProject(restored);
        this.current = restored;
        result = this.getProject();
      } catch (error) {
        destination.pop();
        source.push(snapshot);
        throw error;
      }
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private async queueProjectFileOperation<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const queued = this.writeChain.then(async () => { result = await operation(); });
    this.writeChain = queued.catch(() => undefined);
    await queued;
    return result;
  }

  private async readProjectFile(filePath: string): Promise<ProjectManifest> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(filePath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("找不到指定的專案檔。");
      throw new Error(`無法讀取專案檔：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!looksLikeProject(parsed)) throw new Error("專案檔格式或 schema 不相容；目前專案未變更。");
    return migrateProject(parsed);
  }

  private async persistProject(project: ProjectManifest, explicitPath = this.activeProjectPath): Promise<void> {
    if (explicitPath) await this.writeProjectFile(explicitPath, project);
    await this.writeProjectFile(this.manifestPath, project);
  }

  private async writeSessionPointer(filePath: string): Promise<void> {
    await this.writeJsonFile(this.sessionPath, { filePath });
  }

  private async writeProjectFile(filePath: string, project: ProjectManifest): Promise<void> {
    await this.writeJsonFile(filePath, project);
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const partialPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.partial`);
    try {
      await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await finalizePartialOutput(partialPath, filePath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }
}
