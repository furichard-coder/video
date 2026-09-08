import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConcatRenderProgress,
  ConcatRenderResult,
  IntroSuggestion,
  MainStartCardOptions,
  OutputSelection,
  PreviewOutputRecord,
  PreviewResolution,
  PreviewRenderPurpose,
  RenderClipSelection,
  SourceAsset,
  SubtitleBurnInOptions,
  SubtitleRenderLanguage,
  SubtitleRenderPosition,
  TransitionDurationSec,
} from "../../shared/domain";
import { formatBytes, formatDuration } from "../format";
import { DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS, DEFAULT_MAIN_START_CARD_OPTIONS } from "../../shared/domain";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import { YoutubeSettingsModal } from "./YoutubeSettingsModal";
import { YoutubeUploadModal } from "./YoutubeUploadModal";
import { MainStartCardModal } from "./MainStartCardModal";

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
  onClose: () => void;
}

const TRANSITIONS: TransitionDurationSec[] = [0.3, 0.5, 0.7];
const RESOLUTIONS: Array<{ value: PreviewResolution; label: string; detail: string }> = [
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
const SUBTITLE_LANGUAGES: Array<{ value: SubtitleRenderLanguage; label: string }> = [
  { value: "zh-TW", label: "繁體中文（原文）" }, { value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }, { value: "ja", label: "日本語" }, { value: "ko", label: "한국어" },
];
const SUBTITLE_POSITIONS: Array<{ value: SubtitleRenderPosition; label: string }> = [
  { value: "TOP", label: "上方" }, { value: "MIDDLE", label: "中央" }, { value: "BOTTOM", label: "下方" },
];

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
  if (progress.phase === "FINALIZING") return "正在驗證並完成 MP4…";
  return "正在編碼串連預覽…";
}

export function ConcatRenderModal({ assets, purpose = "CONCAT", introClips, introSegmentMaxDurationMs = DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS, mainClips, confirmedSubtitleCount = 0, subtitlesNeedReview = false, initialResolution, projectName, onClose }: ConcatRenderModalProps) {
  const [transitionSeconds, setTransitionSeconds] = useState<TransitionDurationSec>(0.3);
  const [resolution, setResolution] = useState<PreviewResolution>(initialResolution ?? "480P");
  const [output, setOutput] = useState<OutputSelection>();
  const [progress, setProgress] = useState<ConcatRenderProgress>();
  const [result, setResult] = useState<ConcatRenderResult>();
  const [rendering, setRendering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [showYoutubeUpload, setShowYoutubeUpload] = useState(false);
  const [showYoutubeSettings, setShowYoutubeSettings] = useState(false);
  const [youtubeSettingsRevision, setYoutubeSettingsRevision] = useState(0);
  const [outputOpenError, setOutputOpenError] = useState<string>();
  const [platformHandoffBusy, setPlatformHandoffBusy] = useState<"BILIBILI" | "TIKTOK">();
  const [platformHandoffNotice, setPlatformHandoffNotice] = useState<string>();
  const [previousOutputs, setPreviousOutputs] = useState<PreviewOutputRecord[]>([]);
  const isIntro = purpose === "INTRO";
  const isClip = purpose === "CLIP";
  const isMain = purpose === "CONCAT";
  const purposeTitle = isIntro ? "產出 Intro 預覽" : isClip ? "輸出最高 4K 時間段" : "產出串連預覽";
  const historyTitle = isIntro ? "曾經輸出的片頭預覽" : isClip ? "曾經輸出的 4K 時間段" : "曾經輸出的正片預覽";
  const [prependIntro, setPrependIntro] = useState(() => isMain && Boolean(introClips?.length));
  const [autoUploadEnabled, setAutoUploadEnabled] = useState(() => isMain);
  const [autoUploadStatus, setAutoUploadStatus] = useState<"DISABLED" | "ARMED" | "COUNTING" | "CANCELLED" | "OPENED">(() => isMain ? "ARMED" : "DISABLED");
  const [subtitleBurnIn, setSubtitleBurnIn] = useState<SubtitleBurnInOptions>({ enabled: false, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }], styleProfile: { verticalPositionPercent: 82, fontSizePx: 28, textColor: "#FFFFFF", shadowEnabled: true, outlineWidthPx: 2 } });
  const [includeBgm, setIncludeBgm] = useState(() => isMain);
  const [mainStartCard, setMainStartCard] = useState<MainStartCardOptions>(() => ({ ...DEFAULT_MAIN_START_CARD_OPTIONS, line1: projectName?.trim() || DEFAULT_MAIN_START_CARD_OPTIONS.line1 }));
  const [mainStartCardConfirmed, setMainStartCardConfirmed] = useState(false);
  const [showMainStartCard, setShowMainStartCard] = useState(false);
  const [uploadCountdownSeconds, setUploadCountdownSeconds] = useState<number>();
  const preferencesTouchedRef = useRef(false);
  const effectiveIntroClips = useMemo(
    () => introSegmentsForOutput(introClips ?? [], introSegmentMaxDurationMs),
    [introClips, introSegmentMaxDurationMs],
  );
  const cappedIntroCount = useMemo(() => (introClips ?? []).filter((clip) => clip.outMs - clip.inMs > introSegmentMaxDurationMs).length, [introClips, introSegmentMaxDurationMs]);
  const renderItems = useMemo(() => isIntro
    ? effectiveIntroClips.map((clip) => ({ key: clip.id, assetId: clip.assetId, fileName: clip.fileName, inMs: clip.inMs, outMs: clip.outMs, mediaInsertionId: undefined as string | undefined, section: "INTRO" as const }))
    : [
      ...(isMain && prependIntro ? effectiveIntroClips.map((clip) => ({ key: `intro:${clip.id}`, assetId: clip.assetId, fileName: clip.fileName, inMs: clip.inMs, outMs: clip.outMs, mediaInsertionId: undefined as string | undefined, section: "INTRO" as const })) : []),
      ...(mainClips ?? []).map((clip, index) => ({
        key: `${clip.assetId}:${clip.inMs}:${clip.outMs}:${clip.mediaInsertionId ?? "main"}:${index}`,
        assetId: clip.assetId,
        fileName: assets.find((asset) => asset.id === clip.assetId)?.fileName ?? clip.assetId,
        inMs: clip.inMs,
        outMs: clip.outMs,
        mediaInsertionId: clip.mediaInsertionId,
        section: "MAIN" as const,
      })),
    ], [assets, effectiveIntroClips, isIntro, isMain, mainClips, prependIntro]);
  const matchingOutputs = useMemo(() => previousOutputs
    .filter((item) => item.exists && (isIntro ? item.purpose === "INTRO" : isClip ? item.purpose === "CLIP" : item.purpose === "CONCAT" || item.purpose === "UNKNOWN"))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [isClip, isIntro, previousOutputs]);

  const refreshOutputHistory = async () => {
    const history = await window.sourceApp.getPreviewOutputHistory();
    setPreviousOutputs(history.outputs);
  };

  const prepareAutomaticOutput = async (preserveExistingError = false) => {
    if (!preserveExistingError) setError(undefined);
    try { setOutput(await window.sourceApp.prepareConcatOutput(suggestedFileName(purpose))); }
    catch (reason) {
      if (!preserveExistingError) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    window.sourceApp.onConcatProgress(setProgress);
    void prepareAutomaticOutput();
    void refreshOutputHistory().catch((reason: unknown) => setOutputOpenError(reason instanceof Error ? reason.message : String(reason)));
    void window.sourceApp.getUserPreferences().then((preferences) => {
      if (preferencesTouchedRef.current) return;
      setTransitionSeconds(preferences.renderDefaults.transitionSeconds);
      setResolution(isClip ? "4K" : initialResolution ?? preferences.renderDefaults.resolution);
      if (isMain) setSubtitleBurnIn({ ...preferences.subtitleBurnInDefaults, styleProfile: preferences.subtitlePreviewStyle });
      if (isIntro) setIncludeBgm(preferences.renderDefaults.introPreviewIncludeBgm);
      if (isMain) setIncludeBgm(preferences.renderDefaults.mainPreviewIncludeBgm);
      if (isMain) {
        const shouldPrepend = Boolean(introClips?.length) && preferences.renderDefaults.prependIntro;
        setPrependIntro(shouldPrepend);
        setMainStartCard(preferences.renderDefaults.mainStartCard ?? { ...DEFAULT_MAIN_START_CARD_OPTIONS, line1: projectName?.trim() || DEFAULT_MAIN_START_CARD_OPTIONS.line1 });
        setMainStartCardConfirmed(false);
        if (shouldPrepend) setShowMainStartCard(true);
        setAutoUploadEnabled(preferences.renderDefaults.autoUpload);
        setAutoUploadStatus(preferences.renderDefaults.autoUpload ? "ARMED" : "DISABLED");
      }
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => window.sourceApp.clearConcatProgressListeners();
  }, [initialResolution, introClips?.length, isClip, isIntro, isMain, projectName]);

  const rememberRenderDefaults = (update: Parameters<typeof window.sourceApp.updateUserPreferences>[0]["renderDefaults"]) => {
    preferencesTouchedRef.current = true;
    void window.sourceApp.updateUserPreferences({ renderDefaults: update }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const updateSubtitleBurnIn = (next: SubtitleBurnInOptions) => {
    preferencesTouchedRef.current = true;
    setSubtitleBurnIn(next);
    void window.sourceApp.updateUserPreferences({ subtitleBurnInDefaults: next }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  // The checkbox must always remain usable for turning permanent subtitle burn-in
  // off.  Validation is only required when enabling it; this avoids a disabled
  // control trapping a previously saved "enabled" preference.
  const toggleSubtitleBurnIn = (enabled: boolean) => {
    if (enabled && (!confirmedSubtitleCount || subtitlesNeedReview)) {
      setError(!confirmedSubtitleCount
        ? "尚無已確認字幕；請先到「CC 字幕」逐項確認並保存。"
        : "正片順序或 IN／OUT 已變更；請先重新複核並保存字幕。\n若只是不嵌入字幕，可直接取消勾選。" );
      return;
    }
    setError(undefined);
    updateSubtitleBurnIn({ ...subtitleBurnIn, enabled });
  };

  const patchSubtitleTrack = (index: number, patch: Partial<SubtitleBurnInOptions["tracks"][number]>) => {
    const tracks = subtitleBurnIn.tracks.map((track, current) => current === index ? { ...track, ...patch } : track);
    updateSubtitleBurnIn({ ...subtitleBurnIn, tracks });
  };

  useEffect(() => {
    if (autoUploadStatus !== "COUNTING") return;
    if ((uploadCountdownSeconds ?? 0) <= 0) {
      setAutoUploadStatus("OPENED");
      setShowYoutubeUpload(true);
      return;
    }
    const timer = window.setTimeout(() => setUploadCountdownSeconds((current) => Math.max(0, (current ?? 0) - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [autoUploadStatus, uploadCountdownSeconds]);

  const estimatedDurationMs = useMemo(() => {
    if (renderItems.some((item) => item.outMs <= item.inMs)) return undefined;
    return Math.max(
      0,
      renderItems.reduce((sum, item) => sum + item.outMs - item.inMs, 0) -
        transitionSeconds * 1000 * Math.max(0, renderItems.length - 1),
    );
  }, [renderItems, transitionSeconds]);

  const chooseOutput = async () => {
    setError(undefined);
    try {
      const selected = await window.sourceApp.chooseConcatOutput(suggestedFileName(purpose));
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
    setRendering(true);
    setCancelling(false);
    setResult(undefined);
    setError(undefined);
    setProgress({ phase: "PREPARING", percent: 0, outTimeMs: 0, expectedDurationMs: 0 });
    try {
      const completed = await window.sourceApp.startConcatRender({
        outputToken: output.token,
        orderedAssetIds: renderItems.map((item) => item.assetId),
        clipSelections: renderItems.map((item) => ({ assetId: item.assetId, inMs: item.inMs, outMs: item.outMs, ...(item.mediaInsertionId ? { mediaInsertionId: item.mediaInsertionId } : {}) })),
        transitionSeconds,
        resolution,
        purpose,
        prependIntro: isMain && prependIntro,
        subtitleBurnIn: isMain ? subtitleBurnIn : { enabled: false, tracks: [] },
        includeBgm: isClip ? false : includeBgm,
        ...(isMain && prependIntro ? { mainStartCard } : {}),
      });
      setResult(completed);
      await refreshOutputHistory();
      if (isMain && autoUploadEnabled && !completed.cancelled) {
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
      setError(message.includes("取消") ? "已取消產出；未留下不完整的輸出檔。" : message);
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
    setPlatformHandoffBusy(platform); setOutputOpenError(undefined); setPlatformHandoffNotice(undefined);
    try { setPlatformHandoffNotice((await window.sourceApp.openPlatformUpload(result.jobId, platform)).message); }
    catch (reason) { setOutputOpenError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPlatformHandoffBusy(undefined); }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="concat-modal" role="dialog" aria-modal="true" aria-label={purposeTitle}>
        <header className="modal-header">
          <div><span className="eyebrow">{isIntro ? "INTRO PREVIEW OUTPUT" : isClip ? "SOURCE-BASED 4K CLIP" : "CONCAT PREVIEW OUTPUT"}</span><h2>{purposeTitle}</h2></div>
          <button className="icon-button" type="button" aria-label="關閉" disabled={rendering} onClick={onClose}>×</button>
        </header>

        {result ? (
          <div className="concat-complete">
            <span className="complete-mark">✓</span>
            <div><span className="eyebrow">{result.cancelled ? "CANCELLED PREVIEW SAVED" : "PREVIEW READY"}</span><h3>{result.cancelled ? "已停止產出並完成較短的可播放 MP4" : isIntro ? "Intro 預覽已完成" : isClip ? "4K 時間段已完成" : "串連預覽已完成"}</h3></div>
            <p>{result.cancelled ? `已在取消位置安全寫完 MPEG-4 尾端並驗證可播放；成品較原計畫短（原計畫 ${formatDuration(result.plannedDurationMs)}）。` : isClip ? "已從最高品質來源重新編碼固定時間段，並套用已保存的局部放大；未使用代理作為輸出來源。" : `已依目前順序串接 ${renderItems.length} 個${isIntro ? "建議片段" : "影片／照片片段"}${result.includedIntroSegmentCount ? `，前方包含 ${result.includedIntroSegmentCount} 段已確認片頭${result.mainStartCardDurationSeconds ? `及 ${result.mainStartCardDurationSeconds} 秒正片開始提示頁` : ""}` : ""}，交接處套用 ${result.transitionSeconds} 秒疊化${result.photoShutterAppliedCount ? `，${result.photoShutterAppliedCount} 次照片出現已加入沙丘快門聲` : ""}${result.bgmAppliedCount ? `，並混入 ${result.bgmAppliedCount} 首配樂` : ""}。`}</p>
            {result.subtitleBurnedLanguages?.length ? <p className="inline-notice">已永久嵌入 {result.subtitleBurnedLanguages.map((language) => SUBTITLE_LANGUAGES.find((item) => item.value === language)?.label ?? language).join("＋")} 字幕；翻譯來源：{result.subtitleTranslationProviders?.join("、")}。</p> : null}
            <dl className="result-facts">
              <div><dt>解析度</dt><dd>{RESOLUTION_LABELS[result.resolution]}</dd></div>
              <div><dt>{result.cancelled ? "完成片長" : "預估片長"}</dt><dd>{formatDuration(result.expectedDurationMs)}</dd></div>
              <div><dt>檔案大小</dt><dd>{formatBytes(result.sizeBytes)}</dd></div>
            </dl>
            <div className="output-path-box"><span>輸出位置</span><strong title={result.outputPath}>{result.outputPath}</strong></div>
            {isMain && autoUploadStatus === "COUNTING" && <section className="upload-countdown" aria-live="polite"><div><span className="eyebrow">AUTO UPLOAD READY</span><strong>{uploadCountdownSeconds} 秒後開啟 YouTube 上傳確認</strong><p>預設不公開。倒數結束只會開啟最後確認頁，不會跳過頻道、標題、觀眾設定與人工確認。</p></div><label><input type="checkbox" checked onChange={() => { setAutoUploadEnabled(false); setAutoUploadStatus("CANCELLED"); setUploadCountdownSeconds(undefined); rememberRenderDefaults({ autoUpload: false }); }} />輸出後自動準備上傳</label><button className="cancel-button" type="button" onClick={() => { setAutoUploadEnabled(false); setAutoUploadStatus("CANCELLED"); setUploadCountdownSeconds(undefined); rememberRenderDefaults({ autoUpload: false }); }}>取消自動上傳</button></section>}
            {isMain && autoUploadStatus === "CANCELLED" && <p className="inline-notice" role="status">已取消 60 秒自動上傳準備；本機 MP4 完整保留，仍可按下方按鈕手動上傳。</p>}
            {outputOpenError && <div className="notice error concat-error" role="alert">{outputOpenError}</div>}
            {platformHandoffNotice && <><div className="notice success concat-error" role="status">{platformHandoffNotice}</div><small>仍需您在平台上確認後發布。</small></>}
            <div className="concat-footer-actions">
              <button className="secondary-button" type="button" onClick={() => { setOutputOpenError(undefined); void window.sourceApp.playConcatOutput(result.jobId).catch((reason: unknown) => setOutputOpenError(reason instanceof Error ? reason.message : String(reason))); }}>▶ 播放完成檔</button>
              <button className="secondary-button" type="button" onClick={() => void window.sourceApp.revealConcatOutput(result.jobId)}>在檔案總管中顯示</button>
              {isMain && <button className="youtube-connect-button" type="button" onClick={() => { setAutoUploadStatus("OPENED"); setUploadCountdownSeconds(undefined); setShowYoutubeUpload(true); }}>上傳 YouTube 預覽</button>}
              {isMain && <button className="bilibili-upload-button" type="button" disabled={Boolean(platformHandoffBusy)} onClick={() => void openPlatformHandoff("BILIBILI")}>{platformHandoffBusy === "BILIBILI" ? "開啟中…" : "前往 BiliBili 投稿"}</button>}
              {isMain && <button className="tiktok-upload-button" type="button" disabled={Boolean(platformHandoffBusy)} onClick={() => void openPlatformHandoff("TIKTOK")}>{platformHandoffBusy === "TIKTOK" ? "開啟中…" : "前往 TikTok 投稿"}</button>}
              <button className="primary-button" type="button" onClick={onClose}>完成</button>
            </div>
            <small className="preview-only-warning">這是{isIntro ? "片頭" : isClip ? "來源時間段" : "串連"}預覽，不是正式輸出 Master，也不會作為後續正式輸出的來源。</small>
          </div>
        ) : (
          <div className="concat-layout">
            <div className="concat-settings">
              {!isClip && <section className="setting-block">
                <div><span className="setting-step">01</span><div><h3>交接疊化秒數</h3><p>每兩個影片／照片片段交接時，同步套用影像疊化與音訊淡入淡出。</p></div></div>
                <div className="option-grid transition-options" aria-label="交接疊化秒數">
                  {TRANSITIONS.map((value) => (
                    <button key={value} type="button" className={transitionSeconds === value ? "is-selected" : ""} disabled={rendering} aria-pressed={transitionSeconds === value} onClick={() => { setTransitionSeconds(value); rememberRenderDefaults({ transitionSeconds: value }); }}><strong>{value}</strong><span>秒</span></button>
                  ))}
                </div>
              </section>}

              <section className="setting-block">
                <div><span className="setting-step">{isClip ? "01" : "02"}</span><div><h3>{isClip ? "最高解析度時間段" : "預覽解析度"}</h3><p>{isClip ? "固定輸出 3840×2160，從原始來源重新編碼並套用局部放大；低於 4K 的來源只能等比放大，無法恢復不存在的細節。" : "固定 16:9；9:16 直式素材保持中央原比例，左右使用同一來源放大模糊填滿，不會橫向拉伸。4K 預覽可能耗時。"}</p></div></div>
                <div className="option-grid resolution-options" aria-label="預覽解析度">
                  {RESOLUTIONS.filter((item) => !isClip || item.value === "4K").map((item) => (
                    <button key={item.value} type="button" className={resolution === item.value ? "is-selected" : ""} disabled={rendering || isClip} aria-pressed={resolution === item.value} onClick={() => { setResolution(item.value); if (!isClip) rememberRenderDefaults({ resolution: item.value }); }}><strong>{item.label}</strong><span>{item.detail}</span></button>
                  ))}
                </div>
              </section>

              {!isClip && <section className="setting-block intro-output-bgm-setting">
                <div><span className="setting-step">03</span><div><h3>MP3 配樂</h3><p>依配樂頁保存的 MP3 時間、source IN／OUT、淡入淡出與音量混入；素材原音也使用配樂頁的百分比。</p></div></div>
                <label className="subtitle-burn-toggle"><input aria-label="這次 MP4 嵌入 MP3 配樂" type="checkbox" checked={includeBgm} disabled={rendering} onChange={(event) => { setIncludeBgm(event.target.checked); rememberRenderDefaults(isIntro ? { introPreviewIncludeBgm: event.target.checked } : { mainPreviewIncludeBgm: event.target.checked }); }} /><span><strong>將 MP3 配樂嵌入這次產出的 MP4</strong><small>取消時只播放素材原音；勾選時若 MP3 離線，輸出會安全阻擋並指出檔名。</small></span></label>
              </section>}

              {isMain && <section className="setting-block subtitle-burn-setting">
                <div><span className="setting-step">04</span><div><h3>嵌入影片字幕（最多兩種語言）</h3><p>使用字幕頁中「已確認」的繁體中文。選擇其他語言時，OpenAI 新的無狀態請求優先，失敗才使用已設定的 Google Cloud 翻譯。</p></div></div>
                <label className={`subtitle-burn-toggle ${(!confirmedSubtitleCount || subtitlesNeedReview) ? "is-disabled" : ""}`}><input aria-label="將字幕永久嵌入這次 MP4" type="checkbox" checked={subtitleBurnIn.enabled} disabled={rendering} onChange={(event) => toggleSubtitleBurnIn(event.target.checked)} /><span><strong>將字幕永久嵌入這次 MP4</strong><small>勾選後會在本次輸出永久嵌入；尚未開始輸出前隨時可以取消勾選（取消後輸出不嵌入字幕），不會修改來源檔。長句會依畫面寬度自動換行。</small></span></label>
                {!confirmedSubtitleCount && <p className="inline-error">尚無已確認字幕；請先到「CC 字幕」逐項確認並保存。</p>}
                {subtitlesNeedReview && <p className="inline-error">正片順序或 IN／OUT 已變更；請先重新複核並保存字幕。</p>}
                {subtitleBurnIn.enabled && <div className="subtitle-track-settings">
                  {subtitleBurnIn.tracks.map((track, index) => <div className="subtitle-track-row" key={`${index}:${track.language}`}>
                    <strong>第 {index + 1} 種語言</strong>
                    <label>語言<select aria-label={`第 ${index + 1} 種字幕語言`} value={track.language} onChange={(event) => patchSubtitleTrack(index, { language: event.target.value as SubtitleRenderLanguage })}>{SUBTITLE_LANGUAGES.map((language) => <option key={language.value} value={language.value} disabled={subtitleBurnIn.tracks.some((item, itemIndex) => itemIndex !== index && item.language === language.value)}>{language.label}</option>)}</select></label>
                    <label>位置<select aria-label={`第 ${index + 1} 種字幕位置`} value={track.position} onChange={(event) => patchSubtitleTrack(index, { position: event.target.value as SubtitleRenderPosition })}>{SUBTITLE_POSITIONS.map((position) => <option key={position.value} value={position.value}>{position.label}</option>)}</select></label>
                    <label>文字大小（1080p 基準）<input aria-label={`第 ${index + 1} 種字幕文字大小`} type="number" min="24" max="96" step="1" value={track.fontSize1080p} onChange={(event) => patchSubtitleTrack(index, { fontSize1080p: Math.max(24, Math.min(96, Number(event.target.value) || 24)) })} /><span>px</span></label>
                    {index === 1 && <button className="danger-text" type="button" onClick={() => updateSubtitleBurnIn({ ...subtitleBurnIn, tracks: subtitleBurnIn.tracks.slice(0, 1) })}>移除第二語言</button>}
                  </div>)}
                  {subtitleBurnIn.tracks.length < 2 && <button className="secondary-button" type="button" onClick={() => { const used = new Set(subtitleBurnIn.tracks.map((track) => track.language)); const language = SUBTITLE_LANGUAGES.find((item) => !used.has(item.value))?.value ?? "en"; updateSubtitleBurnIn({ ...subtitleBurnIn, tracks: [...subtitleBurnIn.tracks, { language, position: "TOP", fontSize1080p: 42 }] }); }}>＋ 加入第二種語言</button>}
                  <small>同時顯示兩種語言時可分別設定位置與大小；若選在相同位置，App 會自動分層避免互相覆蓋。</small>
                </div>}
              </section>}

              <section className="setting-block">
                <div><span className="setting-step">{isClip ? "02" : isIntro ? "04" : "05"}</span><div><h3>輸出位置</h3><p>自動沿用上一次指定的資料夾並產生不覆寫舊檔的名稱；只有按下此欄才另外指定。</p></div></div>
                <button className="output-picker" type="button" aria-label={`選擇儲存位置，${output?.automatic ? "目前為自動位置" : output ? "目前已另外指定" : "正在準備自動位置"}${output?.displayPath ? `：${output.displayPath}` : ""}`} disabled={rendering} onClick={() => void chooseOutput()}>
                  <span>{output?.automatic ? "自動位置" : output ? "已另外指定" : "正在準備"}</span>
                  <strong title={output?.displayPath}>{output?.displayPath ?? "正在依上次位置產生檔名…"}</strong>
                </button>
                <button className="secondary-button regenerate-output-button" type="button" disabled={rendering} onClick={() => void prepareAutomaticOutput()}>重新產生檔名</button>
              </section>

              {isMain && <section className="setting-block"><div><span className="setting-step">06</span><div><h3>片頭串接與上傳準備</h3><p>片頭可自動放在正片最前方；串接時必須先確認正片開始提示頁。輸出完成後可倒數 60 秒開啟 YouTube 最後確認頁。</p></div></div><div className="post-render-options"><label className={!introClips?.length ? "is-disabled" : ""}><input type="checkbox" checked={prependIntro} disabled={rendering || !introClips?.length} onChange={(event) => { const enabled = event.target.checked; setPrependIntro(enabled); setMainStartCardConfirmed(false); if (enabled) setShowMainStartCard(true); rememberRenderDefaults({ prependIntro: enabled }); }} /><span><strong>自動串接已確認片頭＋正片</strong><small>{introClips?.length ? `目前會在正片前加入 ${introClips.length} 段片頭；勾選後會強制設定 3–7 秒的正片開始提示頁。` : "目前沒有已確認的片頭；請先到 AI 精彩片頭頁建立。"}</small></span></label>{prependIntro && <div className="main-start-card-summary"><span>{mainStartCardConfirmed ? "✓ 已確認" : "尚未確認"} · {mainStartCard.durationSeconds} 秒 · 「{mainStartCard.line1}／{mainStartCard.line2}」</span><button className="secondary-button" type="button" disabled={rendering} onClick={() => setShowMainStartCard(true)}>設定提示頁</button></div>}<label><input type="checkbox" checked={autoUploadEnabled} disabled={rendering} onChange={(event) => { setAutoUploadEnabled(event.target.checked); setAutoUploadStatus(event.target.checked ? "ARMED" : "DISABLED"); rememberRenderDefaults({ autoUpload: event.target.checked }); }} /><span><strong>輸出後自動準備 YouTube 上傳</strong><small>沿用您上次的選擇。啟用時完成後倒數 60 秒；倒數結束仍需在最後頁確認頻道、標題及觀眾設定。</small></span></label></div></section>}

              {error && <div className="notice error concat-error" role="alert">{error}</div>}
              {rendering && (
                <section className="render-progress" aria-live="polite">
                  <div><strong>{progressLabel(progress)}</strong><span>{Math.round(progress?.percent ?? 0)}%</span></div>
                  <progress max="100" value={progress?.percent ?? 0} />
                  <small>可取消；若已有足夠畫面，App 會要求編碼器安全寫完 MP4 結尾並保留較短成品。太早取消、無法驗證播放時才會清除 partial。來源不受影響。</small>
                </section>
              )}

              <div className="concat-footer-actions">
                {rendering ? (
                  <button className="cancel-button render-cancel" type="button" disabled={cancelling} onClick={() => void cancelRender()}>{cancelling ? "正在取消…" : "取消產出"}</button>
                ) : (
                  <>
                    <button className="secondary-button" type="button" onClick={onClose}>返回</button>
                    <button className="primary-button" type="button" disabled={!output || renderItems.length < 1} onClick={() => void startRender()}>OK，開始產出</button>
                  </>
                )}
              </div>
            </div>

            <aside className="concat-order">
              <span className="eyebrow">CURRENT SORT ORDER</span>
              <h3>{renderItems.length} 個片段</h3>
              <p>{isIntro ? "輸出依照精彩建議頁目前的片段順序與 IN／OUT。" : isClip ? "輸出這一個固定來源時間段，並套用重疊於此時間內的局部放大設定。" : "輸出依照目前素材順序、影片 IN／OUT 與每張照片設定的 3–7 秒顯示時間。"}</p>
              {cappedIntroCount > 0 && (isIntro || (isMain && prependIntro)) && <p className="inline-notice" role="status">有 {cappedIntroCount} 段檢看片段超時；實際輸出會保留各段起點，並截取最多 {formatDuration(introSegmentMaxDurationMs)}。</p>}
              <ol>{renderItems.map((item, index) => <li key={item.key}><span>{String(index + 1).padStart(2, "0")}</span><div><strong title={item.fileName}>{item.fileName}</strong><small>{item.section === "INTRO" && !isIntro ? "片頭 · " : ""}{formatDuration(item.inMs)} → {formatDuration(item.outMs)}</small></div></li>)}</ol>
              {estimatedDurationMs !== undefined && <div className="estimate-line"><span>預估串連片長</span><strong>{formatDuration(estimatedDurationMs + (isMain && prependIntro ? mainStartCard.durationSeconds * 1000 + (mainStartCard.transitionStyle === "HARD_CUT" ? transitionSeconds * 1000 : -transitionSeconds * 1000) : 0))}</strong></div>}
              <div className="readonly-note"><span>●</span><div><strong>來源唯讀</strong><small>不改寫、不移動、不刪除來源</small></div></div>
              {!isClip && <div className="readonly-note"><span>♫</span><div><strong>混音保護</strong><small>片段原音＋BGM 分離控制，最終套用 0.95 peak limiter</small></div></div>}
            </aside>
          </div>
        )}
        <section className="inline-output-history" aria-label={historyTitle}>
          <div><span className="eyebrow">PREVIOUS PREVIEW FILES</span><h3>{historyTitle}</h3><p>點擊檔案名稱會交給目前設定的外部播放器；來源與成品檔都不會被修改。</p></div>
          {outputOpenError && <div className="notice error concat-error" role="alert">{outputOpenError}</div>}
          {!matchingOutputs.length ? <p className="inline-history-empty">目前沒有仍存在的同類型預覽檔。</p> : <ol>{matchingOutputs.map((item) => <li key={item.jobId}><div><button type="button" title={item.outputPath} onClick={() => { setOutputOpenError(undefined); void window.sourceApp.playConcatOutput(item.jobId).catch((reason: unknown) => setOutputOpenError(reason instanceof Error ? reason.message : String(reason))); }}>{item.fileName}</button><span>{new Date(item.createdAt).toLocaleString("zh-TW")} · {formatBytes(item.sizeBytes)}{item.resolution ? ` · ${item.resolution}` : ""}</span></div><nav aria-label={`${item.fileName} 檔案操作`}><button type="button" onClick={() => void window.sourceApp.revealConcatOutput(item.jobId).catch((reason: unknown) => setOutputOpenError(reason instanceof Error ? reason.message : String(reason)))}>開啟位置</button><button type="button" onClick={() => void window.sourceApp.copyPreviewOutputPath(item.jobId).catch((reason: unknown) => setOutputOpenError(reason instanceof Error ? reason.message : String(reason)))}>複製路徑</button></nav></li>)}</ol>}
        </section>
      </section>
      {showYoutubeUpload && result && isMain && (
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
      {showMainStartCard && isMain && prependIntro && <MainStartCardModal
        value={mainStartCard}
        backgroundFileName={renderItems.find((item) => item.section === "MAIN")?.fileName}
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
      />}
    </div>
  );
}
