import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AiAnalysisProgress, ConcatRenderProgress, PreviewResult, ProjectManifest, SubtitleCue, SubtitleCueReviewStatus, SubtitleGenerationScope, SubtitlePreviewResult, SubtitlePreviewStyle, SubtitleTimelineScope } from "../../shared/domain";
import { buildTimelinePlan } from "../../shared/timeline-plan";
import { formatDuration } from "../format";
import { SharedIntroPreviewHistory } from "./SharedIntroPreviewHistory";
import { TimecodeInput } from "./TimecodeInput";
import { SafeDefaultButton } from "./SafeDefaultButton";

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

function overlappingCueIds(cues: SubtitleCue[]): Set<string> {
  const result = new Set<string>();
  for (const timelineScope of ["INTRO", "MAIN"] as const) {
    const scoped = cues.filter((cue) => cueScope(cue) === timelineScope && cue.reviewStatus !== "REJECTED").sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    for (let index = 0; index < scoped.length; index += 1) {
      for (let following = index + 1; following < scoped.length && scoped[following].startMs < scoped[index].endMs; following += 1) {
        if (Math.max(scoped[index].startMs, scoped[following].startMs) < Math.min(scoped[index].endMs, scoped[following].endMs)) {
          result.add(scoped[index].id); result.add(scoped[following].id);
        }
      }
    }
  }
  return result;
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
  const [targetCueCount, setTargetCueCount] = useState(100);
  const [aiRegenerationMode, setAiRegenerationMode] = useState<"FILL_BLANKS" | "REPLACE_AI_SCOPE" | "PRESERVE_USER_EDITED">("FILL_BLANKS");
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [localDirty, setLocalDirty] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [forceReviewPrompt, setForceReviewPrompt] = useState(false);
  const [reviewQueueIds, setReviewQueueIds] = useState<string[]>([]);
  const [previewHistoryRevision, setPreviewHistoryRevision] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selectedTextEditorRef = useRef<HTMLTextAreaElement>(null);
  const skipNextProjectSyncRef = useRef(false);
  const selectedScopes = useMemo(() => ([...(scope.intro ? ["INTRO" as const] : []), ...(scope.main ? ["MAIN" as const] : [])]), [scope]);
  const introDurationMs = useMemo(() => buildTimelinePlan({ ...project, timelineOrder: [] }, { includeIntro: true }).durationMs, [project]);
  const introOpenAiCount = useMemo(() => project.introSegments.filter((clip) => clip.analysisMode === "OPENAI_STORY_MATCH").length, [project.introSegments]);
  const visibleCues = useMemo(() => cues.filter((cue) => selectedScopes.includes(cueScope(cue))), [cues, selectedScopes]);
  const overlappingIds = useMemo(() => overlappingCueIds(visibleCues), [visibleCues]);
  const selected = cues.find((cue) => cue.id === selectedId && selectedScopes.includes(cueScope(cue)));
  const selectedTimelineDurationMs = selected && cueScope(selected) === "INTRO" ? introDurationMs : scope.intro && !scope.main ? introDurationMs : timelineDurationMs;
  const needsReview = cues.length > 0 && cues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
  const counts = useMemo(() => ({
    draft: visibleCues.filter((cue) => cue.reviewStatus === "DRAFT").length,
    confirmed: visibleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED").length,
    rejected: visibleCues.filter((cue) => cue.reviewStatus === "REJECTED").length,
  }), [visibleCues]);
  const reviewableVisibleCues = useMemo(() => visibleCues.filter((cue) => cue.reviewStatus !== "REJECTED"), [visibleCues]);
  const allVisibleConfirmed = reviewableVisibleCues.length > 0 && reviewableVisibleCues.every((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED");

  const sourceSelection = useMemo(() => {
    if (!selected || useIntroTimelinePreview) return undefined;
    const cueDurationMs = Math.max(100, selected.endMs - selected.startMs);
    if (selected.sourceAssetId) {
      const asset = project.sources.find((item) => item.id === selected.sourceAssetId);
      if (asset) {
        if (asset.kind === "IMAGE") return { asset, sourceStartMs: 0, sourceEndMs: asset.imageDurationMs ?? cueDurationMs };
        const durationMs = asset.mediaInfo?.durationMs ?? asset.previewRange?.outMs;
        const sourceStartMs = Math.max(0, Math.min(Math.max(0, (durationMs ?? selected.sourceInMs ?? 0) - 100), selected.sourceInMs ?? 0));
        const requestedEndMs = Math.max(sourceStartMs + 100, selected.sourceOutMs ?? sourceStartMs + cueDurationMs);
        const sourceEndMs = durationMs ? Math.min(durationMs, requestedEndMs) : requestedEndMs;
        if (sourceEndMs - sourceStartMs >= 100) return { asset, sourceStartMs, sourceEndMs };
      }
    }
    const plan = cueScope(selected) === "INTRO"
      ? buildTimelinePlan({ ...project, timelineOrder: [] }, { includeIntro: true })
      : buildTimelinePlan(project);
    const clip = plan.clips.filter((item) => selected.startMs >= item.outputStartMs && selected.startMs < item.outputEndMs).at(-1);
    if (clip) {
      const asset = project.sources.find((item) => item.id === clip.assetId);
      if (!asset) return undefined;
      if (asset.kind === "IMAGE") return { asset, sourceStartMs: 0, sourceEndMs: clip.outMs - clip.inMs };
      const sourceStartMs = Math.max(clip.inMs, Math.min(clip.outMs - 100, clip.inMs + selected.startMs - clip.outputStartMs));
      const sourceEndMs = Math.max(sourceStartMs + 100, Math.min(clip.outMs, sourceStartMs + cueDurationMs));
      return { asset, sourceStartMs, sourceEndMs };
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
    if (skipNextProjectSyncRef.current) {
      skipNextProjectSyncRef.current = false;
      return;
    }
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
    const task = sourceSelection.asset.kind === "VIDEO"
      ? window.sourceApp.ensureClipPreview(sourceSelection.asset.id, sourceSelection.sourceStartMs, sourceSelection.sourceEndMs)
      : window.sourceApp.ensurePreview(sourceSelection.asset.id, "IMAGE_PREVIEW");
    void task.then((result) => {
      if (!active) return; completed = true; setPreview(result);
    }).catch((reason: unknown) => {
      if (!active || (reason instanceof Error && reason.name === "AbortError")) return;
      setPreviewError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      if (!completed) {
        if (sourceSelection.asset.kind === "VIDEO") void window.sourceApp.cancelClipPreview(sourceSelection.asset.id, sourceSelection.sourceStartMs, sourceSelection.sourceEndMs);
        else void window.sourceApp.cancelPreview(sourceSelection.asset.id, "IMAGE_PREVIEW");
      }
    };
  }, [sourceSelection?.asset.id, sourceSelection?.asset.kind, sourceSelection?.sourceStartMs, sourceSelection?.sourceEndMs, useIntroTimelinePreview]);

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

  const persistCueList = async (nextCues: SubtitleCue[], successMessage: string): Promise<ProjectManifest | undefined> => {
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(nextCues);
      skipNextProjectSyncRef.current = true;
      onProjectUpdated(updated);
      setCues(structuredClone(updated.subtitleCues));
      setLocalDirty(false);
      setNotice(successMessage);
      return updated;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, reviewStatus: SubtitleCueReviewStatus): Promise<boolean> => {
    if (reviewStatus === "CONFIRMED" && overlappingIds.has(id)) {
      setError("這筆字幕仍與另一筆時間重疊；請先調整紅框字幕的開始／結束時間，再確認。");
      return false;
    }
    setError(undefined);
    setLocalDirty(true);
    const next = cues.map((cue) => cue.id === id ? { ...cue, reviewStatus } : cue);
    const message = reviewStatus === "CONFIRMED"
      ? "這筆字幕的文字、時間與確認狀態已立即保存。"
      : reviewStatus === "REJECTED"
        ? "已排除這筆字幕並立即保存；不會匯出到 SRT。"
        : "已改回待確認並立即保存。";
    return Boolean(await persistCueList(next, message));
  };

  const save = async (): Promise<boolean> => {
    return Boolean(await persistCueList(cues, "所有尚未確認的文字／時間修改已保存，並綁定目前 timeline revision。"));
  };
  const requestClose = () => { if (localDirty) setClosePrompt(true); else onClose(); };

  const requestForceReReview = () => {
    if (localDirty) {
      setError("目前有尚未保存的字幕修改；請先保存，再執行強制重新校對。");
      return;
    }
    setError(undefined);
    setForceReviewPrompt(true);
  };

  const forceReReview = async () => {
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.forceSubtitleReReview(selectedScopes);
      const nextCues = structuredClone(updated.subtitleCues);
      const reviewIds = nextCues.filter((cue) => selectedScopes.includes(cueScope(cue)) && cue.reviewStatus !== "REJECTED").map((cue) => cue.id);
      const first = nextCues.find((cue) => cue.id === reviewIds[0]);
      onProjectUpdated(updated);
      setCues(nextCues);
      setSelectedId(first?.id);
      setSelectedIds(first ? new Set([first.id]) : new Set());
      selectionAnchorId.current = first?.id;
      setCursor(first?.startMs ?? 0);
      setUseIntroTimelinePreview(false);
      setReviewQueueIds(reviewIds);
      setLocalDirty(false);
      setForceReviewPrompt(false);
      setNotice(`已依目前片頭／正片順序、IN／OUT 與 ${updated.timelineTransitionSeconds} 秒疊化重新對位 ${reviewIds.length} 筆字幕；現在從第 1 筆開始逐筆核對 Proxy 畫面。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectReviewCue = (id: string) => {
    const cue = cues.find((item) => item.id === id);
    if (!cue) return;
    setSelectedId(cue.id);
    setSelectedIds(new Set([cue.id]));
    selectionAnchorId.current = cue.id;
    setCursor(cue.startMs);
    setUseIntroTimelinePreview(false);
  };

  const advanceReview = () => {
    const currentIndex = reviewQueueIds.indexOf(selectedId ?? "");
    const nextId = reviewQueueIds[currentIndex >= 0 ? currentIndex + 1 : 0];
    if (nextId) selectReviewCue(nextId);
    else {
      setReviewQueueIds([]);
      setNotice("已完成這一輪逐筆畫面校對；每筆確認都已即時保存。 ");
    }
  };

  const confirmReviewAndAdvance = async () => {
    if (!selected) return;
    if (overlappingIds.has(selected.id)) {
      setError("這筆字幕仍與另一筆時間重疊；請先調整紅框字幕，再標記畫面一致。");
      return;
    }
    if (await setStatus(selected.id, "CONFIRMED")) advanceReview();
  };

  const editReviewCue = () => {
    if (!selected) return;
    setLocalDirty(true);
    setCues((current) => current.map((cue) => cue.id === selected.id ? { ...cue, reviewStatus: "DRAFT" as const, userEdited: true } : cue));
    setNotice("這筆先保持待確認；請直接修改下方文字或頭尾時間，完成後按「修改完成，確認並下一筆」。");
    window.setTimeout(() => { selectedTextEditorRef.current?.focus(); selectedTextEditorRef.current?.select(); }, 0);
  };

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
      const result = await window.sourceApp.generateAiSubtitles({ includeSpeechTranscription, scopes: selectedScopes, mode: aiRegenerationMode, targetCueCount });
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
    setLocalDirty(true);
    setCues((current) => [...current, cue].sort((a, b) => cueScope(a).localeCompare(cueScope(b)) || a.startMs - b.startMs)); setSelectedId(cue.id);
  };

  const deleteCueIds = async (ids: Set<string>, label: string) => {
    if (!ids.size || busy || generating || buildingPreview) return;
    if (!window.confirm(`刪除${label}？\n只會從專案字幕清單移除，不會刪除任何影片或代理檔。`)) return;
    const next = cues.filter((cue) => !ids.has(cue.id));
    const nextSelected = visibleCues.find((cue) => !ids.has(cue.id));
    setBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(next);
      onProjectUpdated(updated); setCues(structuredClone(updated.subtitleCues)); setSelectedId(nextSelected?.id); setSelectedIds(nextSelected ? new Set([nextSelected.id]) : new Set()); selectionAnchorId.current = nextSelected?.id;
      setNotice(`${ids.size === 1 ? "已刪除該筆字幕" : `已刪除${label}`}並保存；影片、照片與代理檔保持不變。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const deleteSelectedCue = async () => {
    if (!selected) return;
    await deleteCueIds(new Set([selected.id]), `這筆${cueScope(selected) === "INTRO" ? "片頭" : "正片"}字幕`);
  };

  const cancelConfirmation = async () => {
    if (!selectedIds.size || busy || generating || buildingPreview) return;
    setLocalDirty(true);
    const next = cues.map((cue) => selectedIds.has(cue.id) ? { ...cue, reviewStatus: "DRAFT" as const } : cue);
    await persistCueList(next, `已取消 ${selectedIds.size} 筆字幕的確認狀態並立即保存；內容仍保留。`);
  };

  const confirmSelected = async () => {
    if (!selectedIds.size || busy || generating || buildingPreview) return;
    const blocked = [...selectedIds].filter((id) => overlappingIds.has(id));
    setLocalDirty(true);
    const next = cues.map((cue) => selectedIds.has(cue.id) && !overlappingIds.has(cue.id) ? { ...cue, reviewStatus: "CONFIRMED" as const } : cue);
    await persistCueList(next, blocked.length ? `已確認並保存 ${selectedIds.size - blocked.length} 筆；另有 ${blocked.length} 筆仍重疊並保持待確認。` : `已確認並立即保存 ${selectedIds.size} 筆字幕。`);
  };

  const toggleAllConfirmation = async () => {
    if (!reviewableVisibleCues.length || busy || generating || buildingPreview) return;
    const nextStatus: SubtitleCueReviewStatus = allVisibleConfirmed ? "DRAFT" : "CONFIRMED";
    setLocalDirty(true);
    const next = cues.map((cue) => reviewableVisibleCues.some((visible) => visible.id === cue.id) && (nextStatus !== "CONFIRMED" || !overlappingIds.has(cue.id)) ? { ...cue, reviewStatus: nextStatus } : cue);
    await persistCueList(next, nextStatus === "CONFIRMED" ? overlappingIds.size ? `已確認並保存所有未重疊字幕；${overlappingIds.size} 筆紅框字幕保持待確認。` : `已全部確認並立即保存目前範圍的 ${reviewableVisibleCues.length} 筆字幕。` : `已全部取消確認並立即保存目前範圍的 ${reviewableVisibleCues.length} 筆字幕。`);
  };

  const moveCueAndSave = async (id: string, direction: -1 | 1) => {
    if (busy || generating || buildingPreview) return;
    const currentCue = cues.find((cue) => cue.id === id);
    if (!currentCue) return;
    if (currentCue.reviewStatus === "REJECTED") return;
    const scoped = visibleCues.filter((cue) => cueScope(cue) === cueScope(currentCue) && cue.reviewStatus !== "REJECTED");
    const currentIndex = scoped.findIndex((cue) => cue.id === id);
    const neighbor = scoped[currentIndex + direction];
    if (!neighbor) return;
    const placement = (cue: SubtitleCue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      sourceAssetId: cue.sourceAssetId,
      sourceInMs: cue.sourceInMs,
      sourceOutMs: cue.sourceOutMs,
    });
    const currentPlacement = placement(currentCue);
    const neighborPlacement = placement(neighbor);
    const next = cues.map((cue) => cue.id === currentCue.id
      ? { ...cue, ...neighborPlacement, reviewStatus: "DRAFT" as const, userEdited: true }
      : cue.id === neighbor.id
        ? { ...cue, ...currentPlacement, reviewStatus: "DRAFT" as const, userEdited: true }
        : cue);
    setLocalDirty(true);
    const updated = await persistCueList(next, `已將這筆字幕${direction < 0 ? "上移" : "下移"}到相鄰時間位置並立即保存；交換位置的兩筆已改回待確認。`);
    if (!updated) return;
    const moved = updated.subtitleCues.find((cue) => cue.id === id);
    setSelectedId(id);
    setSelectedIds(new Set([id]));
    selectionAnchorId.current = id;
    setCursor(moved?.startMs ?? 0);
  };

  const deleteSelectedCues = async () => {
    await deleteCueIds(selectedIds, `選取的 ${selectedIds.size} 筆字幕`);
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
    const previewSourceStartMs = preview?.variant === "VIDEO_CLIP_PROXY" ? (preview.sourceStartMs ?? sourceSelection.sourceStartMs) : 0;
    const sourceTimeMs = previewSourceStartMs + player.currentTime * 1000;
    setCursor(Math.min(selected.endMs, selected.startMs + Math.max(0, sourceTimeMs - sourceSelection.sourceStartMs)));
    if (sourceSelection.sourceEndMs > sourceSelection.sourceStartMs && sourceTimeMs >= sourceSelection.sourceEndMs) { player.pause(); player.currentTime = Math.max(0, (sourceSelection.sourceStartMs - previewSourceStartMs) / 1000); }
  };

  const togglePlayback = () => { const player = videoRef.current; if (player) void (player.paused ? player.play() : Promise.resolve(player.pause())); };
  const displayedDurationMs = useIntroTimelinePreview && introPreview ? introPreview.durationMs : selectedTimelineDurationMs;
  const scrubberMinimumMs = useIntroTimelinePreview ? 0 : selected?.startMs ?? 0;
  const scrubberMaximumMs = useIntroTimelinePreview ? displayedDurationMs : selected?.endMs ?? displayedDurationMs;
  const previewCanvasUnit = 100 / 480;
  const overlayStyle = {
    top: `${subtitleStyle.verticalPositionPercent}%`,
    color: subtitleStyle.textColor,
    fontSize: `${subtitleStyle.fontSizePx * previewCanvasUnit}cqh`,
    WebkitTextStroke: `${subtitleStyle.outlineWidthPx * previewCanvasUnit}cqh #000000`,
    textShadow: subtitleStyle.shadowEnabled
      ? `0 ${2 * previewCanvasUnit}cqh ${4 * previewCanvasUnit}cqh #000, 0 0 ${8 * previewCanvasUnit}cqh #000`
      : "none",
  };
  const canGenerate = selectedScopes.some((item) => item === "INTRO" ? introDurationMs > 0 : timelineDurationMs > 0);

  return <div className="modal-backdrop studio-backdrop" role="presentation">
    <section className="editor-modal subtitle-modal subtitle-review-modal" role="dialog" aria-modal="true" aria-label="AI 字幕審核與 SRT">
    <header className="modal-header"><div><span className="eyebrow">AI SUBTITLE REVIEW · 480P SYNC PREVIEW</span><h2>片頭／正片畫面與故事字幕審核</h2><p>AI 新字幕預設已確認，可直接預覽；素材換序或插入時會依目前 {project.timelineTransitionSeconds} 秒疊化同步搬移字幕，仍可逐項修改。</p></div><button className="icon-button" onClick={requestClose} aria-label="關閉">×</button></header>
      {needsReview && <div className="subtitle-global-warning" role="alert">⚠ 片頭、正片順序或 IN／OUT 已改變；全部字幕時間需要重新複核。</div>}
      {generating && <div className="ai-analysis-progress" aria-live="polite"><span className="spinner"/><div><strong>{phaseLabel(progress)}</strong><small>{progress?.currentName ?? ""}</small><progress max={Math.max(1, progress?.total ?? 1)} value={progress?.processed ?? 0}/></div><span>{progress?.processed ?? 0} / {progress?.total ?? 0}</span><button className="cancel-button" onClick={() => void window.sourceApp.cancelAiSubtitles()}>取消</button></div>}
      {buildingPreview && <div className="subtitle-preview-progress" aria-live="polite"><span className="spinner"/><div><strong>{previewPhaseLabel(previewProgress)}</strong><progress max="100" value={previewProgress?.percent ?? 0}/></div><span>{Math.round(previewProgress?.percent ?? 0)}%</span><button className="cancel-button" onClick={() => void window.sourceApp.cancelSubtitleIntroPreview()}>取消代理</button></div>}
      {error && <section className="subtitle-ai-failure" role="alert"><div><strong>AI 字幕沒有產出</strong><p>{error}</p>{error.includes("credit_balance_exhausted") || error.includes("沒有可用 API 額度") ? <small>片頭代理成功只代表本機 MP4 已完成，不代表 OpenAI API 可用。新版會自動再試 Codex／ChatGPT 登入；若此處仍顯示錯誤，請依後半段訊息確認 Codex 是否已登入，或取消勾選語音分析後重試。</small> : null}</div><button className="settings-button" type="button" onClick={onOpenAiSettings}>開啟 AI 帳號設定</button></section>}
      <div className="subtitle-studio-toolbar">
        <div><span><strong>{counts.draft}</strong> 待確認</span><span><strong>{counts.confirmed}</strong> 已確認</span><span><strong>{counts.rejected}</strong> 已排除</span></div>
        <div className="subtitle-ai-actions"><fieldset className="subtitle-scope"><legend>產生／顯示範圍</legend><label><input aria-label="片頭字幕" type="checkbox" checked={scope.intro} disabled={!project.introSegments.length} onChange={(event) => updateScope("intro", event.target.checked)}/> 片頭</label><label><input aria-label="正片字幕" type="checkbox" checked={scope.main} disabled={timelineDurationMs <= 0} onChange={(event) => updateScope("main", event.target.checked)}/> 正片</label></fieldset><button className="secondary-button" type="button" disabled={generating || busy} onClick={() => void importFile()}>⇧ 匯入 SRT</button><button className="secondary-button force-subtitle-review-button" type="button" disabled={generating || buildingPreview || busy || !reviewableVisibleCues.length} onClick={requestForceReReview}>↻ 強制重新校對</button><label><input aria-label="同時分析素材語音" type="checkbox" checked={includeSpeechTranscription} onChange={(event) => setIncludeSpeechTranscription(event.target.checked)}/> 同時分析素材語音（預設不勾）</label><label className="ai-cue-count">目標字幕數<input aria-label="AI 目標字幕數" type="number" min="1" max="300" value={targetCueCount} disabled={generating || busy} onChange={(event) => setTargetCueCount(Math.max(1, Math.min(300, Math.round(Number(event.target.value) || 1))))}/><small>1–300；較長片段會增加取樣點，實際數量仍受片長及既有字幕影響。</small></label><label className="ai-mode-select">AI 重跑方式<select aria-label="AI 字幕重跑方式" value={aiRegenerationMode} disabled={generating || busy} onChange={(event) => setAiRegenerationMode(event.target.value as typeof aiRegenerationMode)}><option value="FILL_BLANKS">填補空白（保留現有 AI）</option><option value="PRESERVE_USER_EDITED">保留人工修改（重建未修改 AI）</option><option value="REPLACE_AI_SCOPE">替換所選範圍 AI 字幕</option></select></label><button className="settings-button" type="button" onClick={onOpenAiSettings}>✦ AI 帳號／故事設定</button><button className="ai-intro-button" type="button" disabled={generating || buildingPreview || busy || !canGenerate} onClick={() => void generate()}>AI 知識型字幕草稿</button></div>
      </div>
      {overlappingIds.size > 0 && <div className="subtitle-overlap-warning" role="alert">⚠ 有 {overlappingIds.size} 筆新舊字幕時間重疊，兩筆都會顯示紅色外框。請調整開始／結束時間，紅框消失後再確認。</div>}
      {reviewQueueIds.length > 0 && selected && reviewQueueIds.includes(selected.id) && <section className="subtitle-guided-review" aria-label="逐筆 Proxy 字幕校對" aria-live="polite"><div><span className="eyebrow">FORCED TIMELINE REVIEW</span><strong>第 {reviewQueueIds.indexOf(selected.id) + 1}／{reviewQueueIds.length} 筆：這個 Proxy 畫面、字幕文字與頭尾時間是否一致？</strong><p>已先依目前片頭／正片主軸與疊化時間重新對位；按下確認後會立即保存，再進到下一筆。</p></div><nav><button className="confirm-cue" type="button" disabled={!preview || busy} onClick={() => void confirmReviewAndAdvance()}>✓ 一致，確認、保存並下一筆</button><button type="button" disabled={busy} onClick={editReviewCue}>不一致，修改文字／時間</button><button type="button" disabled={busy} onClick={advanceReview}>暫時略過</button><button className="secondary-button" type="button" onClick={() => setReviewQueueIds([])}>結束逐筆校對</button></nav></section>}
      {scope.intro && project.introSegments.length > 0 && <div className={`subtitle-intro-ai-state ${introOpenAiCount ? "has-cloud-analysis" : "is-local-only"}`} role="status">片頭共 {project.introSegments.length} 段，其中 {introOpenAiCount} 段曾完成 OpenAI 人物／事件／故事比對。{introOpenAiCount === 0 ? "目前片頭挑選是本機畫面統計備援，不能視為 AI 連線成功。" : "字幕仍會重新依畫面與故事背景建立草稿。"}</div>}
      <div className="subtitle-review-layout">
        <aside className="subtitle-cue-list">
          {!visibleCues.length && <div className="empty-mini"><strong>所選範圍還沒有字幕</strong><p>可匯入 UTF-8 SRT、設定故事背景後建立 AI 草稿，或人工新增。</p></div>}
          {reviewableVisibleCues.length > 0 && <div className="subtitle-selection-actions subtitle-global-actions" role="toolbar" aria-label="字幕全部操作"><span>目前範圍 {reviewableVisibleCues.length} 筆</span><button type="button" disabled={busy || generating || buildingPreview} onClick={() => void toggleAllConfirmation()}>{allVisibleConfirmed ? "全部取消確認並保存" : "全部確認並保存"}</button></div>}
          {selectedIds.size > 0 && <div className="subtitle-selection-actions" role="toolbar" aria-label="字幕批次操作"><span>已選 {selectedIds.size} 筆</span><button type="button" disabled={busy || generating || buildingPreview} onClick={() => void confirmSelected()}>確認選取並保存</button><button type="button" disabled={busy || generating || buildingPreview} onClick={() => void cancelConfirmation()}>取消確認並保存</button><button type="button" className="danger-text" disabled={busy || generating || buildingPreview} onClick={() => void deleteSelectedCues()}>刪除選取</button></div>}
          {visibleCues.map((cue, index) => {
            const movable = cue.reviewStatus !== "REJECTED";
            const scoped = visibleCues.filter((item) => cueScope(item) === cueScope(cue) && item.reviewStatus !== "REJECTED");
            const scopedIndex = scoped.findIndex((item) => item.id === cue.id);
            const disabled = busy || generating || buildingPreview;
            return <div className={`subtitle-cue-row ${overlappingIds.has(cue.id) ? "has-time-overlap" : ""}`} key={cue.id}>
              <div className={`subtitle-cue-card ${selectedIds.has(cue.id) ? "is-selected" : ""} status-${cue.reviewStatus ?? "CONFIRMED"}`}>
                <button type="button" className="subtitle-cue-select" aria-label={`選取字幕 ${cue.text}`} aria-pressed={selectedIds.has(cue.id)} title="點一下選取；按住 Shift 可連續複選" onClick={(event) => selectCue(cue, event)}><span>{String(index + 1).padStart(2, "0")}</span></button>
                <textarea className="subtitle-cue-inline-editor" aria-label={`直接編輯第 ${index + 1} 筆字幕`} value={cue.text} disabled={disabled} spellCheck title="點入後可直接定位文字游標並修改；按右側確認才會立即保存這筆內容。" onFocus={() => { if (selectedId !== cue.id) selectCue(cue); }} onChange={(event) => patchCue(cue.id, "text", event.target.value)} />
                <em>{overlappingIds.has(cue.id) ? "時間重疊" : statusLabel(cue.reviewStatus)}</em>
                <small>{cueScope(cue) === "INTRO" ? "片頭" : "正片"} · {formatDuration(cue.startMs)} → {formatDuration(cue.endMs)} · <span>{cueOrigin(cue)}</span></small>
              </div>
              <div className="subtitle-cue-row-actions" role="group" aria-label={`第 ${index + 1} 筆字幕操作`}>
                <button type="button" className="subtitle-cue-row-confirm" aria-label={`確認並保存第 ${index + 1} 筆字幕`} disabled={disabled || overlappingIds.has(cue.id)} onClick={() => void setStatus(cue.id, "CONFIRMED")}>✓ 確認</button>
                <button type="button" aria-label={`上移第 ${index + 1} 筆字幕`} title="交換到上一筆的時間位置；兩筆會改回待確認並立即保存。" disabled={disabled || !movable || scopedIndex <= 0} onClick={() => void moveCueAndSave(cue.id, -1)}>↑ 上移</button>
                <button type="button" aria-label={`下移第 ${index + 1} 筆字幕`} title="交換到下一筆的時間位置；兩筆會改回待確認並立即保存。" disabled={disabled || !movable || scopedIndex >= scoped.length - 1} onClick={() => void moveCueAndSave(cue.id, 1)}>↓ 下移</button>
                <button type="button" className="subtitle-cue-row-delete danger-text" aria-label="刪除這筆字幕" title={`刪除字幕：${cue.text}`} disabled={disabled} onClick={() => void deleteCueIds(new Set([cue.id]), `這筆${cueScope(cue) === "INTRO" ? "片頭" : "正片"}字幕`)}>刪除</button>
              </div>
            </div>;
          })}
          <button className="add-cue-button" type="button" disabled={selectedTimelineDurationMs <= 0} onClick={add}>＋ 在 {formatDuration(cursor)} 新增人工字幕</button>
        </aside>
        <main className="subtitle-review-main">
          <section className="subtitle-video-stage">
            {useIntroTimelinePreview && introPreview && <video key={introPreview.url} ref={videoRef} src={introPreview.url} preload="auto" aria-label="480P 片頭字幕同步預覽" onClick={togglePlayback} onPlay={() => setPreviewPlaying(true)} onPause={() => setPreviewPlaying(false)} onTimeUpdate={handleTimeUpdate}/>} 
            {!useIntroTimelinePreview && !selected && <div className="large-loading"><p>從左側選取一筆字幕，或產生 480P 片頭預覽。</p></div>}
            {!useIntroTimelinePreview && selected && sourceSelection && !preview && !previewError && <div className="large-loading"><span className="spinner"/><p>正在準備唯讀 proxy 預覽…</p></div>}
            {previewError && <div className="preview-error"><strong>影像預覽提示</strong><p>{previewError}</p></div>}
            {!useIntroTimelinePreview && selected && !sourceSelection && <div className="large-loading"><p>這筆字幕尚無可直接播放的影片來源；片頭可先建立整體 480P 代理。</p></div>}
            {!useIntroTimelinePreview && selected && sourceSelection?.asset.kind === "IMAGE" && preview && <img className="subtitle-source-image" src={preview.url} alt={`字幕對應畫面 ${sourceSelection.asset.fileName}`} />}
            {!useIntroTimelinePreview && selected && sourceSelection?.asset.kind === "VIDEO" && preview && <video key={`${preview.url}:${selected.id}`} ref={videoRef} src={preview.url} preload="auto" aria-label="字幕快速區段 Proxy 預覽" onClick={togglePlayback} onLoadedMetadata={(event) => { const previewStartMs = preview.variant === "VIDEO_CLIP_PROXY" ? (preview.sourceStartMs ?? sourceSelection.sourceStartMs) : 0; event.currentTarget.currentTime = Math.max(0, (sourceSelection.sourceStartMs - previewStartMs) / 1000); }} onPlay={(event) => { setPreviewPlaying(true); const previewStartMs = preview.variant === "VIDEO_CLIP_PROXY" ? (preview.sourceStartMs ?? sourceSelection.sourceStartMs) : 0; const sourceTimeMs = previewStartMs + event.currentTarget.currentTime * 1000; if (sourceTimeMs < sourceSelection.sourceStartMs || sourceTimeMs >= sourceSelection.sourceEndMs) event.currentTarget.currentTime = Math.max(0, (sourceSelection.sourceStartMs - previewStartMs) / 1000); }} onPause={() => setPreviewPlaying(false)} onTimeUpdate={handleTimeUpdate}/>
            {activeOverlayCue && <div className="subtitle-overlay-preview" style={overlayStyle}>{activeOverlayCue.text}</div>}
          </section>
          <div className="subtitle-time-scrubber"><button type="button" disabled={sourceSelection?.asset.kind === "IMAGE" || (!preview && !introPreview)} onClick={togglePlayback}>{previewPlaying ? "❚❚ 暫停" : "▶ 播放"}</button><span>{useIntroTimelinePreview ? "片頭" : selected && cueScope(selected) === "INTRO" ? "片頭片段" : "正片"} {formatDuration(cursor)} / {formatDuration(displayedDurationMs)}</span><input aria-label="字幕預覽時間" type="range" min={scrubberMinimumMs} max={Math.max(scrubberMinimumMs + 1, scrubberMaximumMs)} step="50" value={Math.max(scrubberMinimumMs, Math.min(cursor, scrubberMaximumMs))} onChange={(event) => { const value = Number(event.target.value); setCursor(value); const player = videoRef.current; if (player) { const previewStartMs = preview?.variant === "VIDEO_CLIP_PROXY" ? (preview.sourceStartMs ?? sourceSelection?.sourceStartMs ?? 0) : 0; player.currentTime = useIntroTimelinePreview ? value / 1000 : sourceSelection ? Math.max(0, (sourceSelection.sourceStartMs + Math.max(0, value - (selected?.startMs ?? 0)) - previewStartMs) / 1000) : player.currentTime; } }}/><div className="subtitle-preview-mode">{project.introSegments.length > 0 && <button type="button" disabled={buildingPreview || generating} onClick={() => introPreview ? setUseIntroTimelinePreview((current) => !current) : void buildIntroPreview().catch((reason: unknown) => setPreviewError(reason instanceof Error ? reason.message : String(reason)))}>{useIntroTimelinePreview ? "改看單筆來源" : introPreview ? "播放片頭 480P" : "建立片頭 480P"}</button>}</div></div>
          <section className="subtitle-style-panel" aria-label="字幕顯示格式"><label>高低位置 <input aria-label="字幕高低位置" type="range" min="10" max="92" value={subtitleStyle.verticalPositionPercent} onChange={(event) => setSubtitleStyle((current) => ({ ...current, verticalPositionPercent: Number(event.target.value) }))}/><span>{subtitleStyle.verticalPositionPercent}%</span></label><label>文字大小 <input aria-label="字幕文字大小" type="number" min="16" max="72" value={subtitleStyle.fontSizePx} onChange={(event) => setSubtitleStyle((current) => ({ ...current, fontSizePx: Number(event.target.value) }))}/><span>px</span></label><label>顏色 <input aria-label="字幕文字顏色" type="color" value={subtitleStyle.textColor} onChange={(event) => setSubtitleStyle((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))}/></label><label><input aria-label="字幕陰影" type="checkbox" checked={subtitleStyle.shadowEnabled} onChange={(event) => setSubtitleStyle((current) => ({ ...current, shadowEnabled: event.target.checked }))}/> 陰影</label><label>外框 <input aria-label="字幕外框寬度" type="number" min="0" max="8" value={subtitleStyle.outlineWidthPx} onChange={(event) => setSubtitleStyle((current) => ({ ...current, outlineWidthPx: Number(event.target.value) }))}/><span>px</span></label><button type="button" className="secondary-button" disabled={busy} onClick={() => void saveStyle()}>儲存顯示格式</button></section>
          {selected && <section className={`cue-review-editor ${overlappingIds.has(selected.id) ? "has-time-overlap" : ""}`}>
            <header><div><span className={`review-status status-${selected.reviewStatus ?? "CONFIRMED"}`}>{statusLabel(selected.reviewStatus)}</span><strong>{cueScope(selected) === "INTRO" ? "片頭" : "正片"} · {cueOrigin(selected)}</strong>{selected.speaker && <small>說話者：{selected.speaker}</small>}</div><button type="button" className="danger-text" disabled={busy || generating || buildingPreview} onClick={() => void deleteSelectedCue()}>刪除這筆（Delete）</button></header>
            <div className="cue-fields"><label>開始（分:秒.毫秒）<TimecodeInput label="字幕開始" valueMs={selected.startMs} maxMs={selectedTimelineDurationMs} onChange={(value) => patchCue(selected.id, "startMs", value / 1000)} /></label><label>結束（分:秒.毫秒）<TimecodeInput label="字幕結束" valueMs={selected.endMs} maxMs={selectedTimelineDurationMs} onChange={(value) => patchCue(selected.id, "endMs", value / 1000)} /></label><label className="cue-text-field">字幕文字<textarea ref={selectedTextEditorRef} value={selected.text} onChange={(event) => patchCue(selected.id, "text", event.target.value)}/></label></div>
            {(selected.visualSummary || selected.eventSummary || selected.peopleSummary?.length || selected.locationSummary?.length || selected.animalSpecies?.length) && <div className="ai-evidence"><h3>AI 判斷依據（請人工核對）</h3><dl>{selected.visualSummary && <><dt>畫面</dt><dd>{selected.visualSummary}</dd></>}{selected.eventSummary && <><dt>事件</dt><dd>{selected.eventSummary}</dd></>}{selected.peopleSummary?.length ? <><dt>人物</dt><dd>{selected.peopleSummary.join("、")}</dd></> : null}{selected.locationSummary?.length ? <><dt>地點</dt><dd>{selected.locationSummary.join("、")}</dd></> : null}{selected.animalSpecies?.length ? <><dt>物種</dt><dd>{selected.animalSpecies.join("、")}</dd></> : null}{selected.speciesExplanation ? <><dt>物種說明</dt><dd>{selected.speciesExplanation}</dd></> : null}</dl><div className="ai-score-row"><span>主題相關 <strong>{selected.topicRelevanceScore ?? "–"}</strong></span><span>聲畫符合 <strong>{selected.transcriptVisualMatchScore ?? "–"}</strong></span><span>AI 信心 <strong>{selected.aiConfidence ?? "–"}</strong></span></div>{selected.aiWarnings?.length ? <ul>{selected.aiWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}</div>}
            <div className="cue-review-actions"><button type="button" className="reject-cue" disabled={busy} onClick={() => void setStatus(selected.id, "REJECTED")}>排除並保存</button><button type="button" disabled={busy} onClick={() => void setStatus(selected.id, "DRAFT")}>改回待確認並保存</button>{reviewQueueIds.includes(selected.id) ? <button type="button" className="confirm-cue" disabled={busy} onClick={() => void confirmReviewAndAdvance()}>✓ 修改完成、保存並下一筆</button> : <button type="button" className="confirm-cue" disabled={busy} onClick={() => void setStatus(selected.id, "CONFIRMED")}>✓ 確認並立即保存</button>}</div>
          </section>}
        </main>
      </div>
      <SharedIntroPreviewHistory refreshKey={previewHistoryRevision} title="片頭頁／字幕頁共用預覽" collapsible defaultCollapsed />
      {notice && <div className="subtitle-result-notice" role="status">{notice}</div>}
      <footer className="settings-footer"><p>每筆確認、取消確認、上下移與刪除都會立即保存；底部按鈕只用來保存尚未確認的文字／時間修改。來源保持唯讀。</p><div>{exporting && <button className="cancel-button" onClick={() => void window.sourceApp.cancelSubtitleExport()}>取消匯出</button>}<button className="secondary-button" disabled={busy || generating || buildingPreview || !localDirty} onClick={() => void save()}>保存未確認修改</button><button className="primary-button" disabled={busy || generating || buildingPreview || !counts.confirmed} onClick={() => void exportFile()}>匯出 {counts.confirmed} 筆已確認 SRT</button></div></footer>
      {forceReviewPrompt && <div className="inline-close-guard" role="alertdialog" aria-label="強制重新校對字幕"><strong>依目前片頭／正片主軸逐筆重新校對？</strong><p>App 會先依目前順序、IN／OUT 與疊化時間刷新字幕對位，再以短區段 Proxy 逐筆詢問「一致」或「不一致，修改」。字幕文字不會刪除。</p><button className="primary-button" disabled={busy} onClick={() => void forceReReview()}>確認，開始逐筆校對</button><SafeDefaultButton className="secondary-button" disabled={busy} onClick={() => setForceReviewPrompt(false)}>取消，不重設</SafeDefaultButton></div>}
      {closePrompt && <div className="inline-close-guard" role="alertdialog" aria-label="字幕未保存"><strong>字幕有未保存修改</strong><p>要先保存再離開，還是放棄這次修改？</p><button className="primary-button" disabled={busy} onClick={async () => { if (await save()) { setClosePrompt(false); onClose(); } }}>保存並離開</button><button className="danger-secondary-button" disabled={busy} onClick={() => { setLocalDirty(false); setClosePrompt(false); onClose(); }}>放棄並離開</button><SafeDefaultButton className="secondary-button" disabled={busy} onClick={() => setClosePrompt(false)}>返回編輯</SafeDefaultButton></div>}
    </section>
  </div>;
}
