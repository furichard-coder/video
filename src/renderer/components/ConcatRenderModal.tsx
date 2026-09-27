import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioProtectionOptions,
  AudioProcessingOptions,
  BackgroundJobSnapshot,
  BgmScopeSelection,
  ConcatRenderProgress,
  ConcatRenderEstimate,
  ConcatRenderResult,
  ConcatRenderRequest,
  IntroSuggestion,
  MainStartCardOptions,
  MainStartCueSettings,
  OutputSelection,
  PostSuccessPowerPreference,
  PreviewResolution,
  PreviewRenderPurpose,
  RenderHardwareCapabilities,
  RenderDiskEstimateBreakdown,
  RenderVideoCodec,
  RenderClipSelection,
  RenderResumeOffer,
  ProjectManifest,
  SourceAsset,
  SubtitleBurnInOptions,
  SubtitleRenderLanguage,
  SubtitleRenderPosition,
  TransitionDurationSec,
  YoutubeHandoffMode,
} from "../../shared/domain";
import { formatBytes, formatDuration, formatRenderClock } from "../format";
import {
  DEFAULT_AUDIO_PROTECTION_OPTIONS,
  DEFAULT_AUDIO_PROCESSING_OPTIONS,
  DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  DEFAULT_MAIN_START_CARD_OPTIONS,
  DEFAULT_MAIN_START_CUE_SETTINGS,
} from "../../shared/domain";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import { YoutubeSettingsModal } from "./YoutubeSettingsModal";
import { YoutubeUploadModal } from "./YoutubeUploadModal";
import { MainStartCardModal } from "./MainStartCardModal";
import { OutputLibrary } from "./OutputLibrary";
import { AudioProtectionSettings } from "./AudioProtectionSettings";
import { AudioProcessingSettings } from "./AudioProcessingSettings";
import { outputDimensions } from "../../shared/render-profile";
import { buildInsertionAudioPlan } from "../../shared/insertion-audio-plan";

interface ConcatRenderModalProps {
  project?: ProjectManifest;
  assets: SourceAsset[];
  purpose?: PreviewRenderPurpose;
  introClips?: IntroSuggestion[];
  introSegmentMaxDurationMs?: number;
  mainClips?: RenderClipSelection[];
  confirmedSubtitleCount?: number;
  subtitlesNeedReview?: boolean;
  initialResolution?: PreviewResolution;
  projectName?: string;
  timelineRevision?: number;
  onPurposeChange?: (purpose: "CONCAT" | "INTRO") => void;
  onClose: () => void;
}

const TRANSITIONS: TransitionDurationSec[] = [0.3, 0.5, 0.7];

function largestDiskContributors(breakdown: RenderDiskEstimateBreakdown): Array<{ label: string; bytes: number }> {
  return [
    { label: "Final-ready 中繼片段", bytes: breakdown.remainingIntermediatePeakBytes },
    { label: "平行工作 partial", bytes: breakdown.concurrentPartialPeakBytes },
    { label: "畫面／Base Audio Master", bytes: breakdown.reusableBaseMasterBytes ?? 0 },
    { label: "最終成品", bytes: breakdown.estimatedFinalOutputBytes },
    { label: "音訊 TEMP", bytes: breakdown.audioTemporaryBytes },
    { label: "Mux 暫存與容器開銷", bytes: breakdown.muxOverheadBytes },
  ]
    .filter((item) => item.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3);
}
const RESOLUTIONS: Array<{
  value: PreviewResolution;
  label: string;
  detail: string;
}> = [
  { value: "360P", label: "360p", detail: "640 × 360 · 較快、檔案較小" },
  { value: "480P", label: "480p", detail: "854 × 480 · 畫面較清楚" },
  { value: "720P", label: "720p", detail: "1280 × 720 · HD 預覽" },
  { value: "1080P", label: "1080p", detail: "1920 × 1080 · 建議預設" },
  { value: "1440P", label: "1440p（2K）", detail: "2560 × 1440 · 細節較高" },
  { value: "4K", label: "4K", detail: "3840 × 2160 · 最慢、檔案最大" },
];
const RESOLUTION_LABELS = Object.fromEntries(
  RESOLUTIONS.map(({ value }) => {
    const dimensions = outputDimensions(value);
    return [value, `${dimensions.width} × ${dimensions.height}`];
  }),
) as Record<PreviewResolution, string>;
const SUBTITLE_LANGUAGES: Array<{
  value: SubtitleRenderLanguage;
  label: string;
}> = [
  { value: "zh-TW", label: "繁體中文（原文）" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
];
const SUBTITLE_POSITIONS: Array<{
  value: SubtitleRenderPosition;
  label: string;
}> = [
  { value: "TOP", label: "上方" },
  { value: "MIDDLE", label: "中央" },
  { value: "BOTTOM", label: "下方" },
];
const DEFAULT_SUBTITLE_STYLE_PROFILE = {
  verticalPositionPercent: 82,
  fontSizePx: 28,
  textColor: "#FFFFFF",
  shadowEnabled: true,
  outlineWidthPx: 2,
} as const;

function suggestedFileName(purpose: PreviewRenderPurpose): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  return `SceneryWalker_${purpose === "INTRO" ? "intro" : purpose === "CLIP" ? "4K_clip" : "preview"}_${stamp}.mp4`;
}

function progressLabel(progress?: ConcatRenderProgress): string {
  if (!progress || progress.phase === "PREPARING") return "正在檢查來源與媒體資訊…";
  if (progress.phase === "TRANSLATING_SUBTITLES") return "正在翻譯並排版已確認字幕…";
  if (progress.phase === "WAITING_FOR_MEMORY") return "可用記憶體偏低，暫停送入下一個片段…";
  if (progress.phase === "FINALIZING") return "正在驗證並完成 MP4…";
  return "正在編碼串連預覽…";
}

export function ConcatRenderModal({
  project,
  assets,
  purpose = "CONCAT",
  introClips,
  introSegmentMaxDurationMs = DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  mainClips,
  confirmedSubtitleCount = 0,
  subtitlesNeedReview = false,
  initialResolution,
  projectName,
  timelineRevision,
  onPurposeChange,
  onClose,
}: ConcatRenderModalProps) {
  const [transitionSeconds, setTransitionSeconds] = useState<TransitionDurationSec>(0.3);
  const [resolution, setResolution] = useState<PreviewResolution>(initialResolution ?? "1080P");
  const [videoCodec, setVideoCodec] = useState<RenderVideoCodec>("H264_QSV");
  const [hardwareCapabilities, setHardwareCapabilities] = useState<RenderHardwareCapabilities>();
  const [lowMemorySegmented, setLowMemorySegmented] = useState(true);
  const [highSpeedMode, setHighSpeedMode] = useState(false);
  const [maximumRenderRamGiB, setMaximumRenderRamGiB] = useState(8);
  const [maximumRenderTempGiB, setMaximumRenderTempGiB] = useState<number | "AUTO">(100);
  const [includeWatermark, setIncludeWatermark] = useState(true);
  const [postSuccessPower, setPostSuccessPower] = useState<PostSuccessPowerPreference>({
    enabled: false,
    trigger: "RENDER_SUCCESS",
    action: "SHUTDOWN",
  });
  const [youtubeHandoffMode, setYoutubeHandoffMode] = useState<YoutubeHandoffMode>("CHROME_DRAG_DROP");
  const [output, setOutput] = useState<OutputSelection>();
  const [renderEstimate, setRenderEstimate] = useState<ConcatRenderEstimate>();
  const [estimateBusy, setEstimateBusy] = useState(false);
  const [estimateError, setEstimateError] = useState<string>();
  const [renderTempRefreshKey, setRenderTempRefreshKey] = useState(0);
  const [resumeOffer, setResumeOffer] = useState<RenderResumeOffer>();
  const [progress, setProgress] = useState<ConcatRenderProgress>();
  const timingSnapshotReceivedAtRef = useRef(performance.now());
  const [timingTick, setTimingTick] = useState(() => performance.now());
  const [result, setResult] = useState<ConcatRenderResult>();
  const [rendering, setRendering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [remotePreparedAt, setRemotePreparedAt] = useState<string>();
  const [remotePreparedFingerprint, setRemotePreparedFingerprint] = useState<string>();
  // monitoring = this window did not start the render; it adopted a render
  // that is already running in the background (user closed and reopened).
  const [monitoring, setMonitoring] = useState(false);
  const [backgroundNotice, setBackgroundNotice] = useState<string>();
  const monitoringJobIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const [showYoutubeUpload, setShowYoutubeUpload] = useState(false);
  const [showYoutubeSettings, setShowYoutubeSettings] = useState(false);
  const [youtubeSettingsRevision, setYoutubeSettingsRevision] = useState(0);
  const [outputOpenError, setOutputOpenError] = useState<string>();
  const [platformHandoffBusy, setPlatformHandoffBusy] = useState<"YOUTUBE" | "BILIBILI" | "TIKTOK">();
  const [platformHandoffNotice, setPlatformHandoffNotice] = useState<string>();
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const isIntro = purpose === "INTRO";
  const isClip = purpose === "CLIP";
  const isMain = purpose === "CONCAT";
  const isYoutubeEligible = isMain || isIntro;
  const resourceProfile = lowMemorySegmented ? "LOW_DISK" : highSpeedMode ? "HIGH_SPEED" : "BALANCED";
  const purposeTitle = isIntro ? "產出 Intro 預覽" : isClip ? "輸出最高 4K 時間段" : "產出串連預覽";
  const historyTitle = isIntro ? "曾經輸出的片頭預覽" : isClip ? "曾經輸出的 4K 時間段" : "曾經輸出的正片預覽";
  const [prependIntro, setPrependIntro] = useState(() => isMain && Boolean(introClips?.length));
  const [autoUploadEnabled, setAutoUploadEnabled] = useState(() => isMain);
  const [youtubeFullAutoUploadEnabled, setYoutubeFullAutoUploadEnabled] = useState(() => isMain);
  const [autoUploadStatus, setAutoUploadStatus] = useState<"DISABLED" | "ARMED" | "COUNTING" | "CANCELLED" | "OPENED">(
    () => (isMain ? "ARMED" : "DISABLED"),
  );
  const [subtitleBurnIn, setSubtitleBurnIn] = useState<SubtitleBurnInOptions>({
    enabled: false,
    tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
    styleProfile: { ...DEFAULT_SUBTITLE_STYLE_PROFILE },
  });
  const [includeBgm, setIncludeBgm] = useState(() => isMain);
  const [bgmScopes, setBgmScopes] = useState<BgmScopeSelection>(() => ({ intro: true, main: true }));

  const timingAdvanceMs =
    progress?.timingStatus === "RUNNING" ? Math.max(0, timingTick - timingSnapshotReceivedAtRef.current) : 0;
  const displayedAttemptElapsedMs =
    progress?.attemptElapsedMs === undefined ? undefined : progress.attemptElapsedMs + timingAdvanceMs;
  const displayedCumulativeElapsedMs =
    progress?.cumulativeElapsedMs === undefined ? undefined : progress.cumulativeElapsedMs + timingAdvanceMs;
  const [audioProtection, setAudioProtection] = useState<AudioProtectionOptions>(() => ({
    ...DEFAULT_AUDIO_PROTECTION_OPTIONS,
  }));
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingOptions>(() => ({
    ...DEFAULT_AUDIO_PROCESSING_OPTIONS,
  }));
  const [mainStartCard, setMainStartCard] = useState<MainStartCardOptions>(() => ({
    ...DEFAULT_MAIN_START_CARD_OPTIONS,
    line1: projectName?.trim() || DEFAULT_MAIN_START_CARD_OPTIONS.line1,
  }));
  const [mainStartCardConfirmed, setMainStartCardConfirmed] = useState(false);
  const [mainStartCue, setMainStartCue] = useState<MainStartCueSettings>(() =>
    project?.mainStartCue ?? { ...DEFAULT_MAIN_START_CUE_SETTINGS },
  );
  const [showMainStartCard, setShowMainStartCard] = useState(false);
  const [uploadCountdownSeconds, setUploadCountdownSeconds] = useState<number>();
  const preferencesTouchedRef = useRef(false);
  const effectiveIntroClips = useMemo(
    () => introSegmentsForOutput(introClips ?? [], introSegmentMaxDurationMs),
    [introClips, introSegmentMaxDurationMs],
  );
  const introDurationWarningCount = useMemo(
    () => (introClips ?? []).filter((clip) => clip.outMs - clip.inMs > introSegmentMaxDurationMs).length,
    [introClips, introSegmentMaxDurationMs],
  );
  const renderItems = useMemo(
    () =>
      isIntro
        ? effectiveIntroClips.map((clip) => ({
            key: clip.id,
            assetId: clip.assetId,
            fileName: clip.fileName,
            inMs: clip.inMs,
            outMs: clip.outMs,
            mediaInsertionId: undefined as string | undefined,
            section: "INTRO" as const,
          }))
        : [
            ...(isMain && prependIntro
              ? effectiveIntroClips.map((clip) => ({
                  key: `intro:${clip.id}`,
                  assetId: clip.assetId,
                  fileName: clip.fileName,
                  inMs: clip.inMs,
                  outMs: clip.outMs,
                  mediaInsertionId: undefined as string | undefined,
                  section: "INTRO" as const,
                }))
              : []),
            ...(mainClips ?? []).map((clip, index) => ({
              key: `${clip.assetId}:${clip.inMs}:${clip.outMs}:${clip.mediaInsertionId ?? "main"}:${index}`,
              assetId: clip.assetId,
              fileName: assets.find((asset) => asset.id === clip.assetId)?.fileName ?? clip.assetId,
              inMs: clip.inMs,
              outMs: clip.outMs,
              mediaInsertionId: clip.mediaInsertionId,
              section: "MAIN" as const,
            })),
          ],
    [assets, effectiveIntroClips, isIntro, isMain, mainClips, prependIntro],
  );
  const insertionAudioPlan = useMemo(
    () =>
      project && !isClip
        ? buildInsertionAudioPlan({ ...project, mainStartCue }, {
            purpose,
            transitionSeconds,
            prependIntro,
            mainStartCard: prependIntro ? mainStartCard : undefined,
            includeBgm,
          })
        : undefined,
    [project, purpose, isClip, transitionSeconds, prependIntro, mainStartCard, mainStartCue, includeBgm],
  );
  const remotePreparationFingerprint = JSON.stringify({
    outputToken: output?.token,
    transitionSeconds,
    resolution,
    videoCodec,
    includeWatermark,
    audioProtection,
    audioProcessing,
    purpose,
    prependIntro,
    subtitleBurnIn,
    includeBgm,
    bgmScopes,
    lowMemorySegmented,
    highSpeedMode,
    resourceProfile,
    maximumRenderRamGiB,
    maximumRenderTempGiB,
    renderItems,
  });

  useEffect(() => {
    if (!remotePreparedFingerprint || remotePreparedFingerprint === remotePreparationFingerprint) return;
    setRemotePreparedFingerprint(undefined);
    setRemotePreparedAt(undefined);
    void window.sourceApp.clearRemotePreparedRender?.();
  }, [remotePreparationFingerprint, remotePreparedFingerprint]);

  const prepareAutomaticOutput = async (preserveExistingError = false) => {
    if (!preserveExistingError) setError(undefined);
    try {
      setOutput(await window.sourceApp.prepareConcatOutput(suggestedFileName(purpose)));
    } catch (reason) {
      if (!preserveExistingError) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    window.sourceApp.onConcatProgress((next) => {
      timingSnapshotReceivedAtRef.current = performance.now();
      setProgress(next);
      setTimingTick(timingSnapshotReceivedAtRef.current);
    });
    void prepareAutomaticOutput();
    void window.sourceApp
      .getConcatRenderResumeOffer?.()
      .then((offer) => {
        if (mountedRef.current) setResumeOffer(offer);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    void window.sourceApp
      .getRenderHardwareCapabilities?.()
      .then((capabilities) => {
        if (mountedRef.current) setHardwareCapabilities(capabilities);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    void window.sourceApp
      .getUserPreferences()
      .then((preferences) => {
        if (preferencesTouchedRef.current) return;
        setTransitionSeconds(preferences.renderDefaults.transitionSeconds);
        setResolution(isClip ? "4K" : (initialResolution ?? preferences.renderDefaults.resolution));
        // Older renderer harnesses may omit this field. H.264 hardware output
        // is the safe speed/compatibility default; the probe decides NVENC vs QSV.
        setVideoCodec(preferences.renderDefaults.videoCodec ?? "H264_QSV");
        setLowMemorySegmented(preferences.renderDefaults.lowMemorySegmented !== false);
        setHighSpeedMode(preferences.renderDefaults.highSpeedMode === true);
        setMaximumRenderRamGiB(preferences.renderDefaults.maximumRenderRamGiB ?? 8);
        setMaximumRenderTempGiB(preferences.renderDefaults.maximumRenderTempGiB ?? 100);
        setIncludeWatermark(preferences.renderDefaults.includeWatermark !== false);
        setPostSuccessPower(
          preferences.renderDefaults.postSuccessPower ?? {
            enabled: false,
            trigger: "RENDER_SUCCESS",
            action: "SHUTDOWN",
          },
        );
        setAudioProtection({
          ...DEFAULT_AUDIO_PROTECTION_OPTIONS,
          ...(preferences.renderDefaults.audioProtection ?? {}),
        });
        const rememberedAudio = {
          ...DEFAULT_AUDIO_PROCESSING_OPTIONS,
          ...(preferences.renderDefaults.audioProcessing ?? {}),
        };
        const canPreserve = Boolean(
          isClip &&
          assets.length === 1 &&
          (assets[0].mediaInfo?.audioChannels ?? 0) > 2 &&
          assets[0].mediaInfo?.audioChannelLayout,
        );
        setAudioProcessing(
          rememberedAudio.mode === "PRESERVE_MULTICHANNEL" && !canPreserve
            ? { ...rememberedAudio, mode: "ORIGINAL_STEREO" }
            : rememberedAudio,
        );
        setBgmScopes({ intro: true, main: true, ...(preferences.renderDefaults.mainBgmScopes ?? {}) });
        setYoutubeHandoffMode(preferences.renderDefaults.youtubeHandoffMode ?? "CHROME_DRAG_DROP");
        if (isYoutubeEligible)
          setSubtitleBurnIn({
            ...preferences.subtitleBurnInDefaults,
            styleProfile: preferences.subtitlePreviewStyle,
          });
        if (isIntro) setIncludeBgm(preferences.renderDefaults.introPreviewIncludeBgm);
        if (isMain) setIncludeBgm(preferences.renderDefaults.mainPreviewIncludeBgm);
        if (isMain) {
          const shouldPrepend = Boolean(introClips?.length) && preferences.renderDefaults.prependIntro;
          setPrependIntro(shouldPrepend);
          setMainStartCard(
            preferences.renderDefaults.mainStartCard ?? {
              ...DEFAULT_MAIN_START_CARD_OPTIONS,
              line1: projectName?.trim() || DEFAULT_MAIN_START_CARD_OPTIONS.line1,
            },
          );
          setMainStartCardConfirmed(false);
          if (shouldPrepend) setShowMainStartCard(true);
          setAutoUploadEnabled(preferences.renderDefaults.autoUpload);
          const fullAuto = preferences.renderDefaults.youtubeFullAutoUpload !== false;
          setYoutubeFullAutoUploadEnabled(fullAuto);
          if (fullAuto) setYoutubeHandoffMode("OFFICIAL_API");
          setAutoUploadStatus(preferences.renderDefaults.autoUpload ? "ARMED" : "DISABLED");
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => window.sourceApp.clearConcatProgressListeners();
  }, [initialResolution, introClips?.length, isClip, isIntro, isMain, isYoutubeEligible, projectName]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!rendering || progress?.timingStatus !== "RUNNING") return;
    const timer = window.setInterval(() => setTimingTick(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progress?.timingStatus, rendering]);

  // Adopt a render that is already running in the background (the user closed
  // this window with × and reopened it). Progress keeps flowing through the
  // regular concat:progress subscription; completion is observed here.
  useEffect(() => {
    const jobsApi = window.sourceApp.getBackgroundJobs;
    if (jobsApi) {
      void jobsApi()
        .then((jobs: BackgroundJobSnapshot[]) => {
          if (!mountedRef.current) return;
          const running = jobs.find((job) => job.kind === "CONCAT_RENDER" && job.status === "RUNNING");
          if (running) {
            monitoringJobIdRef.current = running.id;
            timingSnapshotReceivedAtRef.current = performance.now();
            setMonitoring(true);
            setRendering(true);
            setTimingTick(timingSnapshotReceivedAtRef.current);
            setProgress({
              phase: "RENDERING",
              percent: running.percent ?? 0,
              outTimeMs: 0,
              expectedDurationMs: 0,
              attemptElapsedMs: running.attemptElapsedMs,
              cumulativeElapsedMs: running.cumulativeElapsedMs,
              timingCapturedAt: new Date().toISOString(),
              timingStatus: running.attemptElapsedMs === undefined ? undefined : "RUNNING",
            });
          }
        })
        .catch(() => undefined);
    }
    const onJobs = window.sourceApp.onBackgroundJobs;
    if (!onJobs) return;
    onJobs((jobs: BackgroundJobSnapshot[]) => {
      const trackedId = monitoringJobIdRef.current;
      if (!trackedId || !mountedRef.current) return;
      const tracked = jobs.find((job) => job.id === trackedId);
      if (!tracked || tracked.status === "RUNNING") return;
      monitoringJobIdRef.current = null;
      setMonitoring(false);
      setRendering(false);
      if (tracked.status === "COMPLETED") {
        setBackgroundNotice("背景轉檔完成，成品已加入下方的輸出檔案庫。");
        setHistoryRefreshKey((value) => value + 1);
      } else if (tracked.status === "FAILED") {
        setError(tracked.error ?? "背景轉檔失敗，請重試。");
      } else {
        setBackgroundNotice("背景轉檔已取消。");
      }
    });
    return () => window.sourceApp.clearBackgroundJobsListeners?.();
  }, []);

  const rememberRenderDefaults = (
    update: Parameters<typeof window.sourceApp.updateUserPreferences>[0]["renderDefaults"],
  ) => {
    preferencesTouchedRef.current = true;
    void window.sourceApp
      .updateUserPreferences({ renderDefaults: update })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const updateSubtitleBurnIn = (next: SubtitleBurnInOptions) => {
    preferencesTouchedRef.current = true;
    setSubtitleBurnIn(next);
    void window.sourceApp
      .updateUserPreferences({ subtitleBurnInDefaults: next })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  // The checkbox must always remain usable for turning permanent subtitle burn-in
  // off.  Validation is only required when enabling it; this avoids a disabled
  // control trapping a previously saved "enabled" preference.
  const toggleSubtitleBurnIn = (enabled: boolean) => {
    if (enabled && (!confirmedSubtitleCount || subtitlesNeedReview)) {
      setError(
        !confirmedSubtitleCount
          ? `尚無已確認${isIntro ? "片頭" : "正片"}字幕；請先到「CC 字幕」確認並保存。`
          : `${isIntro ? "片頭" : "正片"}順序或 IN／OUT 已變更；請先重新複核並保存字幕。\n若只是不嵌入字幕，可直接取消勾選。`,
      );
      return;
    }
    setError(undefined);
    updateSubtitleBurnIn({ ...subtitleBurnIn, enabled });
  };

  const patchSubtitleTrack = (index: number, patch: Partial<SubtitleBurnInOptions["tracks"][number]>) => {
    const tracks = subtitleBurnIn.tracks.map((track, current) => (current === index ? { ...track, ...patch } : track));
    updateSubtitleBurnIn({ ...subtitleBurnIn, tracks });
  };

  const updateAudioProtection = (patch: Partial<AudioProtectionOptions>) => {
    const next = { ...audioProtection, ...patch };
    setAudioProtection(next);
    rememberRenderDefaults({ audioProtection: next });
  };
  const updateAudioProcessing = (next: AudioProcessingOptions) => {
    setAudioProcessing(next);
    rememberRenderDefaults({ audioProcessing: next });
  };

  const updatePostSuccessPower = (patch: Partial<PostSuccessPowerPreference>) => {
    const next = { ...postSuccessPower, ...patch };
    setPostSuccessPower(next);
    rememberRenderDefaults({ postSuccessPower: next });
  };

  const updateBgmScopes = (patch: Partial<BgmScopeSelection>) => {
    const next = { ...bgmScopes, ...patch };
    setBgmScopes(next);
    rememberRenderDefaults({ mainBgmScopes: next });
  };

  const updatePrimarySubtitlePreviewSize = (fontSizePx: number) => {
    const styleProfile = {
      ...(subtitleBurnIn.styleProfile ?? DEFAULT_SUBTITLE_STYLE_PROFILE),
      fontSizePx: Math.max(16, Math.min(72, fontSizePx || 16)),
    };
    const next = { ...subtitleBurnIn, styleProfile };
    preferencesTouchedRef.current = true;
    setSubtitleBurnIn(next);
    void window.sourceApp
      .updateUserPreferences({
        subtitleBurnInDefaults: next,
        subtitlePreviewStyle: styleProfile,
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  useEffect(() => {
    if (autoUploadStatus !== "COUNTING") return;
    if ((uploadCountdownSeconds ?? 0) <= 0) {
      setAutoUploadStatus("OPENED");
      if (youtubeFullAutoUploadEnabled || youtubeHandoffMode === "OFFICIAL_API") setShowYoutubeUpload(true);
      else void openYoutubeChromeHandoff();
      return;
    }
    const timer = window.setTimeout(
      () => setUploadCountdownSeconds((current) => Math.max(0, (current ?? 0) - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [autoUploadStatus, uploadCountdownSeconds, youtubeFullAutoUploadEnabled, youtubeHandoffMode]);

  const estimatedDurationMs = useMemo(() => {
    if (renderItems.some((item) => item.outMs <= item.inMs)) return undefined;
    return Math.max(
      0,
      renderItems.reduce((sum, item) => sum + item.outMs - item.inMs, 0) -
        transitionSeconds * 1000 * Math.max(0, renderItems.length - 1),
    );
  }, [renderItems, transitionSeconds]);

  const totalEstimatedDurationMs = useMemo(
    () =>
      estimatedDurationMs === undefined
        ? undefined
        : Math.max(
            0,
            estimatedDurationMs +
              (isMain && prependIntro
                ? mainStartCard.durationSeconds * 1000 +
                  (mainStartCard.transitionStyle === "HARD_CUT" ? transitionSeconds * 1000 : -transitionSeconds * 1000)
                : 0),
          ),
    [
      estimatedDurationMs,
      isMain,
      mainStartCard.durationSeconds,
      mainStartCard.transitionStyle,
      prependIntro,
      transitionSeconds,
    ],
  );

  useEffect(() => {
    if (!output || totalEstimatedDurationMs === undefined || !window.sourceApp.estimateConcatRender) {
      setRenderEstimate(undefined);
      setEstimateError(undefined);
      return;
    }
    let active = true;
    setEstimateBusy(true);
    void window.sourceApp
      .estimateConcatRender({
        outputToken: output.token,
        expectedDurationMs: totalEstimatedDurationMs,
        resolution,
        videoCodec,
        lowMemorySegmented,
        highSpeedMode,
        resourceProfile,
        maximumRenderRamGiB,
        maximumRenderTempGiB,
        orderedAssetIds: renderItems.map((item) => item.assetId),
        clipSelections: renderItems.map((item) => ({
          assetId: item.assetId,
          inMs: item.inMs,
          outMs: item.outMs,
          ...(item.mediaInsertionId ? { mediaInsertionId: item.mediaInsertionId } : {}),
        })),
        transitionSeconds,
        generatedInputCount: isMain && prependIntro ? 1 : 0,
      })
      .then((estimate) => {
        if (active) {
          setRenderEstimate(estimate);
          if (estimate.hardwareCapabilities) setHardwareCapabilities(estimate.hardwareCapabilities);
          setEstimateError(estimate.canRender ? undefined : estimate.warning);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setRenderEstimate(undefined);
          setEstimateError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (active) setEstimateBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    isMain,
    highSpeedMode,
    lowMemorySegmented,
    maximumRenderRamGiB,
    maximumRenderTempGiB,
    output?.token,
    prependIntro,
    renderItems,
    resolution,
    totalEstimatedDurationMs,
    transitionSeconds,
    videoCodec,
    renderTempRefreshKey,
  ]);

  const chooseRenderTemp = async () => {
    if (!window.sourceApp.chooseRenderTemporaryFolder) return;
    try {
      const selected = await window.sourceApp.chooseRenderTemporaryFolder();
      if (!selected) return;
      setRenderTempRefreshKey((value) => value + 1);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const chooseOutput = async () => {
    setError(undefined);
    try {
      const selected = await window.sourceApp.chooseConcatOutput(suggestedFileName(purpose));
      if (selected) setOutput(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const currentRenderRequest = (resourceWarningAcknowledged = false): ConcatRenderRequest => ({
    outputToken: output?.token ?? "",
    orderedAssetIds: renderItems.map((item) => item.assetId),
    clipSelections: renderItems.map((item) => ({
      assetId: item.assetId,
      inMs: item.inMs,
      outMs: item.outMs,
      ...(item.mediaInsertionId ? { mediaInsertionId: item.mediaInsertionId } : {}),
    })),
    transitionSeconds,
    resolution,
    videoCodec,
    includeWatermark,
    audioProtection,
    audioProcessing,
    purpose,
    prependIntro: isMain && prependIntro,
    subtitleBurnIn: isYoutubeEligible ? subtitleBurnIn : { enabled: false, tracks: [] },
    includeBgm: isClip ? false : includeBgm,
    ...(isMain ? { bgmScopes: { intro: prependIntro && bgmScopes.intro, main: bgmScopes.main } } : {}),
    estimatedDurationMs: totalEstimatedDurationMs,
    lowMemorySegmented,
    highSpeedMode,
    resourceProfile,
    maximumRenderRamGiB,
    maximumRenderTempGiB,
    resourceWarningAcknowledged,
    ...(isMain && prependIntro ? { mainStartCard } : {}),
  });

  const prepareRemoteRender = async () => {
    if (!output || !window.sourceApp.prepareRemoteRender) return;
    if (!renderEstimate) {
      setError("请先等待 Windows 端完成转档资源预估与输出预检。");
      return;
    }
    if (isMain && prependIntro && !mainStartCardConfirmed) {
      setError("请先确认正片开始提示页，再开放 iPhone 远端启动。");
      setShowMainStartCard(true);
      return;
    }
    const warnings =
      resourceProfile === "LOW_DISK"
        ? renderEstimate?.modeEstimates.lowDisk?.warnings
        : resourceProfile === "HIGH_SPEED"
          ? renderEstimate?.modeEstimates.highSpeed?.warnings
          : renderEstimate?.modeEstimates.balanced?.warnings;
    if (
      warnings?.length &&
      !window.confirm(
        [
          "远端开始仍会执行最新系统预检。当前有以下提醒：",
          ...warnings.map((item) => `• ${item}`),
          "",
          "仍要准备给 iPhone 启动吗？",
        ].join("\n"),
      )
    )
      return;
    try {
      const prepared = await window.sourceApp.prepareRemoteRender(currentRenderRequest(true));
      setRemotePreparedAt(prepared.preparedAt);
      setRemotePreparedFingerprint(remotePreparationFingerprint);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const startRender = async () => {
    if (!output) return;
    if (isMain && prependIntro && !mainStartCardConfirmed) {
      setError("請先確認 3–7 秒的正片開始提示頁設定，才會開始串接輸出。");
      setShowMainStartCard(true);
      return;
    }
    if (window.sourceApp.setTimelineTransitionSeconds) {
      try {
        await window.sourceApp.setTimelineTransitionSeconds(transitionSeconds);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
    }
    let resourceWarningAcknowledged = false;
    if (window.sourceApp.estimateConcatRender && totalEstimatedDurationMs !== undefined) {
      try {
        const latestEstimate = await window.sourceApp.estimateConcatRender({
          outputToken: output.token,
          expectedDurationMs: totalEstimatedDurationMs,
          resolution,
          videoCodec,
          lowMemorySegmented,
          highSpeedMode,
          resourceProfile,
          maximumRenderRamGiB,
          maximumRenderTempGiB,
          orderedAssetIds: renderItems.map((item) => item.assetId),
          clipSelections: renderItems.map((item) => ({
            assetId: item.assetId,
            inMs: item.inMs,
            outMs: item.outMs,
            ...(item.mediaInsertionId ? { mediaInsertionId: item.mediaInsertionId } : {}),
          })),
          transitionSeconds,
          generatedInputCount: isMain && prependIntro ? 1 : 0,
        });
        setRenderEstimate(latestEstimate);
        setEstimateError(latestEstimate.canRender ? undefined : latestEstimate.warning);
        if (!latestEstimate.canRender) {
          setError(latestEstimate.warning ?? "磁碟空間不足，本次不會開始轉檔。");
          return;
        }
        const selectedMode =
          resourceProfile === "LOW_DISK"
            ? (latestEstimate.modeEstimates.lowDisk ?? latestEstimate.modeEstimates.lowMemory)
            : resourceProfile === "HIGH_SPEED"
              ? (latestEstimate.modeEstimates.highSpeed ?? latestEstimate.modeEstimates.normal)
              : (latestEstimate.modeEstimates.balanced ?? latestEstimate.modeEstimates.normal);
        if (selectedMode.warnings.length) {
          resourceWarningAcknowledged = window.confirm(
            [
              "目前系統資源有以下提醒：",
              "",
              ...selectedMode.warnings.map((warning) => `• ${warning}`),
              "",
              "按『確定』仍繼續；按『取消』先返回並關閉其他大型程式。",
            ].join("\n"),
          );
          if (!resourceWarningAcknowledged) return;
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setEstimateError(message);
        setError(message);
        return;
      }
    }
    setRendering(true);
    setCancelling(false);
    setResult(undefined);
    setError(undefined);
    setProgress({
      phase: "PREPARING",
      percent: 0,
      outTimeMs: 0,
      expectedDurationMs: 0,
    });
    try {
      const completed = await window.sourceApp.startConcatRender(currentRenderRequest(resourceWarningAcknowledged));
      if (!mountedRef.current) return;
      setResult(completed);
      setResumeOffer(undefined);
      setHistoryRefreshKey((value) => value + 1);
      if (isYoutubeEligible && autoUploadEnabled && !completed.cancelled) {
        setUploadCountdownSeconds(60);
        setAutoUploadStatus("COUNTING");
      } else {
        setUploadCountdownSeconds(undefined);
        setAutoUploadStatus("DISABLED");
      }
      setProgress((current) => ({
        ...current,
        phase: "FINALIZING",
        percent: 100,
        outTimeMs: completed.expectedDurationMs,
        expectedDurationMs: completed.expectedDurationMs,
      }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!mountedRef.current) return;
      setError(message.includes("取消") ? "已取消產出；未留下不完整的輸出檔。" : message);
      if (!message.includes("取消") && window.sourceApp.getConcatRenderResumeOffer) {
        setResumeOffer(await window.sourceApp.getConcatRenderResumeOffer());
      }
      await prepareAutomaticOutput(true);
    } finally {
      if (mountedRef.current) {
        setRendering(false);
        setCancelling(false);
      }
    }
  };

  const resumeRender = async () => {
    if (!resumeOffer || !window.sourceApp.resumeConcatRender) return;
    const missingRecorded = resumeOffer.missingCompletedSegmentCount ?? 0;
    const resumeSummary = missingRecorded > 0
      ? `紀錄中有 ${resumeOffer.recordedCompletedSegmentCount ?? resumeOffer.completedSegmentCount} 個完成片段，但其中 ${missingRecorded} 個實體檔案已遺失；續轉時會重新建立缺失片段。`
      : `可沿用 ${resumeOffer.completedSegmentCount}/${resumeOffer.totalSegmentCount} 個目前存在的片段；正式使用前仍會逐檔驗證。`;
    const recoveryNotice = resumeOffer.legacyRecoveryProtected
      ? "v0.79 原 checkpoint 與片段會作為唯讀復原來源，先驗證再建立 v0.80 的獨立工作狀態。"
      : resumeOffer.recoverySourcePreserved
        ? "v0.79 原始復原資料會保留不變。"
        : "";
    if (
      !window.confirm(
        `${resumeSummary}\n${recoveryNotice ? `${recoveryNotice}\n` : ""}輸出：${resumeOffer.outputPath}\n\n是否繼續？`,
      )
    )
      return;
    setRendering(true);
    setCancelling(false);
    setResult(undefined);
    setError(undefined);
    setProgress({ phase: "PREPARING", percent: 0, outTimeMs: 0, expectedDurationMs: 0 });
    try {
      const completed = await window.sourceApp.resumeConcatRender(resumeOffer.checkpointId);
      if (!mountedRef.current) return;
      setResult(completed);
      setResumeOffer(undefined);
      setHistoryRefreshKey((value) => value + 1);
    } catch (reason) {
      if (!mountedRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setResumeOffer(await window.sourceApp.getConcatRenderResumeOffer?.());
    } finally {
      if (mountedRef.current) setRendering(false);
    }
  };

  const discardResume = async () => {
    if (!resumeOffer || !window.sourceApp.discardConcatRenderResume) return;
    if (resumeOffer.legacyRecoveryProtected) {
      setError("v0.79 原始續轉資料受保護，不能在此刪除。請先選擇接續上次轉檔，由 v0.80 驗證後建立獨立工作狀態。");
      return;
    }
    if (!window.confirm("捨棄後會刪除可重建的轉檔中繼片段與診斷 checkpoint，不會刪除來源或既有成品。是否捨棄？"))
      return;
    try {
      await window.sourceApp.discardConcatRenderResume(resumeOffer.checkpointId);
      setResumeOffer(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const discardReusableMaster = async () => {
    if (!window.sourceApp.discardConcatVideoMaster) return;
    if (!window.confirm("删除此专案最近一份可重建的画面 Master？来源与既有输出不会删除；下次只改音讯时将需要重新编码画面。")) return;
    try {
      await window.sourceApp.discardConcatVideoMaster();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancelRender = async () => {
    setCancelling(true);
    try {
      await window.sourceApp.cancelConcatRender();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setCancelling(false);
    }
  };

  const openPlatformHandoff = async (platform: "BILIBILI" | "TIKTOK") => {
    if (!result) return;
    setPlatformHandoffBusy(platform);
    setOutputOpenError(undefined);
    setPlatformHandoffNotice(undefined);
    try {
      setPlatformHandoffNotice((await window.sourceApp.openPlatformUpload(result.jobId, platform)).message);
    } catch (reason) {
      setOutputOpenError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPlatformHandoffBusy(undefined);
    }
  };

  const openYoutubeChromeHandoff = async () => {
    if (!result || !window.sourceApp.prepareYoutubeChromeHandoff) return;
    setPlatformHandoffBusy("YOUTUBE");
    setOutputOpenError(undefined);
    setPlatformHandoffNotice(undefined);
    try {
      setPlatformHandoffNotice((await window.sourceApp.prepareYoutubeChromeHandoff(result.jobId)).message);
    } catch (reason) {
      setOutputOpenError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPlatformHandoffBusy(undefined);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="concat-modal" role="dialog" aria-modal="true" aria-label={purposeTitle}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">
              {isIntro ? "INTRO PREVIEW OUTPUT" : isClip ? "SOURCE-BASED 4K CLIP" : "CONCAT PREVIEW OUTPUT"}
            </span>
            <h2>{purposeTitle}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="關閉"
            title={rendering ? "關閉視窗，轉檔繼續在背景執行" : "關閉"}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {resumeOffer && !rendering && !result && (
          <section className="render-resume-offer" role="status" aria-label="未完成轉檔續轉">
            <div>
              <span className="eyebrow">RESUMABLE RENDER</span>
              <strong>偵測到上一次未完成的轉檔</strong>
              <p>
                實體存在 {resumeOffer.completedSegmentCount}/{resumeOffer.totalSegmentCount} 個片段；
                {resumeOffer.concatStatus === "FAILED" ? "上次在分段或最終串連時失敗。" : "可從目前進度繼續。"}
              </p>
              {resumeOffer.totalSegmentCount > 0 && (
                <small>
                  片段階段已完成 {Math.round((resumeOffer.completedSegmentCount / resumeOffer.totalSegmentCount) * 100)}%
                  （不代表整支影片已完成）。
                </small>
              )}
              {resumeOffer.reusableBytes !== undefined && (
                <small>
                  可重用資料：{formatBytes(resumeOffer.reusableBytes)}
                  {resumeOffer.reusableDurationMs !== undefined
                    ? `，對應片段時長 ${formatRenderClock(resumeOffer.reusableDurationMs)}`
                    : ""}
                  ；正式沿用前仍會驗證格式與完整性。
                </small>
              )}
              {resumeOffer.legacyRecoveryProtected && (
                <small className="warning-text">
                  v0.79 原 checkpoint 與片段受保護；接續時會建立 v0.80 獨立工作狀態，不覆寫原資料。
                </small>
              )}
              {resumeOffer.recoverySourcePreserved && (
                <small>v0.79 原始復原資料已保留，這次只操作 v0.80 工作狀態。</small>
              )}
              {(resumeOffer.currentTempFreeBytes !== undefined ||
                resumeOffer.estimatedRemainingWriteBytes !== undefined) && (
                <small>
                  上次磁碟紀錄（非即時，續轉前會重新檢查）：
                  {resumeOffer.currentTempFreeBytes !== undefined
                    ? ` ${resumeOffer.tempVolume ?? "暫存磁碟"} 可用 ${formatBytes(resumeOffer.currentTempFreeBytes)}`
                    : ""}
                  {resumeOffer.estimatedRemainingWriteBytes !== undefined
                    ? `；當時估計尚需寫入 ${formatBytes(resumeOffer.estimatedRemainingWriteBytes)}`
                    : ""}
                  。
                </small>
              )}
              {(resumeOffer.missingCompletedSegmentCount ?? 0) > 0 && (
                <small className="warning-text">
                  JSON 曾記錄 {resumeOffer.recordedCompletedSegmentCount} 個完成片段，但有 {resumeOffer.missingCompletedSegmentCount}
                  個中繼檔已遺失；缺失部分會重新轉檔，不能直接沿用先前全部成果。
                </small>
              )}
              {resumeOffer.cumulativeElapsedMs !== undefined && (
                <small>已保存累積轉檔耗時：{formatRenderClock(resumeOffer.cumulativeElapsedMs)}</small>
              )}
              {resumeOffer.lastError && <small>{resumeOffer.lastError}</small>}
            </div>
            <div className="render-resume-actions">
              <button className="primary-button" type="button" onClick={() => void resumeRender()}>
                {(resumeOffer.missingCompletedSegmentCount ?? 0) > 0 ? "重建缺失片段並繼續" : "從上次進度繼續"}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={resumeOffer.legacyRecoveryProtected}
                title={resumeOffer.legacyRecoveryProtected ? "v0.79 原始續轉資料受保護，不能直接捨棄" : undefined}
                onClick={() => void discardResume()}
              >
                捨棄舊進度
              </button>
            </div>
          </section>
        )}

        {onPurposeChange && !result && (
          <fieldset className="preview-purpose-selector">
            <legend>這次要輸出哪一段？</legend>
            <label className={isMain ? "is-selected" : ""}>
              <input
                type="radio"
                name="preview-purpose"
                checked={isMain}
                disabled={rendering}
                onChange={() => onPurposeChange("CONCAT")}
              />
              <span>
                <strong>正片預覽</strong>
                <small>依目前正片順序輸出；可選擇在前方串接片頭。</small>
              </span>
            </label>
            <label className={isIntro ? "is-selected" : !introClips?.length ? "is-disabled" : ""}>
              <input
                type="radio"
                name="preview-purpose"
                checked={isIntro}
                disabled={rendering || !introClips?.length}
                onChange={() => onPurposeChange("INTRO")}
              />
              <span>
                <strong>僅片頭預覽</strong>
                <small>
                  {introClips?.length
                    ? `只輸出目前 ${introClips.length} 個片頭片段，完成後可上傳 YouTube 測試。`
                    : "目前尚無片頭片段，請先到片頭頁建立。"}
                </small>
              </span>
            </label>
          </fieldset>
        )}

        {result ? (
          <div className="concat-complete">
            <span className="complete-mark">✓</span>
            <div>
              <span className="eyebrow">{result.cancelled ? "轉檔已取消" : "轉檔完成"}</span>
              <h3>
                {result.cancelled
                  ? "已停止產出並完成較短的可播放 MP4"
                  : isIntro
                    ? "Intro 預覽已完成"
                    : isClip
                      ? "4K 時間段已完成"
                      : "串連預覽已完成"}
              </h3>
            </div>
            <p>
              {result.cancelled
                ? `已在取消位置安全寫完 MPEG-4 尾端並驗證可播放；成品較原計畫短（原計畫 ${formatDuration(result.plannedDurationMs)}）。`
                : isClip
                  ? "已從最高品質來源重新編碼固定時間段，並套用已保存的局部放大；未使用代理作為輸出來源。"
                  : `已依目前順序串接 ${renderItems.length} 個${isIntro ? "建議片段" : "影片／照片片段"}${result.includedIntroSegmentCount ? `，前方包含 ${result.includedIntroSegmentCount} 段已確認片頭${result.mainStartCardDurationSeconds ? `及 ${result.mainStartCardDurationSeconds} 秒正片開始提示頁` : ""}` : ""}，交接處套用 ${result.transitionSeconds} 秒疊化${result.photoShutterAppliedCount ? `，${result.photoShutterAppliedCount} 次照片出現已加入沙丘快門聲` : ""}${result.bgmAppliedCount ? `，並在${result.bgmScopesApplied?.intro && result.bgmScopesApplied?.main ? "片頭與正片" : result.bgmScopesApplied?.intro ? "片頭" : "正片"}混入 ${result.bgmAppliedCount} 首配樂` : ""}${result.autoDubClipCount ? `，其中 ${result.autoDubClipCount} 個無聲片段已自動鋪上第一首配樂` : ""}。`}
            </p>
            {result.subtitleBurnedLanguages?.length ? (
              <p className="inline-notice">
                已永久嵌入{" "}
                {result.subtitleBurnedLanguages
                  .map((language) => SUBTITLE_LANGUAGES.find((item) => item.value === language)?.label ?? language)
                  .join("＋")}{" "}
                字幕；翻譯來源：
                {result.subtitleTranslationProviders?.join("、")}。
              </p>
            ) : null}
            {result.audioProtectionApplied && (
              <p className="inline-notice">
                已套用本機人聲／突發聲保護、平滑壓低包絡線、Compressor 與 {result.audioPeakCeilingDb ?? -1} dB Peak
                Ceiling；請播放完成檔人工確認保留的環境聲是否自然。
              </p>
            )}
            {result.audioProcessing && (
              <p>
                音訊：
                {result.audioProcessing.mode === "VIRTUAL_SURROUND_5_1"
                  ? "Virtual Surround 5.1"
                  : result.audioProcessing.mode === "ENHANCED_STEREO"
                    ? "Enhanced Stereo 2.0"
                    : result.audioProcessing.mode === "PRESERVE_MULTICHANNEL"
                      ? "保持原始多聲道"
                      : "Original Stereo 2.0"}
                {result.audioCodec ? ` · ${result.audioCodec.toUpperCase()}` : ""}
                {result.audioChannels ? ` · ${result.audioChannels} channels` : ""}
                {result.audioSampleRate ? ` · ${Math.round(result.audioSampleRate / 1000)} kHz` : ""}
                {result.audioRemuxedWithoutVideoEncode ? " · 音訊獨立處理，影像未重新編碼" : ""}
              </p>
            )}
            {result.segmentedRender && (
              <p className="inline-notice">
                已使用{result.lowMemorySegmented ? "低記憶體" : "一般模式動態保護"}分段轉檔，每組最多{" "}
                {result.segmentInputLimit ?? 6} 個輸入，共 {result.lowMemoryStageCount ?? 1} 個處理階段
                {result.resumedSegmentCount ? `，沿用 ${result.resumedSegmentCount} 個已完成片段` : ""}；成功後
                checkpoint 與暫存片段已清除。
              </p>
            )}
            <dl className="result-facts">
              {result.attemptElapsedMs !== undefined && (
                <div>
                  <dt>
                    {result.cancelled
                      ? "本次耗時"
                      : result.cumulativeElapsedMs !== result.attemptElapsedMs
                        ? "本次耗時"
                        : "總耗時"}
                  </dt>
                  <dd>{formatRenderClock(result.attemptElapsedMs)}</dd>
                </div>
              )}
              {result.cumulativeElapsedMs !== undefined && result.cumulativeElapsedMs !== result.attemptElapsedMs && (
                <div>
                  <dt>累積總耗時</dt>
                  <dd>{formatRenderClock(result.cumulativeElapsedMs)}</dd>
                </div>
              )}
              <div>
                <dt>解析度</dt>
                <dd>{RESOLUTION_LABELS[result.resolution]}</dd>
              </div>
              <div>
                <dt>影片格式</dt>
                <dd>
                  {result.videoCodec === "H265_QSV"
                    ? "H.265／HEVC（Intel QSV GPU）"
                    : result.videoCodec === "H264_QSV"
                      ? "H.264／AVC（Intel QSV GPU）"
                      : result.videoCodec === "H265"
                        ? "H.265／HEVC（CPU 備援）"
                        : "H.264／AVC（CPU 相容備援）"}
                </dd>
              </div>
              <div>
                <dt>浮水印</dt>
                <dd>{result.watermarkApplied ? "已套用" : "本次未套用"}</dd>
              </div>
              <div>
                <dt>{result.cancelled ? "完成片長" : "預估片長"}</dt>
                <dd>{formatDuration(result.expectedDurationMs)}</dd>
              </div>
              <div>
                <dt>檔案大小</dt>
                <dd>{formatBytes(result.sizeBytes)}</dd>
              </div>
            </dl>
            <div className="output-path-box">
              <span>輸出位置</span>
              <strong title={result.outputPath}>{result.outputPath}</strong>
            </div>
            {isYoutubeEligible && autoUploadStatus === "COUNTING" && (
              <section className="upload-countdown" aria-live="polite">
                <div>
                  <span className="eyebrow">UPLOAD HANDOFF READY</span>
                  <strong>
                    {uploadCountdownSeconds} 秒後
                    {youtubeFullAutoUploadEnabled ? "開始 YouTube 全自動上傳" : "開啟 YouTube 上傳確認"}
                    {!youtubeFullAutoUploadEnabled &&
                      (youtubeHandoffMode === "CHROME_DRAG_DROP" ? "（Chrome 拖放交接）" : "（YouTube API 交接）")}
                  </strong>
                  <p>
                    {youtubeFullAutoUploadEnabled
                      ? "會使用已連線且核對相符的 YouTube 官方 API，上傳為目前選定的可見度；頻道或發布資料未通過驗證時會停止。"
                      : youtubeHandoffMode === "CHROME_DRAG_DROP"
                        ? "會打開 YouTube Studio 上傳頁並在檔案總管選取最新 MP4；最後拖放與發布仍由您確認。"
                        : "預設不公開，只開啟 App 內最後確認頁，不會跳過頻道、標題與觀眾設定。"}
                  </p>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => {
                      setAutoUploadEnabled(false);
                      setYoutubeFullAutoUploadEnabled(false);
                      setAutoUploadStatus("CANCELLED");
                      setUploadCountdownSeconds(undefined);
                      rememberRenderDefaults({ autoUpload: false, youtubeFullAutoUpload: false });
                    }}
                  />
                  輸出後{youtubeFullAutoUploadEnabled ? "全自動上傳" : "自動準備上傳"}
                </label>
                <button
                  className="cancel-button"
                  type="button"
                  onClick={() => {
                    setAutoUploadEnabled(false);
                    setYoutubeFullAutoUploadEnabled(false);
                    setAutoUploadStatus("CANCELLED");
                    setUploadCountdownSeconds(undefined);
                    rememberRenderDefaults({ autoUpload: false, youtubeFullAutoUpload: false });
                  }}
                >
                  取消自動上傳
                </button>
              </section>
            )}
            {isYoutubeEligible && autoUploadStatus === "CANCELLED" && (
              <p className="inline-notice" role="status">
                已取消 60 秒自動上傳準備；本機 MP4 完整保留，仍可按下方按鈕手動上傳。
              </p>
            )}
            {outputOpenError && (
              <div className="notice error concat-error" role="alert">
                {outputOpenError}
              </div>
            )}
            {platformHandoffNotice && (
              <>
                <div className="notice success concat-error" role="status">
                  {platformHandoffNotice}
                </div>
                <small>仍需您在平台上確認後發布。</small>
              </>
            )}
            <div className="concat-footer-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setOutputOpenError(undefined);
                  void window.sourceApp
                    .playConcatOutput(result.jobId)
                    .catch((reason: unknown) =>
                      setOutputOpenError(reason instanceof Error ? reason.message : String(reason)),
                    );
                }}
              >
                ▶ 播放完成檔
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void window.sourceApp.revealConcatOutput(result.jobId)}
              >
                在檔案總管中顯示
              </button>
              {isYoutubeEligible && (
                <button
                  className="youtube-connect-button"
                  type="button"
                  disabled={Boolean(platformHandoffBusy)}
                  onClick={() => void openYoutubeChromeHandoff()}
                >
                  {platformHandoffBusy === "YOUTUBE" ? "正在準備…" : "用 Chrome 拖放上傳（預設）"}
                </button>
              )}
              {isYoutubeEligible && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setAutoUploadStatus("OPENED");
                    setUploadCountdownSeconds(undefined);
                    setShowYoutubeUpload(true);
                  }}
                >
                  上傳 YouTube 預覽
                </button>
              )}
              {isMain && (
                <button
                  className="bilibili-upload-button"
                  type="button"
                  disabled={Boolean(platformHandoffBusy)}
                  onClick={() => void openPlatformHandoff("BILIBILI")}
                >
                  {platformHandoffBusy === "BILIBILI" ? "開啟中…" : "前往 BiliBili 投稿"}
                </button>
              )}
              {isMain && (
                <button
                  className="tiktok-upload-button"
                  type="button"
                  disabled={Boolean(platformHandoffBusy)}
                  onClick={() => void openPlatformHandoff("TIKTOK")}
                >
                  {platformHandoffBusy === "TIKTOK" ? "開啟中…" : "前往 TikTok 投稿"}
                </button>
              )}
              <button className="primary-button" type="button" onClick={onClose}>
                完成
              </button>
            </div>
            <small className="preview-only-warning">
              這是{isIntro ? "片頭" : isClip ? "來源時間段" : "串連"}
              預覽，不是正式輸出 Master，也不會作為後續正式輸出的來源。
            </small>
          </div>
        ) : (
          <div className="concat-layout">
            <div className="concat-settings">
              {isMain && (
                <section className="setting-block primary-output-setting">
                  <div>
                    <span className="setting-step">01</span>
                    <div>
                      <h3>片頭＋正片串接</h3>
                      <p>這是正片輸出的第一個設定；有已確認片頭時預設勾選並放在正片最前方。</p>
                    </div>
                  </div>
                  <label className={`subtitle-burn-toggle ${!introClips?.length ? "is-disabled" : ""}`}>
                    <input
                      aria-label="自動串接已確認片頭加正片"
                      type="checkbox"
                      checked={prependIntro}
                      disabled={rendering || !introClips?.length}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        setPrependIntro(enabled);
                        setMainStartCardConfirmed(false);
                        if (enabled) setShowMainStartCard(true);
                        rememberRenderDefaults({ prependIntro: enabled });
                      }}
                    />
                    <span>
                      <strong>片頭（預設勾選）＋正片</strong>
                      <small>
                        {introClips?.length
                          ? `目前會在正片前加入 ${introClips.length} 段片頭；開始前需確認 3–7 秒正片提示頁。`
                          : "目前沒有已確認的片頭；請先到 AI 精彩片頭頁建立。"}
                      </small>
                    </span>
                  </label>
                  {prependIntro && introClips?.length ? (
                    <div className="main-start-card-summary">
                      <span>
                        {mainStartCardConfirmed ? "✓ 已確認" : "尚未確認"} · {mainStartCard.durationSeconds} 秒 · 「
                        {mainStartCard.line1}／{mainStartCard.line2}」 · 正片 SFX {mainStartCue.enabled ? `${(mainStartCue.durationMs / 1000).toFixed(2)} 秒` : "關閉"}
                      </span>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={rendering}
                        onClick={() => setShowMainStartCard(true)}
                      >
                        設定提示頁
                      </button>
                    </div>
                  ) : null}
                </section>
              )}

              {!isClip && (
                <section className="setting-block low-memory-render-setting">
                  <div>
                    <span className="setting-step">{isMain ? "02" : "01"}</span>
                    <div>
                      <h3>轉檔模式</h3>
                      <p>只改變 FFmpeg 的資源使用策略；影片內容、時間軸、字幕、轉場與構圖都保持一致。</p>
                    </div>
                  </div>
                  <div className="render-mode-selector" role="radiogroup" aria-label="轉檔模式">
                    <label className={lowMemorySegmented ? "is-selected" : ""}>
                      <input
                        aria-label="低記憶體分段轉檔模式"
                        type="radio"
                        name="render-mode"
                        checked={lowMemorySegmented}
                        disabled={rendering}
                        onChange={() => {
                          setLowMemorySegmented(true);
                          setHighSpeedMode(false);
                          rememberRenderDefaults({ lowMemorySegmented: true, highSpeedMode: false, resourceProfile: "LOW_DISK" });
                        }}
                      />
                      <span>
                        <strong>低磁碟／低記憶體（預設）</strong>
                        <small>
                          1 個工作、小批次與及早回收中繼；SSD／RAM 峰值最低，但處理時間較長。
                        </small>
                      </span>
                    </label>
                    <label className={!lowMemorySegmented && !highSpeedMode ? "is-selected" : ""}>
                      <input
                        aria-label="一般轉檔模式"
                        type="radio"
                        name="render-mode"
                        checked={!lowMemorySegmented && !highSpeedMode}
                        disabled={rendering}
                        onChange={() => {
                          setLowMemorySegmented(false);
                          setHighSpeedMode(false);
                          rememberRenderDefaults({ lowMemorySegmented: false, highSpeedMode: false, resourceProfile: "BALANCED" });
                        }}
                      />
                      <span>
                        <strong>一般轉檔</strong>
                        <small>使用較大但仍有安全上限的動態批次；通常較快，但片段多或高解析來源會提高 RAM 峰值。</small>
                      </span>
                    </label>
                    <label className={highSpeedMode ? "is-selected" : ""}>
                      <input
                        aria-label="高速轉檔模式"
                        type="radio"
                        name="render-mode"
                        checked={highSpeedMode}
                        disabled={rendering}
                        onChange={() => {
                          const hardwareCodec = hardwareCapabilities?.recommendedVideoCodec ?? "H264_QSV";
                          setLowMemorySegmented(false);
                          setHighSpeedMode(true);
                          setVideoCodec(hardwareCodec);
                          rememberRenderDefaults({
                            lowMemorySegmented: false,
                            highSpeedMode: true,
                            resourceProfile: "HIGH_SPEED",
                            videoCodec: hardwareCodec,
                          });
                        }}
                      />
                      <span>
                        <strong>高速轉檔（實驗性）</strong>
                        <small>
                          依實際啟動測試與本機效能資料優先 H.264 硬體編碼；目前選擇
                          {hardwareCapabilities
                            ? ` ${hardwareCapabilities.recommendedVideoCodec}`
                            : "會在探測完成後決定"}
                          。依 CPU、GPU、RAM、 Commit 與 SSD 餘量動態調整 2–4 個工作，不會為提高速度犧牲 OOM 安全保留。
                        </small>
                      </span>
                    </label>
                  </div>
                  <div className="render-resource-budget" aria-label="轉檔資源上限">
                    <label>
                      APP RAM 上限
                      <select
                        value={maximumRenderRamGiB}
                        disabled={rendering}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setMaximumRenderRamGiB(value);
                          rememberRenderDefaults({ maximumRenderRamGiB: value });
                        }}
                      >
                        {[8, 12, 16].map((value) => <option key={value} value={value}>{value} GB</option>)}
                      </select>
                    </label>
                    <label>
                      APP TEMP 工作檔上限
                      <select
                        value={String(maximumRenderTempGiB)}
                        disabled={rendering}
                        onChange={(event) => {
                          const value = event.target.value === "AUTO" ? "AUTO" : Number(event.target.value);
                          setMaximumRenderTempGiB(value);
                          rememberRenderDefaults({ maximumRenderTempGiB: value });
                        }}
                      >
                        {[100, 150, 200].map((value) => <option key={value} value={value}>{value} GB</option>)}
                        <option value="AUTO">Auto</option>
                      </select>
                    </label>
                    <small>
                      TEMP 上限只限制 APP 工作檔；磁碟仍需額外保留安全空間。排程器預測超限時會在安全邊界等待或暫停。
                    </small>
                  </div>
                </section>
              )}

              {!isClip && (
                <section className="setting-block">
                  <div>
                    <span className="setting-step">{isMain ? "03" : "02"}</span>
                    <div>
                      <h3>交接疊化秒數</h3>
                      <p>每兩個影片／照片片段交接時，同步套用影像疊化與音訊淡入淡出。</p>
                    </div>
                  </div>
                  <div className="option-grid transition-options" aria-label="交接疊化秒數">
                    {TRANSITIONS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={transitionSeconds === value ? "is-selected" : ""}
                        disabled={rendering}
                        aria-pressed={transitionSeconds === value}
                        onClick={() => {
                          setTransitionSeconds(value);
                          rememberRenderDefaults({ transitionSeconds: value });
                        }}
                      >
                        <strong>{value}</strong>
                        <span>秒</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className="setting-block">
                <div>
                  <span className="setting-step">{isClip ? "01" : isMain ? "04" : "03"}</span>
                  <div>
                    <h3>{isClip ? "最高解析度時間段" : "預覽解析度"}</h3>
                    <p>
                      {isClip
                        ? "固定輸出 3840×2160，從原始來源重新編碼並套用局部放大；低於 4K 的來源只能等比放大，無法恢復不存在的細節。"
                        : "固定 16:9；輸出解析度會同步套用到早期正規化、字幕排版與資源估算。直式素材保持中央原比例，左右以同源模糊填滿。"}
                    </p>
                  </div>
                </div>
                <div className="option-grid resolution-options" aria-label="預覽解析度">
                  {RESOLUTIONS.filter((item) => !isClip || item.value === "4K").map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={resolution === item.value ? "is-selected" : ""}
                      disabled={rendering || isClip}
                      aria-pressed={resolution === item.value}
                      onClick={() => {
                        setResolution(item.value);
                        if (!isClip) rememberRenderDefaults({ resolution: item.value });
                      }}
                    >
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="setting-block">
                <div>
                  <span className="setting-step">{isClip ? "02" : isMain ? "05" : "04"}</span>
                  <div>
                    <h3>影片格式</h3>
                    <p>
                      H.264 是高速與相容性建議。硬體選項必須通過真正 FFmpeg 啟動測試；H.265 若只能用
                      CPU，會明確標示顯著較慢， 不會在背景靜默切換。
                    </p>
                  </div>
                </div>
                {hardwareCapabilities && (
                  <div className="notice info" role="status">
                    <strong>本機建議：{hardwareCapabilities.recommendedVideoCodec}</strong>
                    <span>{hardwareCapabilities.recommendationReason}</span>
                  </div>
                )}
                <div className="option-grid codec-options" aria-label="影片格式">
                  <button
                    type="button"
                    className={videoCodec === "H264_NVENC" ? "is-selected" : ""}
                    disabled={
                      rendering ||
                      hardwareCapabilities?.encoders.find((item) => item.videoCodec === "H264_NVENC")?.available ===
                        false
                    }
                    aria-pressed={videoCodec === "H264_NVENC"}
                    onClick={() => {
                      setVideoCodec("H264_NVENC");
                      rememberRenderDefaults({ videoCodec: "H264_NVENC" });
                    }}
                  >
                    <strong>H.264／AVC · NVIDIA NVENC</strong>
                    <span>
                      {hardwareCapabilities?.encoders.find((item) => item.videoCodec === "H264_NVENC")?.available ===
                      false
                        ? "不可用：實際 FFmpeg 啟動測試失敗"
                        : "高速優先（通過實測時）"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H264_QSV" ? "is-selected" : ""}
                    disabled={
                      rendering ||
                      hardwareCapabilities?.encoders.find((item) => item.videoCodec === "H264_QSV")?.available === false
                    }
                    aria-pressed={videoCodec === "H264_QSV"}
                    onClick={() => {
                      setVideoCodec("H264_QSV");
                      rememberRenderDefaults({ videoCodec: "H264_QSV" });
                    }}
                  >
                    <strong>H.264／AVC · GPU</strong>
                    <span>Intel QSV · 本機實測建議</span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H265_NVENC" ? "is-selected" : ""}
                    disabled={
                      rendering ||
                      hardwareCapabilities?.encoders.find((item) => item.videoCodec === "H265_NVENC")?.available ===
                        false
                    }
                    aria-pressed={videoCodec === "H265_NVENC"}
                    onClick={() => {
                      setVideoCodec("H265_NVENC");
                      rememberRenderDefaults({ videoCodec: "H265_NVENC" });
                    }}
                  >
                    <strong>H.265／HEVC · NVIDIA NVENC</strong>
                    <span>
                      {hardwareCapabilities?.encoders.find((item) => item.videoCodec === "H265_NVENC")?.available ===
                      false
                        ? "不可用：實際 FFmpeg 啟動測試失敗"
                        : "較小檔案（通過實測時）"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H265_QSV" ? "is-selected" : ""}
                    disabled={
                      rendering ||
                      hardwareCapabilities?.encoders.find((item) => item.videoCodec === "H265_QSV")?.available === false
                    }
                    aria-pressed={videoCodec === "H265_QSV"}
                    onClick={() => {
                      setVideoCodec("H265_QSV");
                      rememberRenderDefaults({ videoCodec: "H265_QSV" });
                    }}
                  >
                    <strong>H.265／HEVC · Intel QSV</strong>
                    <span>較小檔案，通常比 H.264 慢</span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H264" ? "is-selected" : ""}
                    disabled={rendering}
                    aria-pressed={videoCodec === "H264"}
                    onClick={() => {
                      setVideoCodec("H264");
                      setHighSpeedMode(false);
                      rememberRenderDefaults({ videoCodec: "H264", highSpeedMode: false });
                    }}
                  >
                    <strong>H.264／AVC · CPU</strong>
                    <span>最廣相容性備援</span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H265" ? "is-selected" : ""}
                    disabled={rendering}
                    aria-pressed={videoCodec === "H265"}
                    onClick={() => {
                      setVideoCodec("H265");
                      setHighSpeedMode(false);
                      rememberRenderDefaults({ videoCodec: "H265", highSpeedMode: false });
                    }}
                  >
                    <strong>H.265／HEVC · CPU Software Encoding</strong>
                    <span>硬體 H.265 不可用時的明確備援；預估速度顯著較慢</span>
                  </button>
                </div>
                {hardwareCapabilities?.encoders.some(
                  (item) => item.backend !== "CPU_SOFTWARE" && !item.available && item.failureReason,
                ) && (
                  <div className="notice warning" role="status">
                    <strong>硬體編碼實測狀態</strong>
                    {hardwareCapabilities.encoders
                      .filter((item) => item.backend !== "CPU_SOFTWARE" && !item.available)
                      .map((item) => (
                        <span key={item.videoCodec}>
                          {item.ffmpegEncoder}：{item.failureReason ?? "無法啟動"}
                        </span>
                      ))}
                  </div>
                )}
              </section>

              {!isClip && (
                <section className="setting-block watermark-render-setting">
                  <div>
                    <span className="setting-step">{isMain ? "06" : "05"}</span>
                    <div>
                      <h3>浮水印</h3>
                      <p>沿用浮水印設定頁的文字、位置、間隔與顯示時間；只控制這一次輸出是否套用。</p>
                    </div>
                  </div>
                  <label className="subtitle-burn-toggle">
                    <input
                      aria-label="這次 MP4 套用浮水印"
                      type="checkbox"
                      checked={includeWatermark}
                      disabled={rendering}
                      onChange={(event) => {
                        setIncludeWatermark(event.target.checked);
                        rememberRenderDefaults({
                          includeWatermark: event.target.checked,
                        });
                      }}
                    />
                    <span>
                      <strong>這次輸出套用浮水印（預設勾選）</strong>
                      <small>取消只影響本次轉檔，不會清除浮水印設定，也不會修改來源。</small>
                    </span>
                  </label>
                </section>
              )}

              {!isClip && (
                <section className="setting-block intro-output-bgm-setting">
                  <div>
                    <span className="setting-step">{isMain ? "07" : "06"}</span>
                    <div>
                      <h3>片頭／正片 Audio</h3>
                      <p>UI 分區確認，底層仍共用 Original、Voice、BGM、SFX 与 Final Mix 时间线。</p>
                    </div>
                  </div>
                  <label className="subtitle-burn-toggle">
                    <input
                      aria-label="這次 MP4 嵌入 MP3 配樂"
                      type="checkbox"
                      checked={includeBgm}
                      disabled={rendering}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        setIncludeBgm(enabled);
                        if (enabled && isMain && !bgmScopes.intro && !bgmScopes.main) updateBgmScopes({ main: true });
                        rememberRenderDefaults(
                          isIntro ? { introPreviewIncludeBgm: enabled } : { mainPreviewIncludeBgm: enabled },
                        );
                      }}
                    />
                    <span>
                      <strong>啟用 BGM</strong>
                      <small>取消只关闭 BGM，不会静音原音；离线曲目会在转档前明确阻挡。</small>
                    </span>
                  </label>
                  {isMain && (
                    <fieldset className="bgm-scope-options" disabled={rendering || !includeBgm}>
                      <legend>Audio 範圍（片頭／正片可分開）</legend>
                      <label className={!prependIntro ? "is-disabled" : ""}>
                        <input
                          aria-label="片頭使用 MP3 配樂"
                          type="checkbox"
                          checked={prependIntro && bgmScopes.intro}
                          disabled={!prependIntro}
                          onChange={(event) => updateBgmScopes({ intro: event.target.checked })}
                        />
                        <span>
                          <strong>片頭 Audio · BGM</strong>
                          <small>只有選片頭時，配樂會在「正片即將開始」提示頁前平滑淡出並停止。</small>
                        </span>
                      </label>
                      <label>
                        <input
                          aria-label="正片使用 MP3 配樂"
                          type="checkbox"
                          checked={bgmScopes.main}
                          onChange={(event) => updateBgmScopes({ main: event.target.checked })}
                        />
                        <span>
                          <strong>正片 Audio · BGM</strong>
                          <small>只有選正片時，配樂會在提示頁結束、正片開始時播放。</small>
                        </span>
                      </label>
                      {!bgmScopes.main && !(prependIntro && bgmScopes.intro) && (
                        <small className="inline-warning">目前未選任何範圍，這次輸出不會混入配樂。</small>
                      )}
                    </fieldset>
                  )}
                </section>
              )}

              <AudioProtectionSettings
                value={audioProtection}
                disabled={rendering}
                stepLabel={isClip ? "04" : isMain ? "08" : "07"}
                onChange={(next) => updateAudioProtection(next)}
              />

              <AudioProcessingSettings
                value={audioProcessing}
                assets={assets}
                timelineRevision={timelineRevision}
                disabled={rendering}
                stepLabel={isClip ? "05" : isMain ? "09" : "08"}
                allowPreserveMultichannel={Boolean(
                  isClip &&
                  assets.length === 1 &&
                  (assets[0].mediaInfo?.audioChannels ?? 0) > 2 &&
                  assets[0].mediaInfo?.audioChannelLayout,
                )}
                onChange={updateAudioProcessing}
              />

              {isYoutubeEligible && (
                <section className="setting-block subtitle-burn-setting">
                  <div>
                    <span className="setting-step">{isMain ? "09" : "08"}</span>
                    <div>
                      <h3>嵌入影片字幕（最多兩種語言）</h3>
                      <p>
                        使用字幕頁中「已確認」的{isIntro ? "片頭" : "正片"}繁體中文。選擇其他語言時，OpenAI
                        新的無狀態請求優先，失敗才使用已設定的 Google Cloud 翻譯。
                      </p>
                    </div>
                  </div>
                  <label
                    className={`subtitle-burn-toggle ${!subtitleBurnIn.enabled && (!confirmedSubtitleCount || subtitlesNeedReview) ? "is-disabled" : ""}`}
                  >
                    <input
                      aria-label="將字幕永久嵌入這次 MP4"
                      aria-describedby="subtitle-burn-help"
                      type="checkbox"
                      checked={subtitleBurnIn.enabled}
                      disabled={rendering}
                      onChange={(event) => toggleSubtitleBurnIn(event.target.checked)}
                    />
                    <span>
                      <strong>將字幕永久嵌入這次 MP4</strong>
                      <small id="subtitle-burn-help">
                        勾選後會在本次輸出永久嵌入；尚未開始輸出前隨時可以取消勾選（取消後輸出不嵌入字幕），不會修改來源檔。即使目前字幕需要複核或尚無確認字幕，只要尚未開始輸出，仍可取消已勾選狀態。
                      </small>
                    </span>
                  </label>
                  {!confirmedSubtitleCount && (
                    <p className="inline-error">
                      尚無已確認{isIntro ? "片頭" : "正片"}字幕；請先到「CC 字幕」確認並保存。
                    </p>
                  )}
                  {subtitlesNeedReview && (
                    <p className="inline-error">
                      {isIntro ? "片頭" : "正片"}順序或 IN／OUT 已變更；請先重新複核並保存字幕。
                    </p>
                  )}
                  {subtitleBurnIn.enabled && (
                    <div className="subtitle-track-settings">
                      {subtitleBurnIn.tracks.map((track, index) => (
                        <div className="subtitle-track-row" key={`${index}:${track.language}`}>
                          <strong>第 {index + 1} 種語言</strong>
                          <label>
                            語言
                            <select
                              aria-label={`第 ${index + 1} 種字幕語言`}
                              value={track.language}
                              onChange={(event) =>
                                patchSubtitleTrack(index, {
                                  language: event.target.value as SubtitleRenderLanguage,
                                })
                              }
                            >
                              {SUBTITLE_LANGUAGES.map((language) => (
                                <option
                                  key={language.value}
                                  value={language.value}
                                  disabled={subtitleBurnIn.tracks.some(
                                    (item, itemIndex) => itemIndex !== index && item.language === language.value,
                                  )}
                                >
                                  {language.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            位置
                            <select
                              aria-label={`第 ${index + 1} 種字幕位置`}
                              value={track.position}
                              onChange={(event) =>
                                patchSubtitleTrack(index, {
                                  position: event.target.value as SubtitleRenderPosition,
                                })
                              }
                            >
                              {SUBTITLE_POSITIONS.map((position) => (
                                <option key={position.value} value={position.value}>
                                  {position.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            {index === 0 ? "文字大小（與字幕頁預覽一致）" : "文字大小（1080p 基準）"}
                            <input
                              aria-label={`第 ${index + 1} 種字幕文字大小`}
                              type="number"
                              min={index === 0 ? "16" : "24"}
                              max={index === 0 ? "72" : "96"}
                              step="1"
                              value={
                                index === 0
                                  ? (subtitleBurnIn.styleProfile?.fontSizePx ??
                                    DEFAULT_SUBTITLE_STYLE_PROFILE.fontSizePx)
                                  : track.fontSize1080p
                              }
                              onChange={(event) => {
                                const value = Number(event.target.value);
                                if (index === 0) {
                                  updatePrimarySubtitlePreviewSize(value);
                                  return;
                                }
                                patchSubtitleTrack(index, {
                                  fontSize1080p: Math.max(24, Math.min(96, value || 24)),
                                });
                              }}
                            />
                            <span>px</span>
                          </label>
                          {index === 1 && (
                            <button
                              className="danger-text"
                              type="button"
                              onClick={() =>
                                updateSubtitleBurnIn({
                                  ...subtitleBurnIn,
                                  tracks: subtitleBurnIn.tracks.slice(0, 1),
                                })
                              }
                            >
                              移除第二語言
                            </button>
                          )}
                        </div>
                      ))}
                      {subtitleBurnIn.tracks.length < 2 && (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => {
                            const used = new Set(subtitleBurnIn.tracks.map((track) => track.language));
                            const language = SUBTITLE_LANGUAGES.find((item) => !used.has(item.value))?.value ?? "en";
                            updateSubtitleBurnIn({
                              ...subtitleBurnIn,
                              tracks: [
                                ...subtitleBurnIn.tracks,
                                {
                                  language,
                                  position: "TOP",
                                  fontSize1080p: 42,
                                },
                              ],
                            });
                          }}
                        >
                          ＋ 加入第二種語言
                        </button>
                      )}
                      <small>
                        第一種字幕沿用字幕頁的 480p 預覽字級與位置，輸出時依解析度等比例換算；第二種語言可另設位置與
                        1080p 字級。若選在相同位置，App 會自動分層避免互相覆蓋。
                      </small>
                    </div>
                  )}
                </section>
              )}

              <section className="setting-block post-success-power-setting">
                <div>
                  <span className="setting-step">{isClip ? "06" : isMain ? "10" : "09"}</span>
                  <div>
                    <h3>成功后自动关机／休眠／睡眠</h3>
                    <p>预设关闭。只有选定的成功事件完整结束后才倒数60秒；失败、取消、暂停或上传未完成绝不执行。</p>
                  </div>
                </div>
                <label className="subtitle-burn-toggle">
                  <input
                    aria-label="启用成功后自动电源动作"
                    type="checkbox"
                    checked={postSuccessPower.enabled}
                    disabled={rendering}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      if (
                        enabled &&
                        !window.confirm(
                          "启用后，只有选定的成功事件完成才会倒数60秒执行电源动作。倒数期间可取消；失败、取消、暂停不会执行。确定启用吗？",
                        )
                      )
                        return;
                      updatePostSuccessPower({ enabled });
                    }}
                  />
                  <span>
                    <strong>启用自动电源动作（预设不勾选）</strong>
                    <small>设定会保存，但每次执行前仍会在这里清楚显示，并在成功后提供取消倒数。</small>
                  </span>
                </label>
                {postSuccessPower.enabled && (
                  <div className="post-success-power-options">
                    <fieldset disabled={rendering}>
                      <legend>触发时机</legend>
                      <label>
                        <input
                          type="radio"
                          name="power-trigger"
                          checked={postSuccessPower.trigger === "RENDER_SUCCESS"}
                          onChange={() => updatePostSuccessPower({ trigger: "RENDER_SUCCESS" })}
                        />
                        转档完成后
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="power-trigger"
                          checked={postSuccessPower.trigger === "YOUTUBE_UPLOAD_SUCCESS"}
                          onChange={() => updatePostSuccessPower({ trigger: "YOUTUBE_UPLOAD_SUCCESS" })}
                        />
                        YouTube 上传成功后
                      </label>
                    </fieldset>
                    <fieldset disabled={rendering}>
                      <legend>动作</legend>
                      {(
                        [
                          ["SHUTDOWN", "自动关机"],
                          ["HIBERNATE", "自动休眠（Hibernate）"],
                          ["SLEEP", "自动睡眠（Sleep）"],
                        ] as const
                      ).map(([action, label]) => (
                        <label key={action}>
                          <input
                            type="radio"
                            name="power-action"
                            checked={postSuccessPower.action === action}
                            onChange={() => updatePostSuccessPower({ action })}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    <p className="inline-warning" role="status">
                      {postSuccessPower.trigger === "YOUTUBE_UPLOAD_SUCCESS"
                        ? "只认 YouTube 官方 API 回传成功；若要求缩图而缩图失败，会等待修复成功，不会仅凭打开浏览器或上传页面执行。"
                        : "会在影片、字幕、音讯后处理与最终档案验证全部成功后触发，不会在 partial 写入或暂停点触发。"}
                    </p>
                  </div>
                )}
              </section>

              <section className="setting-block">
                <div>
                  <span className="setting-step">{isClip ? "07" : isMain ? "11" : "10"}</span>
                  <div>
                    <h3>輸出位置</h3>
                    <p>自動沿用上一次指定的資料夾並產生不覆寫舊檔的名稱；只有按下此欄才另外指定。</p>
                  </div>
                </div>
                <button
                  className="output-picker"
                  type="button"
                  aria-label={`選擇儲存位置，${output?.automatic ? "目前為自動位置" : output ? "目前已另外指定" : "正在準備自動位置"}${output?.displayPath ? `：${output.displayPath}` : ""}`}
                  disabled={rendering}
                  onClick={() => void chooseOutput()}
                >
                  <span>{output?.automatic ? "自動位置" : output ? "已另外指定" : "正在準備"}</span>
                  <strong title={output?.displayPath}>{output?.displayPath ?? "正在依上次位置產生檔名…"}</strong>
                </button>
                <button
                  className="secondary-button regenerate-output-button"
                  type="button"
                  disabled={rendering}
                  onClick={() => void prepareAutomaticOutput()}
                >
                  重新產生檔名
                </button>
              </section>

              <section
                className={`render-preflight ${renderEstimate && !renderEstimate.canRender ? "is-blocked" : ""}`}
                aria-label="轉檔前容量與時間預估"
              >
                <header>
                  <div>
                    <span className="eyebrow">RENDER PREFLIGHT</span>
                    <h3>轉檔前預估</h3>
                  </div>
                  {estimateBusy && <span className="spinner" />}
                </header>
                <div className="render-temp-controls">
                  <span title={renderEstimate?.systemResources?.tempPath}>
                    Render TEMP：{renderEstimate?.systemResources?.tempPath ?? "讀取中…"}
                  </span>
                  <button className="secondary-button" type="button" disabled={rendering} onClick={() => void chooseRenderTemp()}>
                    選擇 TEMP 磁碟
                  </button>
                  {window.sourceApp.revealRenderTemporaryFolder && (
                    <button
                      className="tertiary-button"
                      type="button"
                      disabled={rendering}
                      onClick={() => void window.sourceApp.revealRenderTemporaryFolder?.()}
                    >
                      開啟 TEMP
                    </button>
                  )}
                </div>
                {renderEstimate ? (
                  <>
                    <div className="render-resource-summary">
                      <span>預估成品：約 {formatBytes(renderEstimate.estimatedOutputBytes)}</span>
                      <span>
                        {renderEstimate.driveRoot || "輸出磁碟"} 可用：{formatBytes(renderEstimate.currentFreeBytes)}
                      </span>
                      {renderEstimate.requiredFreeBytes !== undefined &&
                        renderEstimate.safetyMarginBytes !== undefined && (
                          <span>
                            建議所需空間：{formatBytes(renderEstimate.requiredFreeBytes)}（含安全餘量{" "}
                            {formatBytes(renderEstimate.safetyMarginBytes)}）
                          </span>
                        )}
                      <span>目前可用 RAM：{formatBytes(renderEstimate.currentAvailableRamBytes)}</span>
                      {renderEstimate.systemResources && (
                        <>
                          <span>App RAM：約 {formatBytes(renderEstimate.systemResources.appWorkingSetBytes)}</span>
                          <span>
                            其他程式 RAM：約 {formatBytes(renderEstimate.systemResources.otherProgramsRamBytes)}
                          </span>
                          <span>
                            Pagefile：
                            {renderEstimate.systemResources.pagefileEnabled
                              ? `${formatBytes(renderEstimate.systemResources.pagefileUsedBytes ?? 0)} / ${formatBytes(renderEstimate.systemResources.pagefileTotalBytes ?? 0)}`
                              : "未啟用"}
                          </span>
                          {renderEstimate.systemResources.committedBytes &&
                            renderEstimate.systemResources.commitLimitBytes && (
                              <span>
                                System Commit：{formatBytes(renderEstimate.systemResources.committedBytes)} /{" "}
                                {formatBytes(renderEstimate.systemResources.commitLimitBytes)}
                              </span>
                            )}
                          <span>TEMP 可用：{formatBytes(renderEstimate.systemResources.tempDriveFreeBytes)}</span>
                          {renderEstimate.systemResources.cpuUsagePercent !== undefined && (
                            <span>目前 CPU：{renderEstimate.systemResources.cpuUsagePercent.toFixed(0)}%</span>
                          )}
                          {renderEstimate.systemResources.gpuUsagePercent !== undefined && (
                            <span>目前 GPU：{renderEstimate.systemResources.gpuUsagePercent.toFixed(0)}%</span>
                          )}
                          {renderEstimate.systemResources.gpuEncodeUsagePercent !== undefined && (
                            <span>GPU Encode：{renderEstimate.systemResources.gpuEncodeUsagePercent.toFixed(0)}%</span>
                          )}
                          {renderEstimate.systemResources.gpuDecodeUsagePercent !== undefined && (
                            <span>GPU Decode：{renderEstimate.systemResources.gpuDecodeUsagePercent.toFixed(0)}%</span>
                          )}
                          {renderEstimate.systemResources.gpuComputeUsagePercent !== undefined && (
                            <span>
                              GPU Compute：{renderEstimate.systemResources.gpuComputeUsagePercent.toFixed(0)}%
                            </span>
                          )}
                          {renderEstimate.systemResources.vramUsedBytes !== undefined && (
                            <span>
                              VRAM：{formatBytes(renderEstimate.systemResources.vramUsedBytes)}
                              {renderEstimate.systemResources.vramTotalBytes
                                ? ` / ${formatBytes(renderEstimate.systemResources.vramTotalBytes)}`
                                : ""}
                            </span>
                          )}
                        </>
                      )}
                      {renderEstimate.runtimePolicy && (
                        <span>
                          目前模式 RAM 預算：約 {formatBytes(renderEstimate.runtimePolicy.renderRamBudgetBytes)}
                          ；保留系統 {formatBytes(renderEstimate.runtimePolicy.systemSafetyReserveBytes)}；平行工作{" "}
                          {renderEstimate.runtimePolicy.initialParallelJobs}→
                          {renderEstimate.runtimePolicy.maximumParallelJobs}
                        </span>
                      )}
                    </div>
                    <div className="render-mode-comparison" role="table" aria-label="三種轉檔資源策略比較">
                      {(
                        [
                          ["LOW_DISK", "低磁碟／低記憶體", renderEstimate.modeEstimates.lowDisk ?? renderEstimate.modeEstimates.lowMemory],
                          ["BALANCED", "平衡", renderEstimate.modeEstimates.balanced ?? renderEstimate.modeEstimates.normal],
                          ["HIGH_SPEED", "高速", renderEstimate.modeEstimates.highSpeed ?? renderEstimate.modeEstimates.normal],
                        ] as const
                      ).map(([profile, label, mode]) => {
                        const selected = profile === resourceProfile;
                        const difference =
                          profile === "LOW_DISK"
                            ? "最低 SSD／RAM；較慢"
                            : profile === "BALANCED"
                              ? "資源與速度折衷"
                              : "較快；SSD／RAM 較高";
                        return (
                          <article
                            key={profile}
                            className={`render-mode-estimate is-${mode.warningLevel.toLowerCase()} ${selected ? "is-selected" : ""}`}
                            aria-label={`${label}${selected ? "，目前選擇" : ""}`}
                          >
                            <header>
                              <strong>{label}</strong>
                              {selected && <span>目前選擇</span>}
                            </header>
                            <dl>
                              <div>
                                <dt>預估 SSD 工作空間</dt>
                                <dd>約 {formatBytes(mode.estimatedTemporaryBytes)}</dd>
                              </div>
                              <div>
                                <dt>畫面／Base Audio 可重用 Master</dt>
                                <dd>約 {formatBytes(mode.estimatedReusableMasterBytes ?? 0)}（供只改音訊時 -c:v copy；每專案最近 1 份）</dd>
                              </div>
                              <div>
                                <dt>預估 RAM 峰值</dt>
                                <dd>約 {formatBytes(mode.estimatedPeakRamBytes)}</dd>
                              </div>
                              <div>
                                <dt>預估處理時間</dt>
                                <dd>理論約 {formatDuration(mode.estimatedRenderTimeMs)}（開始後以實測 speed 校正）</dd>
                              </div>
                              <div>
                                <dt>與另一模式差異</dt>
                                <dd>{difference}</dd>
                              </div>
                              <div>
                                <dt>同時載入上限</dt>
                                <dd>{mode.maximumSimultaneousInputs} 個輸入</dd>
                              </div>
                              <div>
                                <dt>平行工作上限</dt>
                                <dd>{mode.maximumParallelJobs ?? 1} 個 FFmpeg 工作</dd>
                              </div>
                              <div>
                                <dt>分段工作</dt>
                                <dd>
                                  {mode.usesSegmentedPipeline
                                    ? `${mode.intermediateJobCount} 個中繼工作`
                                    : "單次 pipeline"}
                                </dd>
                              </div>
                            </dl>
                            {mode.diskBreakdown && (
                              <details className="render-disk-breakdown">
                                <summary>SSD 峰值明細</summary>
                                <dl>
                                  <div><dt>Render TEMP</dt><dd>{mode.diskBreakdown.tempPath ?? mode.diskBreakdown.tempVolume}</dd></div>
                                  <div><dt>TEMP 峰值</dt><dd>約 {formatBytes(mode.diskBreakdown.tempPeakBytes ?? mode.diskBreakdown.peakWorkingBytes)}</dd></div>
                                  <div><dt>輸出峰值</dt><dd>約 {formatBytes(mode.diskBreakdown.outputPeakBytes ?? mode.diskBreakdown.estimatedFinalOutputBytes)}</dd></div>
                                  <div><dt>中繼片段</dt><dd>約 {formatBytes(mode.diskBreakdown.remainingIntermediatePeakBytes)}</dd></div>
                                  <div><dt>同時 partial</dt><dd>約 {formatBytes(mode.diskBreakdown.concurrentPartialPeakBytes)}</dd></div>
                                  <div><dt>分段建立峰值</dt><dd>約 {formatBytes(mode.diskBreakdown.segmentBuildPeakBytes ?? 0)}</dd></div>
                                  <div><dt>Master 建立峰值</dt><dd>約 {formatBytes(mode.diskBreakdown.baseMasterBuildPeakBytes ?? 0)}</dd></div>
                                  <div><dt>後製混音／Mux 峰值</dt><dd>約 {formatBytes(mode.diskBreakdown.postAudioMuxPeakBytes ?? 0)}</dd></div>
                                  <div><dt>音訊 TEMP</dt><dd>約 {formatBytes(mode.diskBreakdown.audioTemporaryBytes)}</dd></div>
                                  <div><dt>最終成品</dt><dd>約 {formatBytes(mode.diskBreakdown.estimatedFinalOutputBytes)}</dd></div>
                                  <div><dt>安全保留</dt><dd>約 {formatBytes(mode.diskBreakdown.safetyReserveBytes)}</dd></div>
                                  <div><dt>TEMP 目前可用</dt><dd>{formatBytes(mode.diskBreakdown.currentTempFreeBytes ?? 0)}</dd></div>
                                  <div><dt>輸出目前可用</dt><dd>{formatBytes(mode.diskBreakdown.currentOutputFreeBytes ?? 0)}</dd></div>
                                </dl>
                                <div className="render-disk-why">
                                  <strong>為何需要這些空間？</strong>
                                  <ol>
                                    {largestDiskContributors(mode.diskBreakdown).map((item) => (
                                      <li key={item.label}>{item.label}：約 {formatBytes(item.bytes)}</li>
                                    ))}
                                  </ol>
                                  <small>峰值依檔案生命週期取最大同時存在量，不是把所有階段曾產生的檔案相加。</small>
                                </div>
                              </details>
                            )}
                            {mode.warnings.map((warning) => (
                              <p key={warning} className="mode-resource-warning">
                                ⚠ {warning}
                              </p>
                            ))}
                          </article>
                        );
                      })}
                    </div>
                    <p className="render-workload-note">
                      依目前 {renderEstimate.workload.visualInputCount} 個輸入（影片{" "}
                      {renderEstimate.workload.videoInputCount}、照片 {renderEstimate.workload.photoInputCount}
                      、插入素材 {renderEstimate.workload.insertedInputCount}）、加權來源約{" "}
                      {Math.round(renderEstimate.workload.weightedSourceWidth)} ×{" "}
                      {Math.round(renderEstimate.workload.weightedSourceHeight)}／
                      {renderEstimate.workload.weightedSourceFps.toFixed(1)} FPS 動態估算。
                    </p>
                    <button className="tertiary-button" type="button" disabled={rendering} onClick={() => void discardReusableMaster()}>
                      清理此專案可重建的畫面 Master
                    </button>
                  </>
                ) : (
                  <p>
                    {estimateError ??
                      (estimateBusy
                        ? "正在讀取輸出磁碟與編碼設定…"
                        : "選定輸出位置後會顯示預估檔案大小、時間與硬碟餘量。")}
                  </p>
                )}
                {(estimateError || (renderEstimate?.warning && !renderEstimate.canRender)) && (
                  <p className="render-preflight-warning" role="alert">
                    ⚠ {estimateError ?? renderEstimate?.warning}
                  </p>
                )}
                <small>
                  估算會因畫面複雜度、字幕、浮水印、配樂及其他程式負載而變動；App
                  會在真正開始前再次檢查。低記憶體模式會把暫存需求一併納入；短期中繼會清除，但每個專案保留最近 1 份可重建畫面 Master，供只改音訊時直接重用。
                </small>
              </section>

              {isYoutubeEligible && (
                <section className="setting-block">
                  <div>
                    <span className="setting-step">{isMain ? "12" : "11"}</span>
                    <div>
                      <h3>{isIntro ? "片頭 YouTube 測試上傳" : "YouTube 上傳"}</h3>
                      <p>
                        {isIntro
                          ? "這次只輸出片頭；完成後可打開 Chrome 上傳頁與檔案總管，或使用 YouTube 官方 API 作不公開測試。"
                          : "可選人工 Chrome 拖放或官方 API；全自動模式預設使用官方 API、不公開上傳。"}
                      </p>
                    </div>
                  </div>
                  <div className="post-render-options">
                    <div className="upload-method-options" role="radiogroup" aria-label="YouTube 上傳方式">
                      <label>
                        <input
                          type="radio"
                          name="youtube-handoff"
                          checked={youtubeHandoffMode === "CHROME_DRAG_DROP"}
                          disabled={rendering || youtubeFullAutoUploadEnabled}
                          onChange={() => {
                            setYoutubeHandoffMode("CHROME_DRAG_DROP");
                            rememberRenderDefaults({
                              youtubeHandoffMode: "CHROME_DRAG_DROP",
                            });
                          }}
                        />
                        <span>
                          <strong>Chrome＋檔案總管拖放（預設）</strong>
                          <small>
                            {youtubeFullAutoUploadEnabled
                              ? "全自動上傳啟用時固定使用官方 API；取消全自動後才可改用拖放。"
                              : "App 打開 YouTube Studio 並選取最新 MP4；您用滑鼠拖入上傳區。"}
                          </small>
                        </span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="youtube-handoff"
                          checked={youtubeHandoffMode === "OFFICIAL_API"}
                          disabled={rendering}
                          onChange={() => {
                            setYoutubeHandoffMode("OFFICIAL_API");
                            rememberRenderDefaults({
                              youtubeHandoffMode: "OFFICIAL_API",
                            });
                          }}
                        />
                        <span>
                          <strong>YouTube 官方 API</strong>
                          <small>沿用現有的頻道連線、標題、縮圖與說明確認流程。</small>
                        </span>
                      </label>
                    </div>
                    <label className="youtube-full-auto-toggle">
                      <input
                        aria-label="YouTube 全自動上傳"
                        type="checkbox"
                        checked={youtubeFullAutoUploadEnabled}
                        disabled={rendering}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setYoutubeFullAutoUploadEnabled(enabled);
                          setAutoUploadEnabled(enabled);
                          setAutoUploadStatus(enabled ? "ARMED" : "DISABLED");
                          if (enabled) setYoutubeHandoffMode("OFFICIAL_API");
                          rememberRenderDefaults({
                            autoUpload: enabled,
                            youtubeFullAutoUpload: enabled,
                            ...(enabled ? { youtubeHandoffMode: "OFFICIAL_API" as const } : {}),
                          });
                        }}
                      />
                      <span>
                        <strong>YouTube 全自動上傳（預設勾選）</strong>
                        <small>完成後倒數 60 秒，使用已連線的 YouTube 官方 API 自動送出；預設維持不公開。</small>
                      </span>
                    </label>
                    {youtubeFullAutoUploadEnabled && (
                      <fieldset className="youtube-auto-review-options" disabled>
                        <legend>全自動上傳會一併套用</legend>
                        <label>
                          <input type="checkbox" checked readOnly />
                          <span>
                            <strong>觀眾設定：不是兒童內容</strong>
                          </span>
                        </label>
                        <label>
                          <input type="checkbox" checked readOnly />
                          <span>
                            <strong>我已播放檢查影片，並確認縮圖、標題、說明、章節、頻道、觀眾及可見度。</strong>
                          </span>
                        </label>
                        <label>
                          <input type="checkbox" checked readOnly />
                          <span>
                            <strong>我已檢查上傳設定；倒數後自動按下「確認內容並開始上傳」</strong>
                          </span>
                        </label>
                      </fieldset>
                    )}
                  </div>
                </section>
              )}

              {error && (
                <div className="notice error concat-error" role="alert">
                  {(progress?.timingStatus === "CANCELLED" || progress?.timingStatus === "FAILED") && (
                    <strong>{progress.timingStatus === "CANCELLED" ? "轉檔已取消" : "轉檔失敗"}</strong>
                  )}
                  <span>{error}</span>
                  {displayedAttemptElapsedMs !== undefined && (
                    <span>本次耗時：{formatRenderClock(displayedAttemptElapsedMs)}</span>
                  )}
                  {displayedCumulativeElapsedMs !== undefined &&
                    displayedCumulativeElapsedMs !== displayedAttemptElapsedMs && (
                      <span>累積轉檔耗時：{formatRenderClock(displayedCumulativeElapsedMs)}</span>
                    )}
                </div>
              )}
              {backgroundNotice && (
                <div className="notice success" role="status">
                  {backgroundNotice}
                </div>
              )}
              {rendering && (
                <section className="render-progress" aria-live="polite">
                  <div>
                    <strong>{progressLabel(progress)}</strong>
                    <span>{Math.round(progress?.percent ?? 0)}%</span>
                  </div>
                  <progress max="100" value={progress?.percent ?? 0} />
                  {progress?.currentSegment && <strong>{progress.currentSegment}</strong>}
                  {displayedAttemptElapsedMs !== undefined && (
                    <div className="render-elapsed-status">
                      <strong>已耗時：{formatRenderClock(displayedAttemptElapsedMs)}</strong>
                      {displayedCumulativeElapsedMs !== undefined &&
                        displayedCumulativeElapsedMs !== displayedAttemptElapsedMs && (
                          <span>累積轉檔耗時：{formatRenderClock(displayedCumulativeElapsedMs)}</span>
                        )}
                      {progress?.estimatedRemainingMs !== undefined && (
                        <span>預估剩餘：{formatRenderClock(progress.estimatedRemainingMs)}</span>
                      )}
                    </div>
                  )}
                  {progress?.resourceUsage && (
                    <div className="render-runtime-resources">
                      <span>Encoder：{progress.resourceUsage.encoderName ?? "偵測中"}</span>
                      <span>Decoder：{progress.resourceUsage.decoderName ?? "偵測中"}</span>
                      <span>RAM 可用：{formatBytes(progress.resourceUsage.availableRamBytes)}</span>
                      <span>FFmpeg RAM：{formatBytes(progress.resourceUsage.ffmpegPrivateBytes ?? 0)}</span>
                      <span>App RAM：{formatBytes(progress.resourceUsage.appWorkingSetBytes)}</span>
                      {progress.resourceUsage.cpuUsagePercent !== undefined && (
                        <span>CPU Usage：{progress.resourceUsage.cpuUsagePercent.toFixed(0)}%</span>
                      )}
                      {progress.resourceUsage.gpuEncodeUsagePercent !== undefined && (
                        <span>GPU Encode Usage：{progress.resourceUsage.gpuEncodeUsagePercent.toFixed(0)}%</span>
                      )}
                      {progress.resourceUsage.gpuDecodeUsagePercent !== undefined && (
                        <span>GPU Decode Usage：{progress.resourceUsage.gpuDecodeUsagePercent.toFixed(0)}%</span>
                      )}
                      {progress.resourceUsage.gpuComputeUsagePercent !== undefined && (
                        <span>GPU Compute Usage：{progress.resourceUsage.gpuComputeUsagePercent.toFixed(0)}%</span>
                      )}
                      {progress.resourceUsage.vramUsedBytes !== undefined && (
                        <span>
                          VRAM：{formatBytes(progress.resourceUsage.vramUsedBytes)}
                          {progress.resourceUsage.vramTotalBytes
                            ? ` / ${formatBytes(progress.resourceUsage.vramTotalBytes)}`
                            : ""}
                        </span>
                      )}
                      {progress.resourceUsage.currentJobs !== undefined && (
                        <span>Current Parallel Jobs：{progress.resourceUsage.currentJobs}</span>
                      )}
                      {progress.resourceUsage.ffmpegFps !== undefined && (
                        <span>FFmpeg FPS：{progress.resourceUsage.ffmpegFps.toFixed(1)}</span>
                      )}
                      {progress.resourceUsage.ffmpegSpeed !== undefined && (
                        <span>speed={progress.resourceUsage.ffmpegSpeed.toFixed(2)}x</span>
                      )}
                      {progress.resourceUsage.diskReadBytesPerSecond !== undefined && (
                        <span>SSD 讀取：{formatBytes(progress.resourceUsage.diskReadBytesPerSecond)}/秒</span>
                      )}
                      {progress.resourceUsage.diskWriteBytesPerSecond !== undefined && (
                        <span>SSD 寫入：{formatBytes(progress.resourceUsage.diskWriteBytesPerSecond)}/秒</span>
                      )}
                      <span>SSD 輸出可用：{formatBytes(progress.resourceUsage.outputDriveFreeBytes)}</span>
                      <span>TEMP 可用：{formatBytes(progress.resourceUsage.tempDriveFreeBytes)}</span>
                      <span>SSD / TEMP 工作檔：{formatBytes(progress.resourceUsage.renderWorkingBytes ?? 0)}</span>
                    </div>
                  )}
                  {progress?.diskStatus && (
                    <div className={`render-runtime-resources is-${progress.diskStatus.pressureLevel.toLowerCase()}`}>
                      <span>TEMP 磁碟：{progress.diskStatus.tempVolume}</span>
                      <span>TEMP 可用：{formatBytes(progress.diskStatus.tempFreeBytes)}</span>
                      <span>中繼／TEMP：{formatBytes(progress.diskStatus.renderTempBytes)}</span>
                      <span>輸出磁碟：{progress.diskStatus.outputVolume}</span>
                      <span>輸出可用：{formatBytes(progress.diskStatus.outputFreeBytes)}</span>
                      <span>目前輸出：{formatBytes(progress.diskStatus.finalOutputBytes)}</span>
                      <span>預估尚需寫入：{formatBytes(progress.diskStatus.estimatedRemainingWriteBytes)}</span>
                      <span>磁碟狀態：{progress.diskStatus.pressureLevel}</span>
                    </div>
                  )}
                  {monitoring && <small>已從背景轉檔接回監控中；再按 × 回主畫面也不會中斷。</small>}
                  <small>
                    可取消；若已有足夠畫面，App 會要求編碼器安全寫完 MP4
                    結尾並保留較短成品。太早取消、無法驗證播放時才會清除 partial。來源不受影響。 按右上 ×
                    可回主畫面改字幕或做其他工作，轉檔會繼續；本次成品使用開始轉檔時的內容。
                  </small>
                </section>
              )}

              <div className="concat-footer-actions">
                {rendering ? (
                  <button
                    className="cancel-button render-cancel"
                    type="button"
                    disabled={cancelling}
                    onClick={() => void cancelRender()}
                  >
                    {cancelling ? "正在取消…" : "取消產出"}
                  </button>
                ) : (
                  <>
                    <button className="secondary-button" type="button" onClick={onClose}>
                      返回
                    </button>
                    <button
                      className="purple-button"
                      type="button"
                      disabled={
                        !output || !renderEstimate || renderItems.length < 1 || estimateBusy || Boolean(estimateError)
                      }
                      onClick={() => void prepareRemoteRender()}
                    >
                      {remotePreparedAt ? "已准备 iPhone 启动" : "准备 iPhone 远端启动"}
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      aria-busy={estimateBusy}
                      disabled={
                        !output ||
                        renderItems.length < 1 ||
                        estimateBusy ||
                        renderEstimate?.canRender === false ||
                        Boolean(estimateError)
                      }
                      onClick={() => void startRender()}
                    >
                      OK，開始產出
                    </button>
                  </>
                )}
              </div>
            </div>

            <aside className="concat-order">
              <span className="eyebrow">CURRENT SORT ORDER</span>
              <h3>{renderItems.length} 個片段</h3>
              <p>
                {isIntro
                  ? "輸出依照精彩建議頁目前的片段順序與 IN／OUT。"
                  : isClip
                    ? "輸出這一個固定來源時間段，並套用重疊於此時間內的局部放大設定。"
                    : "輸出依照目前素材順序、影片 IN／OUT 與每張照片設定的 3–7 秒顯示時間。"}
              </p>
              {introDurationWarningCount > 0 && (isIntro || (isMain && prependIntro)) && (
                <p className="inline-notice" role="status">
                  有 {introDurationWarningCount} 段超過建議的 {formatDuration(introSegmentMaxDurationMs)}
                  ；這次輸出仍會完整保留所選 IN／OUT，不會截短。
                </p>
              )}
              <ol>
                {renderItems.map((item, index) => (
                  <li key={item.key}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <small>
                        {item.section === "INTRO" && !isIntro ? "片頭 · " : ""}
                        {formatDuration(item.inMs)} → {formatDuration(item.outMs)}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              {insertionAudioPlan && insertionAudioPlan.items.length > 0 && (
                <section className="insertion-audio-review" aria-label="插入素材音訊確認">
                  <h4>片頭 Audio／正片 Audio</h4>
                  <p>以下直接讀取與 Final FFmpeg 相同的 Audio Plan；時間已包含目前轉場重疊。配音目前无独立音轨，开关只作为未来配音 gate，不会改变素材原音。</p>
                  {(["INTRO", "MAIN"] as const).map((scope) => {
                    const scoped = insertionAudioPlan.items.filter((item) => item.scope === scope);
                    if (!scoped.length && scope === "INTRO") return null;
                    return (
                      <section className="audio-scope-summary" key={scope} aria-label={scope === "INTRO" ? "片頭 Audio" : "正片 Audio"}>
                        <h5>{scope === "INTRO" ? "片頭 Audio" : "正片 Audio"}</h5>
                        {scope === "MAIN" && prependIntro && (
                          <p>正片開始提示音：{mainStartCue.enabled ? `開啟 · ${(mainStartCue.durationMs / 1000).toFixed(2)} 秒` : "關閉"}</p>
                        )}
                  <div className="insertion-audio-review-table" role="table">
                    {scoped.map((item, index) => (
                      <article key={`${item.scope}:${item.instanceId}`} role="row">
                        <strong>{index + 1}. {item.fileName}</strong>
                        <small>{item.scope === "INTRO" ? "片頭" : "正片安插"} · {item.kind === "IMAGE" ? "照片" : "影片"}</small>
                        <span>開始 {formatDuration(item.timelineStartMs)} · 長度 {formatDuration(item.durationMs)}</span>
                        <span>原音 {item.gates.original ? "✓" : "–"}　配音 {item.gates.voice ? "✓" : "–"}　BGM {item.gates.bgm ? "✓" : "–"}　SFX {item.gates.sfx ? "✓" : "–"}</span>
                        <span>原始音軌：{item.hasSourceAudio ? "有" : "無"}</span>
                        <span>SFX：{item.sfxEnabled ? `${item.sfxName} · ${item.sfxVolumePercent}%` : "關閉"}</span>
                        <span>
                          BGM：{item.bgmEnabled
                            ? `#${item.bgmTrackIndex} ${item.bgmTrackName} · ${formatDuration(item.bgmTimelineStartMs)}–${formatDuration(item.bgmTimelineEndMs)} · 播放 ${formatDuration(item.bgmPlayDurationMs)} · ${item.bgmVolumePercent}% · ${item.continuousWithPrevious ? "延續前一素材" : "新範圍"}${item.usesLoop ? " · Loop" : ""}`
                            : "不使用"}
                        </span>
                      </article>
                    ))}
                  </div>
                      </section>
                    );
                  })}
                  {insertionAudioPlan.bgmRanges.length > 0 && (
                    <div className="insertion-bgm-ranges">
                      <strong>合併後的連續 BGM Range</strong>
                      {insertionAudioPlan.bgmRanges.map((range) => (
                        <small key={range.id}>
                          BGM #{range.bgmTrackIndex}｜開始 {formatDuration(range.timelineStartMs)}｜長度 {formatDuration(range.durationMs)}｜
                          {range.memberInstanceIds.length} 個連續素材｜{range.usesLoop ? range.loopStrategy === "CROSSFADE" ? `交叉淡化循環 ${range.loopCrossfadeMs} ms` : `有界接點平滑循環 ${range.loopCrossfadeMs} ms` : "單次播放"}｜
                          淡入／淡出 {range.fadeInMs}/{range.fadeOutMs} ms
                        </small>
                      ))}
                    </div>
                  )}
                  {insertionAudioPlan.warnings.map((warning) => <small className="inline-error" key={warning}>{warning}</small>)}
                </section>
              )}
              {totalEstimatedDurationMs !== undefined && (
                <div className="estimate-line">
                  <span>預估串連片長</span>
                  <strong>{formatDuration(totalEstimatedDurationMs)}</strong>
                </div>
              )}
              <div className="readonly-note">
                <span>●</span>
                <div>
                  <strong>來源唯讀</strong>
                  <small>不改寫、不移動、不刪除來源</small>
                </div>
              </div>
              {!isClip && (
                <div className="readonly-note">
                  <span>♫</span>
                  <div>
                    <strong>混音保護</strong>
                    <small>片段原音＋BGM 分離控制；預設另套用人聲包絡線、Compressor 與 -1 dB Peak Ceiling</small>
                  </div>
                </div>
              )}
            </aside>
          </div>
        )}
        <OutputLibrary
          purpose={isIntro ? "INTRO" : isClip ? "CLIP" : ["CONCAT", "UNKNOWN"]}
          title={historyTitle}
          refreshKey={historyRefreshKey}
          recentOnly={false}
          emptyText="目前沒有仍存在的同類型預覽檔。"
        />
      </section>
      {showYoutubeUpload && result && isYoutubeEligible && (
        <YoutubeUploadModal
          key={youtubeSettingsRevision}
          renderResult={result}
          automaticUpload={youtubeFullAutoUploadEnabled}
          onOpenSettings={() => setShowYoutubeSettings(true)}
          onClose={() => setShowYoutubeUpload(false)}
        />
      )}
      {showYoutubeSettings && (
        <YoutubeSettingsModal
          onClose={() => {
            setShowYoutubeSettings(false);
            setYoutubeSettingsRevision((current) => current + 1);
          }}
        />
      )}
      {showMainStartCard && isMain && prependIntro && (
        <MainStartCardModal
          value={mainStartCard}
          cue={mainStartCue}
          backgroundFileName={renderItems.find((item) => item.section === "MAIN")?.fileName}
          introClips={effectiveIntroClips}
          assets={assets}
          onCancel={() => {
            setShowMainStartCard(false);
            setPrependIntro(false);
            setMainStartCardConfirmed(false);
            rememberRenderDefaults({ prependIntro: false });
          }}
          onSave={(next, cue) => {
            setMainStartCard(next);
            setMainStartCue(cue);
            setMainStartCardConfirmed(true);
            setShowMainStartCard(false);
            setError(undefined);
            void window.sourceApp.setMainStartCue(cue).catch((reason) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
            );
            rememberRenderDefaults({ prependIntro: true, mainStartCard: next });
          }}
        />
      )}
    </div>
  );
}
