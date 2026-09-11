import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioProtectionOptions,
  BgmScopeSelection,
  ConcatRenderProgress,
  ConcatRenderEstimate,
  ConcatRenderResult,
  IntroSuggestion,
  MainStartCardOptions,
  OutputSelection,
  PreviewResolution,
  PreviewRenderPurpose,
  RenderVideoCodec,
  RenderClipSelection,
  SourceAsset,
  SubtitleBurnInOptions,
  SubtitleRenderLanguage,
  SubtitleRenderPosition,
  TransitionDurationSec,
  YoutubeHandoffMode,
} from "../../shared/domain";
import { formatBytes, formatDuration } from "../format";
import {
  DEFAULT_AUDIO_PROTECTION_OPTIONS,
  DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  DEFAULT_MAIN_START_CARD_OPTIONS,
} from "../../shared/domain";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import { YoutubeSettingsModal } from "./YoutubeSettingsModal";
import { YoutubeUploadModal } from "./YoutubeUploadModal";
import { MainStartCardModal } from "./MainStartCardModal";
import { OutputLibrary } from "./OutputLibrary";
import { AudioProtectionSettings } from "./AudioProtectionSettings";

interface ConcatRenderModalProps {
  assets: SourceAsset[];
  purpose?: PreviewRenderPurpose;
  introClips?: IntroSuggestion[];
  introSegmentMaxDurationMs?: number;
  mainClips?: RenderClipSelection[];
  confirmedSubtitleCount?: number;
  subtitlesNeedReview?: boolean;
  initialResolution?: PreviewResolution;
  projectName?: string;
  onPurposeChange?: (purpose: "CONCAT" | "INTRO") => void;
  onClose: () => void;
}

const TRANSITIONS: TransitionDurationSec[] = [0.3, 0.5, 0.7];
const RESOLUTIONS: Array<{
  value: PreviewResolution;
  label: string;
  detail: string;
}> = [
  { value: "360P", label: "360p", detail: "640 × 360 · 較快、檔案較小" },
  { value: "480P", label: "480p", detail: "854 × 480 · 畫面較清楚" },
  { value: "720P", label: "720p", detail: "1280 × 720 · HD 預覽" },
  { value: "4K", label: "4K", detail: "3840 × 2160 · 最慢、檔案最大" },
];

const RESOLUTION_LABELS: Record<PreviewResolution, string> = {
  "360P": "640 × 360",
  "480P": "854 × 480",
  "720P": "1280 × 720",
  "4K": "3840 × 2160",
};
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
  if (!progress || progress.phase === "PREPARING")
    return "正在檢查來源與媒體資訊…";
  if (progress.phase === "TRANSLATING_SUBTITLES")
    return "正在翻譯並排版已確認字幕…";
  if (progress.phase === "FINALIZING") return "正在驗證並完成 MP4…";
  return "正在編碼串連預覽…";
}

export function ConcatRenderModal({
  assets,
  purpose = "CONCAT",
  introClips,
  introSegmentMaxDurationMs = DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  mainClips,
  confirmedSubtitleCount = 0,
  subtitlesNeedReview = false,
  initialResolution,
  projectName,
  onPurposeChange,
  onClose,
}: ConcatRenderModalProps) {
  const [transitionSeconds, setTransitionSeconds] =
    useState<TransitionDurationSec>(0.3);
  const [resolution, setResolution] = useState<PreviewResolution>(
    initialResolution ?? "480P",
  );
  const [videoCodec, setVideoCodec] = useState<RenderVideoCodec>("H265_QSV");
  const [includeWatermark, setIncludeWatermark] = useState(true);
  const [youtubeHandoffMode, setYoutubeHandoffMode] =
    useState<YoutubeHandoffMode>("CHROME_DRAG_DROP");
  const [output, setOutput] = useState<OutputSelection>();
  const [renderEstimate, setRenderEstimate] = useState<ConcatRenderEstimate>();
  const [estimateBusy, setEstimateBusy] = useState(false);
  const [estimateError, setEstimateError] = useState<string>();
  const [progress, setProgress] = useState<ConcatRenderProgress>();
  const [result, setResult] = useState<ConcatRenderResult>();
  const [rendering, setRendering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [showYoutubeUpload, setShowYoutubeUpload] = useState(false);
  const [showYoutubeSettings, setShowYoutubeSettings] = useState(false);
  const [youtubeSettingsRevision, setYoutubeSettingsRevision] = useState(0);
  const [outputOpenError, setOutputOpenError] = useState<string>();
  const [platformHandoffBusy, setPlatformHandoffBusy] = useState<
    "YOUTUBE" | "BILIBILI" | "TIKTOK"
  >();
  const [platformHandoffNotice, setPlatformHandoffNotice] = useState<string>();
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const isIntro = purpose === "INTRO";
  const isClip = purpose === "CLIP";
  const isMain = purpose === "CONCAT";
  const isYoutubeEligible = isMain || isIntro;
  const purposeTitle = isIntro
    ? "產出 Intro 預覽"
    : isClip
      ? "輸出最高 4K 時間段"
      : "產出串連預覽";
  const historyTitle = isIntro
    ? "曾經輸出的片頭預覽"
    : isClip
      ? "曾經輸出的 4K 時間段"
      : "曾經輸出的正片預覽";
  const [prependIntro, setPrependIntro] = useState(
    () => isMain && Boolean(introClips?.length),
  );
  const [autoUploadEnabled, setAutoUploadEnabled] = useState(() => isMain);
  const [autoUploadStatus, setAutoUploadStatus] = useState<
    "DISABLED" | "ARMED" | "COUNTING" | "CANCELLED" | "OPENED"
  >(() => (isMain ? "ARMED" : "DISABLED"));
  const [subtitleBurnIn, setSubtitleBurnIn] = useState<SubtitleBurnInOptions>({
    enabled: false,
    tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
    styleProfile: { ...DEFAULT_SUBTITLE_STYLE_PROFILE },
  });
  const [includeBgm, setIncludeBgm] = useState(() => isMain);
  const [bgmScopes, setBgmScopes] = useState<BgmScopeSelection>(() => ({ intro: true, main: true }));
  const [audioProtection, setAudioProtection] = useState<AudioProtectionOptions>(
    () => ({ ...DEFAULT_AUDIO_PROTECTION_OPTIONS }),
  );
  const [mainStartCard, setMainStartCard] = useState<MainStartCardOptions>(
    () => ({
      ...DEFAULT_MAIN_START_CARD_OPTIONS,
      line1: projectName?.trim() || DEFAULT_MAIN_START_CARD_OPTIONS.line1,
    }),
  );
  const [mainStartCardConfirmed, setMainStartCardConfirmed] = useState(false);
  const [showMainStartCard, setShowMainStartCard] = useState(false);
  const [uploadCountdownSeconds, setUploadCountdownSeconds] =
    useState<number>();
  const preferencesTouchedRef = useRef(false);
  const effectiveIntroClips = useMemo(
    () => introSegmentsForOutput(introClips ?? [], introSegmentMaxDurationMs),
    [introClips, introSegmentMaxDurationMs],
  );
  const cappedIntroCount = useMemo(
    () =>
      (introClips ?? []).filter(
        (clip) => clip.outMs - clip.inMs > introSegmentMaxDurationMs,
      ).length,
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
              fileName:
                assets.find((asset) => asset.id === clip.assetId)?.fileName ??
                clip.assetId,
              inMs: clip.inMs,
              outMs: clip.outMs,
              mediaInsertionId: clip.mediaInsertionId,
              section: "MAIN" as const,
            })),
          ],
    [assets, effectiveIntroClips, isIntro, isMain, mainClips, prependIntro],
  );

  const prepareAutomaticOutput = async (preserveExistingError = false) => {
    if (!preserveExistingError) setError(undefined);
    try {
      setOutput(
        await window.sourceApp.prepareConcatOutput(suggestedFileName(purpose)),
      );
    } catch (reason) {
      if (!preserveExistingError)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    window.sourceApp.onConcatProgress(setProgress);
    void prepareAutomaticOutput();
    void window.sourceApp
      .getUserPreferences()
      .then((preferences) => {
        if (preferencesTouchedRef.current) return;
        setTransitionSeconds(preferences.renderDefaults.transitionSeconds);
        setResolution(
          isClip
            ? "4K"
            : (initialResolution ?? preferences.renderDefaults.resolution),
        );
        // Older renderer harnesses and v0.49 preference files may omit the
        // field; the persisted v0.50 defaults are H265_QSV.
        setVideoCodec(preferences.renderDefaults.videoCodec ?? "H265");
        setIncludeWatermark(
          preferences.renderDefaults.includeWatermark !== false,
        );
        setAudioProtection({
          ...DEFAULT_AUDIO_PROTECTION_OPTIONS,
          ...(preferences.renderDefaults.audioProtection ?? {}),
        });
        setBgmScopes({ intro: true, main: true, ...(preferences.renderDefaults.mainBgmScopes ?? {}) });
        setYoutubeHandoffMode(
          preferences.renderDefaults.youtubeHandoffMode ?? "CHROME_DRAG_DROP",
        );
        if (isYoutubeEligible)
          setSubtitleBurnIn({
            ...preferences.subtitleBurnInDefaults,
            styleProfile: preferences.subtitlePreviewStyle,
          });
        if (isIntro)
          setIncludeBgm(preferences.renderDefaults.introPreviewIncludeBgm);
        if (isMain)
          setIncludeBgm(preferences.renderDefaults.mainPreviewIncludeBgm);
        if (isMain) {
          const shouldPrepend =
            Boolean(introClips?.length) &&
            preferences.renderDefaults.prependIntro;
          setPrependIntro(shouldPrepend);
          setMainStartCard(
            preferences.renderDefaults.mainStartCard ?? {
              ...DEFAULT_MAIN_START_CARD_OPTIONS,
              line1:
                projectName?.trim() || DEFAULT_MAIN_START_CARD_OPTIONS.line1,
            },
          );
          setMainStartCardConfirmed(false);
          if (shouldPrepend) setShowMainStartCard(true);
          setAutoUploadEnabled(preferences.renderDefaults.autoUpload);
          setAutoUploadStatus(
            preferences.renderDefaults.autoUpload ? "ARMED" : "DISABLED",
          );
        }
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => window.sourceApp.clearConcatProgressListeners();
  }, [
    initialResolution,
    introClips?.length,
    isClip,
    isIntro,
    isMain,
    isYoutubeEligible,
    projectName,
  ]);

  const rememberRenderDefaults = (
    update: Parameters<
      typeof window.sourceApp.updateUserPreferences
    >[0]["renderDefaults"],
  ) => {
    preferencesTouchedRef.current = true;
    void window.sourceApp
      .updateUserPreferences({ renderDefaults: update })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  };

  const updateSubtitleBurnIn = (next: SubtitleBurnInOptions) => {
    preferencesTouchedRef.current = true;
    setSubtitleBurnIn(next);
    void window.sourceApp
      .updateUserPreferences({ subtitleBurnInDefaults: next })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
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

  const patchSubtitleTrack = (
    index: number,
    patch: Partial<SubtitleBurnInOptions["tracks"][number]>,
  ) => {
    const tracks = subtitleBurnIn.tracks.map((track, current) =>
      current === index ? { ...track, ...patch } : track,
    );
    updateSubtitleBurnIn({ ...subtitleBurnIn, tracks });
  };

  const updateAudioProtection = (patch: Partial<AudioProtectionOptions>) => {
    const next = { ...audioProtection, ...patch };
    setAudioProtection(next);
    rememberRenderDefaults({ audioProtection: next });
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
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  };

  useEffect(() => {
    if (autoUploadStatus !== "COUNTING") return;
    if ((uploadCountdownSeconds ?? 0) <= 0) {
      setAutoUploadStatus("OPENED");
      if (youtubeHandoffMode === "OFFICIAL_API") setShowYoutubeUpload(true);
      else void openYoutubeChromeHandoff();
      return;
    }
    const timer = window.setTimeout(
      () =>
        setUploadCountdownSeconds((current) => Math.max(0, (current ?? 0) - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [autoUploadStatus, uploadCountdownSeconds, youtubeHandoffMode]);

  const estimatedDurationMs = useMemo(() => {
    if (renderItems.some((item) => item.outMs <= item.inMs)) return undefined;
    return Math.max(
      0,
      renderItems.reduce((sum, item) => sum + item.outMs - item.inMs, 0) -
        transitionSeconds * 1000 * Math.max(0, renderItems.length - 1),
    );
  }, [renderItems, transitionSeconds]);

  const totalEstimatedDurationMs = useMemo(() => estimatedDurationMs === undefined ? undefined : Math.max(0,
    estimatedDurationMs + (isMain && prependIntro
      ? mainStartCard.durationSeconds * 1000 + (mainStartCard.transitionStyle === "HARD_CUT" ? transitionSeconds * 1000 : -transitionSeconds * 1000)
      : 0),
  ), [estimatedDurationMs, isMain, mainStartCard.durationSeconds, mainStartCard.transitionStyle, prependIntro, transitionSeconds]);

  useEffect(() => {
    if (!output || totalEstimatedDurationMs === undefined || !window.sourceApp.estimateConcatRender) { setRenderEstimate(undefined); setEstimateError(undefined); return; }
    let active = true;
    setEstimateBusy(true);
    void window.sourceApp.estimateConcatRender({ outputToken: output.token, expectedDurationMs: totalEstimatedDurationMs, resolution, videoCodec })
      .then((estimate) => { if (active) { setRenderEstimate(estimate); setEstimateError(estimate.canRender ? undefined : estimate.warning); } })
      .catch((reason: unknown) => { if (active) { setRenderEstimate(undefined); setEstimateError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (active) setEstimateBusy(false); });
    return () => { active = false; };
  }, [output?.token, resolution, totalEstimatedDurationMs, videoCodec]);

  const chooseOutput = async () => {
    setError(undefined);
    try {
      const selected = await window.sourceApp.chooseConcatOutput(
        suggestedFileName(purpose),
      );
      if (selected) setOutput(selected);
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
      try { await window.sourceApp.setTimelineTransitionSeconds(transitionSeconds); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    }
    if (window.sourceApp.estimateConcatRender && totalEstimatedDurationMs !== undefined) {
      try {
        const latestEstimate = await window.sourceApp.estimateConcatRender({ outputToken: output.token, expectedDurationMs: totalEstimatedDurationMs, resolution, videoCodec });
        setRenderEstimate(latestEstimate);
        setEstimateError(latestEstimate.canRender ? undefined : latestEstimate.warning);
        if (!latestEstimate.canRender) { setError(latestEstimate.warning ?? "磁碟空間不足，本次不會開始轉檔。"); return; }
      } catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setEstimateError(message); setError(message); return; }
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
      const completed = await window.sourceApp.startConcatRender({
        outputToken: output.token,
        orderedAssetIds: renderItems.map((item) => item.assetId),
        clipSelections: renderItems.map((item) => ({
          assetId: item.assetId,
          inMs: item.inMs,
          outMs: item.outMs,
          ...(item.mediaInsertionId
            ? { mediaInsertionId: item.mediaInsertionId }
            : {}),
        })),
        transitionSeconds,
        resolution,
        videoCodec,
        includeWatermark,
        audioProtection,
        purpose,
        prependIntro: isMain && prependIntro,
        subtitleBurnIn: isYoutubeEligible
          ? subtitleBurnIn
          : { enabled: false, tracks: [] },
        includeBgm: isClip ? false : includeBgm,
        ...(isMain ? { bgmScopes: { intro: prependIntro && bgmScopes.intro, main: bgmScopes.main } } : {}),
        estimatedDurationMs: totalEstimatedDurationMs,
        ...(isMain && prependIntro ? { mainStartCard } : {}),
      });
      setResult(completed);
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
      setError(
        message.includes("取消")
          ? "已取消產出；未留下不完整的輸出檔。"
          : message,
      );
      await prepareAutomaticOutput(true);
      setProgress(undefined);
    } finally {
      setRendering(false);
      setCancelling(false);
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
      setPlatformHandoffNotice(
        (await window.sourceApp.openPlatformUpload(result.jobId, platform))
          .message,
      );
    } catch (reason) {
      setOutputOpenError(
        reason instanceof Error ? reason.message : String(reason),
      );
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
      setPlatformHandoffNotice(
        (await window.sourceApp.prepareYoutubeChromeHandoff(result.jobId))
          .message,
      );
    } catch (reason) {
      setOutputOpenError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setPlatformHandoffBusy(undefined);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="concat-modal"
        role="dialog"
        aria-modal="true"
        aria-label={purposeTitle}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">
              {isIntro
                ? "INTRO PREVIEW OUTPUT"
                : isClip
                  ? "SOURCE-BASED 4K CLIP"
                  : "CONCAT PREVIEW OUTPUT"}
            </span>
            <h2>{purposeTitle}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="關閉"
            disabled={rendering}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {onPurposeChange && !result && (
          <fieldset className="preview-purpose-selector">
            <legend>這次要輸出哪一段？</legend>
            <label className={isMain ? "is-selected" : ""}>
              <input type="radio" name="preview-purpose" checked={isMain} disabled={rendering} onChange={() => onPurposeChange("CONCAT")} />
              <span><strong>正片預覽</strong><small>依目前正片順序輸出；可選擇在前方串接片頭。</small></span>
            </label>
            <label className={isIntro ? "is-selected" : !introClips?.length ? "is-disabled" : ""}>
              <input type="radio" name="preview-purpose" checked={isIntro} disabled={rendering || !introClips?.length} onChange={() => onPurposeChange("INTRO")} />
              <span><strong>僅片頭預覽</strong><small>{introClips?.length ? `只輸出目前 ${introClips.length} 個片頭片段，完成後可上傳 YouTube 測試。` : "目前尚無片頭片段，請先到片頭頁建立。"}</small></span>
            </label>
          </fieldset>
        )}

        {result ? (
          <div className="concat-complete">
            <span className="complete-mark">✓</span>
            <div>
              <span className="eyebrow">
                {result.cancelled ? "CANCELLED PREVIEW SAVED" : "PREVIEW READY"}
              </span>
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
                  : `已依目前順序串接 ${renderItems.length} 個${isIntro ? "建議片段" : "影片／照片片段"}${result.includedIntroSegmentCount ? `，前方包含 ${result.includedIntroSegmentCount} 段已確認片頭${result.mainStartCardDurationSeconds ? `及 ${result.mainStartCardDurationSeconds} 秒正片開始提示頁` : ""}` : ""}，交接處套用 ${result.transitionSeconds} 秒疊化${result.photoShutterAppliedCount ? `，${result.photoShutterAppliedCount} 次照片出現已加入沙丘快門聲` : ""}${result.bgmAppliedCount ? `，並在${result.bgmScopesApplied?.intro && result.bgmScopesApplied?.main ? "片頭與正片" : result.bgmScopesApplied?.intro ? "片頭" : "正片"}混入 ${result.bgmAppliedCount} 首配樂` : ""}。`}
            </p>
            {result.subtitleBurnedLanguages?.length ? (
              <p className="inline-notice">
                已永久嵌入{" "}
                {result.subtitleBurnedLanguages
                  .map(
                    (language) =>
                      SUBTITLE_LANGUAGES.find((item) => item.value === language)
                        ?.label ?? language,
                  )
                  .join("＋")}{" "}
                字幕；翻譯來源：
                {result.subtitleTranslationProviders?.join("、")}。
              </p>
            ) : null}
            {result.audioProtectionApplied && (
              <p className="inline-notice">
                已套用本機人聲／突發聲保護、平滑壓低包絡線、Compressor 與 {result.audioPeakCeilingDb ?? -1} dB Peak Ceiling；請播放完成檔人工確認保留的環境聲是否自然。
              </p>
            )}
            <dl className="result-facts">
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
                    {uploadCountdownSeconds} 秒後開啟 YouTube 上傳確認
                    {youtubeHandoffMode === "CHROME_DRAG_DROP"
                      ? "（預設為 Chrome 拖放交接）"
                      : "（YouTube API 交接）"}
                  </strong>
                  <p>
                    {youtubeHandoffMode === "CHROME_DRAG_DROP"
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
                      setAutoUploadStatus("CANCELLED");
                      setUploadCountdownSeconds(undefined);
                      rememberRenderDefaults({ autoUpload: false });
                    }}
                  />
                  輸出後自動準備上傳
                </label>
                <button
                  className="cancel-button"
                  type="button"
                  onClick={() => {
                    setAutoUploadEnabled(false);
                    setAutoUploadStatus("CANCELLED");
                    setUploadCountdownSeconds(undefined);
                    rememberRenderDefaults({ autoUpload: false });
                  }}
                >
                  取消自動上傳
                </button>
              </section>
            )}
            {isYoutubeEligible && autoUploadStatus === "CANCELLED" && (
              <p className="inline-notice" role="status">
                已取消 60 秒自動上傳準備；本機 MP4
                完整保留，仍可按下方按鈕手動上傳。
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
                      setOutputOpenError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    );
                }}
              >
                ▶ 播放完成檔
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  void window.sourceApp.revealConcatOutput(result.jobId)
                }
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
                  {platformHandoffBusy === "YOUTUBE"
                    ? "正在準備…"
                    : "用 Chrome 拖放上傳（預設）"}
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
                  {platformHandoffBusy === "BILIBILI"
                    ? "開啟中…"
                    : "前往 BiliBili 投稿"}
                </button>
              )}
              {isMain && (
                <button
                  className="tiktok-upload-button"
                  type="button"
                  disabled={Boolean(platformHandoffBusy)}
                  onClick={() => void openPlatformHandoff("TIKTOK")}
                >
                  {platformHandoffBusy === "TIKTOK"
                    ? "開啟中…"
                    : "前往 TikTok 投稿"}
                </button>
              )}
              <button
                className="primary-button"
                type="button"
                onClick={onClose}
              >
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
              {!isClip && (
                <section className="setting-block">
                  <div>
                    <span className="setting-step">01</span>
                    <div>
                      <h3>交接疊化秒數</h3>
                      <p>
                        每兩個影片／照片片段交接時，同步套用影像疊化與音訊淡入淡出。
                      </p>
                    </div>
                  </div>
                  <div
                    className="option-grid transition-options"
                    aria-label="交接疊化秒數"
                  >
                    {TRANSITIONS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={
                          transitionSeconds === value ? "is-selected" : ""
                        }
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
                  <span className="setting-step">{isClip ? "01" : "02"}</span>
                  <div>
                    <h3>{isClip ? "最高解析度時間段" : "預覽解析度"}</h3>
                    <p>
                      {isClip
                        ? "固定輸出 3840×2160，從原始來源重新編碼並套用局部放大；低於 4K 的來源只能等比放大，無法恢復不存在的細節。"
                        : "固定 16:9；9:16 直式素材保持中央原比例，左右使用同一來源放大模糊填滿，不會橫向拉伸。4K 預覽可能耗時。"}
                    </p>
                  </div>
                </div>
                <div
                  className="option-grid resolution-options"
                  aria-label="預覽解析度"
                >
                  {RESOLUTIONS.filter(
                    (item) => !isClip || item.value === "4K",
                  ).map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={resolution === item.value ? "is-selected" : ""}
                      disabled={rendering || isClip}
                      aria-pressed={resolution === item.value}
                      onClick={() => {
                        setResolution(item.value);
                        if (!isClip)
                          rememberRenderDefaults({ resolution: item.value });
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
                  <span className="setting-step">{isClip ? "02" : "03"}</span>
                  <div>
                    <h3>影片格式</h3>
                    <p>
                      新版預設先用 Intel QSV GPU 的 H.265／HEVC；若這台電腦的硬體編碼器無法啟動，再手動改選 CPU 備援。需要舊裝置相容性時可改用 H.264。
                    </p>
                  </div>
                </div>
                <div
                  className="option-grid codec-options"
                  aria-label="影片格式"
                >
                  <button
                    type="button"
                    className={videoCodec === "H265_QSV" ? "is-selected" : ""}
                    disabled={rendering}
                    aria-pressed={videoCodec === "H265_QSV"}
                    onClick={() => {
                      setVideoCodec("H265_QSV");
                      rememberRenderDefaults({ videoCodec: "H265_QSV" });
                    }}
                  >
                    <strong>H.265／HEVC · GPU</strong>
                    <span>預設 · Intel QSV 硬體編碼，較省時間</span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H264_QSV" ? "is-selected" : ""}
                    disabled={rendering}
                    aria-pressed={videoCodec === "H264_QSV"}
                    onClick={() => {
                      setVideoCodec("H264_QSV");
                      rememberRenderDefaults({ videoCodec: "H264_QSV" });
                    }}
                  >
                    <strong>H.264／AVC · GPU</strong>
                    <span>Intel QSV · 相容性較高</span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H265" ? "is-selected" : ""}
                    disabled={rendering}
                    aria-pressed={videoCodec === "H265"}
                    onClick={() => { setVideoCodec("H265"); rememberRenderDefaults({ videoCodec: "H265" }); }}
                  >
                    <strong>H.265／HEVC · CPU</strong>
                    <span>GPU 不可用時的備援</span>
                  </button>
                  <button
                    type="button"
                    className={videoCodec === "H264" ? "is-selected" : ""}
                    disabled={rendering}
                    aria-pressed={videoCodec === "H264"}
                    onClick={() => { setVideoCodec("H264"); rememberRenderDefaults({ videoCodec: "H264" }); }}
                  >
                    <strong>H.264／AVC · CPU</strong>
                    <span>最廣相容性備援</span>
                  </button>
                </div>
              </section>

              {!isClip && (
                <section className="setting-block watermark-render-setting">
                  <div>
                    <span className="setting-step">
                      04
                    </span>
                    <div>
                      <h3>浮水印</h3>
                      <p>
                        沿用浮水印設定頁的文字、位置、間隔與顯示時間；只控制這一次輸出是否套用。
                      </p>
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
                      <small>
                        取消只影響本次轉檔，不會清除浮水印設定，也不會修改來源。
                      </small>
                    </span>
                  </label>
                </section>
              )}

              {!isClip && (
                <section className="setting-block intro-output-bgm-setting">
                  <div>
                    <span className="setting-step">05</span>
                    <div>
                      <h3>MP3 配樂</h3>
                      <p>
                        依配樂頁保存的 MP3 時間、source
                        IN／OUT、淡入淡出與音量混入；素材原音也使用配樂頁的百分比。
                      </p>
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
                          isIntro
                            ? { introPreviewIncludeBgm: enabled }
                            : { mainPreviewIncludeBgm: enabled },
                        );
                      }}
                    />
                    <span>
                      <strong>將 MP3 配樂嵌入這次產出的 MP4</strong>
                      <small>
                        取消時只播放素材原音；勾選時若 MP3
                        離線，輸出會安全阻擋並指出檔名。
                      </small>
                    </span>
                  </label>
                  {isMain && (
                    <fieldset className="bgm-scope-options" disabled={rendering || !includeBgm}>
                      <legend>這次配樂套用範圍（可複選或單選）</legend>
                      <label className={!prependIntro ? "is-disabled" : ""}>
                        <input
                          aria-label="片頭使用 MP3 配樂"
                          type="checkbox"
                          checked={prependIntro && bgmScopes.intro}
                          disabled={!prependIntro}
                          onChange={(event) => updateBgmScopes({ intro: event.target.checked })}
                        />
                        <span><strong>片頭</strong><small>只有選片頭時，配樂會在「正片即將開始」提示頁前平滑淡出並停止。</small></span>
                      </label>
                      <label>
                        <input
                          aria-label="正片使用 MP3 配樂"
                          type="checkbox"
                          checked={bgmScopes.main}
                          onChange={(event) => updateBgmScopes({ main: event.target.checked })}
                        />
                        <span><strong>正片</strong><small>只有選正片時，配樂會在提示頁結束、正片開始時播放。</small></span>
                      </label>
                      {!bgmScopes.main && !(prependIntro && bgmScopes.intro) && <small className="inline-warning">目前未選任何範圍，這次輸出不會混入配樂。</small>}
                    </fieldset>
                  )}
                </section>
              )}

              <AudioProtectionSettings
                value={audioProtection}
                disabled={rendering}
                stepLabel={isClip ? "04" : "06"}
                onChange={(next) => updateAudioProtection(next)}
              />

              {isYoutubeEligible && (
                <section className="setting-block subtitle-burn-setting">
                  <div>
                    <span className="setting-step">07</span>
                    <div>
                      <h3>嵌入影片字幕（最多兩種語言）</h3>
                      <p>
                        使用字幕頁中「已確認」的{isIntro ? "片頭" : "正片"}繁體中文。選擇其他語言時，OpenAI
                        新的無狀態請求優先，失敗才使用已設定的 Google Cloud
                        翻譯。
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
                      onChange={(event) =>
                        toggleSubtitleBurnIn(event.target.checked)
                      }
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
                        <div
                          className="subtitle-track-row"
                          key={`${index}:${track.language}`}
                        >
                          <strong>第 {index + 1} 種語言</strong>
                          <label>
                            語言
                            <select
                              aria-label={`第 ${index + 1} 種字幕語言`}
                              value={track.language}
                              onChange={(event) =>
                                patchSubtitleTrack(index, {
                                  language: event.target
                                    .value as SubtitleRenderLanguage,
                                })
                              }
                            >
                              {SUBTITLE_LANGUAGES.map((language) => (
                                <option
                                  key={language.value}
                                  value={language.value}
                                  disabled={subtitleBurnIn.tracks.some(
                                    (item, itemIndex) =>
                                      itemIndex !== index &&
                                      item.language === language.value,
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
                                  position: event.target
                                    .value as SubtitleRenderPosition,
                                })
                              }
                            >
                              {SUBTITLE_POSITIONS.map((position) => (
                                <option
                                  key={position.value}
                                  value={position.value}
                                >
                                  {position.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            {index === 0
                              ? "文字大小（與字幕頁預覽一致）"
                              : "文字大小（1080p 基準）"}
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
                                  fontSize1080p: Math.max(
                                    24,
                                    Math.min(96, value || 24),
                                  ),
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
                            const used = new Set(
                              subtitleBurnIn.tracks.map(
                                (track) => track.language,
                              ),
                            );
                            const language =
                              SUBTITLE_LANGUAGES.find(
                                (item) => !used.has(item.value),
                              )?.value ?? "en";
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
                        第一種字幕沿用字幕頁的 480p 預覽字級與位置，輸出時依解析度等比例換算；第二種語言可另設位置與 1080p 字級。若選在相同位置，App 會自動分層避免互相覆蓋。
                      </small>
                    </div>
                  )}
                </section>
              )}

              <section className="setting-block">
                <div>
                  <span className="setting-step">
                    {isClip ? "05" : "08"}
                  </span>
                  <div>
                    <h3>輸出位置</h3>
                    <p>
                      自動沿用上一次指定的資料夾並產生不覆寫舊檔的名稱；只有按下此欄才另外指定。
                    </p>
                  </div>
                </div>
                <button
                  className="output-picker"
                  type="button"
                  aria-label={`選擇儲存位置，${output?.automatic ? "目前為自動位置" : output ? "目前已另外指定" : "正在準備自動位置"}${output?.displayPath ? `：${output.displayPath}` : ""}`}
                  disabled={rendering}
                  onClick={() => void chooseOutput()}
                >
                  <span>
                    {output?.automatic
                      ? "自動位置"
                      : output
                        ? "已另外指定"
                        : "正在準備"}
                  </span>
                  <strong title={output?.displayPath}>
                    {output?.displayPath ?? "正在依上次位置產生檔名…"}
                  </strong>
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

              <section className={`render-preflight ${renderEstimate && !renderEstimate.canRender ? "is-blocked" : ""}`} aria-label="轉檔前容量與時間預估">
                <header><div><span className="eyebrow">RENDER PREFLIGHT</span><h3>轉檔前預估</h3></div>{estimateBusy && <span className="spinner" />}</header>
                {renderEstimate ? <dl>
                  <div><dt>預估檔案大小</dt><dd>約 {formatBytes(renderEstimate.estimatedOutputBytes)}</dd></div>
                  <div><dt>預估所需時間</dt><dd>約 {formatDuration(renderEstimate.estimatedRenderTimeMs)}</dd></div>
                  <div><dt>{renderEstimate.driveRoot || "輸出磁碟"} 目前剩餘</dt><dd>{formatBytes(renderEstimate.currentFreeBytes)}</dd></div>
                  <div><dt>完成後預估剩餘</dt><dd>{formatBytes(renderEstimate.estimatedFreeAfterBytes)}</dd></div>
                </dl> : <p>{estimateError ?? (estimateBusy ? "正在讀取輸出磁碟與編碼設定…" : "選定輸出位置後會顯示預估檔案大小、時間與硬碟餘量。")}</p>}
                {(estimateError || renderEstimate?.warning) && <p className="render-preflight-warning" role="alert">⚠ {estimateError ?? renderEstimate?.warning}</p>}
                <small>估算會因畫面複雜度、字幕、浮水印、配樂及其他程式負載而變動；App 會在真正開始前再次檢查。預估完成後若無法保留至少 1 GB，轉檔會被阻擋。</small>
              </section>

              {isYoutubeEligible && (
                <section className="setting-block">
                  <div>
                    <span className="setting-step">09</span>
                    <div>
                      <h3>{isIntro ? "片頭 YouTube 測試上傳" : "片頭串接與 YouTube 上傳交接"}</h3>
                      <p>
                        {isIntro ? "這次只輸出片頭；完成後可打開 Chrome 上傳頁與檔案總管，或使用 YouTube 官方 API 作不公開測試。" : "片頭可自動放在正片最前方；輸出完成後預設打開 Chrome 上傳頁與檔案總管，由您拖放最新 MP4。"}
                      </p>
                    </div>
                  </div>
                  <div className="post-render-options">
                    {isMain && <label className={!introClips?.length ? "is-disabled" : ""}>
                      <input
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
                        <strong>自動串接已確認片頭＋正片</strong>
                        <small>
                          {introClips?.length
                            ? `目前會在正片前加入 ${introClips.length} 段片頭；勾選後會強制設定 3–7 秒的正片開始提示頁。`
                            : "目前沒有已確認的片頭；請先到 AI 精彩片頭頁建立。"}
                        </small>
                      </span>
                    </label>}
                    {isMain && prependIntro && (
                      <div className="main-start-card-summary">
                        <span>
                          {mainStartCardConfirmed ? "✓ 已確認" : "尚未確認"} ·{" "}
                          {mainStartCard.durationSeconds} 秒 · 「
                          {mainStartCard.line1}／{mainStartCard.line2}」
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
                    )}
                    <div
                      className="upload-method-options"
                      role="radiogroup"
                      aria-label="YouTube 上傳方式"
                    >
                      <label>
                        <input
                          type="radio"
                          name="youtube-handoff"
                          checked={youtubeHandoffMode === "CHROME_DRAG_DROP"}
                          disabled={rendering}
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
                            App 打開 YouTube Studio 並選取最新
                            MP4；您用滑鼠拖入上傳區。
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
                          <small>
                            沿用現有的頻道連線、標題、縮圖與說明確認流程。
                          </small>
                        </span>
                      </label>
                    </div>
                    <label>
                      <input
                        type="checkbox"
                        checked={autoUploadEnabled}
                        disabled={rendering}
                        onChange={(event) => {
                          setAutoUploadEnabled(event.target.checked);
                          setAutoUploadStatus(
                            event.target.checked ? "ARMED" : "DISABLED",
                          );
                          rememberRenderDefaults({
                            autoUpload: event.target.checked,
                          });
                        }}
                      />
                      <span>
                          <strong>輸出後自動準備 YouTube 上傳交接</strong>
                        <small>
                          完成後倒數 60 秒；不會替您按下公開或發布。
                        </small>
                      </span>
                    </label>
                  </div>
                </section>
              )}

              {error && (
                <div className="notice error concat-error" role="alert">
                  {error}
                </div>
              )}
              {rendering && (
                <section className="render-progress" aria-live="polite">
                  <div>
                    <strong>{progressLabel(progress)}</strong>
                    <span>{Math.round(progress?.percent ?? 0)}%</span>
                  </div>
                  <progress max="100" value={progress?.percent ?? 0} />
                  <small>
                    可取消；若已有足夠畫面，App 會要求編碼器安全寫完 MP4
                    結尾並保留較短成品。太早取消、無法驗證播放時才會清除
                    partial。來源不受影響。
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
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={onClose}
                    >
                      返回
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!output || renderItems.length < 1 || estimateBusy || renderEstimate?.canRender === false || Boolean(estimateError)}
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
              {cappedIntroCount > 0 &&
                (isIntro || (isMain && prependIntro)) && (
                  <p className="inline-notice" role="status">
                    有 {cappedIntroCount}{" "}
                    段檢看片段超時；實際輸出會保留各段起點，並截取最多{" "}
                    {formatDuration(introSegmentMaxDurationMs)}。
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
                        {formatDuration(item.inMs)} →{" "}
                        {formatDuration(item.outMs)}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
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
                    <small>
                      片段原音＋BGM 分離控制；預設另套用人聲包絡線、Compressor 與 -1 dB Peak Ceiling
                    </small>
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
          backgroundFileName={
            renderItems.find((item) => item.section === "MAIN")?.fileName
          }
          introClips={effectiveIntroClips}
          assets={assets}
          onCancel={() => {
            setShowMainStartCard(false);
            setPrependIntro(false);
            setMainStartCardConfirmed(false);
            rememberRenderDefaults({ prependIntro: false });
          }}
          onSave={(next) => {
            setMainStartCard(next);
            setMainStartCardConfirmed(true);
            setShowMainStartCard(false);
            setError(undefined);
            rememberRenderDefaults({ prependIntro: true, mainStartCard: next });
          }}
        />
      )}
    </div>
  );
}
