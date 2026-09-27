export const MANIFEST_SCHEMA_VERSION = 21 as const;
export const PREVIEWER_VERSION = "preview-v5-orientation-planar-safe" as const;
export const CLIP_PREVIEWER_VERSION = "clip-preview-v3-orientation-planar-safe" as const;
export const DEFAULT_IMAGE_DURATION_MS = 5_000 as const;
export const MIN_IMAGE_DURATION_MS = 3_000 as const;
export const MAX_IMAGE_DURATION_MS = 7_000 as const;
export const PHOTO_INSERTION_EDGE_MARGIN_MS = 750 as const;
export const DUNES_SHUTTER_EFFECT_ID = "DUNES_CAMERA_SHUTTER_CLICK_14671" as const;
export const DUNES_SHUTTER_EFFECT_SHA256 = "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93" as const;
export const PHOTO_SOUND_PREVIEW_URL = "preview-media://asset/dunes-shutter.mp3" as const;
export const DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT = 100 as const;
export const DEFAULT_BGM_VOLUME_PERCENT = 35 as const;
export const DEFAULT_INSERTION_BGM_VOLUME_PERCENT = 28 as const;
export const DEFAULT_INSERTION_SFX_VOLUME_PERCENT = 70 as const;
export const DEFAULT_INSERTION_AUDIO_FADE_MS = 180 as const;
export const DEFAULT_INSERTION_BGM_LOOP_CROSSFADE_MS = 120 as const;
export const MAIN_START_CUE_SFX_ID = "SCENERYWALKER_MAIN_START_CHIME_V1" as const;
export const DEFAULT_MAIN_START_CUE_DURATION_MS = 650 as const;
export const MAX_MIX_VOLUME_PERCENT = 300 as const;
export const DEFAULT_INTRO_TARGET_DURATION_MS = 90_000 as const;
export const DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS = 15_000 as const;
export const INTRO_DURATION_WARNING_MS = 180_000 as const;
export const INTRO_MAX_SEGMENTS = 50 as const;
export const INTRO_MIN_SEGMENT_MS = 3_000 as const;
export const INTRO_MAX_SEGMENT_MS = 22_000 as const;
/** Smallest UI step for a freely adjusted Intro clip; 3–22s remains guidance only. */
export const INTRO_EDIT_MIN_SEGMENT_MS = 100 as const;
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
export type PreviewResolution = "360P" | "480P" | "720P" | "1080P" | "1440P" | "4K";
/**
 * Render encoder selection.  The QSV variants use Intel Quick Sync when the
 * local FFmpeg build/driver exposes it; the non-QSV variants remain explicit
 * CPU fallbacks for machines that cannot use hardware encoding.
 */
export type RenderVideoCodec = "H264_NVENC" | "H265_NVENC" | "H265_QSV" | "H265" | "H264_QSV" | "H264";
export type AudioProcessingMode =
  "ORIGINAL_STEREO" | "ENHANCED_STEREO" | "VIRTUAL_SURROUND_5_1" | "PRESERVE_MULTICHANNEL";
export type SurroundAudioCodec = "AAC" | "AC3" | "EAC3";
export type AudioSpatialPreset = "NATURAL" | "CINEMA" | "WIDE";

export interface AudioProcessingOptions {
  mode: AudioProcessingMode;
  preset: AudioSpatialPreset;
  codec: SurroundAudioCodec;
  bitrateKbps: number;
  sampleRate: 48_000;
  /** Conservative user controls; 100 is the Natural reference level. */
  surroundStrengthPercent: number;
  lfeStrengthPercent: number;
  lfeCutoffHz: number;
  loudnessTargetLufs: number;
  truePeakCeilingDb: number;
  /** 100 keeps the Natural reference width; higher values widen only the side component. */
  stereoWidthPercent?: number;
  /** Conservative broad tone control for preview/final parity. */
  eqLowDb?: number;
  eqPresenceDb?: number;
}

export const DEFAULT_AUDIO_PROCESSING_OPTIONS: AudioProcessingOptions = {
  mode: "ORIGINAL_STEREO",
  preset: "NATURAL",
  codec: "AAC",
  bitrateKbps: 384,
  sampleRate: 48_000,
  surroundStrengthPercent: 65,
  lfeStrengthPercent: 45,
  lfeCutoffHz: 100,
  loudnessTargetLufs: -16,
  truePeakCeilingDb: -1.5,
  stereoWidthPercent: 100,
  eqLowDb: 0,
  eqPresenceDb: 0,
};

export type RemoteRenderControlState =
  "IDLE" | "PREPARED" | "RUNNING" | "PAUSING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface RemoteRenderSnapshot {
  revision: number;
  capturedAt: string;
  projectName: string;
  state: RemoteRenderControlState;
  prepared: boolean;
  progressPercent: number;
  attemptElapsedMs?: number;
  cumulativeElapsedMs?: number;
  estimatedRemainingMs?: number;
  currentSegment?: string;
  encoder?: string;
  resolution?: PreviewResolution;
  renderMode?: RenderRuntimePolicy["mode"];
  audioMode?: AudioProcessingMode;
  cpuUsagePercent?: number;
  gpuEncodeUsagePercent?: number;
  ramUsedBytes?: number;
  ramAvailableBytes?: number;
  ssdFreeBytes?: number;
  latestError?: string;
  pauseDetail?: string;
}

export interface RemoteControlStatus {
  enabled: boolean;
  port?: number;
  addresses: string[];
  pairingUrl?: string;
  qrDataUrl?: string;
  pairingExpiresAt?: string;
  render: RemoteRenderSnapshot;
}

export interface RemotePreparedRender {
  preparedAt: string;
  outputDisplayPath: string;
  resolution: PreviewResolution;
  renderMode: RenderRuntimePolicy["mode"];
  audioMode: AudioProcessingMode;
}

export interface RenderEncoderCapability {
  videoCodec: RenderVideoCodec;
  ffmpegEncoder: "h264_nvenc" | "hevc_nvenc" | "h264_qsv" | "hevc_qsv" | "libx264" | "libx265";
  backend: "NVIDIA_NVENC" | "INTEL_QSV" | "CPU_SOFTWARE";
  codec: "H264" | "H265";
  listed: boolean;
  runtimeVerified: boolean;
  available: boolean;
  failureReason?: string;
}

export interface RenderDecoderCapability {
  backend: "NVIDIA_CUDA" | "INTEL_QSV" | "CPU_SOFTWARE";
  codec: "H264" | "H265";
  ffmpegDecoder: string;
  listed: boolean;
  runtimeVerified: boolean;
  available: boolean;
  failureReason?: string;
}

export interface RenderHardwareCapabilities {
  schemaVersion: 1;
  fingerprint: string;
  capturedAt: string;
  ffmpegExecutable: string;
  ffmpegVersion: string;
  gpuAdapters: Array<{ name: string; driverVersion?: string }>;
  encoders: RenderEncoderCapability[];
  decoders: RenderDecoderCapability[];
  gpuFilters: string[];
  recommendedVideoCodec: RenderVideoCodec;
  recommendationReason: string;
  probeDeferredReason?: string;
}

export interface RenderBenchmarkResult {
  mode: "ORIGINAL_NORMAL_2" | "NORMAL_2" | "NORMAL_3" | "NORMAL_4" | "HIGH_SPEED_H264" | "H265";
  jobs: number;
  encoder: string;
  decoder: string;
  processingSeconds?: number;
  fps?: number;
  speed?: number;
  cpuAveragePercent?: number;
  cpuPeakPercent?: number;
  gpuEncodeAveragePercent?: number;
  gpuEncodePeakPercent?: number;
  gpuDecodeAveragePercent?: number;
  gpuDecodePeakPercent?: number;
  gpuComputeAveragePercent?: number;
  gpuComputePeakPercent?: number;
  ramPeakBytes?: number;
  vramPeakBytes?: number;
  ssdTemporaryPeakBytes?: number;
  finalFileSizeBytes?: number;
  oom: boolean;
  status: "PASS" | "FAILED_SAFE" | "SKIPPED_UNAVAILABLE";
  failureReason?: string;
}

export interface RenderPerformanceProfile {
  schemaVersion: 1;
  fingerprint: string;
  capturedAt: string;
  sampleDurationSeconds: number;
  sourceAssetIds: string[];
  results: RenderBenchmarkResult[];
  recommendedMode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED";
  recommendedVideoCodec: RenderVideoCodec;
  recommendedParallelJobs: number;
  recommendationReason: string;
}
export type ConcatRenderPhase =
  | "PREPARING"
  | "TRANSLATING_SUBTITLES"
  | "WAITING_FOR_MEMORY"
  | "PAUSED_DISK_SPACE"
  | "RENDERING"
  | "FINALIZING";
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
export type AiAnalysisPhase =
  "PREPARING" | "EXTRACTING_AUDIO" | "TRANSCRIBING" | "SAMPLING_FRAMES" | "MATCHING_STORY" | "SAVING_DRAFTS";
export type MaterialAnalysisProvider = "CHATGPT" | "GEMINI";
export type YoutubeBrowser = "CHROME" | "EDGE";
export type YoutubePrivacyStatus = "unlisted" | "private";
export type YoutubeHandoffMode = "CHROME_DRAG_DROP" | "OFFICIAL_API";
export type YoutubeUploadPhase = "AUTHORIZING" | "STARTING" | "UPLOADING" | "FINALIZING";
export type PostSuccessPowerTrigger = "RENDER_SUCCESS" | "YOUTUBE_UPLOAD_SUCCESS";
export type PostSuccessPowerAction = "SHUTDOWN" | "HIBERNATE" | "SLEEP";

export interface PostSuccessPowerPreference {
  /** Explicit opt-in. Legacy or malformed preference data always becomes false. */
  enabled: boolean;
  trigger: PostSuccessPowerTrigger;
  action: PostSuccessPowerAction;
}

export interface PostSuccessPowerStatus {
  state: "IDLE" | "SCHEDULED" | "EXECUTING" | "CANCELLED" | "FAILED";
  action?: PostSuccessPowerAction;
  trigger?: PostSuccessPowerTrigger;
  scheduledAt?: string;
  executeAt?: string;
  secondsRemaining?: number;
  message?: string;
}
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

export interface AudioProtectionOptions {
  /** Master per-render switch; enabled by default in current UI and sanitized legacy preferences. */
  enabled: boolean;
  /** Local 1–4 kHz detector drives a smooth, bounded ducking envelope. */
  autoDuckVoiceAndSuddenSounds: boolean;
  /** Raises detector threshold and keeps distant crowd/market texture. */
  preserveDistantCrowdAmbience: boolean;
  /** Uses a slower attack so weak scene-matched transients remain audible. */
  preserveSceneMatchedSounds: boolean;
  /** Gentle full-program speech-band attenuation after automatic ducking. */
  eqEnabled: boolean;
  maxDuckingDb: number;
  eqReductionDb: number;
  peakCeilingDb: -1 | -2;
}

export interface BgmScopeSelection {
  /** Play BGM over the confirmed Intro section. */
  intro: boolean;
  /** Play BGM over the Main section. */
  main: boolean;
}

export const DEFAULT_AUDIO_PROTECTION_OPTIONS: AudioProtectionOptions = {
  enabled: true,
  autoDuckVoiceAndSuddenSounds: true,
  preserveDistantCrowdAmbience: true,
  preserveSceneMatchedSounds: true,
  eqEnabled: true,
  maxDuckingDb: 6,
  eqReductionDb: 1.5,
  peakCeilingDb: -1,
};

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

export interface MainStartCueSettings {
  enabled: boolean;
  durationMs: number;
}

export const DEFAULT_MAIN_START_CUE_SETTINGS: MainStartCueSettings = {
  enabled: true,
  durationMs: DEFAULT_MAIN_START_CUE_DURATION_MS,
};

/** Canonical per-occurrence track gates shared by Intro, Main, preview and final render. */
export interface AudioTrackGates {
  original: boolean;
  voice: boolean;
  bgm: boolean;
  sfx: boolean;
}

export const DEFAULT_AUDIO_TRACK_GATES: AudioTrackGates = {
  original: true,
  voice: true,
  bgm: true,
  sfx: true,
};

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
    /** Optional only for preferences written by versions before v0.49; the store fills defaults. */
    videoCodec?: RenderVideoCodec;
    includeWatermark?: boolean;
    /** Optional only for preferences written before v0.54; the store fills defaults. */
    audioProtection?: AudioProtectionOptions;
    /** Neutral, non-licensed spatial-audio output profile. */
    audioProcessing?: AudioProcessingOptions;
    /** Optional only for preferences written before v0.54; the store fills defaults. */
    mainBgmScopes?: BgmScopeSelection;
    youtubeHandoffMode?: YoutubeHandoffMode;
    prependIntro: boolean;
    autoUpload: boolean;
    /** Default-on bounded FFmpeg graph mode for long or high-resolution timelines. */
    lowMemorySegmented?: boolean;
    /** Opt-in throughput mode; still obeys Main-process RAM/Commit/SSD safety gates. */
    highSpeedMode?: boolean;
    /** v0.77 explicit resource architecture profile. Legacy booleans remain readable. */
    resourceProfile?: "LOW_DISK" | "BALANCED" | "HIGH_SPEED";
    /** User budget for FFmpeg working RAM. */
    maximumRenderRamGiB?: number;
    /** AUTO or an explicit cap for app-owned render TEMP. */
    maximumRenderTempGiB?: number | "AUTO";
    /** Uses the official YouTube API and applies the explicit automatic review choices after render. */
    youtubeFullAutoUpload?: boolean;
    /** Explicit post-success power action. Defaults disabled and never migrates as enabled. */
    postSuccessPower?: PostSuccessPowerPreference;
    /** Optional app-owned root for large resumable FFmpeg intermediates. */
    renderTemporaryFolder?: string;
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
  /**
   * Max characters per subtitle line. Undefined (or non-numeric) keeps the
   * automatic width-derived wrap so older preferences keep working.
   */
  maxCharactersPerLine?: number;
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
  audioChannels?: number;
  audioChannelLayout?: string;
  audioSampleRate?: number;
  audioBitrate?: number;
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
  /**
   * VIDEO clips acoustically detected as silent use the first BGM-page track
   * unless explicitly false. Undefined keeps the default-on behavior.
   */
  dubWithBgm?: boolean;
  /** Main-grid clip track gates. Source speech remains part of Original, never Voice. */
  mainAudioGates?: AudioTrackGates;
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
  /** Per occurrence; never inferred from another use of the same SourceAsset. */
  insertionAudio?: InsertionAudioSettings;
}

export interface InsertionAudioSettings {
  trackGates?: AudioTrackGates;
  /** Camera shutter is an independent SFX event. Only PHOTO occurrences may enable it. */
  sfxEnabled: boolean;
  sfxId?: typeof DUNES_SHUTTER_EFFECT_ID;
  sfxVolumePercent: number;
  /** BGM is independent from SFX. Undefined track means no insertion BGM. */
  bgmTrackId?: string;
  bgmVolumePercent: number;
  fadeMs: number;
  loopCrossfadeMs: number;
}

export type InsertionAudioScope = "INTRO" | "MAIN";

export interface InsertionAudioPlanItem {
  instanceId: string;
  scope: InsertionAudioScope;
  assetId: string;
  fileName: string;
  kind: SourceKind;
  timelineStartMs: number;
  timelineEndMs: number;
  durationMs: number;
  hasSourceAudio: boolean;
  sourceInMs: number;
  sourceOutMs: number;
  gates: AudioTrackGates;
  sfxEnabled: boolean;
  sfxName?: string;
  sfxVolumePercent?: number;
  bgmEnabled: boolean;
  bgmTrackId?: string;
  bgmTrackIndex?: number;
  bgmTrackName?: string;
  bgmTimelineStartMs?: number;
  bgmTimelineEndMs?: number;
  bgmPlayDurationMs?: number;
  bgmSourcePositionMs?: number;
  bgmVolumePercent?: number;
  continuousWithPrevious: boolean;
  usesLoop: boolean;
  fadeMs: number;
}

export interface InsertionBgmRange {
  id: string;
  scope: InsertionAudioScope;
  bgmTrackId: string;
  bgmTrackIndex: number;
  bgmTrackName: string;
  timelineStartMs: number;
  timelineEndMs: number;
  durationMs: number;
  sourceInMs: number;
  sourceSpanMs: number;
  volumePercent: number;
  fadeInMs: number;
  fadeOutMs: number;
  loopCrossfadeMs: number;
  usesLoop: boolean;
  /** CROSSFADE is exact; the bounded fallback uses a short seam envelope to avoid unbounded graphs. */
  loopStrategy: "NONE" | "CROSSFADE" | "BOUNDED_DECLICK_FALLBACK";
  memberInstanceIds: string[];
}

export interface InsertionSfxEvent {
  instanceId: string;
  scope: InsertionAudioScope;
  timelineStartMs: number;
  sfxId: typeof DUNES_SHUTTER_EFFECT_ID | typeof MAIN_START_CUE_SFX_ID;
  displayName: string;
  volumePercent: number;
  durationMs?: number;
  source: "PACKAGED_SHUTTER" | "SYNTHETIC_MAIN_CUE";
}

export interface InsertionAudioPlan {
  version: "insertion-audio-plan-v1";
  timelineDurationMs: number;
  transitionMs: number;
  items: InsertionAudioPlanItem[];
  bgmRanges: InsertionBgmRange[];
  sfxEvents: InsertionSfxEvent[];
  warnings: string[];
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
  /**
   * Optional per-cue line-width override. Undefined uses the v0.60 language
   * default: Chinese-only 12; English or mixed Chinese/English 20.
   */
  lineWidthChars?: number;
  /**
   * Optional cue-specific position on the canonical output canvas. Percentages
   * are resolution-independent, so preview and ASS burn-in resolve identically.
   * Omitted positions preserve the legacy centered/global-height placement.
   */
  position?: SubtitleCuePosition;
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
  animalSpecies?: string[];
  speciesExplanation?: string;
  topicRelevanceScore?: number;
  transcriptVisualMatchScore?: number;
  aiConfidence?: number;
  aiWarnings?: string[];
  aiAnalysisVersion?: string;
}

export interface SubtitleCuePosition {
  xPercent: number;
  yPercent: number;
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
export interface GeminiPublishReview {
  enabled: boolean;
  status: "REVIEWED" | "NOT_CONFIGURED" | "FAILED";
  model: string;
  summary: string;
  recommendedTitleId?: string;
  recommendedThumbnailId?: string;
  warnings: string[];
  reviewedAt?: string;
}
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
  geminiReview?: GeminiPublishReview;
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
export interface PublishProgress {
  percent: number;
  detail: string;
}
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
  /** Requested total number of visual/speech cues. The service clamps this to its safe 1–300 range. */
  targetCueCount?: number;
  /** How a subsequent AI pass treats existing AI cues in the selected scope. */
  mode?: "FILL_BLANKS" | "REPLACE_AI_SCOPE" | "PRESERVE_USER_EDITED";
}

/** A focused visual analysis request for one photo or selected video frames. */
export interface MaterialSubtitleAnalysisRequest {
  assetId: string;
  timelineScope: SubtitleTimelineScope;
  provider: MaterialAnalysisProvider;
  /** Source-relative milliseconds. Photos ignore this and use one still frame. */
  frameTimesMs?: number[];
}

export interface MaterialSubtitleAnalysisResult {
  drafts: SubtitleCue[];
  overlaps: Array<{
    draftId: string;
    existingCues: Array<{
      id: string;
      startMs: number;
      endMs: number;
      text: string;
      reviewStatus?: SubtitleCueReviewStatus;
    }>;
  }>;
  providerLabel: "OPENAI_API" | "CODEX_CHATGPT" | "GEMINI";
  analyzedFrameTimesMs: number[];
  warnings: string[];
  analysisVersion: string;
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
  /** Canonical 0.3/0.5/0.7 second overlap used by timeline and subtitle positioning. */
  timelineTransitionSeconds: TransitionDurationSec;
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
  mainStartCue: MainStartCueSettings;
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
  /** Defaults to H264 only for legacy callers. The current UI explicitly prefers H265. */
  videoCodec?: RenderVideoCodec;
  /** Per-render switch. Project watermark settings still control text, schedule and destinations. */
  includeWatermark?: boolean;
  /** Local privacy/loudness protection; omitted legacy callers receive safe defaults. */
  audioProtection?: AudioProtectionOptions;
  audioProcessing?: AudioProcessingOptions;
  purpose?: PreviewRenderPurpose;
  prependIntro?: boolean;
  subtitleBurnIn?: SubtitleBurnInOptions;
  /** Internal review proxies can opt out so offline BGM never blocks picture/subtitle checking. */
  includeBgm?: boolean;
  /** For CONCAT output, independently enables Intro and Main BGM ranges. */
  bgmScopes?: BgmScopeSelection;
  /** Required by the UI whenever a confirmed Intro is prepended to Main. */
  mainStartCard?: MainStartCardOptions;
  shortsPortrait?: boolean;
  shortsMaxDurationSec?: 60 | 180;
  shortsSource?: "INTRO" | "MAIN";
  /** Renderer estimate used only for the preflight disk-reserve check. */
  estimatedDurationMs?: number;
  /** Bounds each FFmpeg filter graph and uses removable staged intermediates. */
  lowMemorySegmented?: boolean;
  /** Allows 3–4 adaptive workers and guarded QSV decode attempts when supported. */
  highSpeedMode?: boolean;
  resourceProfile?: "LOW_DISK" | "BALANCED" | "HIGH_SPEED";
  maximumRenderRamGiB?: number;
  maximumRenderTempGiB?: number | "AUTO";
  /** User explicitly accepted the current advisory RAM/commit warning. */
  resourceWarningAcknowledged?: boolean;
  /** Main-process validated app-owned render work root. Renderer input is ignored. */
  renderTemporaryFolder?: string;
  /** Main-process-only peak additional-write estimate used by the runtime disk gate. */
  estimatedPeakDiskBytes?: number;
  /** Main-process-only final output estimate used by per-volume runtime diagnostics. */
  estimatedFinalOutputBytes?: number;
  /** Main-process-only policy; Renderer values are ignored and replaced before execution. */
  runtimePolicy?: RenderRuntimePolicy;
  /** Main-process-only persisted checkpoint identifier. */
  resumeCheckpointId?: string;
}

export interface RenderRuntimePolicy {
  mode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED";
  resourceProfile?: "LOW_DISK" | "BALANCED" | "HIGH_SPEED";
  maxVisualInputsPerStage: number;
  /** Number of independent segment encodes allowed to start together. */
  initialParallelJobs: number;
  /** Hard ceiling; the runtime controller may remain below this value. */
  maximumParallelJobs: number;
  filterComplexThreads: number;
  encoderThreads: number;
  systemSafetyReserveBytes: number;
  renderRamBudgetBytes: number;
  pauseNewStageBelowAvailableBytes: number;
  /** Conservative scheduler estimates. Live observations replace them after a wave. */
  estimatedRamPerJobBytes?: number;
  estimatedWorkingBytesPerJob?: number;
  minimumCommitHeadroomBytes?: number;
  minimumOutputFreeBytes?: number;
  maximumRenderTempBytes?: number;
}

export interface SystemResourceSnapshot {
  capturedAt: string;
  totalRamBytes: number;
  availableRamBytes: number;
  appWorkingSetBytes: number;
  otherProgramsRamBytes: number;
  committedBytes?: number;
  commitLimitBytes?: number;
  pagefileEnabled?: boolean;
  pagefileTotalBytes?: number;
  pagefileUsedBytes?: number;
  pagefilePeakUsedBytes?: number;
  tempPath: string;
  tempDriveFreeBytes: number;
  tempDriveCapacityBytes?: number;
  outputDriveFreeBytes: number;
  outputDriveCapacityBytes?: number;
  renderWorkingBytes?: number;
  ffmpegWorkingSetBytes?: number;
  ffmpegPrivateBytes?: number;
  cpuUsagePercent?: number;
  gpuUsagePercent?: number;
  gpuComputeUsagePercent?: number;
  gpuEncodeUsagePercent?: number;
  gpuDecodeUsagePercent?: number;
  vramUsedBytes?: number;
  vramTotalBytes?: number;
  diskReadBytesPerSecond?: number;
  diskWriteBytesPerSecond?: number;
  currentJobs?: number;
  ffmpegFps?: number;
  ffmpegSpeed?: number;
  encoderName?: string;
  decoderName?: string;
  diskUsage?: RenderDiskRuntimeSnapshot;
}

export type RenderDiskPressureLevel = "OK" | "WARNING" | "CRITICAL" | "EMERGENCY";

export interface RenderDiskPathUsage {
  label: "SOURCE_LOCAL" | "PROXY_CACHE" | "EXISTING_TEMP" | "INTERMEDIATE" | "AUDIO_TEMP" | "FINAL_OUTPUT" | "CHECKPOINT";
  path: string;
  volume: string;
  bytes: number;
}

export interface RenderDiskRuntimeSnapshot {
  capturedAt: string;
  tempPath: string;
  tempVolume: string;
  outputPath: string;
  outputVolume: string;
  tempFreeBytes: number;
  outputFreeBytes: number;
  tempCapacityBytes: number;
  outputCapacityBytes: number;
  renderTempBytes: number;
  intermediateBytes: number;
  finalOutputBytes: number;
  proxyCacheBytes: number;
  estimatedRemainingWriteBytes: number;
  safetyReserveBytes: number;
  requiredAdditionalBytes: number;
  pressureLevel: RenderDiskPressureLevel;
}

export interface RenderResumeOffer {
  checkpointId: string;
  projectId: string;
  outputPath: string;
  mode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED";
  completedSegmentCount: number;
  /** Completed records in JSON before checking that their media still exists. */
  recordedCompletedSegmentCount?: number;
  /** Recorded completed segment files that are missing or have the wrong size. */
  missingCompletedSegmentCount?: number;
  physicalState?: "READY" | "PARTIAL" | "SEGMENT_CACHE_MISSING";
  totalSegmentCount: number;
  concatStatus: "PENDING" | "FAILED" | "PAUSED_DISK_SPACE";
  lastError?: string;
  updatedAt: string;
  lastAttemptElapsedMs?: number;
  cumulativeElapsedMs?: number;
  /** Bytes of physically present completed media that can be reused after validation. */
  reusableBytes?: number;
  /** Timeline duration represented by physically present completed media. */
  reusableDurationMs?: number;
  /** Original checkpoint when v0.80 imported an older job copy-on-write. */
  migratedFromCheckpointId?: string;
  recoverySourcePreserved?: boolean;
  /** Older recovery data is read-only until copy-on-write migration succeeds. */
  legacyRecoveryProtected?: boolean;
  /** Last persisted disk snapshot; UI labels it historical until preflight refreshes it. */
  currentTempFreeBytes?: number;
  currentOutputFreeBytes?: number;
  estimatedRemainingWriteBytes?: number;
  requiredAdditionalBytes?: number;
  tempVolume?: string;
  outputVolume?: string;
}

export interface ConcatRenderEstimateRequest {
  outputToken: string;
  expectedDurationMs: number;
  resolution: PreviewResolution;
  videoCodec: RenderVideoCodec;
  lowMemorySegmented?: boolean;
  highSpeedMode?: boolean;
  resourceProfile?: "LOW_DISK" | "BALANCED" | "HIGH_SPEED";
  maximumRenderRamGiB?: number;
  maximumRenderTempGiB?: number | "AUTO";
  /** Exact visual inputs selected for this render; Main resolves metadata from the project store. */
  orderedAssetIds?: string[];
  clipSelections?: RenderClipSelection[];
  transitionSeconds?: TransitionDurationSec;
  /** Generated title/start cards have output cost but no SourceAsset record. */
  generatedInputCount?: number;
}

export type RenderEstimateWarningLevel = "NONE" | "WARNING" | "DANGER";

export interface RenderModeResourceEstimate {
  resourceProfile?: "LOW_DISK" | "BALANCED" | "HIGH_SPEED";
  lowMemorySegmented: boolean;
  /** True only when the input count is large enough to activate staged intermediates. */
  usesSegmentedPipeline: boolean;
  estimatedOutputBytes: number;
  /** Peak working SSD footprint: partial output plus any live staged intermediates. */
  estimatedTemporaryBytes: number;
  /** Rebuildable per-project picture/base-audio master retained for audio-only revisions. */
  estimatedReusableMasterBytes?: number;
  estimatedPeakRamBytes: number;
  estimatedRenderTimeMs: number;
  estimatedFreeAfterBytes: number;
  maximumSimultaneousInputs: number;
  maximumParallelJobs?: number;
  intermediateJobCount: number;
  warningLevel: RenderEstimateWarningLevel;
  warnings: string[];
  canRender: boolean;
  diskBreakdown?: RenderDiskEstimateBreakdown;
}

export interface RenderDiskEstimateBreakdown {
  sourceLogicalBytes: number;
  sourceLocalBytes: number;
  existingProxyBytes: number;
  existingTemporaryBytes: number;
  reusableCompletedSegmentBytes: number;
  remainingIntermediatePeakBytes: number;
  concurrentPartialPeakBytes: number;
  /** Peak while a wave writes validated replacements before consumed inputs are collected. */
  segmentBuildPeakBytes?: number;
  /** Final-ready segments plus the picture/base-audio master being built. */
  baseMasterBuildPeakBytes?: number;
  /** Persistent master plus audio/final mux branch after segment GC. */
  postAudioMuxPeakBytes?: number;
  reusableBaseMasterBytes?: number;
  audioTemporaryBytes: number;
  estimatedFinalOutputBytes: number;
  muxOverheadBytes: number;
  peakWorkingBytes: number;
  safetyReserveBytes: number;
  requiredPeakFreeBytes: number;
  predictedMinimumFreeBytes: number;
  /** Per-volume peaks are authoritative when TEMP and final output differ. */
  tempPeakBytes?: number;
  outputPeakBytes?: number;
  tempRequiredFreeBytes?: number;
  outputRequiredFreeBytes?: number;
  currentTempFreeBytes?: number;
  currentOutputFreeBytes?: number;
  predictedTempMinimumFreeBytes?: number;
  predictedOutputMinimumFreeBytes?: number;
  tempPath?: string;
  tempVolume: string;
  outputVolume: string;
}

export interface RenderEstimateWorkloadSummary {
  visualInputCount: number;
  insertedInputCount: number;
  photoInputCount: number;
  videoInputCount: number;
  sourceDurationMs: number;
  weightedSourceFps: number;
  weightedSourceWidth: number;
  weightedSourceHeight: number;
  transitionSeconds: number;
}

export interface ConcatRenderEstimate {
  outputPath: string;
  driveRoot: string;
  currentFreeBytes: number;
  estimatedOutputBytes: number;
  /** Peak removable work files required only by low-memory segmented rendering. */
  estimatedTemporaryBytes?: number;
  estimatedRenderTimeMs: number;
  estimatedFreeAfterBytes: number;
  minimumReserveBytes: number;
  /** Advisory free-space reserve. Unlike minimumReserveBytes, this does not by itself block render. */
  safetyMarginBytes?: number;
  requiredFreeBytes?: number;
  canRender: boolean;
  warning?: string;
  currentAvailableRamBytes: number;
  totalRamBytes: number;
  modeEstimates: {
    lowMemory: RenderModeResourceEstimate;
    normal: RenderModeResourceEstimate;
    lowDisk?: RenderModeResourceEstimate;
    balanced?: RenderModeResourceEstimate;
    highSpeed?: RenderModeResourceEstimate;
  };
  workload: RenderEstimateWorkloadSummary;
  systemResources?: SystemResourceSnapshot;
  runtimePolicy?: RenderRuntimePolicy;
  hardwareCapabilities?: RenderHardwareCapabilities;
  diskPaths?: RenderDiskPathUsage[];
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
  currentSegment?: string;
  segmentIndex?: number;
  segmentCount?: number;
  estimatedRemainingMs?: number;
  resourceUsage?: SystemResourceSnapshot;
  /** Actual wall time since the first FFmpeg child of this invocation spawned. */
  attemptElapsedMs?: number;
  /** Previous persisted attempts plus the current invocation. This is not ETA. */
  cumulativeElapsedMs?: number;
  /** Wall timestamp for audit; Renderer advances from its local monotonic receipt time. */
  timingCapturedAt?: string;
  timingStatus?: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "PAUSED_DISK_SPACE";
  diskStatus?: RenderDiskRuntimeSnapshot;
}

export interface ConcatRenderResult {
  jobId: string;
  outputPath: string;
  sizeBytes: number;
  expectedDurationMs: number;
  transitionSeconds: TransitionDurationSec;
  resolution: PreviewResolution;
  videoCodec?: RenderVideoCodec;
  purpose: PreviewRenderPurpose;
  bgmAppliedCount?: number;
  bgmScopesApplied?: BgmScopeSelection;
  /** Silent clips auto-dubbed with the first BGM-page track in this render. */
  autoDubClipCount?: number;
  photoShutterAppliedCount?: number;
  mixPolicy?: "ORIGINAL_PLUS_BGM_LIMITED_0_95" | "VOICE_DUCK_EQ_COMPRESS_LIMIT";
  audioProtectionApplied?: boolean;
  audioPeakCeilingDb?: -1 | -2;
  audioProcessing?: AudioProcessingOptions;
  audioCodec?: string;
  audioChannels?: number;
  audioChannelLayout?: string;
  audioSampleRate?: number;
  audioBitrate?: number;
  audioRemuxedWithoutVideoEncode?: boolean;
  /** True when the timeline-correct picture/base-audio master was reused and no video encoder ran. */
  videoBaseMasterReused?: boolean;
  pictureBaseSignature?: string;
  finalAudioSignature?: string;
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
  lowMemorySegmented?: boolean;
  highSpeedMode?: boolean;
  lowMemoryStageCount?: number;
  segmentedRender?: boolean;
  segmentInputLimit?: number;
  resumedSegmentCount?: number;
  attemptElapsedMs?: number;
  cumulativeElapsedMs?: number;
  insertionAudioPlan?: InsertionAudioPlan;
}

export interface AudioPreviewRequest {
  assetId: string;
  startMs?: number;
  durationMs?: number;
  timelineRevision?: number;
  options: AudioProcessingOptions;
}

export interface AudioMeterReading {
  integratedLufs?: number;
  truePeakDb?: number;
  channelPeaksDb: number[];
  clipping: boolean;
  warnings: string[];
}

export interface AudioPreviewResult {
  cacheKey: string;
  url: string;
  mode: AudioProcessingMode;
  monitoring: "STEREO" | "DOWNMIXED_5_1";
  durationMs: number;
  startMs?: number;
  cacheStatus?: CacheStatus;
  sourceChannels?: number;
  sourceChannelLayout?: string;
  meter: AudioMeterReading;
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
  videoCodec?: RenderVideoCodec;
  cancelled?: boolean;
  includedIntroSegmentCount?: number;
  projectName?: string;
  exists: boolean;
  aspectRatio?: "PORTRAIT_9_16" | "LANDSCAPE_16_9";
  attemptElapsedMs?: number;
  cumulativeElapsedMs?: number;
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
  /** Same persisted per-occurrence audio model used by Main media insertions. */
  insertionAudio?: InsertionAudioSettings;
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

export type BackgroundJobKind =
  | "MUSIC_SUGGESTIONS"
  | "INTRO_ANALYSIS"
  | "AI_SUBTITLES"
  | "AI_MATERIAL_ANALYSIS"
  | "SUBTITLE_PREVIEW"
  | "CONCAT_RENDER"
  | "AI_PUBLISH_ASSETS";
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
  attemptElapsedMs?: number;
  cumulativeElapsedMs?: number;
}

export type ProjectChangeSection =
  "SOURCES" | "MAIN_TIMELINE" | "INTRO_TIMELINE" | "BGM" | "SUBTITLES" | "AI_CONTEXT" | "SETTINGS" | "OUTPUTS";
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
  geminiReview?: {
    enabled: boolean;
    model: string;
    credentialStatus: AiCredentialStatus;
  };
}

export interface GeminiReviewSettingsUpdate {
  enabled: boolean;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
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
  platform: BrowserUploadPlatform | "YOUTUBE";
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
  moveCursorToSafeAction?(rect: { x: number; y: number; width: number; height: number }): void;
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
  setDubWithBgm(assetId: string, enabled: boolean): Promise<ProjectManifest>;
  setMainAudioGates(assetId: string, gates: AudioTrackGates): Promise<ProjectManifest>;
  setMainStartCue(settings: MainStartCueSettings): Promise<ProjectManifest>;
  addMediaInsertion(
    anchorVideoAssetId: string,
    insertedAssetId: string,
    atMs: number,
    sourceRange?: PreviewRange,
  ): Promise<ProjectManifest>;
  updateMediaInsertion(insertionId: string, atMs: number, sourceRange: PreviewRange): Promise<ProjectManifest>;
  setInsertionAudio(
    scope: InsertionAudioScope,
    instanceId: string,
    settings: InsertionAudioSettings,
  ): Promise<ProjectManifest>;
  removeMediaInsertion(insertionId: string): Promise<ProjectManifest>;
  moveMediaInsertion(insertionId: string, toIndex: number): Promise<ProjectManifest>;
  setVolumeSegments(assetId: string, segments: VolumeSegment[]): Promise<SourceAsset>;
  setMainExclusionRanges(assetId: string, ranges: MainExclusionRange[]): Promise<MainExclusionRangeUpdateResult>;
  setZoomSegments(assetId: string, segments: ZoomSegment[]): Promise<ZoomSegmentUpdateResult>;
  placeAsset(assetId: string, placement: PlacementRequest): Promise<ProjectManifest>;
  moveTimelineAsset(assetId: string, toIndex: number): Promise<ProjectManifest>;
  setTimelineTransitionSeconds?(seconds: TransitionDurationSec): Promise<ProjectManifest>;
  forceSubtitleReReview(scopes: SubtitleTimelineScope[]): Promise<ProjectManifest>;
  setSortMode(mode: SortMode): Promise<ProjectManifest>;
  ensureMetadata(assetId: string): Promise<SourceAsset>;
  ensurePreview(assetId: string, variant: PreviewVariant): Promise<PreviewResult>;
  ensureClipPreview(assetId: string, inMs: number, outMs: number): Promise<PreviewResult>;
  ensureIntroThumbnail?(assetId: string, inMs: number, outMs: number): Promise<{ url: string; cacheStatus: "HIT" | "CREATED" }>;
  cancelPreview(assetId: string, variant: PreviewVariant): Promise<void>;
  cancelClipPreview(assetId: string, inMs: number, outMs: number): Promise<void>;
  chooseConcatOutput(suggestedName: string): Promise<OutputSelection | null>;
  prepareConcatOutput(suggestedName: string): Promise<OutputSelection>;
  chooseRenderTemporaryFolder?(): Promise<{ path: string; volume: string; freeBytes: number; capacityBytes: number } | null>;
  validateRenderTemporaryFolder?(targetPath: string): Promise<{ path: string; volume: string; freeBytes: number; capacityBytes: number }>;
  revealRenderTemporaryFolder?(): Promise<void>;
  cleanupRenderTemporaryFolder?(): Promise<{ reclaimedBytes: number }>;
  estimateConcatRender?(request: ConcatRenderEstimateRequest): Promise<ConcatRenderEstimate>;
  getRenderHardwareCapabilities?(force?: boolean): Promise<RenderHardwareCapabilities>;
  runRenderPerformanceBenchmark?(): Promise<RenderPerformanceProfile>;
  startConcatRender(request: ConcatRenderRequest): Promise<ConcatRenderResult>;
  createAudioPreview?(request: AudioPreviewRequest): Promise<AudioPreviewResult>;
  cancelAudioPreview?(): Promise<void>;
  getRemoteControlStatus?(): Promise<RemoteControlStatus>;
  enableRemoteControl?(): Promise<RemoteControlStatus>;
  disableRemoteControl?(): Promise<RemoteControlStatus>;
  rotateRemotePairing?(): Promise<RemoteControlStatus>;
  getPostSuccessPowerStatus?(): Promise<PostSuccessPowerStatus>;
  cancelPostSuccessPower?(): Promise<PostSuccessPowerStatus>;
  onPostSuccessPowerStatus?(callback: (status: PostSuccessPowerStatus) => void): void;
  clearPostSuccessPowerStatusListeners?(): void;
  prepareRemoteRender?(request: ConcatRenderRequest): Promise<RemotePreparedRender>;
  clearRemotePreparedRender?(): Promise<void>;
  onRemoteControlStatus?(callback: (status: RemoteControlStatus) => void): void;
  clearRemoteControlStatusListeners?(): void;
  getConcatRenderResumeOffer?(): Promise<RenderResumeOffer | undefined>;
  resumeConcatRender?(checkpointId: string): Promise<ConcatRenderResult>;
  discardConcatRenderResume?(checkpointId: string): Promise<void>;
  discardConcatVideoMaster?(): Promise<void>;
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
  saveGeminiReviewSettings?(input: GeminiReviewSettingsUpdate): Promise<AiSettingsSnapshot>;
  setActiveAiAccount(accountId: string): Promise<AiSettingsSnapshot>;
  removeAiAccount(accountId: string): Promise<AiSettingsSnapshot>;
  testAiAccount(accountId: string): Promise<AiConnectionTestResult>;
  transcribeVoiceInput(request: VoiceInputRequest): Promise<VoiceInputResult>;
  getTranslationSettings(): Promise<TranslationSettingsSnapshot>;
  updateTranslationSettings(update: TranslationSettingsUpdate): Promise<TranslationSettingsSnapshot>;
  testGoogleTranslation(): Promise<TranslationConnectionTestResult>;
  setAiStoryContext(context: AiStoryContext): Promise<ProjectManifest>;
  generateAiSubtitles(options: AiSubtitleGenerationOptions): Promise<AiSubtitleGenerationResult>;
  analyzeMaterialForSubtitles?(request: MaterialSubtitleAnalysisRequest): Promise<MaterialSubtitleAnalysisResult>;
  cancelMaterialSubtitleAnalysis?(): Promise<void>;
  /** Optional until the AI publishing workspace is loaded; keeps older renderer test harnesses compatible. */
  getAiPublishAssets?(): Promise<AiPublishAssets | null>;
  setAiPublishAssets?(assets: AiPublishAssets): Promise<ProjectManifest>;
  generateAiPublishAssets?(options: AiPublishGenerationOptions): Promise<AiPublishGenerationResult>;
  cancelAiPublishAssets?(): Promise<void>;
  choosePublishThumbnailOutput?(
    format: "jpg" | "png",
  ): Promise<{ token: string; displayPath: string; format: "jpg" | "png" } | null>;
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
  prepareYoutubeChromeHandoff?(jobId: string): Promise<PlatformUploadHandoffResult>;
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
