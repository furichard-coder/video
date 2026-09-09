export const MANIFEST_SCHEMA_VERSION = 16 as const;
export const PREVIEWER_VERSION = "preview-v3" as const;
export const CLIP_PREVIEWER_VERSION = "clip-preview-v1" as const;
export const DEFAULT_IMAGE_DURATION_MS = 5_000 as const;
export const MIN_IMAGE_DURATION_MS = 3_000 as const;
export const MAX_IMAGE_DURATION_MS = 7_000 as const;
export const PHOTO_INSERTION_EDGE_MARGIN_MS = 750 as const;
export const DUNES_SHUTTER_EFFECT_ID = "DUNES_CAMERA_SHUTTER_CLICK_14671" as const;
export const DUNES_SHUTTER_EFFECT_SHA256 = "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93" as const;
export const PHOTO_SOUND_PREVIEW_URL = "preview-media://asset/dunes-shutter.mp3" as const;
export const DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT = 100 as const;
export const DEFAULT_BGM_VOLUME_PERCENT = 35 as const;
export const MAX_MIX_VOLUME_PERCENT = 300 as const;
export const DEFAULT_INTRO_TARGET_DURATION_MS = 90_000 as const;
export const DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS = 15_000 as const;
export const INTRO_DURATION_WARNING_MS = 180_000 as const;
export const INTRO_MAX_SEGMENTS = 50 as const;
export const INTRO_MIN_SEGMENT_MS = 3_000 as const;
export const INTRO_MAX_SEGMENT_MS = 22_000 as const;
/** Internal scale percentage. 100 means the user-facing 0% enlargement. */
export const DEFAULT_ZOOM_PERCENT = 100 as const;
export const MIN_ZOOM_PERCENT = 100 as const;
export const MAX_ZOOM_PERCENT = 400 as const;
export const DEFAULT_ZOOM_ENHANCEMENT_PRESET = "BALANCED" as const;
export const DEFAULT_MAIN_START_CARD_DURATION_SEC = 3 as const;

export type SourceKind = "VIDEO" | "IMAGE";
export type SourcePolicy = "READ_ONLY";
export type PreviewPolicy = "DERIVED_CACHE_ONLY_NOT_MASTER";
export type MetadataState = "PENDING" | "READY" | "FAILED";
export type SortMode = "MANUAL_ORDER" | "SMART_SEQUENCE" | "FILE_NAME" | "CAPTURE_OR_FILE_TIME" | "ADDED_ORDER";
export type ViewMode = "GRID" | "LIST";
export type PreviewVariant = "THUMBNAIL" | "IMAGE_PREVIEW" | "VIDEO_PROXY" | "VIDEO_CLIP_PROXY";
export type CacheStatus = "HIT" | "CREATED" | "INVALIDATED";
export type TransitionDurationSec = 0.3 | 0.5 | 0.7;
export type MainStartCardTransition = "DISSOLVE" | "FADE_BLACK" | "HARD_CUT";
export type PreviewResolution = "360P" | "480P" | "720P" | "4K";
export type ConcatRenderPhase = "PREPARING" | "TRANSLATING_SUBTITLES" | "RENDERING" | "FINALIZING";
export type PreviewRenderPurpose = "CONCAT" | "INTRO" | "CLIP" | "SHORTS";
export type IntroAnalysisPhase = "PREPARING" | "ANALYZING" | "RANKING";
export type KnownExternalPlayerId = "SYSTEM_DEFAULT" | "VLC" | "WINDOWS_MEDIA_PLAYER" | "MPC_HC";
export type ExternalPlayerId = KnownExternalPlayerId | `CUSTOM:${string}`;
export type ExternalMediaTarget = "PROXY" | "ORIGINAL";
export type ExternalOpenStatus = "OPENED" | "FALLBACK_SYSTEM_DEFAULT" | "USE_INTERNAL";
export type AiProviderKind = "OPENAI";
export type AiCredentialStatus = "SAVED_ENCRYPTED" | "ENVIRONMENT" | "MISSING";
export type SubtitleCueOrigin = "MANUAL" | "IMPORTED_SRT" | "AI_SPEECH" | "AI_VISUAL";
export type SubtitleCueReviewStatus = "DRAFT" | "CONFIRMED" | "REJECTED";
export type SubtitleTimelineScope = "INTRO" | "MAIN";
export type AiAnalysisPhase = "PREPARING" | "EXTRACTING_AUDIO" | "TRANSCRIBING" | "SAMPLING_FRAMES" | "MATCHING_STORY" | "SAVING_DRAFTS";
export type YoutubeBrowser = "CHROME" | "EDGE";
export type YoutubePrivacyStatus = "unlisted" | "private";
export type YoutubeUploadPhase = "AUTHORIZING" | "STARTING" | "UPLOADING" | "FINALIZING";
export type BrowserUploadPlatform = "BILIBILI" | "TIKTOK";
export type PreviewOutputOrigin = "APP_RENDERED" | "IMPORTED_EXISTING";
export type PreviewOutputPurpose = PreviewRenderPurpose | "UNKNOWN";
export type VoiceInputLanguage = "zh-TW" | "en-US";
export type SubtitleRenderLanguage = "zh-TW" | "zh-CN" | "en" | "ja" | "ko";
export type SubtitleRenderPosition = "TOP" | "MIDDLE" | "BOTTOM";
export type SubtitleTranslationProvider = "ORIGINAL" | "OPENAI" | "GOOGLE_CLOUD";
export type ColorPresetId = "NATURAL" | "WARM_GOLDEN" | "COOL_CLEAR" | "VIVID_TRAVEL" | "WARM_VIVID";
export type WatermarkCorner = "LOWER_LEFT" | "LOWER_RIGHT";
export type WatermarkTextLayout = "STACKED_TWO_LINES" | "SINGLE_LINE";
export type ZoomEnhancementPreset = "OFF" | "BALANCED" | "DETAIL" | "DENOISE";
export type MusicSuggestionPlatform = "YOUTUBE" | "TIKTOK";
export type MusicSuggestionProvider = "OPENAI_API" | "CODEX_CHATGPT";
export type PreferenceDirectoryKey =
  | "SOURCE_MEDIA"
  | "SOURCE_FOLDER"
  | "INTRO_MEDIA"
  | "PROJECT"
  | "PREVIEW_OUTPUT"
  | "OUTPUT_HISTORY"
  | "SUBTITLE_OUTPUT"
  | "SUBTITLE_INPUT"
  | "BGM"
  | "CUSTOM_PLAYER"
  | "OAUTH_CLIENT";

export interface MainStartCardOptions {
  durationSeconds: number;
  line1: string;
  line2: string;
  line1FontSize1080p: number;
  line2FontSize1080p: number;
  lineGap1080p: number;
  overlayOpacityPercent: number;
  transitionStyle: MainStartCardTransition;
  /** Empty/undefined keeps the first Main clip; otherwise resolves a current confirmed Intro segment by ID. */
  backgroundIntroSegmentId?: string;
}

export const DEFAULT_MAIN_START_CARD_OPTIONS: MainStartCardOptions = {
  durationSeconds: DEFAULT_MAIN_START_CARD_DURATION_SEC,
  line1: "漫步風光",
  line2: "旅程開始",
  line1FontSize1080p: 114,
  line2FontSize1080p: 90,
  lineGap1080p: 122,
  overlayOpacityPercent: 62,
  transitionStyle: "DISSOLVE",
};

export interface UserPreferences {
  schemaVersion: 1;
  viewMode: ViewMode;
  renderDefaults: {
    transitionSeconds: TransitionDurationSec;
    resolution: PreviewResolution;
    prependIntro: boolean;
    autoUpload: boolean;
    introPreviewIncludeBgm: boolean;
    mainPreviewIncludeBgm: boolean;
    mainStartCard: MainStartCardOptions;
  };
  youtubeUploadDefaults: {
    privacyStatus: YoutubePrivacyStatus;
  };
  voiceInputLanguage: VoiceInputLanguage;
  subtitleBurnInDefaults: SubtitleBurnInOptions;
  subtitleGenerationScope: SubtitleGenerationScope;
  subtitlePreviewStyle: SubtitlePreviewStyle;
  musicSuggestionDefaults: {
    includeTikTokTrending: boolean;
    royaltyFreeOnly: boolean;
  };
  lastDirectories: Partial<Record<PreferenceDirectoryKey, string>>;
  updatedAt: string;
}

export interface UserPreferencesUpdate {
  viewMode?: ViewMode;
  renderDefaults?: Partial<UserPreferences["renderDefaults"]>;
  youtubeUploadDefaults?: Partial<UserPreferences["youtubeUploadDefaults"]>;
  voiceInputLanguage?: VoiceInputLanguage;
  subtitleBurnInDefaults?: SubtitleBurnInOptions;
  subtitleGenerationScope?: SubtitleGenerationScope;
  subtitlePreviewStyle?: SubtitlePreviewStyle;
  musicSuggestionDefaults?: Partial<UserPreferences["musicSuggestionDefaults"]>;
}

export interface MusicSuggestionRequest {
  includeTikTokTrending: boolean;
  royaltyFreeOnly: boolean;
}

export interface MusicSuggestion {
  id: string;
  platform: MusicSuggestionPlatform;
  title: string;
  artist?: string;
  reason: string;
  auditionUrl: string;
  evidenceUrl: string;
  observedAt?: string;
  trendEvidence?: string;
  rightsEvidence?: string;
  rightsStatus: "REVIEW_REQUIRED";
}

export interface MusicSuggestionResult {
  provider: MusicSuggestionProvider;
  accountName: string;
  generatedAt: string;
  topicSummary: string;
  royaltyFreeOnly: boolean;
  suggestions: MusicSuggestion[];
  warnings: string[];
}

export interface SubtitleGenerationScope {
  intro: boolean;
  main: boolean;
}

/** Shared style profile used by renderer previews and final subtitle burn-in. */
export interface SubtitleStyleProfile {
  verticalPositionPercent: number;
  fontSizePx: number;
  textColor: string;
  shadowEnabled: boolean;
  outlineWidthPx: number;
}

/** Backwards-compatible name used by existing preference and renderer code. */
export type SubtitlePreviewStyle = SubtitleStyleProfile;

export interface VoiceInputRequest {
  audioBytes: Uint8Array;
  mimeType: string;
  language: VoiceInputLanguage;
}

export interface VoiceInputResult {
  text: string;
  language: VoiceInputLanguage;
  segmentCount: number;
}

export interface SubtitleBurnInTrack {
  language: SubtitleRenderLanguage;
  position: SubtitleRenderPosition;
  fontSize1080p: number;
}

export interface SubtitleBurnInOptions {
  enabled: boolean;
  tracks: SubtitleBurnInTrack[];
  /** Optional shared preview/burn-in style. Older manifests/preferences omit it. */
  styleProfile?: SubtitleStyleProfile;
}

export interface TranslationSettingsSnapshot {
  schemaVersion: 1;
  googleCloudConfigured: boolean;
  encryptionAvailable: boolean;
}

export interface TranslationSettingsUpdate {
  googleCloudApiKey?: string;
  clearGoogleCloudApiKey?: boolean;
}

export interface TranslationConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface AppInfo {
  version: string;
  productName: string;
}

export interface ProjectHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}

export interface BasicMediaInfo {
  width?: number;
  height?: number;
  durationMs?: number;
  frameRate?: string;
  videoCodec?: string;
  audioCodec?: string;
  captureTime?: string;
  rotationDegrees?: number;
  displayWidth?: number;
  displayHeight?: number;
  isPortrait?: boolean;
}

export interface PreviewRange {
  inMs: number;
  outMs: number;
}

export interface VolumeSegment {
  id: string;
  startMs: number;
  endMs: number;
  volumePercent: number;
}

export interface MainExclusionRange {
  id: string;
  startMs: number;
  endMs: number;
}

export interface ZoomSegment {
  id: string;
  startMs: number;
  endMs: number;
  zoomPercent: number;
  centerXPercent: number;
  centerYPercent: number;
  enhancementPreset?: ZoomEnhancementPreset;
}

export interface SourceAsset {
  id: string;
  sourcePath: string;
  sourceIdentity: string;
  fileName: string;
  extension: string;
  kind: SourceKind;
  sizeBytes: number;
  fileCreatedAt: string;
  fileModifiedAt: string;
  addedAt: string;
  addedOrder: number;
  sourcePolicy: SourcePolicy;
  previewPolicy: PreviewPolicy;
  previewCacheKey: string;
  metadataState: MetadataState;
  metadataError?: string;
  mediaInfo?: BasicMediaInfo;
  imageDurationMs?: number;
  photoSoundEnabled?: boolean;
  previewRange?: PreviewRange;
  volumeSegments?: VolumeSegment[];
  mainExclusionRanges?: MainExclusionRange[];
  zoomSegments?: ZoomSegment[];
}

export interface MediaInsertion {
  id: string;
  anchorVideoAssetId: string;
  insertedAssetId: string;
  atMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  sequenceIndex: number;
  previousPlacement: "TIMELINE" | "PENDING";
  previousTimelineIndex: number;
  previousPendingIndex?: number;
  createdAt: string;
}

export interface PhotoSoundEffectConfig {
  id: typeof DUNES_SHUTTER_EFFECT_ID;
  displayName: string;
  sourceProject: string;
  sourceUrl: string;
  licenseUrl: string;
  sha256: typeof DUNES_SHUTTER_EFFECT_SHA256;
  volumePercent: 70;
}

export type PlacementAction = "FRONT" | "END" | "BEFORE" | "AFTER" | "PENDING";

export interface PlacementDecision {
  assetId: string;
  action: PlacementAction;
  anchorAssetId?: string;
  decidedAt: string;
}

export interface PlacementRequest {
  action: PlacementAction;
  anchorAssetId?: string;
}

export interface BgmTrack {
  id: string;
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  durationMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  timelineInMs: number;
  timelineOutMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  volumePercent: number;
  sourcePolicy: SourcePolicy;
  addedAt: string;
  sourceKind?: "LOCAL_FILE" | "YOUTUBE_REFERENCE";
  resolutionStatus?: "READY" | "NEEDS_LOCAL_FILE";
  sourceUrl?: string;
  rightsConfirmed?: boolean;
}

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Older manifests omit this field and are treated as MAIN. */
  timelineScope?: SubtitleTimelineScope;
  origin?: SubtitleCueOrigin;
  reviewStatus?: SubtitleCueReviewStatus;
  /** Set when a human changes text/time or explicitly protects a cue from AI regeneration. */
  userEdited?: boolean;
  speaker?: string;
  sourceAssetId?: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  visualSummary?: string;
  eventSummary?: string;
  peopleSummary?: string[];
  locationSummary?: string[];
  topicRelevanceScore?: number;
  transcriptVisualMatchScore?: number;
  aiConfidence?: number;
  aiWarnings?: string[];
  aiAnalysisVersion?: string;
}

export interface AiStoryContext {
  topic: string;
  locations: string[];
  people: string[];
  storySummary: string;
  audiencePromise: string;
  subtitleLanguage: string;
  introPrompt?: string;
  introBaseAssetId?: string;
}

export type PublishAiProvider = "OPENAI_API" | "CODEX_CHATGPT" | "MANUAL" | "LOCAL_FALLBACK";
export type PublishRegenerationMode = "FILL_BLANKS" | "PRESERVE_USER_EDITED" | "REPLACE_AI_DRAFTS";
export interface PublishTopicSnapshot {
  topic: string;
  locations: string[];
  storySummary: string;
  audiencePromise: string;
  capturedAt: string;
}
export interface PublishTitleCandidate {
  id: string;
  text: string;
  charCount: number;
  reason: string;
  userEdited?: boolean;
}
export interface ThumbnailStyle {
  text: string;
  textXPercent: number;
  textYPercent: number;
  fontSizePx: number;
  textColor: string;
  outlineWidthPx: number;
  overlayOpacityPercent: number;
}
export interface ThumbnailCandidate {
  id: string;
  assetId: string;
  sourceTimeMs: number;
  sourceFileName: string;
  reason: string;
  layout: "LEFT_TEXT" | "RIGHT_TEXT" | "CENTER_TEXT";
  colorNote: string;
  previewUrl?: string;
  outputPath?: string;
  importedPath?: string;
  style: ThumbnailStyle;
  userEdited?: boolean;
}
export interface PublishChapterCue {
  id: string;
  startMs: number;
  title: string;
  description: string;
  sourceAssetId?: string;
  userEdited?: boolean;
}
export interface AiPublishAssets {
  schemaVersion: 1;
  topicSnapshot: PublishTopicSnapshot;
  titles: PublishTitleCandidate[];
  description: string;
  englishSummary: string;
  hashtags: string[];
  thumbnails: ThumbnailCandidate[];
  chapters: PublishChapterCue[];
  selectedTitleId?: string;
  selectedThumbnailId?: string;
  provider: PublishAiProvider;
  model?: string;
  analyzerVersion: string;
  generatedAt: string;
  mainTimelineRevision: number;
  introTimelineRevision?: number;
  stale: boolean;
  userEdited: boolean;
  warnings: string[];
}
export interface AiPublishGenerationOptions {
  topic: PublishTopicSnapshot;
  mode?: PublishRegenerationMode;
}
export interface AiPublishGenerationResult {
  project: ProjectManifest;
  assets: AiPublishAssets;
  provider: PublishAiProvider;
  model?: string;
}
export interface PublishProgress { percent: number; detail: string; }
export interface ThumbnailRenderRequest {
  candidateId: string;
  outputToken: string;
  format: "jpg" | "png";
  quality?: number;
}
export interface ThumbnailRenderResult {
  candidateId: string;
  outputPath: string;
  sizeBytes: number;
  width: 1280;
  height: 720;
  format: "jpg" | "png";
}

export interface ProjectColorSettings {
  introPresetId: ColorPresetId;
  applyToMain: boolean;
}

export interface WatermarkTextSettings {
  text: string;
  position: WatermarkCorner;
  layout: WatermarkTextLayout;
  fontSize1080p: number;
}

export interface WatermarkSettings {
  enabled: boolean;
  chinese: WatermarkTextSettings;
  english: WatermarkTextSettings;
  /** Seconds from output start to the first appearance. */
  startSeconds: number;
  /** Seconds from one appearance start to the next appearance start. */
  intervalSeconds: number;
  visibleDurationSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  textOpacityPercent: number;
  boxOpacityPercent: number;
  safeMargin1080p: number;
  applyToMain: boolean;
  applyToIntro: boolean;
  applyToShorts: boolean;
}

export interface AiSubtitleGenerationOptions {
  includeSpeechTranscription: boolean;
  scopes?: SubtitleTimelineScope[];
  /** How a subsequent AI pass treats existing AI cues in the selected scope. */
  mode?: "FILL_BLANKS" | "REPLACE_AI_SCOPE" | "PRESERVE_USER_EDITED";
}

export interface SubtitlePreviewResult {
  cacheKey: string;
  cacheStatus: CacheStatus;
  durationMs: number;
  url: string;
  outputPath: string;
  sizeBytes: number;
  bgmIncluded: boolean;
}

export interface ProjectManifest {
  schemaVersion: number;
  id: string;
  name: string;
  sourcePolicy: SourcePolicy;
  previewPolicy: PreviewPolicy;
  previewerVersion: typeof PREVIEWER_VERSION;
  sortMode: SortMode;
  createdAt: string;
  updatedAt: string;
  sources: SourceAsset[];
  timelineOrder: string[];
  pendingAssetIds: string[];
  excludedMainAssetIds: string[];
  recentMainRemovals: RemovedMainAsset[];
  introSegments: IntroSuggestion[];
  introTargetDurationMs: number;
  introSegmentMaxDurationMs: number;
  colorSettings: ProjectColorSettings;
  watermarkSettings?: WatermarkSettings;
  introExcludedSegmentIds: string[];
  recentIntroRemovals: RemovedIntroSegment[];
  placementDecisions: PlacementDecision[];
  mediaInsertions: MediaInsertion[];
  photoSoundEffect: PhotoSoundEffectConfig;
  bgmTracks: BgmTrack[];
  sourceAudioVolumePercent?: number;
  aiStoryContext: AiStoryContext;
  aiPublishAssets?: AiPublishAssets;
  /** Last completed intro analysis; suggestions remain pending until the user applies them. */
  introAnalysisResult?: IntroAnalysisResult;
  /** Last manual AI music discovery for this project; never used as a licensed audio source. */
  musicSuggestionResult?: MusicSuggestionResult;
  subtitleCues: SubtitleCue[];
  timelineRevision: number;
  subtitleTimelineRevision: number;
  mainTimelineRevision?: number;
  introTimelineRevision?: number;
  mainSubtitleReviewRevision?: number;
  introSubtitleReviewRevision?: number;
  audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95";
}

export interface ImportProgress {
  phase: "DISCOVERING" | "ADDING";
  discovered: number;
  processed: number;
  currentName?: string;
}

export interface ImportResult {
  cancelled: boolean;
  addedCount: number;
  duplicateCount: number;
  unsupportedCount: number;
  errors: string[];
  project: ProjectManifest;
  addedAssetIds: string[];
}

export interface PreviewRangeUpdateResult {
  asset: SourceAsset;
  adjustedVolumeSegmentCount: number;
  adjustedMainExclusionRangeCount: number;
  adjustedZoomSegmentCount: number;
  project: ProjectManifest;
}

export interface MainExclusionRangeUpdateResult {
  asset: SourceAsset;
  mergedRangeCount: number;
  project: ProjectManifest;
}

export interface ZoomSegmentUpdateResult {
  asset: SourceAsset;
  project: ProjectManifest;
}

export interface ImageDurationUpdateResult {
  asset: SourceAsset;
  project: ProjectManifest;
}

export interface ProjectFileResult {
  project: ProjectManifest;
  filePath: string;
}

export interface ProjectFileState {
  filePath?: string;
}

export interface BgmImportResult {
  cancelled: boolean;
  addedCount: number;
  errors: string[];
  project: ProjectManifest;
}

export interface SubtitleExportResult {
  outputPath: string;
  cueCount: number;
}

export interface SubtitleImportResult {
  filePath: string;
  fileName: string;
  cues: SubtitleCue[];
}

export interface PreviewResult {
  assetId: string;
  variant: PreviewVariant;
  url: string;
  cacheStatus: CacheStatus;
  sourceStartMs?: number;
  sourceEndMs?: number;
}

export interface OutputSelection {
  token: string;
  displayPath: string;
  automatic?: boolean;
}

export interface ConcatRenderRequest {
  outputToken: string;
  orderedAssetIds: string[];
  clipSelections?: RenderClipSelection[];
  transitionSeconds: TransitionDurationSec;
  resolution: PreviewResolution;
  purpose?: PreviewRenderPurpose;
  prependIntro?: boolean;
  subtitleBurnIn?: SubtitleBurnInOptions;
  /** Internal review proxies can opt out so offline BGM never blocks picture/subtitle checking. */
  includeBgm?: boolean;
  /** Required by the UI whenever a confirmed Intro is prepended to Main. */
  mainStartCard?: MainStartCardOptions;
  shortsPortrait?: boolean;
  shortsMaxDurationSec?: 60 | 180;
  shortsSource?: "INTRO" | "MAIN";
}

export interface RenderClipSelection extends PreviewRange {
  assetId: string;
  mediaInsertionId?: string;
}

export interface ConcatRenderProgress {
  phase: ConcatRenderPhase;
  percent: number;
  outTimeMs: number;
  expectedDurationMs: number;
}

export interface ConcatRenderResult {
  jobId: string;
  outputPath: string;
  sizeBytes: number;
  expectedDurationMs: number;
  transitionSeconds: TransitionDurationSec;
  resolution: PreviewResolution;
  purpose: PreviewRenderPurpose;
  bgmAppliedCount?: number;
  photoShutterAppliedCount?: number;
  mixPolicy?: "ORIGINAL_PLUS_BGM_LIMITED_0_95";
  cancelled?: boolean;
  plannedDurationMs?: number;
  includedIntroSegmentCount?: number;
  subtitleBurnedLanguages?: SubtitleRenderLanguage[];
  subtitleTranslationProviders?: SubtitleTranslationProvider[];
  colorPresetId?: ColorPresetId;
  colorAppliedToMain?: boolean;
  watermarkApplied?: boolean;
  mainStartCardDurationSeconds?: number;
  shortsPortrait?: boolean;
  aspectRatio?: "PORTRAIT_9_16" | "LANDSCAPE_16_9";
}

export interface PreviewOutputRecord {
  jobId: string;
  outputPath: string;
  fileName: string;
  purpose: PreviewOutputPurpose;
  origin: PreviewOutputOrigin;
  createdAt: string;
  sizeBytes: number;
  durationMs?: number;
  resolution?: PreviewResolution;
  cancelled?: boolean;
  includedIntroSegmentCount?: number;
  projectName?: string;
  exists: boolean;
  aspectRatio?: "PORTRAIT_9_16" | "LANDSCAPE_16_9";
}

export interface PreviewOutputHistorySnapshot {
  schemaVersion: 1;
  outputs: PreviewOutputRecord[];
}

export interface PreviewOutputImportResult {
  cancelled: boolean;
  addedCount: number;
  duplicateCount: number;
  errors: string[];
  history: PreviewOutputHistorySnapshot;
}

export interface IntroSuggestion extends RenderClipSelection {
  id: string;
  fileName: string;
  score: number;
  reasons: string[];
  origin?: "AI" | "MANUAL";
  previewUrl?: string;
  analysisMode?: "LOCAL_SIGNAL_ONLY" | "OPENAI_STORY_MATCH";
  storyRelevanceScore?: number;
  eventSummary?: string;
  peopleSummary?: string[];
  locationSummary?: string[];
  spokenSummary?: string;
  aiConfidence?: number;
  aiWarnings?: string[];
}

export interface RemovedMainAsset {
  assetId: string;
  previousTimelineIndex: number | null;
  wasPending: boolean;
  previousSortMode: SortMode;
  removedAt: string;
}

export interface RemovedIntroSegment {
  segment: IntroSuggestion;
  previousIndex: number;
  removedAt: string;
}

export interface IntroAnalysisProgress {
  phase: IntroAnalysisPhase;
  processed: number;
  total: number;
  currentName?: string;
}

export interface IntroAnalysisResult {
  analyzerVersion: string;
  analyzedAssetCount: number;
  cacheHits: number;
  generatedAt: string;
  suggestions: IntroSuggestion[];
  analysisMode?: "LOCAL_SIGNAL_ONLY" | "OPENAI_STORY_MATCH";
  cloudAnalyzedCount?: number;
  cloudFallbackReason?: string;
}

export type BackgroundJobKind = "MUSIC_SUGGESTIONS" | "INTRO_ANALYSIS" | "AI_SUBTITLES" | "SUBTITLE_PREVIEW" | "CONCAT_RENDER" | "AI_PUBLISH_ASSETS";
export type BackgroundJobStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface BackgroundJobSnapshot {
  id: string;
  kind: BackgroundJobKind;
  label: string;
  status: BackgroundJobStatus;
  startedAt: string;
  finishedAt?: string;
  percent?: number;
  detail?: string;
  error?: string;
  projectId?: string;
  projectName?: string;
  projectRevision?: number;
}

export type ProjectChangeSection = "SOURCES" | "MAIN_TIMELINE" | "INTRO_TIMELINE" | "BGM" | "SUBTITLES" | "AI_CONTEXT" | "SETTINGS" | "OUTPUTS";
export interface ProjectChangedEvent {
  projectId: string;
  revision: number;
  updatedAt: string;
  changedSections: ProjectChangeSection[];
  project: ProjectManifest;
  filePath?: string;
}

export interface AiAccountProfile {
  id: string;
  name: string;
  provider: AiProviderKind;
  visionModel: string;
  transcriptionModel: string;
  credentialStatus: AiCredentialStatus;
  updatedAt: string;
}

export interface AiSettingsSnapshot {
  schemaVersion: 1;
  activeAccountId: string;
  accounts: AiAccountProfile[];
  encryptionAvailable: boolean;
  codexLoginReusable: boolean;
}

export interface AiAccountSaveInput {
  id?: string;
  name: string;
  provider: AiProviderKind;
  visionModel: string;
  transcriptionModel: string;
  apiKey?: string;
  clearApiKey?: boolean;
  makeActive?: boolean;
}

export interface AiConnectionTestResult {
  ok: boolean;
  accountId: string;
  providerLabel: string;
  message: string;
  checks?: string[];
  requestIds?: string[];
}

export interface AiAnalysisProgress {
  phase: AiAnalysisPhase;
  processed: number;
  total: number;
  currentName?: string;
}

export interface AiSubtitleGenerationResult {
  project: ProjectManifest;
  generatedCount: number;
  transcribedCount: number;
  visualOnlyCount: number;
  skippedConfirmedCount: number;
  accountName: string;
  analysisVersion: string;
  providerLabel?: "OPENAI_API" | "CODEX_CHATGPT";
}

export interface YoutubeBrowserOption {
  id: YoutubeBrowser;
  label: string;
  available: boolean;
  executablePath?: string;
}

export interface YoutubeSettingsSnapshot {
  schemaVersion: 1;
  preferredBrowser: YoutubeBrowser;
  targetChannelName: string;
  clientConfigured: boolean;
  connected: boolean;
  clientIdHint?: string;
  channelId?: string;
  channelTitle?: string;
  connectedAt?: string;
  encryptionAvailable: boolean;
  browsers: YoutubeBrowserOption[];
}

export interface YoutubeSettingsUpdate {
  preferredBrowser: YoutubeBrowser;
  targetChannelName: string;
}

export interface YoutubeUploadRequest {
  jobId: string;
  title: string;
  description: string;
  privacyStatus: YoutubePrivacyStatus;
  madeForKids: boolean;
  thumbnailPath?: string;
}

export interface YoutubeUploadProgress {
  phase: YoutubeUploadPhase;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

export interface YoutubeUploadResult {
  videoId: string;
  videoUrl: string;
  title: string;
  requestedPrivacyStatus: YoutubePrivacyStatus;
  channelId?: string;
  channelTitle?: string;
  thumbnailStatus?: "NOT_REQUESTED" | "UPLOADED" | "FAILED";
  thumbnailError?: string;
}

export interface PlatformUploadHandoffResult {
  platform: BrowserUploadPlatform;
  outputPath: string;
  uploadUrl: string;
  message: string;
}

export interface PlatformPortalResult {
  platform: BrowserUploadPlatform;
  uploadUrl: string;
  message: string;
}

export interface CustomPlayerDefinition {
  id: `CUSTOM:${string}`;
  name: string;
  executablePath: string;
}

export interface ExternalPlayerSettings {
  schemaVersion: 1;
  defaultPlayerId: ExternalPlayerId;
  extensionOverrides: Record<string, ExternalPlayerId>;
  customPlayers: CustomPlayerDefinition[];
  updatedAt: string;
}

export interface ExternalPlayerSettingsUpdate {
  defaultPlayerId: ExternalPlayerId;
  extensionOverrides: Record<string, ExternalPlayerId>;
}

export interface ExternalPlayerOption {
  id: ExternalPlayerId;
  label: string;
  kind: "SYSTEM" | "KNOWN" | "CUSTOM";
  available: boolean;
  executablePath?: string;
  detail?: string;
}

export interface ExternalPlayerSettingsSnapshot {
  settings: ExternalPlayerSettings;
  players: ExternalPlayerOption[];
}

export interface ExternalOpenResult {
  status: ExternalOpenStatus;
  target: ExternalMediaTarget;
  playerLabel: string;
  message?: string;
}

export interface AppApi {
  getAppInfo(): Promise<AppInfo>;
  confirmAppClose(): void;
  onAppCloseRequested(callback: () => void): void;
  clearAppCloseRequestedListeners(): void;
  getUserPreferences(): Promise<UserPreferences>;
  getBackgroundJobs?(): Promise<BackgroundJobSnapshot[]>;
  onBackgroundJobs?(callback: (jobs: BackgroundJobSnapshot[]) => void): void;
  clearBackgroundJobsListeners?(): void;
  onProjectChanged?(callback: (event: ProjectChangedEvent) => void): void;
  clearProjectChangedListeners?(): void;
  updateUserPreferences(update: UserPreferencesUpdate): Promise<UserPreferences>;
  getProject(): Promise<ProjectManifest>;
  getProjectHistoryState(): Promise<ProjectHistoryState>;
  undoProject(): Promise<ProjectManifest>;
  redoProject(): Promise<ProjectManifest>;
  chooseFiles(): Promise<ImportResult>;
  chooseFolder(): Promise<ImportResult>;
  chooseIntroFiles(): Promise<ImportResult>;
  cancelImport(): Promise<void>;
  getProjectFileState(): Promise<ProjectFileState>;
  saveProject(): Promise<ProjectFileResult>;
  saveProjectAs(): Promise<ProjectFileResult | null>;
  openProject(): Promise<ProjectFileResult | null>;
  removeMainAsset(assetId: string): Promise<ProjectManifest>;
  restoreMainAsset(assetId: string): Promise<ProjectManifest>;
  setIntroSegments(segments: IntroSuggestion[]): Promise<ProjectManifest>;
  setIntroTargetDuration(durationMs: number): Promise<ProjectManifest>;
  setIntroSegmentMaxDuration(durationMs: number): Promise<ProjectManifest>;
  removeIntroSegment(segmentId: string): Promise<ProjectManifest>;
  restoreIntroSegment(segmentId: string): Promise<ProjectManifest>;
  setPreviewRange(assetId: string, range: PreviewRange): Promise<PreviewRangeUpdateResult>;
  setImageDuration(assetId: string, durationMs: number): Promise<ImageDurationUpdateResult>;
  setPhotoSoundEnabled(assetId: string, enabled: boolean): Promise<ProjectManifest>;
  addMediaInsertion(anchorVideoAssetId: string, insertedAssetId: string, atMs: number, sourceRange?: PreviewRange): Promise<ProjectManifest>;
  updateMediaInsertion(insertionId: string, atMs: number, sourceRange: PreviewRange): Promise<ProjectManifest>;
  removeMediaInsertion(insertionId: string): Promise<ProjectManifest>;
  moveMediaInsertion(insertionId: string, toIndex: number): Promise<ProjectManifest>;
  setVolumeSegments(assetId: string, segments: VolumeSegment[]): Promise<SourceAsset>;
  setMainExclusionRanges(assetId: string, ranges: MainExclusionRange[]): Promise<MainExclusionRangeUpdateResult>;
  setZoomSegments(assetId: string, segments: ZoomSegment[]): Promise<ZoomSegmentUpdateResult>;
  placeAsset(assetId: string, placement: PlacementRequest): Promise<ProjectManifest>;
  moveTimelineAsset(assetId: string, toIndex: number): Promise<ProjectManifest>;
  setSortMode(mode: SortMode): Promise<ProjectManifest>;
  ensureMetadata(assetId: string): Promise<SourceAsset>;
  ensurePreview(assetId: string, variant: PreviewVariant): Promise<PreviewResult>;
  ensureClipPreview(assetId: string, inMs: number, outMs: number): Promise<PreviewResult>;
  cancelPreview(assetId: string, variant: PreviewVariant): Promise<void>;
  cancelClipPreview(assetId: string, inMs: number, outMs: number): Promise<void>;
  chooseConcatOutput(suggestedName: string): Promise<OutputSelection | null>;
  prepareConcatOutput(suggestedName: string): Promise<OutputSelection>;
  startConcatRender(request: ConcatRenderRequest): Promise<ConcatRenderResult>;
  cancelConcatRender(): Promise<void>;
  revealConcatOutput(jobId: string): Promise<void>;
  playConcatOutput(jobId: string): Promise<ExternalOpenResult>;
  copyPreviewOutputPath(jobId: string): Promise<void>;
  getPreviewOutputHistory(): Promise<PreviewOutputHistorySnapshot>;
  chooseExistingPreviewOutputs(): Promise<PreviewOutputImportResult>;
  removePreviewOutputRecord(jobId: string): Promise<PreviewOutputHistorySnapshot>;
  analyzeIntro(assetIds: string[], maxDurationMs: number, maxSegmentDurationMs: number): Promise<IntroAnalysisResult>;
  cancelIntroAnalysis(): Promise<void>;
  getAiSettings(): Promise<AiSettingsSnapshot>;
  saveAiAccount(input: AiAccountSaveInput): Promise<AiSettingsSnapshot>;
  setActiveAiAccount(accountId: string): Promise<AiSettingsSnapshot>;
  removeAiAccount(accountId: string): Promise<AiSettingsSnapshot>;
  testAiAccount(accountId: string): Promise<AiConnectionTestResult>;
  transcribeVoiceInput(request: VoiceInputRequest): Promise<VoiceInputResult>;
  getTranslationSettings(): Promise<TranslationSettingsSnapshot>;
  updateTranslationSettings(update: TranslationSettingsUpdate): Promise<TranslationSettingsSnapshot>;
  testGoogleTranslation(): Promise<TranslationConnectionTestResult>;
  setAiStoryContext(context: AiStoryContext): Promise<ProjectManifest>;
  generateAiSubtitles(options: AiSubtitleGenerationOptions): Promise<AiSubtitleGenerationResult>;
  /** Optional until the AI publishing workspace is loaded; keeps older renderer test harnesses compatible. */
  getAiPublishAssets?(): Promise<AiPublishAssets | null>;
  setAiPublishAssets?(assets: AiPublishAssets): Promise<ProjectManifest>;
  generateAiPublishAssets?(options: AiPublishGenerationOptions): Promise<AiPublishGenerationResult>;
  cancelAiPublishAssets?(): Promise<void>;
  choosePublishThumbnailOutput?(format: "jpg" | "png"): Promise<{ token: string; displayPath: string; format: "jpg" | "png" } | null>;
  choosePublishThumbnailImport?(): Promise<{ path: string; format: "jpg" | "png" } | null>;
  renderPublishThumbnail?(request: ThumbnailRenderRequest): Promise<ThumbnailRenderResult>;
  onPublishProgress?(callback: (progress: PublishProgress) => void): void;
  clearPublishProgressListeners?(): void;
  buildSubtitleIntroPreview(includeBgm?: boolean): Promise<SubtitlePreviewResult>;
  cancelSubtitleIntroPreview(): Promise<void>;
  setProjectColorSettings(settings: ProjectColorSettings): Promise<ProjectManifest>;
  setWatermarkSettings(settings: WatermarkSettings): Promise<ProjectManifest>;
  cancelAiSubtitles(): Promise<void>;
  getExternalPlayerSettings(): Promise<ExternalPlayerSettingsSnapshot>;
  updateExternalPlayerSettings(update: ExternalPlayerSettingsUpdate): Promise<ExternalPlayerSettingsSnapshot>;
  chooseCustomPlayer(): Promise<ExternalPlayerSettingsSnapshot | null>;
  removeCustomPlayer(playerId: ExternalPlayerId): Promise<ExternalPlayerSettingsSnapshot>;
  openExternalMedia(assetId: string, target: ExternalMediaTarget): Promise<ExternalOpenResult>;
  chooseBgmFiles(): Promise<BgmImportResult>;
  addBgmYoutubeReferences(urls: string[]): Promise<BgmImportResult>;
  resolveBgmReference(trackId: string, rightsConfirmed: boolean): Promise<BgmImportResult | null>;
  sequenceBgmTracks(): Promise<ProjectManifest>;
  setSourceAudioVolume(volumePercent: number): Promise<ProjectManifest>;
  updateBgmTrack(track: BgmTrack): Promise<ProjectManifest>;
  removeBgmTrack(trackId: string): Promise<ProjectManifest>;
  moveBgmTrack(trackId: string, toIndex: number): Promise<ProjectManifest>;
  playBgmTrack(trackId: string): Promise<ExternalOpenResult>;
  revealBgmTrack(trackId: string): Promise<void>;
  copyBgmTrackPath(trackId: string): Promise<void>;
  openYoutubeAudioLibrary(): Promise<void>;
  generateMusicSuggestions(request: MusicSuggestionRequest): Promise<MusicSuggestionResult>;
  cancelMusicSuggestions(): Promise<void>;
  openMusicSuggestion(url: string): Promise<void>;
  setSubtitleCues(cues: SubtitleCue[]): Promise<ProjectManifest>;
  chooseSubtitleInput(): Promise<SubtitleImportResult | null>;
  chooseSubtitleOutput(suggestedName: string): Promise<OutputSelection | null>;
  exportSubtitles(outputToken: string, scopes?: SubtitleTimelineScope[]): Promise<SubtitleExportResult>;
  cancelSubtitleExport(): Promise<void>;
  getYoutubeSettings(): Promise<YoutubeSettingsSnapshot>;
  updateYoutubeSettings(update: YoutubeSettingsUpdate): Promise<YoutubeSettingsSnapshot>;
  chooseYoutubeOAuthClient(): Promise<YoutubeSettingsSnapshot | null>;
  connectYoutube(): Promise<YoutubeSettingsSnapshot>;
  cancelYoutubeConnect(): Promise<void>;
  disconnectYoutube(): Promise<YoutubeSettingsSnapshot>;
  uploadYoutubeVideo(request: YoutubeUploadRequest): Promise<YoutubeUploadResult>;
  retryYoutubeThumbnail?(videoId: string, thumbnailPath: string): Promise<{ status: "UPLOADED" }>;
  cancelYoutubeUpload(): Promise<void>;
  openYoutubeVideo(videoId: string): Promise<void>;
  openPlatformUpload(jobId: string, platform: BrowserUploadPlatform): Promise<PlatformUploadHandoffResult>;
  openPlatformPortal(platform: BrowserUploadPlatform): Promise<PlatformPortalResult>;
  onImportProgress(callback: (progress: ImportProgress) => void): void;
  clearImportProgressListeners(): void;
  onConcatProgress(callback: (progress: ConcatRenderProgress) => void): void;
  clearConcatProgressListeners(): void;
  onIntroAnalysisProgress(callback: (progress: IntroAnalysisProgress) => void): void;
  clearIntroAnalysisProgressListeners(): void;
  onAiAnalysisProgress(callback: (progress: AiAnalysisProgress) => void): void;
  clearAiAnalysisProgressListeners(): void;
  onSubtitlePreviewProgress(callback: (progress: ConcatRenderProgress) => void): void;
  clearSubtitlePreviewProgressListeners(): void;
  onYoutubeUploadProgress(callback: (progress: YoutubeUploadProgress) => void): void;
  clearYoutubeUploadProgressListeners(): void;
}
