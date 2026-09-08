import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AiAnalysisProgress, ConcatRenderProgress, PreviewResult, ProjectManifest, SubtitleCue, SubtitleCueReviewStatus, SubtitleGenerationScope, SubtitlePreviewResult, SubtitlePreviewStyle, SubtitleTimelineScope } from "../../shared/domain";
import { mainRenderSelections } from "../../shared/editing-rules";
import { formatDuration } from "../format";
import { SharedIntroPreviewHistory } from "./SharedIntroPreviewHistory";
import { TimecodeInput } from "./TimecodeInput";

interface Props {
  project: ProjectManifest;
  timelineDurationMs: number;
  onProjectUpdated(project: ProjectManifest): void;
  onOpenAiSettings(): void;
  onClose(): void;
}

const DEFAULT_SCOPE: SubtitleGenerationScope = { intro: false, main: true };
const DEFAULT_STYLE: SubtitlePreviewStyle = { verticalPositionPercent: 82, fontSizePx: 28, textColor: "#FFFFFF", shadowEnabled: true, outlineWidthPx: 2 };

function fileName(scopes: SubtitleTimelineScope[]) {
  const date = new Date();
  const label = scopes.length === 2 ? "intro_main" : scopes[0]?.toLowerCase() ?? "main";
  return `SceneryWalker_${label}_subtitles_${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}.srt`;
}

function statusLabel(status?: SubtitleCueReviewStatus): string {
  if (status === "DRAFT") return "待確認";
  if (status === "REJECTED") return "已排除";
  return "已確認";
}

function phaseLabel(progress?: AiAnalysisProgress): string {
  if (!progress || progress.phase === "PREPARING") return "正在準備所選片頭／正片時間線…";
  if (progress.phase === "EXTRACTING_AUDIO") return "正在建立短音訊衍生檔…";
  if (progress.phase === "TRANSCRIBING") return "正在辨識說話內容與時間…";
  if (progress.phase === "SAMPLING_FRAMES") return "正在建立低解析畫面故事板…";
  if (progress.phase === "MATCHING_STORY") return "正在比對人物、事件、地點與主題…";
  return "正在保存字幕…";
}

function previewPhaseLabel(progress?: ConcatRenderProgress): string {
  if (!progress || progress.phase === "PREPARING") return "正在準備 480P 片頭字幕預覽…";
  if (progress.phase === "FINALIZING") return "正在完成可播放 MP4 代理…";
  return "正在產生 480P 片頭字幕代理…";
}

function cueOrigin(cue: SubtitleCue): string {
  if (cue.origin === "AI_SPEECH") return "AI 語音＋畫面";
  if (cue.origin === "AI_VISUAL") return "AI 畫面情境";
  if (cue.origin === "IMPORTED_SRT") return "匯入 SRT";
  return "人工字幕";
}

function cueScope(cue: SubtitleCue): SubtitleTimelineScope { return cue.timelineScope ?? "MAIN"; }

function scopeNeedsReview(project: ProjectManifest, scope: SubtitleTimelineScope): boolean {
  const timelineRevision = scope === "INTRO" ? (project.introTimelineRevision ?? project.timelineRevision) : (project.mainTimelineRevision ?? project.timelineRevision);
  const reviewedRevision = scope === "INTRO" ? (project.introSubtitleReviewRevision ?? project.subtitleTimelineRevision) : (project.mainSubtitleReviewRevision ?? project.subtitleTimelineRevision);
  return timelineRevision !== reviewedRevision;
}

export function SubtitleStudio({ project, timelineDurationMs, onProjectUpdated, onOpenAiSettings, onClose }: Props) {
  const [cues, setCues] = useState<SubtitleCue[]>(() => {
    const timelineNeedsReview = project.subtitleCues.length > 0 && project.subtitleCues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
    return structuredClone(project.subtitleCues).map((cue) => timelineNeedsReview && cue.reviewStatus !== "REJECTED" ? { ...cue, reviewStatus: "DRAFT" as const } : cue);
  });
  const [scope, setScope] = useState<SubtitleGenerationScope>(DEFAULT_SCOPE);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitlePreviewStyle>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => project.subtitleCues[0]?.id);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(project.subtitleCues[0] ? [project.subtitleCues[0].id] : []));
  const selectionAnchorId = useRef<string | undefined>(project.subtitleCues[0]?.id);
  const [cursor, setCursor] = useState(0);
  const [preview, setPreview] = useState<PreviewResult>();
  const [introPreview, setIntroPreview] = useState<SubtitlePreviewResult>();
  const [useIntroTimelinePreview, setUseIntroTimelinePreview] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [progress, setProgress] = useState<AiAnalysisProgress>();
  const [previewProgress, setPreviewProgress] = useState<ConcatRenderProgress>();
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [includeSpeechTranscription, setIncludeSpeechTranscription] = useState(false);
  const [aiRegenerationMode, setAiRegenerationMode] = useState<"FILL_BLANKS" | "REPLACE_AI_SCOPE" | "PRESERVE_USER_EDITED">("FILL_BLANKS");
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [localDirty, setLocalDirty] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [previewHistoryRevision, setPreviewHistoryRevision] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selectedScopes = useMemo(() => ([...(scope.intro ? ["INTRO" as const] : []), ...(scope.main ? ["MAIN" as const] : [])]), [scope]);
  const introDurationMs = useMemo(() => project.introSegments.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0), [project.introSegments]);
  const introOpenAiCount = useMemo(() => project.introSegments.filter((clip) => clip.analysisMode === "OPENAI_STORY_MATCH").length, [project.introSegments]);
  const visibleCues = useMemo(() => cues.filter((cue) => selectedScopes.includes(cueScope(cue))), [cues, selectedScopes]);
  const selected = cues.find((cue) => cue.id === selectedId && selectedScopes.includes(cueScope(cue)));
  const selectedTimelineDurationMs = selected && cueScope(selected) === "INTRO" ? introDurationMs : scope.intro && !scope.main ? introDurationMs : timelineDurationMs;
  const needsReview = cues.length > 0 && cues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
  const counts = useMemo(() => ({
    draft: visibleCues.filter((cue) => cue.reviewStatus === "DRAFT").length,
    confirmed: visibleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED").length,
    rejected: visibleCues.filter((cue) => cue.reviewStatus === "REJECTED").length,
  }), [visibleCues]);

  const sourceSelection = useMemo(() => {
    if (!selected || useIntroTimelinePreview) return undefined;
    if (selected.sourceAssetId) {
      const asset = project.sources.find((item) => item.id === selected.sourceAssetId);
      if (asset?.kind === "VIDEO") return { asset, sourceStartMs: selected.sourceInMs ?? 0, sourceEndMs: selected.sourceOutMs ?? selected.sourceInMs ?? 0 };
    }
    const clips = cueScope(selected) === "INTRO"
      ? project.introSegments.map((clip) => ({ assetId: clip.assetId, inMs: clip.inMs, outMs: clip.outMs }))
      : mainRenderSelections(project);
    let offset = 0;
    for (const clip of clips) {
      const duration = clip.outMs - clip.inMs;
      if (selected.startMs < offset + duration) {
        const asset = project.sources.find((item) => item.id === clip.assetId);
        if (asset?.kind !== "VIDEO") return undefined;
        const sourceStartMs = clip.inMs + Math.max(0, selected.startMs - offset);
        return { asset, sourceStartMs, sourceEndMs: Math.min(clip.outMs, sourceStartMs + selected.endMs - selected.startMs) };
      }
      offset += duration;
    }
    return undefined;
  }, [project, selected, useIntroTimelinePreview]);

  const activeOverlayCue = useMemo(() => {
    if (useIntroTimelinePreview) return cues.find((cue) => cueScope(cue) === "INTRO" && cue.reviewStatus !== "REJECTED" && cue.startMs <= cursor && cue.endMs > cursor);
    return selected?.reviewStatus === "REJECTED" ? undefined : selected;
  }, [cues, cursor, selected, useIntroTimelinePreview]);

  useEffect(() => {
    window.sourceApp.onAiAnalysisProgress(setProgress);
    window.sourceApp.onSubtitlePreviewProgress(setPreviewProgress);
    void window.sourceApp.getUserPreferences().then((preferences) => {
      setScope(preferences.subtitleGenerationScope);
      setSubtitleStyle(preferences.subtitlePreviewStyle);
    }).catch(() => undefined);
    return () => { window.sourceApp.clearAiAnalysisProgressListeners(); window.sourceApp.clearSubtitlePreviewProgressListeners(); };
  }, []);

  useEffect(() => {
    if (!localDirty) {
      const needs = project.subtitleCues.length > 0 && project.subtitleCues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
      setCues(structuredClone(project.subtitleCues).map((cue) => needs && cue.reviewStatus !== "REJECTED" ? { ...cue, reviewStatus: "DRAFT" as const } : cue));
      setSelectedId(project.subtitleCues[0]?.id);
      setSelectedIds(project.subtitleCues[0] ? new Set([project.subtitleCues[0].id]) : new Set());
    } else if (project.updatedAt) {
      setNotice("專案在背景更新；目前未保存的字幕編輯仍保留，請保存或重新載入以採用外部版本。");
    }
  }, [project.id, project.subtitleCues, project.updatedAt]);

  useEffect(() => {
    if (selected) return;
    const first = visibleCues[0]; setSelectedId(first?.id); setSelectedIds(first ? new Set([first.id]) : new Set()); selectionAnchorId.current = first?.id; setCursor(first?.startMs ?? 0);
  }, [selected, visibleCues]);

  useEffect(() => {
    if (!sourceSelection) { setPreview(undefined); if (!useIntroTimelinePreview) setPreviewError(undefined); return; }
    let active = true; let completed = false;
    setPreview(undefined); setPreviewError(undefined);
    void window.sourceApp.ensurePreview(sourceSelection.asset.id, "VIDEO_PROXY").then((result) => {
      if (!active) return; completed = true; setPreview(result);
    }).catch((reason: unknown) => {
      if (!active || (reason instanceof Error && reason.name === "AbortError")) return;
      setPreviewError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; if (!completed) void window.sourceApp.cancelPreview(sourceSelection.asset.id, "VIDEO_PROXY"); };
  }, [sourceSelection?.asset.id, useIntroTimelinePreview]);

  const updateScope = (key: keyof SubtitleGenerationScope, checked: boolean) => {
    const next = { ...scope, [key]: checked };
    if (!next.intro && !next.main) { setError("片頭與正片至少需要勾選一項。"); return; }
    setError(undefined); setScope(next);
    if (!next.intro) setUseIntroTimelinePreview(false);
    void window.sourceApp.updateUserPreferences({ subtitleGenerationScope: next }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const patchCue = (id: string, field: "startMs" | "endMs" | "text", value: string | number) => {
    setLocalDirty(true);
    setCues((current) => current.map((cue) => cue.id === id ? { ...cue, userEdited: true, [field]: field === "text" ? value : Math.round(Number(value) * 1000) } : cue));
  };

  const setStatus = (id: string, reviewStatus: SubtitleCueReviewStatus) => {
    setCues((current) => current.map((cue) => cue.id === id ? { ...cue, reviewStatus } : cue));
    setNotice(reviewStatus === "CONFIRMED" ? "已標記為確認；請保存字幕以寫入專案。" : reviewStatus === "REJECTED" ? "已排除這筆草稿；不會匯出到 SRT。" : "已改回待確認草稿。");
  };

  const save = async (): Promise<boolean> => {
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(cues);
      onProjectUpdated(updated); setCues(updated.subtitleCues);
      setLocalDirty(false);
      setNotice("字幕與審核狀態已保存，並綁定目前 timeline revision。");
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { setBusy(false); }
  };
  const requestClose = () => { if (localDirty) setClosePrompt(true); else onClose(); };

  const buildIntroPreview = async () => {
    if (!project.introSegments.length) throw new Error("片頭目前沒有片段，無法建立 480P 字幕預覽。");
    setBuildingPreview(true); setPreviewProgress({ phase: "PREPARING", percent: 0, outTimeMs: 0, expectedDurationMs: introDurationMs }); setPreviewError(undefined);
    try {
      const result = await window.sourceApp.buildSubtitleIntroPreview(false);
      setIntroPreview(result); setUseIntroTimelinePreview(true); setCursor(0);
      setPreviewHistoryRevision((value) => value + 1);
      setNotice(`480P 片頭字幕代理已${result.cacheStatus === "HIT" ? "從快取載入" : "產生完成"}；播放時字幕會依時間同步顯示。`);
    } finally { setBuildingPreview(false); setPreviewProgress(undefined); }
  };

  const generate = async () => {
    if (!selectedScopes.length) { setError("請至少選擇片頭或正片。"); return; }
    setGenerating(true); setError(undefined); setNotice(undefined); setProgress({ phase: "PREPARING", processed: 0, total: 1 });
    try {
      const result = await window.sourceApp.generateAiSubtitles({ includeSpeechTranscription, scopes: selectedScopes, mode: aiRegenerationMode });
      onProjectUpdated(result.project); setCues(structuredClone(result.project.subtitleCues));
      setLocalDirty(false);
      const firstGenerated = result.project.subtitleCues.find((cue) => (cue.origin === "AI_SPEECH" || cue.origin === "AI_VISUAL") && selectedScopes.includes(cueScope(cue)));
      setSelectedId(firstGenerated?.id ?? result.project.subtitleCues.find((cue) => selectedScopes.includes(cueScope(cue)))?.id);
      setSelectedIds(firstGenerated ? new Set([firstGenerated.id]) : new Set());
      selectionAnchorId.current = firstGenerated?.id;
      setNotice(`已由「${result.accountName}」建立 ${result.generatedCount} 筆已確認字幕（知識型畫面 ${result.visualOnlyCount}、語音 ${result.transcribedCount}）。仍可逐項修改、取消確認或刪除。`);
      if (scope.intro) {
        try { await buildIntroPreview(); }
        catch (reason) { setPreviewError(`字幕草稿已建立，但 480P 片頭代理失敗：${reason instanceof Error ? reason.message : String(reason)}`); }
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("取消") || (reason instanceof Error && reason.name === "AbortError") ? "AI 字幕分析已取消；未完成的草稿不會寫入專案。" : message);
    } finally { setGenerating(false); setProgress(undefined); }
  };

  const saveStyle = async () => {
    setBusy(true); setError(undefined);
    try { const saved = await window.sourceApp.updateUserPreferences({ subtitlePreviewStyle: subtitleStyle }); setSubtitleStyle(saved.subtitlePreviewStyle); setNotice("字幕位置、大小、顏色、陰影與外框已保存為下次預設。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const exportFile = async () => {
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(cues); onProjectUpdated(updated); setCues(updated.subtitleCues);
      const output = await window.sourceApp.chooseSubtitleOutput(fileName(selectedScopes)); if (!output) return;
      setExporting(true); const result = await window.sourceApp.exportSubtitles(output.token, selectedScopes);
      setNotice(`已匯出 ${result.cueCount} 筆已確認 UTF-8 SRT：${result.outputPath}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); setExporting(false); }
  };

  const importFile = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (cues.length && !window.confirm("匯入 SRT 會加入所選字幕範圍並保留另一範圍；來源 SRT 不會被修改。是否繼續？")) return;
      const result = await window.sourceApp.chooseSubtitleInput(); if (!result) return;
      const targetScope: SubtitleTimelineScope = scope.intro && !scope.main ? "INTRO" : "MAIN";
      const retained = cues.filter((cue) => cueScope(cue) !== targetScope);
      const imported = result.cues.map((cue) => ({ ...cue, timelineScope: targetScope }));
      const updated = await window.sourceApp.setSubtitleCues([...retained, ...imported]);
      onProjectUpdated(updated); setCues(structuredClone(updated.subtitleCues)); setSelectedId(imported[0]?.id); setCursor(imported[0]?.startMs ?? 0);
      setNotice(`已匯入 ${result.fileName} 的 ${imported.length} 筆字幕（${targetScope === "INTRO" ? "片頭" : "正片"}）；可逐項修改時間與文字。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const add = () => {
    const timelineScope: SubtitleTimelineScope = scope.intro && !scope.main ? "INTRO" : selected ? cueScope(selected) : "MAIN";
    const durationMs = timelineScope === "INTRO" ? introDurationMs : timelineDurationMs;
    const start = Math.min(cursor, Math.max(0, durationMs - 100)); const end = Math.min(durationMs, start + 2_000);
    const cue: SubtitleCue = { id: crypto.randomUUID(), startMs: start, endMs: Math.max(start + 100, end), text: "新字幕", timelineScope, origin: "MANUAL", reviewStatus: "CONFIRMED" };
    setCues((current) => [...current, cue].sort((a, b) => cueScope(a).localeCompare(cueScope(b)) || a.startMs - b.startMs)); setSelectedId(cue.id);
  };

  const deleteSelectedCue = async () => {
    if (!selected || busy || generating || buildingPreview) return;
    if (!window.confirm(`刪除這筆${cueScope(selected) === "INTRO" ? "片頭" : "正片"}字幕？\n只會從專案字幕清單移除，不會刪除任何影片或代理檔。`)) return;
    const next = cues.filter((cue) => cue.id !== selected.id);
    const nextSelected = visibleCues.find((cue) => cue.id !== selected.id);
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(next);
      onProjectUpdated(updated); setCues(structuredClone(updated.subtitleCues)); setSelectedId(nextSelected?.id); setSelectedIds(nextSelected ? new Set([nextSelected.id]) : new Set()); selectionAnchorId.current = nextSelected?.id;
      setNotice("已刪除該筆字幕並保存；影片、照片與代理檔保持不變。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const cancelConfirmation = () => {
    if (!selectedIds.size || busy || generating || buildingPreview) return;
    setCues((current) => current.map((cue) => selectedIds.has(cue.id) ? { ...cue, reviewStatus: "DRAFT" as const } : cue));
    setNotice(`已取消 ${selectedIds.size} 筆字幕的確認狀態；內容仍保留，請保存字幕以寫入專案。`);
  };

  const deleteSelectedCues = async () => {
    if (!selectedIds.size || busy || generating || buildingPreview) return;
    if (!window.confirm(`刪除選取的 ${selectedIds.size} 筆字幕？\n只會從專案字幕清單移除，不會刪除任何影片或代理檔。`)) return;
    const next = cues.filter((cue) => !selectedIds.has(cue.id));
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(next);
      onProjectUpdated(updated); setCues(structuredClone(updated.subtitleCues));
      const nextSelected = updated.subtitleCues.find((cue) => selectedScopes.includes(cueScope(cue)));
      setSelectedId(nextSelected?.id); setSelectedIds(nextSelected ? new Set([nextSelected.id]) : new Set()); selectionAnchorId.current = nextSelected?.id;
      setNotice(`已刪除 ${selectedIds.size} 筆字幕並保存；影片、照片與代理檔保持不變。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || !selected) return;
      const target = event.target;
      if (target instanceof Element && target.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault(); void deleteSelectedCue();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected?.id, cues, busy, generating, buildingPreview]);

  const selectCue = (cue: SubtitleCue, event?: ReactMouseEvent<HTMLButtonElement>) => {
    const anchorIndex = selectionAnchorId.current ? visibleCues.findIndex((item) => item.id === selectionAnchorId.current) : -1;
    const currentIndex = visibleCues.findIndex((item) => item.id === cue.id);
    const nextIds = event?.shiftKey && anchorIndex >= 0 && currentIndex >= 0
      ? new Set(visibleCues.slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1).map((item) => item.id))
      : new Set([cue.id]);
    setSelectedIds(nextIds);
    if (!event?.shiftKey) selectionAnchorId.current = cue.id;
    setSelectedId(cue.id); setCursor(cue.startMs);
    const player = videoRef.current;
    if (player && useIntroTimelinePreview && cueScope(cue) === "INTRO") player.currentTime = cue.startMs / 1000;
  };

  const handleTimeUpdate = () => {
    const player = videoRef.current; if (!player) return;
    if (useIntroTimelinePreview && introPreview) {
      const nextCursor = Math.min(introPreview.durationMs, player.currentTime * 1000); setCursor(nextCursor);
      const active = cues.find((cue) => cueScope(cue) === "INTRO" && cue.reviewStatus !== "REJECTED" && cue.startMs <= nextCursor && cue.endMs > nextCursor);
      if (active && active.id !== selectedId) setSelectedId(active.id);
      return;
    }
    if (!selected || !sourceSelection) return;
    const sourceTimeMs = player.currentTime * 1000;
    setCursor(Math.min(selected.endMs, selected.startMs + Math.max(0, sourceTimeMs - sourceSelection.sourceStartMs)));
    if (sourceSelection.sourceEndMs > sourceSelection.sourceStartMs && sourceTimeMs >= sourceSelection.sourceEndMs) { player.pause(); player.currentTime = sourceSelection.sourceStartMs / 1000; }
  };

  const togglePlayback = () => { const player = videoRef.current; if (player) void (player.paused ? player.play() : Promise.resolve(player.pause())); };
  const displayedDurationMs = useIntroTimelinePreview && introPreview ? introPreview.durationMs : selectedTimelineDurationMs;
  const overlayStyle = { top: `${subtitleStyle.verticalPositionPercent}%`, color: subtitleStyle.textColor, fontSize: `${subtitleStyle.fontSizePx}px`, WebkitTextStroke: `${subtitleStyle.outlineWidthPx}px #000000`, textShadow: subtitleStyle.shadowEnabled ? "0 2px 4px #000, 0 0 8px #000" : "none" };
  const canGenerate = selectedScopes.some((item) => item === "INTRO" ? introDurationMs > 0 : timelineDurationMs > 0);

  return <div className="modal-backdrop studio-backdrop" role="presentation">
    <section className="editor-modal subtitle-modal subtitle-review-modal" role="dialog" aria-modal="true" aria-label="AI 字幕審核與 SRT">
    <header className="modal-header"><div><span className="eyebrow">AI SUBTITLE REVIEW · 480P SYNC PREVIEW</span><h2>片頭／正片畫面與故事字幕審核</h2><p>AI 新字幕預設已確認，可直接預覽；人工修改、時間與文字仍可逐項調整並保存。</p></div><button className="icon-button" onClick={requestClose} aria-label="關閉">×</button></header>
      {needsReview && <div className="subtitle-global-warning" role="alert">⚠ 片頭、正片順序或 IN／OUT 已改變；全部字幕時間需要重新複核。</div>}
      {generating && <div className="ai-analysis-progress" aria-live="polite"><span className="spinner"/><div><strong>{phaseLabel(progress)}</strong><small>{progress?.currentName ?? ""}</small><progress max={Math.max(1, progress?.total ?? 1)} value={progress?.processed ?? 0}/></div><span>{progress?.processed ?? 0} / {progress?.total ?? 0}</span><button className="cancel-button" onClick={() => void window.sourceApp.cancelAiSubtitles()}>取消</button></div>}
      {buildingPreview && <div className="subtitle-preview-progress" aria-live="polite"><span className="spinner"/><div><strong>{previewPhaseLabel(previewProgress)}</strong><progress max="100" value={previewProgress?.percent ?? 0}/></div><span>{Math.round(previewProgress?.percent ?? 0)}%</span><button className="cancel-button" onClick={() => void window.sourceApp.cancelSubtitleIntroPreview()}>取消代理</button></div>}
      {error && <section className="subtitle-ai-failure" role="alert"><div><strong>AI 字幕沒有產出</strong><p>{error}</p>{error.includes("credit_balance_exhausted") || error.includes("沒有可用 API 額度") ? <small>片頭代理成功只代表本機 MP4 已完成，不代表 OpenAI API 可用。新版會自動再試 Codex／ChatGPT 登入；若此處仍顯示錯誤，請依後半段訊息確認 Codex 是否已登入，或取消勾選語音分析後重試。</small> : null}</div><button className="settings-button" type="button" onClick={onOpenAiSettings}>開啟 AI 帳號設定</button></section>}
      <div className="subtitle-studio-toolbar">
        <div><span><strong>{counts.draft}</strong> 待確認</span><span><strong>{counts.confirmed}</strong> 已確認</span><span><strong>{counts.rejected}</strong> 已排除</span></div>
        <div className="subtitle-ai-actions"><fieldset className="subtitle-scope"><legend>產生／顯示範圍</legend><label><input aria-label="片頭字幕" type="checkbox" checked={scope.intro} disabled={!project.introSegments.length} onChange={(event) => updateScope("intro", event.target.checked)}/> 片頭</label><label><input aria-label="正片字幕" type="checkbox" checked={scope.main} disabled={timelineDurationMs <= 0} onChange={(event) => updateScope("main", event.target.checked)}/> 正片</label></fieldset><button className="secondary-button" type="button" disabled={generating || busy} onClick={() => void importFile()}>⇧ 匯入 SRT</button><label><input aria-label="同時分析素材語音" type="checkbox" checked={includeSpeechTranscription} onChange={(event) => setIncludeSpeechTranscription(event.target.checked)}/> 同時分析素材語音（預設不勾）</label><label className="ai-mode-select">AI 重跑方式<select aria-label="AI 字幕重跑方式" value={aiRegenerationMode} disabled={generating || busy} onChange={(event) => setAiRegenerationMode(event.target.value as typeof aiRegenerationMode)}><option value="FILL_BLANKS">填補空白（保留現有 AI）</option><option value="PRESERVE_USER_EDITED">保留人工修改（重建未修改 AI）</option><option value="REPLACE_AI_SCOPE">替換所選範圍 AI 字幕</option></select></label><button className="settings-button" type="button" onClick={onOpenAiSettings}>✦ AI 帳號／故事設定</button><button className="ai-intro-button" type="button" disabled={generating || buildingPreview || busy || !canGenerate} onClick={() => void generate()}>AI 知識型字幕草稿</button></div>
      </div>
      {scope.intro && project.introSegments.length > 0 && <div className={`subtitle-intro-ai-state ${introOpenAiCount ? "has-cloud-analysis" : "is-local-only"}`} role="status">片頭共 {project.introSegments.length} 段，其中 {introOpenAiCount} 段曾完成 OpenAI 人物／事件／故事比對。{introOpenAiCount === 0 ? "目前片頭挑選是本機畫面統計備援，不能視為 AI 連線成功。" : "字幕仍會重新依畫面與故事背景建立草稿。"}</div>}
      <div className="subtitle-review-layout">
        <aside className="subtitle-cue-list">
          {!visibleCues.length && <div className="empty-mini"><strong>所選範圍還沒有字幕</strong><p>可匯入 UTF-8 SRT、設定故事背景後建立 AI 草稿，或人工新增。</p></div>}
          {selectedIds.size > 0 && <div className="subtitle-selection-actions" role="toolbar" aria-label="字幕批次操作"><span>已選 {selectedIds.size} 筆</span><button type="button" disabled={busy || generating || buildingPreview} onClick={cancelConfirmation}>取消確認</button><button type="button" className="danger-text" disabled={busy || generating || buildingPreview} onClick={() => void deleteSelectedCues()}>刪除選取</button></div>}
          {visibleCues.map((cue, index) => <button type="button" key={cue.id} className={`${selectedIds.has(cue.id) ? "is-selected" : ""} status-${cue.reviewStatus ?? "CONFIRMED"}`} aria-pressed={selectedIds.has(cue.id)} onClick={(event) => selectCue(cue, event)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{cue.text}</strong><small>{cueScope(cue) === "INTRO" ? "片頭" : "正片"} · {formatDuration(cue.startMs)} → {formatDuration(cue.endMs)} · <span>{cueOrigin(cue)}</span></small></div><em>{statusLabel(cue.reviewStatus)}</em></button>)}
          <button className="add-cue-button" type="button" disabled={selectedTimelineDurationMs <= 0} onClick={add}>＋ 在 {formatDuration(cursor)} 新增人工字幕</button>
        </aside>
        <main className="subtitle-review-main">
          <section className="subtitle-video-stage">
            {useIntroTimelinePreview && introPreview && <video key={introPreview.url} ref={videoRef} src={introPreview.url} preload="auto" aria-label="480P 片頭字幕同步預覽" onClick={togglePlayback} onPlay={() => setPreviewPlaying(true)} onPause={() => setPreviewPlaying(false)} onTimeUpdate={handleTimeUpdate}/>} 
            {!useIntroTimelinePreview && !selected && <div className="large-loading"><p>從左側選取一筆字幕，或產生 480P 片頭預覽。</p></div>}
            {!useIntroTimelinePreview && selected && sourceSelection && !preview && !previewError && <div className="large-loading"><span className="spinner"/><p>正在準備唯讀 proxy 預覽…</p></div>}
            {previewError && <div className="preview-error"><strong>影像預覽提示</strong><p>{previewError}</p></div>}
            {!useIntroTimelinePreview && selected && !sourceSelection && <div className="large-loading"><p>這筆字幕尚無可直接播放的影片來源；片頭可先建立整體 480P 代理。</p></div>}
            {!useIntroTimelinePreview && selected && sourceSelection && preview && <video key={`${preview.url}:${selected.id}`} ref={videoRef} src={preview.url} preload="auto" aria-label="字幕等比例畫面預覽" onClick={togglePlayback} onLoadedMetadata={(event) => { event.currentTarget.currentTime = sourceSelection.sourceStartMs / 1000; }} onPlay={(event) => { setPreviewPlaying(true); const time = event.currentTarget.currentTime * 1000; if (time < sourceSelection.sourceStartMs || time >= sourceSelection.sourceEndMs) event.currentTarget.currentTime = sourceSelection.sourceStartMs / 1000; }} onPause={() => setPreviewPlaying(false)} onTimeUpdate={handleTimeUpdate}/>} 
            {activeOverlayCue && <div className="subtitle-overlay-preview" style={overlayStyle}>{activeOverlayCue.text}</div>}
          </section>
          <div className="subtitle-time-scrubber"><button type="button" disabled={!preview && !introPreview} onClick={togglePlayback}>{previewPlaying ? "❚❚ 暫停" : "▶ 播放"}</button><span>{useIntroTimelinePreview ? "片頭" : selected && cueScope(selected) === "INTRO" ? "片頭片段" : "正片"} {formatDuration(cursor)} / {formatDuration(displayedDurationMs)}</span><input aria-label="字幕預覽時間" type="range" min="0" max={Math.max(1, displayedDurationMs)} step="50" value={Math.min(cursor, displayedDurationMs)} onChange={(event) => { const value = Number(event.target.value); setCursor(value); const player = videoRef.current; if (player) player.currentTime = useIntroTimelinePreview ? value / 1000 : sourceSelection ? (sourceSelection.sourceStartMs + Math.max(0, value - (selected?.startMs ?? 0))) / 1000 : player.currentTime; }}/><div className="subtitle-preview-mode">{project.introSegments.length > 0 && <button type="button" disabled={buildingPreview || generating} onClick={() => introPreview ? setUseIntroTimelinePreview((current) => !current) : void buildIntroPreview().catch((reason: unknown) => setPreviewError(reason instanceof Error ? reason.message : String(reason)))}>{useIntroTimelinePreview ? "改看單筆來源" : introPreview ? "播放片頭 480P" : "建立片頭 480P"}</button>}</div></div>
          <section className="subtitle-style-panel" aria-label="字幕顯示格式"><label>高低位置 <input aria-label="字幕高低位置" type="range" min="10" max="92" value={subtitleStyle.verticalPositionPercent} onChange={(event) => setSubtitleStyle((current) => ({ ...current, verticalPositionPercent: Number(event.target.value) }))}/><span>{subtitleStyle.verticalPositionPercent}%</span></label><label>文字大小 <input aria-label="字幕文字大小" type="number" min="16" max="72" value={subtitleStyle.fontSizePx} onChange={(event) => setSubtitleStyle((current) => ({ ...current, fontSizePx: Number(event.target.value) }))}/><span>px</span></label><label>顏色 <input aria-label="字幕文字顏色" type="color" value={subtitleStyle.textColor} onChange={(event) => setSubtitleStyle((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))}/></label><label><input aria-label="字幕陰影" type="checkbox" checked={subtitleStyle.shadowEnabled} onChange={(event) => setSubtitleStyle((current) => ({ ...current, shadowEnabled: event.target.checked }))}/> 陰影</label><label>外框 <input aria-label="字幕外框寬度" type="number" min="0" max="8" value={subtitleStyle.outlineWidthPx} onChange={(event) => setSubtitleStyle((current) => ({ ...current, outlineWidthPx: Number(event.target.value) }))}/><span>px</span></label><button type="button" className="secondary-button" disabled={busy} onClick={() => void saveStyle()}>儲存顯示格式</button></section>
          {selected && <section className="cue-review-editor">
            <header><div><span className={`review-status status-${selected.reviewStatus ?? "CONFIRMED"}`}>{statusLabel(selected.reviewStatus)}</span><strong>{cueScope(selected) === "INTRO" ? "片頭" : "正片"} · {cueOrigin(selected)}</strong>{selected.speaker && <small>說話者：{selected.speaker}</small>}</div><button type="button" className="danger-text" disabled={busy || generating || buildingPreview} onClick={() => void deleteSelectedCue()}>刪除這筆（Delete）</button></header>
          <div className="cue-fields"><label>開始（分:秒.毫秒）<TimecodeInput label="字幕開始" valueMs={selected.startMs} maxMs={selectedTimelineDurationMs} onChange={(value) => patchCue(selected.id, "startMs", value / 1000)} /></label><label>結束（分:秒.毫秒）<TimecodeInput label="字幕結束" valueMs={selected.endMs} maxMs={selectedTimelineDurationMs} onChange={(value) => patchCue(selected.id, "endMs", value / 1000)} /></label><label className="cue-text-field">字幕文字<textarea value={selected.text} onChange={(event) => patchCue(selected.id, "text", event.target.value)}/></label></div>
            {(selected.visualSummary || selected.eventSummary || selected.peopleSummary?.length || selected.locationSummary?.length) && <div className="ai-evidence"><h3>AI 判斷依據（請人工核對）</h3><dl>{selected.visualSummary && <><dt>畫面</dt><dd>{selected.visualSummary}</dd></>}{selected.eventSummary && <><dt>事件</dt><dd>{selected.eventSummary}</dd></>}{selected.peopleSummary?.length ? <><dt>人物</dt><dd>{selected.peopleSummary.join("、")}</dd></> : null}{selected.locationSummary?.length ? <><dt>地點</dt><dd>{selected.locationSummary.join("、")}</dd></> : null}</dl><div className="ai-score-row"><span>主題相關 <strong>{selected.topicRelevanceScore ?? "–"}</strong></span><span>聲畫符合 <strong>{selected.transcriptVisualMatchScore ?? "–"}</strong></span><span>AI 信心 <strong>{selected.aiConfidence ?? "–"}</strong></span></div>{selected.aiWarnings?.length ? <ul>{selected.aiWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}</div>}
            <div className="cue-review-actions"><button type="button" className="reject-cue" onClick={() => setStatus(selected.id, "REJECTED")}>排除</button><button type="button" onClick={() => setStatus(selected.id, "DRAFT")}>改回待確認</button><button type="button" className="confirm-cue" onClick={() => setStatus(selected.id, "CONFIRMED")}>✓ 確認時間、畫面與文字</button></div>
          </section>}
        </main>
      </div>
      <SharedIntroPreviewHistory refreshKey={previewHistoryRevision} title="片頭頁／字幕頁共用預覽" />
      {notice && <div className="subtitle-result-notice" role="status">{notice}</div>}
      <footer className="settings-footer"><p>片頭與正片字幕使用各自時間基準；480P 只供同步檢視，來源保持唯讀且代理不可作正式 Master。</p><div>{exporting && <button className="cancel-button" onClick={() => void window.sourceApp.cancelSubtitleExport()}>取消匯出</button>}<button className="secondary-button" disabled={busy || generating || buildingPreview} onClick={() => void save()}>保存字幕</button><button className="primary-button" disabled={busy || generating || buildingPreview || !counts.confirmed} onClick={() => void exportFile()}>匯出 {counts.confirmed} 筆已確認 SRT</button></div></footer>
      {closePrompt && <div className="inline-close-guard" role="alertdialog" aria-label="字幕未保存"><strong>字幕有未保存修改</strong><p>要先保存再離開，還是放棄這次修改？</p><button className="primary-button" disabled={busy} onClick={async () => { if (await save()) { setClosePrompt(false); onClose(); } }}>保存並離開</button><button className="danger-secondary-button" disabled={busy} onClick={() => { setLocalDirty(false); setClosePrompt(false); onClose(); }}>放棄並離開</button><button className="secondary-button" disabled={busy} onClick={() => setClosePrompt(false)}>返回編輯</button></div>}
    </section>
  </div>;
}
