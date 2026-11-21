import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type {
  AiAnalysisProgress,
  ConcatRenderProgress,
  PreviewResult,
  ProjectManifest,
  SubtitleCue,
  SubtitleCueReviewStatus,
  SubtitleGenerationScope,
  SubtitlePreviewResult,
  SubtitleAnalysisVideoSelection,
  SubtitlePreviewStyle,
  SubtitleTimelineScope,
  MaterialAnalysisProvider,
  SubtitleVisualDensity,
  SubtitleVisualAnalysisProgress,
  SubtitleVisualAnalysisOptions,
  SubtitleVisualPreflight,
  StandaloneSubtitleWorkspace,
} from "../../shared/domain";
import { buildTimelinePlan } from "../../shared/timeline-plan";
import {
  SUBTITLE_WRAP_MANUAL_MAX,
  SUBTITLE_WRAP_MANUAL_MIN,
  defaultSubtitleLineWidth,
  nudgeSubtitleCuePosition,
  resolveCueSubtitleWrapLimit,
  resolveSubtitleCuePosition,
  subtitleFrameFontSize,
  subtitleFrameOutlineWidth,
  subtitleFrameShadowSize,
  wrapSubtitleText,
} from "../../shared/subtitle-text";
import { formatDuration } from "../format";
import { SharedIntroPreviewHistory } from "./SharedIntroPreviewHistory";
import { TimecodeInput } from "./TimecodeInput";
import { SafeDefaultButton } from "./SafeDefaultButton";
import { StandaloneSubtitleReview } from "./StandaloneSubtitleReview";
import {
  activeSubtitleCueAt,
  adjacentCue,
  buildSubtitlePlaybackSegments,
  playbackSegmentAt,
  projectClockToSourceMs,
  sourceTimeToProjectClockMs,
} from "../subtitle-playback";

interface Props {
  project: ProjectManifest;
  timelineDurationMs: number;
  onProjectUpdated(project: ProjectManifest): void;
  onOpenAiSettings(): void;
  onClose(): void;
}

const DEFAULT_SCOPE: SubtitleGenerationScope = { intro: false, main: true };
const DEFAULT_STYLE: SubtitlePreviewStyle = {
  verticalPositionPercent: 82,
  fontSizePx: 28,
  textColor: "#FFFFFF",
  shadowEnabled: true,
  outlineWidthPx: 2,
};

function formatExactCueTime(timeMs: number): string {
  const safeMs = Math.max(0, Math.round(Number.isFinite(timeMs) ? timeMs : 0));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(safeMs % 1_000).padStart(3, "0")}`;
}

function formatCueDuration(startMs: number, endMs: number): string {
  return `${(Math.max(0, endMs - startMs) / 1_000).toFixed(3)}s`;
}

function fileName(scopes: SubtitleTimelineScope[]) {
  const date = new Date();
  const label = scopes.length === 2 ? "intro_main" : (scopes[0]?.toLowerCase() ?? "main");
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

function cueScope(cue: SubtitleCue): SubtitleTimelineScope {
  return cue.timelineScope ?? "MAIN";
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

function scopeNeedsReview(project: ProjectManifest, scope: SubtitleTimelineScope): boolean {
  const timelineRevision =
    scope === "INTRO"
      ? (project.introTimelineRevision ?? project.timelineRevision)
      : (project.mainTimelineRevision ?? project.timelineRevision);
  const reviewedRevision =
    scope === "INTRO"
      ? (project.introSubtitleReviewRevision ?? project.subtitleTimelineRevision)
      : (project.mainSubtitleReviewRevision ?? project.subtitleTimelineRevision);
  return timelineRevision !== reviewedRevision;
}

function overlappingCueIds(cues: SubtitleCue[]): Set<string> {
  const result = new Set<string>();
  for (const timelineScope of ["INTRO", "MAIN"] as const) {
    const scoped = cues
      .filter((cue) => cueScope(cue) === timelineScope && cue.reviewStatus !== "REJECTED")
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    for (let index = 0; index < scoped.length; index += 1) {
      for (
        let following = index + 1;
        following < scoped.length && scoped[following].startMs < scoped[index].endMs;
        following += 1
      ) {
        if (
          Math.max(scoped[index].startMs, scoped[following].startMs) <
          Math.min(scoped[index].endMs, scoped[following].endMs)
        ) {
          result.add(scoped[index].id);
          result.add(scoped[following].id);
        }
      }
    }
  }
  return result;
}

export function SubtitleStudio({ project, timelineDurationMs, onProjectUpdated, onOpenAiSettings, onClose }: Props) {
  const [cues, setCues] = useState<SubtitleCue[]>(() => {
    const timelineNeedsReview =
      project.subtitleCues.length > 0 && project.subtitleCues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
    return structuredClone(project.subtitleCues).map((cue) =>
      timelineNeedsReview && cue.reviewStatus !== "REJECTED" ? { ...cue, reviewStatus: "DRAFT" as const } : cue,
    );
  });
  const [scope, setScope] = useState<SubtitleGenerationScope>(DEFAULT_SCOPE);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitlePreviewStyle>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => project.subtitleCues[0]?.id);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(project.subtitleCues[0] ? [project.subtitleCues[0].id] : []),
  );
  const selectionAnchorId = useRef<string | undefined>(project.subtitleCues[0]?.id);
  const [cursor, setCursor] = useState(0);
  const [preview, setPreview] = useState<PreviewResult>();
  const [introPreview, setIntroPreview] = useState<SubtitlePreviewResult>();
  const [useIntroTimelinePreview, setUseIntroTimelinePreview] = useState(false);
  const [sourcePlaybackScope, setSourcePlaybackScope] = useState<SubtitleTimelineScope>("MAIN");
  const [previewError, setPreviewError] = useState<string>();
  const [progress, setProgress] = useState<AiAnalysisProgress>();
  const [previewProgress, setPreviewProgress] = useState<ConcatRenderProgress>();
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [includeSpeechTranscription, setIncludeSpeechTranscription] = useState(false);
  const [targetCueCount, setTargetCueCount] = useState(100);
  const [aiRegenerationMode, setAiRegenerationMode] = useState<
    "FILL_BLANKS" | "REPLACE_AI_SCOPE" | "PRESERVE_USER_EDITED"
  >("FILL_BLANKS");
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [followResumeRevision, setFollowResumeRevision] = useState(0);
  const [projectAiCheckEnabled, setProjectAiCheckEnabled] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [analysisVideo, setAnalysisVideo] = useState<SubtitleAnalysisVideoSelection>();
  const [visualPreflight, setVisualPreflight] = useState<SubtitleVisualPreflight>();
  const [standaloneWorkspace, setStandaloneWorkspace] = useState<StandaloneSubtitleWorkspace>();
  const [visualProvider, setVisualProvider] = useState<MaterialAnalysisProvider>("CHATGPT");
  const [visualIntervalSeconds, setVisualIntervalSeconds] = useState(2);
  const [visualDensity, setVisualDensity] = useState<SubtitleVisualDensity>("STANDARD");
  const [visualSrtPolicy, setVisualSrtPolicy] = useState<"BACKUP" | "SAVE_AS" | "OVERWRITE" | "CANCEL">("BACKUP");
  const [detectSceneChanges, setDetectSceneChanges] = useState(true);
  const [deduplicateFrames, setDeduplicateFrames] = useState(true);
  const [visualTitle, setVisualTitle] = useState(project.aiStoryContext.topic ?? "");
  const [visualDescription, setVisualDescription] = useState(project.aiStoryContext.storySummary ?? "");
  const [visualProgress, setVisualProgress] = useState<SubtitleVisualAnalysisProgress>({
    status: "IDLE",
    rawFrames: 0,
    sceneFrames: 0,
    deduplicatedFrames: 0,
    sentFrames: 0,
    requests: 0,
    elapsedMs: 0,
    tokens: 0,
    cacheHits: 0,
    temporaryBytes: 0,
  });
  const [savedDraftToken, setSavedDraftToken] = useState<{ token: string; officialExists: boolean }>();
  const [localDirty, setLocalDirty] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [forceReviewPrompt, setForceReviewPrompt] = useState(false);
  const [lineWidthCueId, setLineWidthCueId] = useState<string>();
  const [lineWidthDraft, setLineWidthDraft] = useState("");
  const [positionCueId, setPositionCueId] = useState<string>();
  const [reviewQueueIds, setReviewQueueIds] = useState<string[]>([]);
  const [visualDraftLanguage, setVisualDraftLanguage] = useState("zh-TW");
  const [localCorrectionText, setLocalCorrectionText] = useState("");
  const [previewHistoryRevision, setPreviewHistoryRevision] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selectedTextEditorRef = useRef<HTMLTextAreaElement>(null);
  const positionNudgeRef = useRef<HTMLDivElement>(null);
  const cueListRef = useRef<HTMLElement>(null);
  const cueRowRefs = useRef(new Map<string, HTMLDivElement>());
  const manualFollowUntilRef = useRef(0);
  const manualFollowTimerRef = useRef<number | undefined>(undefined);
  const programmaticFollowUntilRef = useRef(0);
  const continuePlaybackRef = useRef(false);
  const handoffSegmentIdRef = useRef<string | undefined>(undefined);
  const imagePlaybackAnchorRef = useRef<{ segmentId: string; projectMs: number; wallMs: number } | undefined>(undefined);
  const skipNextProjectSyncRef = useRef(false);
  const selectedScopes = useMemo(
    () => [...(scope.intro ? ["INTRO" as const] : []), ...(scope.main ? ["MAIN" as const] : [])],
    [scope],
  );
  const introDurationMs = useMemo(
    () => buildTimelinePlan({ ...project, timelineOrder: [] }, { includeIntro: true }).durationMs,
    [project],
  );
  const introOpenAiCount = useMemo(
    () => project.introSegments.filter((clip) => clip.analysisMode === "OPENAI_STORY_MATCH").length,
    [project.introSegments],
  );
  const visibleCues = useMemo(
    () => cues.filter((cue) => selectedScopes.includes(cueScope(cue))),
    [cues, selectedScopes],
  );
  const overlappingIds = useMemo(() => overlappingCueIds(visibleCues), [visibleCues]);
  useEffect(() => {
    console.info("[SUBTITLE_UI]", { projectId: project.id, loaded: project.subtitleCues.length, renderedRows: visibleCues.length, drafts: cues.filter((cue) => cue.reviewStatus === "DRAFT").length });
  }, [project.id, project.subtitleCues.length, visibleCues.length]);
  const selected = cues.find((cue) => cue.id === selectedId && selectedScopes.includes(cueScope(cue)));
  const selectedTimelineDurationMs =
    selected && cueScope(selected) === "INTRO"
      ? introDurationMs
      : scope.intro && !scope.main
        ? introDurationMs
        : timelineDurationMs;
  const needsReview = cues.length > 0 && cues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
  const counts = useMemo(
    () => ({
      draft: visibleCues.filter((cue) => cue.reviewStatus === "DRAFT").length,
      confirmed: visibleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED").length,
      rejected: visibleCues.filter((cue) => cue.reviewStatus === "REJECTED").length,
    }),
    [visibleCues],
  );
  const reviewableVisibleCues = useMemo(
    () => visibleCues.filter((cue) => cue.reviewStatus !== "REJECTED"),
    [visibleCues],
  );
  const allVisibleConfirmed =
    reviewableVisibleCues.length > 0 &&
    reviewableVisibleCues.every((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED");

  const playbackScope: SubtitleTimelineScope = useIntroTimelinePreview ? "INTRO" : sourcePlaybackScope;
  const playbackSegments = useMemo(() => buildSubtitlePlaybackSegments(project, playbackScope), [project, playbackScope]);
  const sourceSelection = useMemo(() => {
    if (useIntroTimelinePreview) return undefined;
    const segment = playbackSegmentAt(playbackSegments, cursor) ?? playbackSegments[0];
    return segment ? {
      asset: segment.asset,
      sourceStartMs: segment.sourceStartMs,
      sourceEndMs: segment.sourceEndMs,
      projectStartMs: segment.projectStartMs,
      projectEndMs: segment.projectEndMs,
      ownershipEndMs: segment.ownershipEndMs,
      segmentId: segment.id,
    } : undefined;
  }, [cursor, playbackSegments, useIntroTimelinePreview]);
  const activeSourcePreview = useMemo(() => {
    if (!preview || !sourceSelection || preview.assetId !== sourceSelection.asset.id) return undefined;
    if (sourceSelection.asset.kind === "IMAGE") return preview.variant === "IMAGE_PREVIEW" ? preview : undefined;
    return preview.variant === "VIDEO_CLIP_PROXY" || preview.variant === "VIDEO_PROXY" ? preview : undefined;
  }, [preview, sourceSelection?.asset.id, sourceSelection?.asset.kind]);

  const activeOverlayCue = useMemo(() => {
    return activeSubtitleCueAt(cues, playbackScope, cursor);
  }, [cues, cursor, playbackScope]);
  const navigationCueId = selected && cueScope(selected) === playbackScope ? selectedId : activeOverlayCue?.id;

  useEffect(() => {
    const list = cueListRef.current;
    if (!list) return;
    const markManual = () => {
      manualFollowUntilRef.current = Date.now() + 4_000;
      if (manualFollowTimerRef.current !== undefined) window.clearTimeout(manualFollowTimerRef.current);
      manualFollowTimerRef.current = window.setTimeout(() => setFollowResumeRevision((revision) => revision + 1), 4_000);
    };
    const onScroll = () => {
      if (Date.now() < programmaticFollowUntilRef.current) return;
      markManual();
    };
    const onManualScroll = () => markManual();
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("wheel", onManualScroll, { passive: true });
    list.addEventListener("pointerdown", onManualScroll, { passive: true });
    return () => {
      list.removeEventListener("scroll", onScroll); list.removeEventListener("wheel", onManualScroll); list.removeEventListener("pointerdown", onManualScroll);
      if (manualFollowTimerRef.current !== undefined) window.clearTimeout(manualFollowTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!activeOverlayCue) return;
    if (Date.now() < manualFollowUntilRef.current) return;
    const list = cueListRef.current;
    const row = cueRowRefs.current.get(activeOverlayCue.id);
    if (!list || !row) return;
    programmaticFollowUntilRef.current = Date.now() + 1_200;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const relativeCenter = rowRect.height > 0
      ? list.scrollTop + rowRect.top - listRect.top + rowRect.height / 2
      : row.offsetTop + row.clientHeight / 2;
    const top = Math.max(0, relativeCenter - list.clientHeight * 0.45);
    if (typeof list.scrollTo === "function") list.scrollTo({ top, behavior: "smooth" });
    else list.scrollTop = top;
    console.info("[SUBTITLE] focus", { workspace: "project", cueId: activeOverlayCue.id, reason: followResumeRevision ? "manual-override-expired-or-active-change" : "active-change", top });
  }, [activeOverlayCue?.id, followResumeRevision]);

  useEffect(() => {
    window.sourceApp.onAiAnalysisProgress(setProgress);
    window.sourceApp.onSubtitlePreviewProgress(setPreviewProgress);
    window.sourceApp.onSubtitleVisualAnalysisProgress?.(setVisualProgress);
    void window.sourceApp
      .getUserPreferences()
      .then((preferences) => {
        setScope(preferences.subtitleGenerationScope);
        setSourcePlaybackScope(preferences.subtitleGenerationScope.main ? "MAIN" : "INTRO");
        setSubtitleStyle(preferences.subtitlePreviewStyle);
      })
      .catch(() => undefined);
    return () => {
      window.sourceApp.clearAiAnalysisProgressListeners();
      window.sourceApp.clearSubtitlePreviewProgressListeners();
      window.sourceApp.clearSubtitleVisualAnalysisProgressListeners?.();
    };
  }, []);

  useEffect(() => {
    setVisualTitle(project.aiStoryContext.topic ?? "");
    setVisualDescription(project.aiStoryContext.storySummary ?? "");
  }, [project.id, project.aiStoryContext.topic, project.aiStoryContext.storySummary]);

  useEffect(() => {
    void window.sourceApp
      .getSubtitleAnalysisVideo?.()
      .then(setAnalysisVideo)
      .catch(() => undefined);
    void window.sourceApp.getStandaloneSubtitleWorkspace?.().then((workspace) => setStandaloneWorkspace(workspace ?? undefined)).catch(() => undefined);
  }, [project.id]);

  const chooseAnalysisVideo = async () => {
    try {
      const selected = await window.sourceApp.chooseSubtitleAnalysisVideo?.();
      if (selected) setAnalysisVideo(selected);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    }
  };

  const prepareProjectAiCheck = async () => {
    if (!projectAiCheckEnabled || !window.sourceApp.prepareProjectSubtitleAiCheck) return;
    if (localDirty && !await save()) return;
    setBusy(true); setError(undefined);
    try {
      const workspace = await window.sourceApp.prepareProjectSubtitleAiCheck();
      setStandaloneWorkspace(workspace);
      setNotice("已用目前 projectId 的成功輸出建立 AI 逐筆檢查工作區；所有建議仍需人工保留、套用、編輯或略過。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const importStandaloneSrtReview = async () => {
    if (!window.sourceApp.importStandaloneSubtitleWorkspaceFromSrt) return;
    setBusy(true); setError(undefined);
    try {
      const workspace = await window.sourceApp.importStandaloneSubtitleWorkspaceFromSrt();
      if (workspace) {
        setStandaloneWorkspace(workspace);
        setNotice("已將既有 SRT 複製到所選影片的獨立 AI draft 工作區；來源 SRT 與目前專案字幕都不會被修改。");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (skipNextProjectSyncRef.current) {
      skipNextProjectSyncRef.current = false;
      return;
    }
    if (!localDirty) {
      const needs =
        project.subtitleCues.length > 0 && project.subtitleCues.some((cue) => scopeNeedsReview(project, cueScope(cue)));
      setCues(
        structuredClone(project.subtitleCues).map((cue) =>
          needs && cue.reviewStatus !== "REJECTED" ? { ...cue, reviewStatus: "DRAFT" as const } : cue,
        ),
      );
      setSelectedId(project.subtitleCues[0]?.id);
      setSelectedIds(project.subtitleCues[0] ? new Set([project.subtitleCues[0].id]) : new Set());
    } else if (project.updatedAt) {
      setNotice("專案在背景更新；目前未保存的字幕編輯仍保留，請保存或重新載入以採用外部版本。");
    }
  }, [project.id, project.subtitleCues, project.updatedAt]);

  useEffect(() => {
    if (selected) return;
    const first = visibleCues[0];
    setSelectedId(first?.id);
    setSelectedIds(first ? new Set([first.id]) : new Set());
    selectionAnchorId.current = first?.id;
    setCursor(first?.startMs ?? 0);
  }, [selected, visibleCues]);

  useEffect(() => {
    if (!sourceSelection) {
      setPreview(undefined);
      if (!useIntroTimelinePreview) setPreviewError(undefined);
      return;
    }
    let active = true;
    let completed = false;
    setPreview(undefined);
    setPreviewError(undefined);
    const task =
      sourceSelection.asset.kind === "VIDEO"
        ? window.sourceApp.ensureClipPreview(
            sourceSelection.asset.id,
            sourceSelection.sourceStartMs,
            sourceSelection.sourceEndMs,
          )
        : window.sourceApp.ensurePreview(sourceSelection.asset.id, "IMAGE_PREVIEW");
    void task
      .then((result) => {
        if (!active) return;
        completed = true;
        setPreview(result);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof Error && reason.name === "AbortError")) return;
        setPreviewError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      if (!completed) {
        if (sourceSelection.asset.kind === "VIDEO")
          void window.sourceApp.cancelClipPreview(
            sourceSelection.asset.id,
            sourceSelection.sourceStartMs,
            sourceSelection.sourceEndMs,
          );
        else void window.sourceApp.cancelPreview(sourceSelection.asset.id, "IMAGE_PREVIEW");
      }
    };
  }, [
    sourceSelection?.segmentId,
    sourceSelection?.asset.id,
    sourceSelection?.asset.kind,
    sourceSelection?.sourceStartMs,
    sourceSelection?.sourceEndMs,
    useIntroTimelinePreview,
  ]);

  useEffect(() => {
    if (!activeSourcePreview?.url || sourceSelection?.asset.kind !== "VIDEO" || !continuePlaybackRef.current || useIntroTimelinePreview) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const resume = () => {
      if (cancelled || !continuePlaybackRef.current) return;
      const player = videoRef.current;
      if (!player) {
        if (attempts++ < 40) timer = window.setTimeout(resume, 50);
        return;
      }
      player.play().then(() => { continuePlaybackRef.current = false; }).catch(() => {
        if (attempts++ < 40) timer = window.setTimeout(resume, 100);
      });
    };
    timer = window.setTimeout(resume, 0);
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [activeSourcePreview?.url, sourceSelection?.segmentId, sourceSelection?.asset.kind, useIntroTimelinePreview]);

  useEffect(() => {
    if (useIntroTimelinePreview || sourceSelection?.asset.kind !== "IMAGE" || !continuePlaybackRef.current) return;
    continuePlaybackRef.current = false;
    handoffSegmentIdRef.current = undefined;
    setPreviewPlaying(true);
  }, [sourceSelection?.segmentId, sourceSelection?.asset.kind, useIntroTimelinePreview]);

  const updateScope = (key: keyof SubtitleGenerationScope, checked: boolean) => {
    const next = { ...scope, [key]: checked };
    if (!next.intro && !next.main) {
      setError("片頭與正片至少需要勾選一項。");
      return;
    }
    setError(undefined);
    setScope(next);
    if (!next.main) setSourcePlaybackScope("INTRO");
    else if (!next.intro && sourcePlaybackScope === "INTRO") setSourcePlaybackScope("MAIN");
    if (!next.intro) setUseIntroTimelinePreview(false);
    void window.sourceApp
      .updateUserPreferences({ subtitleGenerationScope: next })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const patchCue = (id: string, field: "startMs" | "endMs" | "text", value: string | number) => {
    setLocalDirty(true);
    setCues((current) =>
      current.map((cue) =>
        cue.id === id
          ? { ...cue, userEdited: true, [field]: field === "text" ? value : Math.round(Number(value) * 1000) }
          : cue,
      ),
    );
  };

  const openLineWidthEditor = (cue: SubtitleCue) => {
    setLineWidthCueId(cue.id);
    setLineWidthDraft(String(cue.lineWidthChars ?? defaultSubtitleLineWidth(cue.text)));
    setError(undefined);
  };

  const saveLineWidth = async (automatic = false) => {
    const cue = cues.find((item) => item.id === lineWidthCueId);
    if (!cue) return;
    const parsed = Math.floor(Number(lineWidthDraft));
    if (
      !automatic &&
      (!Number.isInteger(parsed) || parsed < SUBTITLE_WRAP_MANUAL_MIN || parsed > SUBTITLE_WRAP_MANUAL_MAX)
    ) {
      setError(`單筆字幕每行字數必須是 ${SUBTITLE_WRAP_MANUAL_MIN}–${SUBTITLE_WRAP_MANUAL_MAX} 的整數。`);
      return;
    }
    const next = cues.map((item) =>
      item.id === cue.id ? { ...item, lineWidthChars: automatic ? undefined : parsed, userEdited: true } : item,
    );
    if (
      await persistCueList(
        next,
        automatic
          ? `這筆字幕已恢復自動行寬（目前 ${defaultSubtitleLineWidth(cue.text)} 字／行）並立即保存。`
          : `這筆字幕已改為每行 ${parsed} 字並立即保存。`,
      )
    )
      setLineWidthCueId(undefined);
  };

  const openPositionEditor = (cue: SubtitleCue) => {
    setSelectedId(cue.id);
    setSelectedIds(new Set([cue.id]));
    selectionAnchorId.current = cue.id;
    setPositionCueId(cue.id);
    setError(undefined);
  };

  useEffect(() => {
    if (!positionCueId) return;
    const frame = window.requestAnimationFrame(() => positionNudgeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [positionCueId]);

  const nudgePositionAndSave = async (id: string, direction: "UP" | "DOWN" | "LEFT" | "RIGHT", largeStep = false) => {
    if (busy || generating || buildingPreview) return;
    const cue = cues.find((item) => item.id === id);
    if (!cue) return;
    const position = nudgeSubtitleCuePosition(
      cue.position,
      subtitleStyle.verticalPositionPercent,
      direction,
      largeStep,
    );
    const next = cues.map((item) => (item.id === id ? { ...item, position, userEdited: true } : item));
    await persistCueList(next, `這筆字幕位置已調整為 X ${position.xPercent}%／Y ${position.yPercent}% 並立即保存。`);
  };

  const resetPositionAndSave = async (id: string) => {
    if (busy || generating || buildingPreview) return;
    const next = cues.map((item) => (item.id === id ? { ...item, position: undefined, userEdited: true } : item));
    await persistCueList(next, "這筆字幕已恢復畫面中央／全域高低位置並立即保存。");
  };

  const handlePositionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
    const target = event.target;
    if (target instanceof Element && target.matches("input, textarea, select, [contenteditable='true']")) return;
    const direction =
      event.key === "ArrowUp"
        ? "UP"
        : event.key === "ArrowDown"
          ? "DOWN"
          : event.key === "ArrowLeft"
            ? "LEFT"
            : event.key === "ArrowRight"
              ? "RIGHT"
              : undefined;
    if (!direction) return;
    event.preventDefault();
    void nudgePositionAndSave(id, direction, event.shiftKey);
  };

  const persistCueList = async (
    nextCues: SubtitleCue[],
    successMessage: string,
  ): Promise<ProjectManifest | undefined> => {
    setBusy(true);
    setError(undefined);
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
    const next = cues.map((cue) => (cue.id === id ? { ...cue, reviewStatus } : cue));
    const message =
      reviewStatus === "CONFIRMED"
        ? "這筆字幕的文字、時間與確認狀態已立即保存。"
        : reviewStatus === "REJECTED"
          ? "已排除這筆字幕並立即保存；不會匯出到 SRT。"
          : "已改回待確認並立即保存。";
    return Boolean(await persistCueList(next, message));
  };

  const save = async (): Promise<boolean> => {
    return Boolean(await persistCueList(cues, "所有尚未確認的文字／時間修改已保存，並綁定目前 timeline revision。"));
  };
  const requestClose = () => {
    if (localDirty) setClosePrompt(true);
    else onClose();
  };

  const requestForceReReview = () => {
    if (localDirty) {
      setError("目前有尚未保存的字幕修改；請先保存，再執行強制重新校對。");
      return;
    }
    setError(undefined);
    setForceReviewPrompt(true);
  };

  const forceReReview = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await window.sourceApp.forceSubtitleReReview(selectedScopes);
      const nextCues = structuredClone(updated.subtitleCues);
      const reviewIds = nextCues
        .filter((cue) => selectedScopes.includes(cueScope(cue)) && cue.reviewStatus !== "REJECTED")
        .map((cue) => cue.id);
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
      setNotice(
        `已依目前片頭／正片順序、IN／OUT 與 ${updated.timelineTransitionSeconds} 秒疊化重新對位 ${reviewIds.length} 筆字幕；現在從第 1 筆開始逐筆核對 Proxy 畫面。`,
      );
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
    setCues((current) =>
      current.map((cue) =>
        cue.id === selected.id ? { ...cue, reviewStatus: "DRAFT" as const, userEdited: true } : cue,
      ),
    );
    setNotice("這筆先保持待確認；請直接修改下方文字或頭尾時間，完成後按「修改完成，確認並下一筆」。");
    window.setTimeout(() => {
      selectedTextEditorRef.current?.focus();
      selectedTextEditorRef.current?.select();
    }, 0);
  };

  const buildIntroPreview = async () => {
    if (!project.introSegments.length) throw new Error("片頭目前沒有片段，無法建立 480P 字幕預覽。");
    setBuildingPreview(true);
    setPreviewProgress({ phase: "PREPARING", percent: 0, outTimeMs: 0, expectedDurationMs: introDurationMs });
    setPreviewError(undefined);
    try {
      const result = await window.sourceApp.buildSubtitleIntroPreview(false);
      setIntroPreview(result);
      setUseIntroTimelinePreview(true);
      setCursor(0);
      setPreviewHistoryRevision((value) => value + 1);
      setNotice(
        `480P 片頭字幕代理已${result.cacheStatus === "HIT" ? "從快取載入" : "產生完成"}；播放時字幕會依時間同步顯示。`,
      );
    } finally {
      setBuildingPreview(false);
      setPreviewProgress(undefined);
    }
  };

  const generate = async () => {
    if (!selectedScopes.length) {
      setError("請至少選擇片頭或正片。");
      return;
    }
    setGenerating(true);
    setError(undefined);
    setNotice(undefined);
    setProgress({ phase: "PREPARING", processed: 0, total: 1 });
    try {
      const result = await window.sourceApp.generateAiSubtitles({
        includeSpeechTranscription,
        scopes: selectedScopes,
        mode: aiRegenerationMode,
        targetCueCount,
      });
      onProjectUpdated(result.project);
      setCues(structuredClone(result.project.subtitleCues));
      setLocalDirty(false);
      const firstGenerated = result.project.subtitleCues.find(
        (cue) => (cue.origin === "AI_SPEECH" || cue.origin === "AI_VISUAL") && selectedScopes.includes(cueScope(cue)),
      );
      setSelectedId(
        firstGenerated?.id ?? result.project.subtitleCues.find((cue) => selectedScopes.includes(cueScope(cue)))?.id,
      );
      setSelectedIds(firstGenerated ? new Set([firstGenerated.id]) : new Set());
      selectionAnchorId.current = firstGenerated?.id;
      setNotice(
        `已由「${result.accountName}」建立 ${result.generatedCount} 筆已確認字幕（知識型畫面 ${result.visualOnlyCount}、語音 ${result.transcribedCount}）。仍可逐項修改、取消確認或刪除。`,
      );
      if (scope.intro) {
        try {
          await buildIntroPreview();
        } catch (reason) {
          setPreviewError(
            `字幕草稿已建立，但 480P 片頭代理失敗：${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(
        message.includes("取消") || (reason instanceof Error && reason.name === "AbortError")
          ? "AI 字幕分析已取消；未完成的草稿不會寫入專案。"
          : message,
      );
    } finally {
      setGenerating(false);
      setProgress(undefined);
    }
  };

  const startVisualAnalysis = async (confirmed = false) => {
    const start = window.sourceApp.startSubtitleVisualAnalysis;
    if (!start) {
      setError("目前版本尚未連接字幕視覺分析工作。更新後即可從此處啟動。 ");
      return;
    }
    if (visualSrtPolicy === "CANCEL") {
      setNotice("已依正式 SRT 保護選項取消；沒有啟動分析或修改字幕。");
      return;
    }
    try {
      setError(undefined);
      const options: SubtitleVisualAnalysisOptions = {
        provider: visualProvider, intervalSeconds: Math.max(1, Math.min(60, Math.round(visualIntervalSeconds) || 2)),
        density: visualDensity, displayLanguage: visualDraftLanguage as SubtitleVisualAnalysisOptions["displayLanguage"],
        detectSceneChanges, deduplicateFrames, title: visualTitle.trim(), description: visualDescription.trim(), scopes: selectedScopes,
      };
      if (window.sourceApp.getSubtitleVisualPreflight && !confirmed) {
        setVisualPreflight(await window.sourceApp.getSubtitleVisualPreflight(options));
        return;
      }
      if (visualPreflight) {
        options.analysisMode = visualPreflight.recommendedMode;
        options.srtPolicy = visualSrtPolicy === "BACKUP" ? "BACKUP" : "SAVE_AS";
      }
      setVisualPreflight(undefined);
      setVisualProgress({
        status: "RUNNING",
        rawFrames: 0,
        sceneFrames: 0,
        deduplicatedFrames: 0,
        sentFrames: 0,
        requests: 0,
        elapsedMs: 0,
        tokens: 0,
        cacheHits: 0,
        temporaryBytes: 0,
      });
      const result = await start(options);
      if (result?.workspace) setStandaloneWorkspace(result.workspace);
    } catch (reason) {
      setVisualProgress((current) => ({
        ...current,
        status: "FAILED",
        error: reason instanceof Error ? reason.message : String(reason),
      }));
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const controlVisualAnalysis = async (action: "pause" | "resume" | "cancel") => {
    try {
      const operation =
        action === "pause"
          ? window.sourceApp.pauseSubtitleVisualAnalysis
          : action === "resume"
            ? window.sourceApp.resumeSubtitleVisualAnalysis
            : window.sourceApp.cancelSubtitleVisualAnalysis;
      if (!operation) throw new Error("此版本尚未提供字幕視覺分析工作控制。");
      if (action === "resume") setVisualProgress((current) => ({ ...current, status: "RUNNING", error: undefined }));
      const result = await operation();
      if (result && "workspace" in result && result.workspace) setStandaloneWorkspace(result.workspace);
      if (action === "pause") setVisualProgress((current) => ({ ...current, status: "PAUSED" }));
      if (action === "cancel") setVisualProgress((current) => ({ ...current, status: "CANCELLED" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveStyle = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await window.sourceApp.updateUserPreferences({ subtitlePreviewStyle: subtitleStyle });
      setSubtitleStyle(saved.subtitlePreviewStyle);
      setNotice("字幕位置、大小、顏色、陰影、外框與選填的批次行寬已保存為下次預設。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(cues);
      onProjectUpdated(updated);
      setCues(updated.subtitleCues);
      const output = await window.sourceApp.chooseSubtitleOutput(fileName(selectedScopes));
      if (!output) return;
      setExporting(true);
      const result = await window.sourceApp.exportSubtitles(output.token, selectedScopes);
      setNotice(`已匯出 ${result.cueCount} 筆已確認 UTF-8 SRT：${result.outputPath}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setExporting(false);
    }
  };

  const saveAiDraftFile = async () => {
    if (!window.sourceApp.saveSubtitleAiDraft || !window.sourceApp.promoteSubtitleAiDraft) return;
    setBusy(true);
    setError(undefined);
    try {
      const output = await window.sourceApp.chooseSubtitleOutput(fileName(selectedScopes));
      if (!output) return;
      const saved = await window.sourceApp.saveSubtitleAiDraft(output.token, selectedScopes);
      setSavedDraftToken({ token: output.token, officialExists: saved.officialExists });
      setNotice(`已安全保存 ${saved.cueCount} 筆待確認字幕：${saved.draftPath}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const promoteSavedAiDraft = async () => {
    if (!savedDraftToken || !window.sourceApp.promoteSubtitleAiDraft) return;
    const message = savedDraftToken.officialExists
      ? "正式 SRT 已存在。繼續會先建立時間戳備份，再升級已逐筆確認的草稿。"
      : "將已逐筆確認的 AI 草稿升級為正式 SRT？";
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      const promoted = await window.sourceApp.promoteSubtitleAiDraft(savedDraftToken.token, visualSrtPolicy === "OVERWRITE" ? "OVERWRITE" : "BACKUP");
      setSavedDraftToken(undefined);
      setNotice(
        `已升級為正式 SRT：${promoted.outputPath}${promoted.backupPath ? `；舊檔備份：${promoted.backupPath}` : ""}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (cues.length && !window.confirm("匯入 SRT 會加入所選字幕範圍並保留另一範圍；來源 SRT 不會被修改。是否繼續？"))
        return;
      const result = await window.sourceApp.chooseSubtitleInput();
      if (!result) return;
      const targetScope: SubtitleTimelineScope = scope.intro && !scope.main ? "INTRO" : "MAIN";
      const retained = cues.filter((cue) => cueScope(cue) !== targetScope);
      const imported = result.cues.map((cue) => ({ ...cue, timelineScope: targetScope }));
      const updated = await window.sourceApp.setSubtitleCues([...retained, ...imported]);
      onProjectUpdated(updated);
      setCues(structuredClone(updated.subtitleCues));
      setSelectedId(imported[0]?.id);
      setCursor(imported[0]?.startMs ?? 0);
      setNotice(
        `已匯入 ${result.fileName} 的 ${imported.length} 筆字幕（${targetScope === "INTRO" ? "片頭" : "正片"}）；可逐項修改時間與文字。`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const timelineScope: SubtitleTimelineScope =
      scope.intro && !scope.main ? "INTRO" : selected ? cueScope(selected) : "MAIN";
    const durationMs = timelineScope === "INTRO" ? introDurationMs : timelineDurationMs;
    const start = Math.min(cursor, Math.max(0, durationMs - 100));
    const end = Math.min(durationMs, start + 2_000);
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      startMs: start,
      endMs: Math.max(start + 100, end),
      text: "新字幕",
      timelineScope,
      origin: "MANUAL",
      reviewStatus: "CONFIRMED",
    };
    setLocalDirty(true);
    setCues((current) =>
      [...current, cue].sort((a, b) => cueScope(a).localeCompare(cueScope(b)) || a.startMs - b.startMs),
    );
    setSelectedId(cue.id);
  };

  const deleteCueIds = async (ids: Set<string>, label: string) => {
    if (!ids.size || busy || generating || buildingPreview) return;
    if (!window.confirm(`刪除${label}？\n只會從專案字幕清單移除，不會刪除任何影片或代理檔。`)) return;
    const next = cues.filter((cue) => !ids.has(cue.id));
    const nextSelected = visibleCues.find((cue) => !ids.has(cue.id));
    setBusy(true);
    setError(undefined);
    try {
      const updated = await window.sourceApp.setSubtitleCues(next);
      onProjectUpdated(updated);
      setCues(structuredClone(updated.subtitleCues));
      setSelectedId(nextSelected?.id);
      setSelectedIds(nextSelected ? new Set([nextSelected.id]) : new Set());
      selectionAnchorId.current = nextSelected?.id;
      setNotice(`${ids.size === 1 ? "已刪除該筆字幕" : `已刪除${label}`}並保存；影片、照片與代理檔保持不變。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedCue = async () => {
    if (!selected) return;
    await deleteCueIds(new Set([selected.id]), `這筆${cueScope(selected) === "INTRO" ? "片頭" : "正片"}字幕`);
  };

  const cancelConfirmation = async () => {
    if (!selectedIds.size || busy || generating || buildingPreview) return;
    setLocalDirty(true);
    const next = cues.map((cue) => (selectedIds.has(cue.id) ? { ...cue, reviewStatus: "DRAFT" as const } : cue));
    await persistCueList(next, `已取消 ${selectedIds.size} 筆字幕的確認狀態並立即保存；內容仍保留。`);
  };

  const confirmSelected = async () => {
    if (!selectedIds.size || busy || generating || buildingPreview) return;
    const blocked = [...selectedIds].filter((id) => overlappingIds.has(id));
    setLocalDirty(true);
    const next = cues.map((cue) =>
      selectedIds.has(cue.id) && !overlappingIds.has(cue.id) ? { ...cue, reviewStatus: "CONFIRMED" as const } : cue,
    );
    await persistCueList(
      next,
      blocked.length
        ? `已確認並保存 ${selectedIds.size - blocked.length} 筆；另有 ${blocked.length} 筆仍重疊並保持待確認。`
        : `已確認並立即保存 ${selectedIds.size} 筆字幕。`,
    );
  };

  const toggleAllConfirmation = async () => {
    if (!reviewableVisibleCues.length || busy || generating || buildingPreview) return;
    const nextStatus: SubtitleCueReviewStatus = allVisibleConfirmed ? "DRAFT" : "CONFIRMED";
    setLocalDirty(true);
    const next = cues.map((cue) =>
      reviewableVisibleCues.some((visible) => visible.id === cue.id) &&
      (nextStatus !== "CONFIRMED" || !overlappingIds.has(cue.id))
        ? { ...cue, reviewStatus: nextStatus }
        : cue,
    );
    await persistCueList(
      next,
      nextStatus === "CONFIRMED"
        ? overlappingIds.size
          ? `已確認並保存所有未重疊字幕；${overlappingIds.size} 筆紅框字幕保持待確認。`
          : `已全部確認並立即保存目前範圍的 ${reviewableVisibleCues.length} 筆字幕。`
        : `已全部取消確認並立即保存目前範圍的 ${reviewableVisibleCues.length} 筆字幕。`,
    );
  };

  const moveCueAndSave = async (id: string, direction: -1 | 1) => {
    if (busy || generating || buildingPreview) return;
    const currentCue = cues.find((cue) => cue.id === id);
    if (!currentCue) return;
    if (currentCue.reviewStatus === "REJECTED") return;
    const scoped = visibleCues.filter(
      (cue) => cueScope(cue) === cueScope(currentCue) && cue.reviewStatus !== "REJECTED",
    );
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
    const next = cues.map((cue) =>
      cue.id === currentCue.id
        ? { ...cue, ...neighborPlacement, reviewStatus: "DRAFT" as const, userEdited: true }
        : cue.id === neighbor.id
          ? { ...cue, ...currentPlacement, reviewStatus: "DRAFT" as const, userEdited: true }
          : cue,
    );
    setLocalDirty(true);
    const updated = await persistCueList(
      next,
      `已將這筆字幕${direction < 0 ? "上移" : "下移"}到相鄰時間位置並立即保存；交換位置的兩筆已改回待確認。`,
    );
    if (!updated) return;
    const moved = updated.subtitleCues.find((cue) => cue.id === id);
    setSelectedId(id);
    setSelectedIds(new Set([id]));
    selectionAnchorId.current = id;
    setCursor(moved?.startMs ?? 0);
  };

  const isEditableVisualDraft = (cue: SubtitleCue | undefined): cue is SubtitleCue =>
    cue?.origin === "AI_VISUAL" && cue.reviewStatus === "DRAFT";
  const orderedActiveCues = visibleCues
    .filter((cue) => cueScope(cue) === (selected ? cueScope(selected) : "MAIN") && cue.reviewStatus !== "REJECTED")
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const selectedCueIndex = selected ? orderedActiveCues.findIndex((cue) => cue.id === selected.id) : -1;
  const previousVisualDraft = selectedCueIndex > 0 ? orderedActiveCues[selectedCueIndex - 1] : undefined;
  const nextVisualDraft = selectedCueIndex >= 0 ? orderedActiveCues[selectedCueIndex + 1] : undefined;
  const canMergePrevious = isEditableVisualDraft(selected) && isEditableVisualDraft(previousVisualDraft);
  const canMergeNext = isEditableVisualDraft(selected) && isEditableVisualDraft(nextVisualDraft);

  const mergeVisualDraft = async (neighbor: SubtitleCue | undefined) => {
    if (!isEditableVisualDraft(selected) || !isEditableVisualDraft(neighbor) || busy) return;
    const first = selected.startMs <= neighbor.startMs ? selected : neighbor;
    const second = first.id === selected.id ? neighbor : selected;
    const merged: SubtitleCue = {
      ...first,
      startMs: Math.min(first.startMs, second.startMs),
      endMs: Math.max(first.endMs, second.endMs),
      text: [first.text.trim(), second.text.trim()].filter(Boolean).join("\n"),
      visualSummary: [first.visualSummary, second.visualSummary].filter(Boolean).join("；") || undefined,
      eventSummary: [first.eventSummary, second.eventSummary].filter(Boolean).join("；") || undefined,
      peopleSummary: [...new Set([...(first.peopleSummary ?? []), ...(second.peopleSummary ?? [])])],
      locationSummary: [...new Set([...(first.locationSummary ?? []), ...(second.locationSummary ?? [])])],
      animalSpecies: [...new Set([...(first.animalSpecies ?? []), ...(second.animalSpecies ?? [])])],
      reviewStatus: "DRAFT",
      userEdited: true,
    };
    const next = cues.flatMap((cue) =>
      cue.id === first.id ? [merged] : cue.id === second.id ? [] : [cue],
    );
    const updated = await persistCueList(next, "相鄰畫面情境草稿已合併並保存；合併結果仍待確認。");
    if (updated) {
      setSelectedId(merged.id);
      setSelectedIds(new Set([merged.id]));
      selectionAnchorId.current = merged.id;
    }
  };

  const splitVisualDraft = async () => {
    if (!isEditableVisualDraft(selected) || busy) return;
    const text = selected.text.trim();
    if (text.length < 2 || selected.endMs - selected.startMs < 2) return;
    const target = Math.floor(text.length / 2);
    const whitespaceBreaks = [...text.matchAll(/\s+/g)].map((match) => match.index ?? 0);
    const splitAt = whitespaceBreaks.length
      ? whitespaceBreaks.reduce((closest, position) =>
          Math.abs(position - target) < Math.abs(closest - target) ? position : closest,
        whitespaceBreaks[0])
      : target;
    const firstText = text.slice(0, splitAt).trim();
    const secondText = text.slice(splitAt).trim();
    if (!firstText || !secondText) return;
    const midpointMs = Math.round((selected.startMs + selected.endMs) / 2);
    const secondCue: SubtitleCue = {
      ...selected,
      id: crypto.randomUUID(),
      startMs: midpointMs,
      text: secondText,
      reviewStatus: "DRAFT",
      userEdited: true,
    };
    const firstCue: SubtitleCue = {
      ...selected,
      endMs: midpointMs,
      text: firstText,
      reviewStatus: "DRAFT",
      userEdited: true,
    };
    const next = cues.flatMap((cue) =>
      cue.id === selected.id ? [firstCue, secondCue] : [cue],
    );
    const updated = await persistCueList(next, "畫面情境草稿已在時間中點拆分並保存；兩筆仍待確認。");
    if (updated) {
      setSelectedId(firstCue.id);
      setSelectedIds(new Set([firstCue.id]));
      selectionAnchorId.current = firstCue.id;
    }
  };

  const applyLocalVisualCorrection = async () => {
    if (!isEditableVisualDraft(selected) || busy) return;
    const correctedText = localCorrectionText.trim();
    if (!correctedText) {
      setError("請輸入要套用的字幕文字。");
      return;
    }
    const next = cues.map((cue) =>
      cue.id === selected.id
        ? { ...cue, text: correctedText, reviewStatus: "DRAFT" as const, userEdited: true }
        : cue,
    );
    if (await persistCueList(next, "已將本機輸入的修正文案保存為待確認草稿。")) {
      setLocalCorrectionText("");
    }
  };

  const regenerateSelectedVisualDrafts = async () => {
    const regenerate = window.sourceApp.regenerateSubtitleVisualCue;
    const instruction = localCorrectionText.trim();
    const targets = cues.filter((cue) => selectedIds.has(cue.id) && isEditableVisualDraft(cue)).slice(0, 10);
    if (!regenerate || !targets.length || !instruction || busy) return;
    if (!window.confirm(`將為 ${targets.length} 筆草稿各取附近最多 3 張畫面並呼叫所選 AI 服務。繼續？`)) return;
    setBusy(true); setError(undefined);
    try {
      const replacements = new Map<string, Awaited<ReturnType<typeof regenerate>>>();
      for (const cue of targets) replacements.set(cue.id, await regenerate({ cueId: cue.id, instruction, provider: visualProvider, displayLanguage: visualDraftLanguage as SubtitleVisualAnalysisOptions["displayLanguage"] }));
      const next = cues.map((cue) => replacements.has(cue.id) ? { ...cue, text: replacements.get(cue.id)!.text, reviewStatus: "DRAFT" as const, userEdited: true, aiConfidence: Math.round(replacements.get(cue.id)!.confidence * 100) } : cue);
      await persistCueList(next, `已依指示重新產生 ${replacements.size} 筆畫面字幕草稿；仍需逐筆確認。`);
      setLocalCorrectionText("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const deleteSelectedCues = async () => {
    await deleteCueIds(selectedIds, `選取的 ${selectedIds.size} 筆字幕`);
  };

  const selectCue = (cue: SubtitleCue, event?: ReactMouseEvent<HTMLButtonElement>) => {
    const anchorIndex = selectionAnchorId.current
      ? visibleCues.findIndex((item) => item.id === selectionAnchorId.current)
      : -1;
    const currentIndex = visibleCues.findIndex((item) => item.id === cue.id);
    const nextIds =
      event?.shiftKey && anchorIndex >= 0 && currentIndex >= 0
        ? new Set(
            visibleCues
              .slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1)
              .map((item) => item.id),
          )
        : new Set([cue.id]);
    setSelectedIds(nextIds);
    if (!event?.shiftKey) selectionAnchorId.current = cue.id;
    setSelectedId(cue.id);
  };

  const jumpToProjectTime = (timeMs: number, requestedScope = playbackScope, forceSourcePreview = false) => {
    const duration = requestedScope === "INTRO" ? introDurationMs : timelineDurationMs;
    const nextClock = Math.max(0, Math.min(duration, Math.round(timeMs)));
    const requestedSegments = requestedScope === playbackScope
      ? playbackSegments
      : buildSubtitlePlaybackSegments(project, requestedScope);
    if (requestedScope !== sourcePlaybackScope) setSourcePlaybackScope(requestedScope);
    if (forceSourcePreview) setUseIntroTimelinePreview(false);
    setCursor(nextClock);
    manualFollowUntilRef.current = 0;
    if (manualFollowTimerRef.current !== undefined) window.clearTimeout(manualFollowTimerRef.current);
    setFollowResumeRevision((revision) => revision + 1);
    const segment = playbackSegmentAt(requestedSegments, nextClock);
    const player = videoRef.current;
    continuePlaybackRef.current = false;
    handoffSegmentIdRef.current = undefined;
    if (player && !player.paused) player.pause();
    setPreviewPlaying(false);
    if (player && useIntroTimelinePreview && !forceSourcePreview) player.currentTime = nextClock / 1000;
    else if (player && segment && sourceSelection?.segmentId === segment.id) {
      const previewStartMs = activeSourcePreview?.variant === "VIDEO_CLIP_PROXY" ? (activeSourcePreview.sourceStartMs ?? segment.sourceStartMs) : 0;
      player.currentTime = Math.max(0, (projectClockToSourceMs(segment, nextClock) - previewStartMs) / 1000);
    }
  };

  const returnToCurrentCue = () => {
    manualFollowUntilRef.current = 0;
    if (manualFollowTimerRef.current !== undefined) window.clearTimeout(manualFollowTimerRef.current);
    manualFollowTimerRef.current = undefined;
    setFollowResumeRevision((revision) => revision + 1);
  };

  const jumpToCue = (cue: SubtitleCue) => {
    setSelectedId(cue.id);
    setSelectedIds(new Set([cue.id]));
    selectionAnchorId.current = cue.id;
    jumpToProjectTime(cue.startMs, cueScope(cue), true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (standaloneWorkspace) return;
      const editing = isTextEditingTarget(event.target);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void save();
        return;
      }
      if (editing) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        jumpToProjectTime(cursor + (event.key === "ArrowLeft" ? -2_000 : 2_000));
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const target = adjacentCue(cues, playbackScope, navigationCueId, event.key === "ArrowUp" ? -1 : 1);
        if (target) selectCue(target);
      } else if (event.key === "Delete" && selected) {
        event.preventDefault();
        void deleteSelectedCue();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [standaloneWorkspace, selected?.id, selectedId, navigationCueId, cues, cursor, playbackScope, playbackSegments, sourceSelection?.segmentId, activeSourcePreview?.url, busy, generating, buildingPreview]);

  useEffect(() => {
    if (!standaloneWorkspace) return;
    continuePlaybackRef.current = false;
    videoRef.current?.pause();
    setPreviewPlaying(false);
  }, [standaloneWorkspace?.id]);

  const handleTimeUpdate = (forceResume = false) => {
    const player = videoRef.current;
    if (!player) return;
    if (useIntroTimelinePreview && introPreview) {
      const nextCursor = Math.min(introPreview.durationMs, player.currentTime * 1000);
      setCursor(nextCursor);
      const active = cues.find(
        (cue) =>
          cueScope(cue) === "INTRO" &&
          cue.reviewStatus !== "REJECTED" &&
          cue.startMs <= nextCursor &&
          cue.endMs > nextCursor,
      );
      if (active && active.id !== selectedId) setSelectedId(active.id);
      return;
    }
    if (!sourceSelection) return;
    const previewSourceStartMs =
      activeSourcePreview?.variant === "VIDEO_CLIP_PROXY" ? (activeSourcePreview.sourceStartMs ?? sourceSelection.sourceStartMs) : 0;
    const sourceTimeMs = previewSourceStartMs + player.currentTime * 1000;
    const segment = playbackSegments.find((item) => item.id === sourceSelection.segmentId);
    if (!segment) return;
    if (handoffSegmentIdRef.current === segment.id) return;
    const nextCursor = sourceTimeToProjectClockMs(segment, sourceTimeMs);
    setCursor(nextCursor);
    const ownershipSourceEndMs = projectClockToSourceMs(segment, segment.ownershipEndMs);
    if (sourceTimeMs >= ownershipSourceEndMs - 1) {
      const currentIndex = playbackSegments.findIndex((item) => item.id === segment.id);
      const next = playbackSegments[currentIndex + 1];
      if (next) {
        handoffSegmentIdRef.current = segment.id;
        continuePlaybackRef.current = continuePlaybackRef.current || forceResume || !player.paused;
        player.pause();
        setCursor((current) => Math.max(current, next.projectStartMs));
      } else {
        player.pause();
        setCursor(segment.ownershipEndMs);
      }
    }
  };

  const togglePlayback = () => {
    const player = videoRef.current;
    if (player) void (player.paused ? player.play() : Promise.resolve(player.pause()));
    else if (sourceSelection?.asset.kind === "IMAGE") setPreviewPlaying((playing) => {
      continuePlaybackRef.current = false;
      return !playing;
    });
  };
  useEffect(() => {
    if (!previewPlaying || useIntroTimelinePreview || sourceSelection?.asset.kind !== "IMAGE") return;
    imagePlaybackAnchorRef.current = {
      segmentId: sourceSelection.segmentId,
      projectMs: Math.max(sourceSelection.projectStartMs, Math.min(cursor, sourceSelection.ownershipEndMs)),
      wallMs: performance.now(),
    };
    const timer = window.setInterval(() => {
      const anchor = imagePlaybackAnchorRef.current;
      if (!anchor || anchor.segmentId !== sourceSelection.segmentId) return;
      setCursor((current) => {
        const nextClock = Math.max(current, anchor.projectMs + (performance.now() - anchor.wallMs) * playbackRate);
        if (nextClock < sourceSelection.ownershipEndMs) return nextClock;
        const index = playbackSegments.findIndex((item) => item.id === sourceSelection.segmentId);
        const next = playbackSegments[index + 1];
        if (next) {
          continuePlaybackRef.current = true;
          return Math.max(current, next.projectStartMs);
        }
        window.clearInterval(timer);
        setPreviewPlaying(false);
        return sourceSelection.ownershipEndMs;
      });
    }, 50);
    return () => {
      window.clearInterval(timer);
      if (imagePlaybackAnchorRef.current?.segmentId === sourceSelection.segmentId) imagePlaybackAnchorRef.current = undefined;
    };
  }, [previewPlaying, useIntroTimelinePreview, sourceSelection?.segmentId, sourceSelection?.asset.kind, playbackRate, playbackSegments]);
  const displayedDurationMs = useIntroTimelinePreview && introPreview
    ? introPreview.durationMs
    : playbackScope === "INTRO" ? introDurationMs : timelineDurationMs;
  const scrubberMinimumMs = 0;
  const scrubberMaximumMs = displayedDurationMs;
  const previewCanvasUnit = 100 / 480;
  const resolvedOverlayPosition = resolveSubtitleCuePosition(
    activeOverlayCue?.position,
    subtitleStyle.verticalPositionPercent,
    854,
    480,
  );
  const overlayAnchor = resolvedOverlayPosition.anchor;
  const overlayStyle = {
    left: `${resolvedOverlayPosition.xPercent}%`,
    top: `${resolvedOverlayPosition.yPercent}%`,
    // Grow the block the same way the burned ASS anchor does (top-down for
    // TOP, bottom-up for BOTTOM), otherwise multi-line previews drift.
    transform:
      overlayAnchor === "BOTTOM"
        ? "translate(-50%, -100%)"
        : overlayAnchor === "TOP"
          ? "translate(-50%, 0)"
          : "translate(-50%, -50%)",
    color: subtitleStyle.textColor,
    fontSize: `${subtitleFrameFontSize(subtitleStyle.fontSizePx, 480) * previewCanvasUnit}cqh`,
    WebkitTextStroke: `${subtitleFrameOutlineWidth(subtitleStyle.outlineWidthPx, 480) * previewCanvasUnit}cqh #000000`,
    textShadow: subtitleStyle.shadowEnabled
      ? `${subtitleFrameShadowSize(subtitleStyle.fontSizePx, 480) * previewCanvasUnit}cqh ${subtitleFrameShadowSize(subtitleStyle.fontSizePx, 480) * previewCanvasUnit}cqh 0 #000`
      : "none",
  };
  const canGenerate = selectedScopes.some((item) => (item === "INTRO" ? introDurationMs > 0 : timelineDurationMs > 0));

  return (
    <div className="modal-backdrop studio-backdrop" role="presentation">
      <section
        className="editor-modal subtitle-modal subtitle-review-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI 字幕審核與 SRT"
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">AI SUBTITLE REVIEW · 480P SYNC PREVIEW</span>
            <h2>片頭／正片畫面與故事字幕審核</h2>
            <p>
              AI 新字幕只會建立待確認草稿；確認後才可成為正式 SRT。素材換序或插入時會依目前{" "}
              {project.timelineTransitionSeconds} 秒疊化同步搬移字幕。
            </p>
          </div>
          <button className="icon-button" onClick={requestClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div
          className="subtitle-review-body"
          role="region"
          aria-label="字幕審核內容，可使用 Page Up、Page Down、Home 與 End 捲動"
          tabIndex={0}
          onKeyDown={(event) => {
            if (!(event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End")) return;
            const target = event.target;
            if (target instanceof Element && target.matches("input, textarea, select, [contenteditable='true']")) return;
            event.preventDefault();
            const body = event.currentTarget;
            const top = event.key === "Home" ? 0 : event.key === "End" ? body.scrollHeight :
              body.scrollTop + (event.key === "PageUp" ? -1 : 1) * Math.max(120, body.clientHeight * 0.8);
            body.scrollTo({ top, behavior: "smooth" });
          }}
        >
        {needsReview && (
          <div className="subtitle-global-warning" role="alert">
            ⚠ 片頭、正片順序或 IN／OUT 已改變；全部字幕時間需要重新複核。
          </div>
        )}
        {generating && (
          <div className="ai-analysis-progress" aria-live="polite">
            <span className="spinner" />
            <div>
              <strong>{phaseLabel(progress)}</strong>
              <small>{progress?.currentName ?? ""}</small>
              <progress max={Math.max(1, progress?.total ?? 1)} value={progress?.processed ?? 0} />
            </div>
            <span>
              {progress?.processed ?? 0} / {progress?.total ?? 0}
            </span>
            <button className="cancel-button" onClick={() => void window.sourceApp.cancelAiSubtitles()}>
              取消
            </button>
          </div>
        )}
        {buildingPreview && (
          <div className="subtitle-preview-progress" aria-live="polite">
            <span className="spinner" />
            <div>
              <strong>{previewPhaseLabel(previewProgress)}</strong>
              <progress max="100" value={previewProgress?.percent ?? 0} />
            </div>
            <span>{Math.round(previewProgress?.percent ?? 0)}%</span>
            <button className="cancel-button" onClick={() => void window.sourceApp.cancelSubtitleIntroPreview()}>
              取消代理
            </button>
          </div>
        )}
        {error && (
          <section className="subtitle-ai-failure" role="alert">
            <div>
              <strong>AI 字幕沒有產出</strong>
              <p>{error}</p>
              {error.includes("credit_balance_exhausted") || error.includes("沒有可用 API 額度") ? (
                <small>
                  片頭代理成功只代表本機 MP4 已完成，不代表 OpenAI API 可用。新版會自動再試 Codex／ChatGPT
                  登入；若此處仍顯示錯誤，請依後半段訊息確認 Codex 是否已登入，或取消勾選語音分析後重試。
                </small>
              ) : null}
            </div>
            <button className="settings-button" type="button" onClick={onOpenAiSettings}>
              開啟 AI 帳號設定
            </button>
            <button className="secondary-button" type="button" onClick={() => setError(undefined)}>
              收起錯誤
            </button>
          </section>
        )}
        <div className="subtitle-studio-toolbar">
          <div>
            <span>
              <strong>{counts.draft}</strong> 待確認
            </span>
            <span>
              <strong>{counts.confirmed}</strong> 已確認
            </span>
            <span>
              <strong>{counts.rejected}</strong> 已排除
            </span>
          </div>
          <div className="subtitle-ai-actions">
            <div className="subtitle-analysis-video" aria-label="AI 字幕分析影片">
              <strong>分析影片</strong>
              <span>{analysisVideo?.fileName ?? "尚未找到可用的成功成品"}</span>
              {analysisVideo?.durationMs ? (
                <small>
                  {formatDuration(analysisVideo.durationMs)} · {analysisVideo.width}×{analysisVideo.height} · {analysisVideo.frameRate ?? "FPS ?"} · {analysisVideo.videoCodec ?? "codec ?"}
                </small>
              ) : null}
              {analysisVideo?.outputPath ? (
                <details>
                  <summary>完整檔案資訊</summary>
                  <small>{analysisVideo.outputPath}</small>
                  <small>{analysisVideo.sizeBytes ? `${(analysisVideo.sizeBytes / 1024 ** 3).toFixed(2)} GiB` : "大小未知"} · 建立 {analysisVideo.createdAt ?? "未知"} · 修改 {analysisVideo.modifiedAt ?? "未知"}</small>
                </details>
              ) : null}
              <button className="secondary-button" type="button" onClick={() => void chooseAnalysisVideo()}>
                選擇影片／重新分析
              </button>
            </div>
            <fieldset className="subtitle-scope">
              <legend>產生／顯示範圍</legend>
              <label>
                <input
                  aria-label="片頭字幕"
                  type="checkbox"
                  checked={scope.intro}
                  disabled={!project.introSegments.length}
                  onChange={(event) => updateScope("intro", event.target.checked)}
                />{" "}
                片頭
              </label>
              <label>
                <input
                  aria-label="正片字幕"
                  type="checkbox"
                  checked={scope.main}
                  disabled={timelineDurationMs <= 0}
                  onChange={(event) => updateScope("main", event.target.checked)}
                />{" "}
                正片
              </label>
            </fieldset>
            <button
              className="secondary-button"
              type="button"
              disabled={generating || busy}
              onClick={() => void importFile()}
            >
              ⇧ 匯入 SRT
            </button>
            <button
              className="secondary-button force-subtitle-review-button"
              type="button"
              disabled={generating || buildingPreview || busy || !reviewableVisibleCues.length}
              onClick={requestForceReReview}
            >
              ↻ 強制重新校對
            </button>
            <label>
              <input
                aria-label="同時分析素材語音"
                type="checkbox"
                checked={includeSpeechTranscription}
                onChange={(event) => setIncludeSpeechTranscription(event.target.checked)}
              />{" "}
              同時分析素材語音（預設不勾）
            </label>
            <label className="ai-cue-count">
              目標字幕數
              <input
                aria-label="AI 目標字幕數"
                type="number"
                min="1"
                max="300"
                value={targetCueCount}
                disabled={generating || busy}
                onChange={(event) =>
                  setTargetCueCount(Math.max(1, Math.min(300, Math.round(Number(event.target.value) || 1))))
                }
              />
              <small>1–300；較長片段會增加取樣點，實際數量仍受片長及既有字幕影響。</small>
            </label>
            <label className="ai-mode-select">
              AI 重跑方式
              <select
                aria-label="AI 字幕重跑方式"
                value={aiRegenerationMode}
                disabled={generating || busy}
                onChange={(event) => setAiRegenerationMode(event.target.value as typeof aiRegenerationMode)}
              >
                <option value="FILL_BLANKS">填補空白（保留現有 AI）</option>
                <option value="PRESERVE_USER_EDITED">保留人工修改（重建未修改 AI）</option>
                <option value="REPLACE_AI_SCOPE">替換所選範圍 AI 字幕</option>
              </select>
            </label>
            <button className="settings-button" type="button" onClick={onOpenAiSettings}>
              ✦ AI 帳號／故事設定
            </button>
            <button
              className="ai-intro-button"
              type="button"
              disabled={generating || buildingPreview || busy || !canGenerate}
              onClick={() => void generate()}
            >
              AI 知識型字幕草稿
            </button>
          </div>
        </div>
        <section className="subtitle-visual-job" aria-label="字幕畫面分析工作">
          <div className="subtitle-visual-job-heading">
            <div>
              <strong>全片畫面字幕分析</strong>
              <small>ChatGPT 視覺需另行設定 OpenAI API；ChatGPT/Codex 登入不等於 API 憑證。Gemini 僅在此處選用時啟用。</small>
            </div>
            <span className={`subtitle-job-status is-${visualProgress.status.toLowerCase()}`} aria-live="polite">
              {visualProgress.status === "RUNNING"
                ? "分析中"
                : visualProgress.status === "PAUSED"
                  ? "已暫停"
                  : visualProgress.status === "COMPLETED"
                    ? "已完成"
                    : visualProgress.status === "CANCELLED"
                      ? "已取消"
                      : visualProgress.status === "FAILED"
                        ? "失敗"
                        : "尚未開始"}
            </span>
          </div>
          <div className="subtitle-visual-job-fields">
            <label>
              分析服務
              <select
                aria-label="字幕畫面分析服務"
                value={visualProvider}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setVisualProvider(event.target.value as MaterialAnalysisProvider)}
              >
                <option value="CHATGPT">ChatGPT 視覺（預設，需 OpenAI API 設定）</option>
                <option value="GEMINI">Gemini（選用）</option>
              </select>
            </label>
            <label>
              既有正式 SRT 保護
              <select
                aria-label="既有正式 SRT 保護方式"
                value={visualSrtPolicy}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setVisualSrtPolicy(event.target.value as typeof visualSrtPolicy)}
              >
                <option value="BACKUP">先備份再升級（預設）</option>
                <option value="SAVE_AS">另存新檔</option>
                <option value="OVERWRITE">確認後覆寫</option>
                <option value="CANCEL">取消，不開始分析</option>
              </select>
            </label>
            <label>
              產生語言
              <select aria-label="字幕畫面分析語言" value={visualDraftLanguage} onChange={(event) => setVisualDraftLanguage(event.target.value)}>
                <option value="zh-TW">繁體中文（台灣，預設）</option><option value="zh-CN">簡體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option>
              </select>
            </label>
            <label>
              取樣間隔（秒）
              <input
                aria-label="畫面取樣間隔"
                type="number"
                min="1"
                max="60"
                value={visualIntervalSeconds}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) =>
                  setVisualIntervalSeconds(Math.max(1, Math.min(60, Math.round(Number(event.target.value) || 1))))
                }
              />
            </label>
            <label>
              畫面密度
              <select
                aria-label="字幕分析畫面密度"
                value={visualDensity}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setVisualDensity(event.target.value as SubtitleVisualDensity)}
              >
                <option value="LOW">低</option>
                <option value="STANDARD">標準</option>
                <option value="DETAILED">詳細</option>
              </select>
            </label>
            <label className="subtitle-visual-context">
              影片標題
              <input
                aria-label="字幕分析影片標題"
                value={visualTitle}
                maxLength={240}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setVisualTitle(event.target.value)}
              />
            </label>
            <label className="subtitle-visual-context">
              影片描述／故事背景
              <textarea
                aria-label="字幕分析影片描述"
                value={visualDescription}
                maxLength={4000}
                rows={2}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setVisualDescription(event.target.value)}
              />
            </label>
            <label className="subtitle-visual-toggle">
              <input
                aria-label="偵測場景變化"
                type="checkbox"
                checked={detectSceneChanges}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setDetectSceneChanges(event.target.checked)}
              />{" "}
              場景變化補點
            </label>
            <label className="subtitle-visual-toggle">
              <input
                aria-label="去除重複畫面"
                type="checkbox"
                checked={deduplicateFrames}
                disabled={visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED"}
                onChange={(event) => setDeduplicateFrames(event.target.checked)}
              />{" "}
              感知去重
            </label>
            <label className="subtitle-visual-toggle">
              <input
                aria-label="AI 檢查現有字幕"
                type="checkbox"
                checked={projectAiCheckEnabled}
                disabled={visualProgress.status === "RUNNING"}
                onChange={(event) => setProjectAiCheckEnabled(event.target.checked)}
              />{" "}
              AI 檢查現有字幕（預設關閉）
            </label>
          </div>
          <div className="subtitle-visual-job-controls">
            <small>
              分析先建立 AI 待確認草稿，不會覆寫正式 SRT。相容影片可更新專案草稿；外部或時間線不相容影片會建立獨立字幕工作區，供檢視、修改與另存 SRT。
            </small>
            {(visualProgress.status === "IDLE" ||
              visualProgress.status === "COMPLETED" ||
              visualProgress.status === "CANCELLED" ||
              visualProgress.status === "FAILED") && (
              <button
                className="ai-intro-button"
                type="button"
                disabled={(!analysisVideo?.outputPath && !canGenerate) || generating || busy}
                onClick={() => void startVisualAnalysis()}
              >
                開始畫面分析
              </button>
            )}
            {visualProgress.status === "RUNNING" && (
              <button className="secondary-button" type="button" onClick={() => void controlVisualAnalysis("pause")}>
                暫停
              </button>
            )}
            {(visualProgress.status === "PAUSED" || visualProgress.status === "FAILED") && (
              <button className="secondary-button" type="button" onClick={() => void controlVisualAnalysis("resume")}>
                繼續
              </button>
            )}
            {(visualProgress.status === "RUNNING" || visualProgress.status === "PAUSED") && (
              <button className="cancel-button" type="button" onClick={() => void controlVisualAnalysis("cancel")}>
                取消分析
              </button>
            )}
            <span>
              原始 {visualProgress.rawFrames} · 場景 {visualProgress.sceneFrames} · 去重{" "}
              {visualProgress.deduplicatedFrames} · 已送出 {visualProgress.sentFrames} 張
            </span>
            <span>
              請求 {visualProgress.requests} · 經過 {formatDuration(visualProgress.elapsedMs)} · Token{" "}
              {visualProgress.tokens} · 快取命中 {visualProgress.cacheHits}
            </span>
            <span>暫存 {visualProgress.temporaryBytes.toLocaleString()} bytes</span>
            <span>{visualProgress.phase} {visualProgress.mode} {visualProgress.modelId ? `模型 ${visualProgress.modelId}` : ""}</span>
            <button
              type="button"
              className="secondary-button"
              disabled={!projectAiCheckEnabled || busy || analysisVideo?.reason !== "PROJECT_CONCAT"}
              onClick={() => void prepareProjectAiCheck()}
            >
              建立現有字幕 AI 檢查工作區
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !analysisVideo?.outputPath}
              onClick={() => void importStandaloneSrtReview()}
            >
              所選影片＋匯入既有 SRT（獨立草稿）
            </button>
            {projectAiCheckEnabled && analysisVideo?.reason !== "PROJECT_CONCAT" && <small>
              目前只有 legacy／外部影片，沒有帶目前 projectId 的成功輸出；為避免錯誤時間軸套回，請先建立新的專案輸出，或在獨立影片工作區檢查而不修改專案。
            </small>}
          </div>
          {visualProgress.error && (
            <small className="subtitle-visual-job-error" role="alert">
              {visualProgress.error}
            </small>
          )}
        </section>
        {visualPreflight && <section className="subtitle-visual-job" aria-label="字幕分析確認">
          <h3>開始前確認</h3>
          <p>{visualPreflight.videoPath}</p>
          <p>影片 {formatDuration(visualPreflight.videoDurationMs)}｜專案 {formatDuration(visualPreflight.projectDurationMs)}｜差 {(visualPreflight.differenceMs / 1000).toFixed(3)} 秒｜容差 {(visualPreflight.toleranceMs / 1000).toFixed(1)} 秒</p>
          <p>{visualPreflight.warning ?? "專案輸出與時間線相容，可使用片段脈絡。"}</p>
          <label>分析模式 <select aria-label="字幕分析模式" value={visualPreflight.recommendedMode} onChange={(event) => setVisualPreflight({ ...visualPreflight, recommendedMode: event.target.value as SubtitleVisualPreflight["recommendedMode"] })}>
            <option value="VIDEO_FIRST">影片時間軸：獨立草稿，不修改專案</option>
            {visualPreflight.recommendedMode === "PROJECT_AWARE" && <option value="PROJECT_AWARE">專案時間軸：更新待確認草稿</option>}
          </select></label>
          <p>每 {visualIntervalSeconds} 秒｜預估 {visualPreflight.rawFrameEstimate} 張（去重前）｜{visualPreflight.provider}｜模型 {visualPreflight.modelId ?? "開始時解析"}</p>
          <p>既有 SRT {visualPreflight.existingSrtCount} 筆｜專案字幕 {visualPreflight.projectSubtitleCount} 筆｜僅建立草稿；正式 SRT 不覆寫</p>
          <button type="button" onClick={() => void startVisualAnalysis(true)}>確認並開始分析</button>
          <button type="button" onClick={() => setVisualPreflight(undefined)}>取消</button>
        </section>}
        {standaloneWorkspace && <StandaloneSubtitleReview workspace={standaloneWorkspace} videoUrl={standaloneWorkspace.previewUrl} onUpdated={setStandaloneWorkspace} onProjectUpdated={onProjectUpdated} onError={setError} />}
        {overlappingIds.size > 0 && (
          <div className="subtitle-overlap-warning" role="alert">
            ⚠ 有 {overlappingIds.size}{" "}
            筆新舊字幕時間重疊，兩筆都會顯示紅色外框。請調整開始／結束時間，紅框消失後再確認。
          </div>
        )}
        {reviewQueueIds.length > 0 && selected && reviewQueueIds.includes(selected.id) && (
          <section className="subtitle-guided-review" aria-label="逐筆 Proxy 字幕校對" aria-live="polite">
            <div>
              <span className="eyebrow">FORCED TIMELINE REVIEW</span>
              <strong>
                第 {reviewQueueIds.indexOf(selected.id) + 1}／{reviewQueueIds.length} 筆：這個 Proxy
                畫面、字幕文字與頭尾時間是否一致？
              </strong>
              <p>已先依目前片頭／正片主軸與疊化時間重新對位；按下確認後會立即保存，再進到下一筆。</p>
            </div>
            <nav>
              <button
                className="confirm-cue"
                type="button"
                disabled={!activeSourcePreview || busy}
                onClick={() => void confirmReviewAndAdvance()}
              >
                ✓ 一致，確認、保存並下一筆
              </button>
              <button type="button" disabled={busy} onClick={editReviewCue}>
                不一致，修改文字／時間
              </button>
              <button type="button" disabled={busy} onClick={advanceReview}>
                暫時略過
              </button>
              <button className="secondary-button" type="button" onClick={() => setReviewQueueIds([])}>
                結束逐筆校對
              </button>
            </nav>
          </section>
        )}
        {scope.intro && project.introSegments.length > 0 && (
          <div
            className={`subtitle-intro-ai-state ${introOpenAiCount ? "has-cloud-analysis" : "is-local-only"}`}
            role="status"
          >
            片頭共 {project.introSegments.length} 段，其中 {introOpenAiCount} 段曾完成 OpenAI 人物／事件／故事比對。
            {introOpenAiCount === 0
              ? "目前片頭挑選是本機畫面統計備援，不能視為 AI 連線成功。"
              : "字幕仍會重新依畫面與故事背景建立草稿。"}
          </div>
        )}
        <div className="subtitle-review-layout">
          <aside className="subtitle-cue-list" ref={cueListRef} data-testid="project-subtitle-cue-list">
            {!visibleCues.length && (
              <div className="empty-mini">
                <strong>所選範圍還沒有字幕</strong>
                <p>可匯入 UTF-8 SRT、設定故事背景後建立 AI 草稿，或人工新增。</p>
              </div>
            )}
            {reviewableVisibleCues.length > 0 && (
              <div
                className="subtitle-selection-actions subtitle-global-actions"
                role="toolbar"
                aria-label="字幕全部操作"
              >
                <span>目前範圍 {reviewableVisibleCues.length} 筆</span>
                <button
                  type="button"
                  disabled={busy || generating || buildingPreview}
                  onClick={() => void toggleAllConfirmation()}
                >
                  {allVisibleConfirmed ? "全部取消確認並保存" : "全部確認並保存"}
                </button>
              </div>
            )}
            {selectedIds.size > 0 && (
              <div className="subtitle-selection-actions" role="toolbar" aria-label="字幕批次操作">
                <span>已選 {selectedIds.size} 筆</span>
                <button
                  type="button"
                  disabled={busy || generating || buildingPreview}
                  onClick={() => void confirmSelected()}
                >
                  確認選取並保存
                </button>
                <button
                  type="button"
                  disabled={busy || generating || buildingPreview}
                  onClick={() => void cancelConfirmation()}
                >
                  取消確認並保存
                </button>
                <button
                  type="button"
                  className="danger-text"
                  disabled={busy || generating || buildingPreview}
                  onClick={() => void deleteSelectedCues()}
                >
                  刪除選取
                </button>
              </div>
            )}
            {visibleCues.map((cue, index) => {
              const movable = cue.reviewStatus !== "REJECTED";
              const scoped = visibleCues.filter(
                (item) => cueScope(item) === cueScope(cue) && item.reviewStatus !== "REJECTED",
              );
              const scopedIndex = scoped.findIndex((item) => item.id === cue.id);
              const disabled = busy || generating || buildingPreview;
              return (
                <div
                  className={`subtitle-cue-row ${cue.id === activeOverlayCue?.id ? "is-active" : ""} ${overlappingIds.has(cue.id) ? "has-time-overlap" : ""}`}
                  key={cue.id}
                  ref={(node) => { if (node) cueRowRefs.current.set(cue.id, node); else cueRowRefs.current.delete(cue.id); }}
                  data-cue-id={cue.id}
                  onDoubleClick={() => jumpToCue(cue)}
                >
                  <div
                    className={`subtitle-cue-card ${selectedIds.has(cue.id) ? "is-selected" : ""} status-${cue.reviewStatus ?? "CONFIRMED"}`}
                  >
                    <button
                      type="button"
                      className="subtitle-cue-select"
                      aria-label={`選取字幕 ${cue.text}`}
                      aria-pressed={selectedIds.has(cue.id)}
                      title="點一下選取；按住 Shift 可連續複選"
                      onClick={(event) => selectCue(cue, event)}
                      onDoubleClick={(event) => { event.stopPropagation(); jumpToCue(cue); }}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </button>
                    <textarea
                      className="subtitle-cue-inline-editor"
                      aria-label={`直接編輯第 ${index + 1} 筆字幕`}
                      value={cue.text}
                      disabled={disabled}
                      spellCheck
                      title="點入後可直接定位文字游標並修改；按右側確認才會立即保存這筆內容。"
                      onFocus={() => {
                        if (selectedId !== cue.id) selectCue(cue);
                      }}
                      onChange={(event) => patchCue(cue.id, "text", event.target.value)}
                    />
                    <em>{overlappingIds.has(cue.id) ? "時間重疊" : statusLabel(cue.reviewStatus)}</em>
                    <small>
                      {cueScope(cue) === "INTRO" ? "片頭" : "正片"} · {formatExactCueTime(cue.startMs)} →{" "}
                      {formatExactCueTime(cue.endMs)} · 時長 {formatCueDuration(cue.startMs, cue.endMs)} · <span>{cueOrigin(cue)}</span> · 每行{" "}
                      {cue.lineWidthChars ?? defaultSubtitleLineWidth(cue.text)} 字
                      {cue.lineWidthChars === undefined ? "（自動）" : "（單筆）"} · 位置 X{" "}
                      {cue.position?.xPercent ?? 50}%／Y{" "}
                      {cue.position?.yPercent ?? subtitleStyle.verticalPositionPercent}%
                    </small>
                  </div>
                  <div className="subtitle-cue-row-actions" role="group" aria-label={`第 ${index + 1} 筆字幕操作`}>
                    <button
                      type="button"
                      aria-label={`跳到第 ${index + 1} 筆字幕`}
                      title="明確跳到這筆字幕的開始時間"
                      disabled={disabled}
                      onClick={() => jumpToCue(cue)}
                    >
                      ▶ 跳到
                    </button>
                    <button
                      type="button"
                      className="subtitle-cue-row-confirm"
                      aria-label={`確認並保存第 ${index + 1} 筆字幕`}
                      disabled={disabled || overlappingIds.has(cue.id)}
                      onClick={() => void setStatus(cue.id, "CONFIRMED")}
                    >
                      ✓ 確認
                    </button>
                    <button
                      type="button"
                      aria-label={`上移第 ${index + 1} 筆字幕`}
                      title="交換到上一筆的時間位置；兩筆會改回待確認並立即保存。"
                      disabled={disabled || !movable || scopedIndex <= 0}
                      onClick={() => void moveCueAndSave(cue.id, -1)}
                    >
                      ↑ 上移
                    </button>
                    <button
                      type="button"
                      aria-label={`下移第 ${index + 1} 筆字幕`}
                      title="交換到下一筆的時間位置；兩筆會改回待確認並立即保存。"
                      disabled={disabled || !movable || scopedIndex >= scoped.length - 1}
                      onClick={() => void moveCueAndSave(cue.id, 1)}
                    >
                      ↓ 下移
                    </button>
                    <button
                      type="button"
                      aria-label={`調整第 ${index + 1} 筆字幕每行字數`}
                      title={`可用鍵盤上下鍵或直接輸入 ${SUBTITLE_WRAP_MANUAL_MIN}–${SUBTITLE_WRAP_MANUAL_MAX}；只改這一筆。`}
                      disabled={disabled}
                      onClick={() => openLineWidthEditor(cue)}
                    >
                      ↔ 行寬
                    </button>
                    <button
                      type="button"
                      aria-label={`調整第 ${index + 1} 筆字幕畫面位置`}
                      title="用方向鍵微調 1%；Shift＋方向鍵調整 5%。"
                      disabled={disabled}
                      onClick={() => openPositionEditor(cue)}
                    >
                      ✥ 位置
                    </button>
                    <button
                      type="button"
                      className="subtitle-cue-row-delete danger-text"
                      aria-label="刪除這筆字幕"
                      title={`刪除字幕：${cue.text}`}
                      disabled={disabled}
                      onClick={() =>
                        void deleteCueIds(new Set([cue.id]), `這筆${cueScope(cue) === "INTRO" ? "片頭" : "正片"}字幕`)
                      }
                    >
                      刪除
                    </button>
                  </div>
                </div>
              );
            })}
            <button className="add-cue-button" type="button" disabled={selectedTimelineDurationMs <= 0} onClick={add}>
              ＋ 在 {formatDuration(cursor)} 新增人工字幕
            </button>
          </aside>
          <main className="subtitle-review-main">
            <section className="subtitle-video-stage">
              {useIntroTimelinePreview && introPreview && (
                <video
                  key={introPreview.url}
                  ref={videoRef}
                  src={introPreview.url}
                  preload="auto"
                  aria-label="480P 片頭字幕同步預覽"
                  onClick={togglePlayback}
                  onPlay={() => setPreviewPlaying(true)}
                  onPause={() => setPreviewPlaying(false)}
                  onTimeUpdate={() => handleTimeUpdate(false)}
                />
              )}
              {!useIntroTimelinePreview && !selected && (
                <div className="large-loading">
                  <p>從左側選取一筆字幕，或產生 480P 片頭預覽。</p>
                </div>
              )}
              {!useIntroTimelinePreview && selected && sourceSelection && !activeSourcePreview && !previewError && (
                <div className="large-loading">
                  <span className="spinner" />
                  <p>正在準備唯讀 proxy 預覽…</p>
                </div>
              )}
              {previewError && (
                <div className="preview-error">
                  <strong>影像預覽提示</strong>
                  <p>{previewError}</p>
                </div>
              )}
              {!useIntroTimelinePreview && selected && !sourceSelection && (
                <div className="large-loading">
                  <p>這筆字幕尚無可直接播放的影片來源；片頭可先建立整體 480P 代理。</p>
                </div>
              )}
              {!useIntroTimelinePreview && selected && sourceSelection?.asset.kind === "IMAGE" && activeSourcePreview && (
                <img
                  className="subtitle-source-image"
                  src={activeSourcePreview.url}
                  alt={`字幕對應畫面 ${sourceSelection.asset.fileName}`}
                />
              )}
              {!useIntroTimelinePreview && selected && sourceSelection?.asset.kind === "VIDEO" && activeSourcePreview && (
                <video
                  key={`${activeSourcePreview.url}:${sourceSelection.segmentId}`}
                  ref={videoRef}
                  src={activeSourcePreview.url}
                  preload="auto"
                  aria-label="字幕快速區段 Proxy 預覽"
                  onClick={togglePlayback}
                  onLoadedMetadata={(event) => {
                    const previewStartMs =
                      activeSourcePreview.variant === "VIDEO_CLIP_PROXY"
                        ? (activeSourcePreview.sourceStartMs ?? sourceSelection.sourceStartMs)
                        : 0;
                    const segment = playbackSegments.find((item) => item.id === sourceSelection.segmentId);
                    const sourceTimeMs = segment ? projectClockToSourceMs(segment, cursor) : sourceSelection.sourceStartMs;
                    event.currentTarget.playbackRate = playbackRate;
                    event.currentTarget.currentTime = Math.max(0, (sourceTimeMs - previewStartMs) / 1000);
                    if (continuePlaybackRef.current) {
                      void event.currentTarget.play().catch(() => undefined);
                    }
                  }}
                  onPlay={(event) => {
                    continuePlaybackRef.current = false;
                    handoffSegmentIdRef.current = undefined;
                    setPreviewPlaying(true);
                    const previewStartMs =
                      activeSourcePreview.variant === "VIDEO_CLIP_PROXY"
                        ? (activeSourcePreview.sourceStartMs ?? sourceSelection.sourceStartMs)
                        : 0;
                    const sourceTimeMs = previewStartMs + event.currentTarget.currentTime * 1000;
                    if (sourceTimeMs < sourceSelection.sourceStartMs || sourceTimeMs >= sourceSelection.sourceEndMs)
                      event.currentTarget.currentTime = Math.max(
                        0,
                        (sourceSelection.sourceStartMs - previewStartMs) / 1000,
                      );
                  }}
                  onPause={() => setPreviewPlaying(false)}
                  onCanPlay={(event) => { if (continuePlaybackRef.current) void event.currentTarget.play().catch(() => undefined); }}
                  onTimeUpdate={() => handleTimeUpdate(false)}
                  onEnded={() => handleTimeUpdate(true)}
                />
              )}
              {activeOverlayCue && (
                <div className="subtitle-overlay-preview" style={overlayStyle}>
                  {wrapSubtitleText(
                    activeOverlayCue.text,
                    resolveCueSubtitleWrapLimit(
                      activeOverlayCue.lineWidthChars,
                      subtitleStyle.maxCharactersPerLine,
                      activeOverlayCue.text,
                    ),
                  ).map((line, index, lines) => (
                    <span key={index}>
                      {line}
                      {index < lines.length - 1 && <br />}
                    </span>
                  ))}
                </div>
              )}
            </section>
            <div className="subtitle-time-scrubber">
              <button
                type="button"
                disabled={!activeSourcePreview && !introPreview}
                onClick={togglePlayback}
              >
                {previewPlaying ? "❚❚ 暫停" : "▶ 播放"}
              </button>
              <span>
                {useIntroTimelinePreview ? "片頭" : playbackScope === "INTRO" ? "片頭片段" : "正片"}{" "}
                {formatDuration(cursor)} / {formatDuration(displayedDurationMs)}
              </span>
              <label>
                速度
                <select
                  aria-label="字幕預覽播放速度"
                  value={playbackRate}
                  onChange={(event) => { const rate = Number(event.target.value); setPlaybackRate(rate); if (videoRef.current) videoRef.current.playbackRate = rate; }}
                >
                  <option value="0.5">0.5×</option>
                  <option value="0.75">0.75×</option>
                  <option value="1">1×</option>
                  <option value="1.25">1.25×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2×</option>
                </select>
              </label>
              <input
                aria-label="字幕預覽時間"
                type="range"
                min={scrubberMinimumMs}
                max={Math.max(scrubberMinimumMs + 1, scrubberMaximumMs)}
                step="50"
                value={Math.max(scrubberMinimumMs, Math.min(cursor, scrubberMaximumMs))}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  jumpToProjectTime(value);
                }}
              />
              <div className="subtitle-review-playback-buttons" role="group" aria-label="字幕預覽定位">
                <button type="button" aria-label="上一筆字幕" disabled={(!activeSourcePreview && !introPreview) || !adjacentCue(cues, playbackScope, navigationCueId, -1)} onClick={() => {
                  const target = adjacentCue(cues, playbackScope, navigationCueId, -1);
                  if (target) jumpToCue(target);
                }}>上一筆字幕</button>
                <button type="button" aria-label="下一筆字幕" disabled={(!activeSourcePreview && !introPreview) || !adjacentCue(cues, playbackScope, navigationCueId, 1)} onClick={() => {
                  const target = adjacentCue(cues, playbackScope, navigationCueId, 1);
                  if (target) jumpToCue(target);
                }}>下一筆字幕</button>
                <button type="button" aria-label="倒退兩秒" disabled={!activeSourcePreview && !introPreview} onClick={() => jumpToProjectTime(cursor - 2_000)}>−2 秒</button>
                <button type="button" aria-label="前進兩秒" disabled={!activeSourcePreview && !introPreview} onClick={() => jumpToProjectTime(cursor + 2_000)}>+2 秒</button>
                <button type="button" aria-label="回到目前字幕" disabled={!activeOverlayCue} onClick={returnToCurrentCue}>回到目前字幕</button>
              </div>
              <div className="subtitle-preview-mode">
                {project.introSegments.length > 0 && (
                  <button
                    type="button"
                    disabled={buildingPreview || generating}
                    onClick={() =>
                      introPreview
                        ? setUseIntroTimelinePreview((current) => !current)
                        : void buildIntroPreview().catch((reason: unknown) =>
                            setPreviewError(reason instanceof Error ? reason.message : String(reason)),
                          )
                    }
                  >
                    {useIntroTimelinePreview ? "改看單筆來源" : introPreview ? "播放片頭 480P" : "建立片頭 480P"}
                  </button>
                )}
              </div>
            </div>
            <section className="subtitle-style-panel" aria-label="字幕顯示格式">
              <label>
                高低位置{" "}
                <input
                  aria-label="字幕高低位置"
                  type="range"
                  min="10"
                  max="92"
                  value={subtitleStyle.verticalPositionPercent}
                  onChange={(event) =>
                    setSubtitleStyle((current) => ({ ...current, verticalPositionPercent: Number(event.target.value) }))
                  }
                />
                <span>{subtitleStyle.verticalPositionPercent}%</span>
              </label>
              <label>
                文字大小{" "}
                <input
                  aria-label="字幕文字大小"
                  type="number"
                  min="16"
                  max="72"
                  value={subtitleStyle.fontSizePx}
                  onChange={(event) =>
                    setSubtitleStyle((current) => ({ ...current, fontSizePx: Number(event.target.value) }))
                  }
                />
                <span>px</span>
              </label>
              <label>
                顏色{" "}
                <input
                  aria-label="字幕文字顏色"
                  type="color"
                  value={subtitleStyle.textColor}
                  onChange={(event) =>
                    setSubtitleStyle((current) => ({ ...current, textColor: event.target.value.toUpperCase() }))
                  }
                />
              </label>
              <label>
                <input
                  aria-label="字幕陰影"
                  type="checkbox"
                  checked={subtitleStyle.shadowEnabled}
                  onChange={(event) =>
                    setSubtitleStyle((current) => ({ ...current, shadowEnabled: event.target.checked }))
                  }
                />{" "}
                陰影
              </label>
              <label>
                外框{" "}
                <input
                  aria-label="字幕外框寬度"
                  type="number"
                  min="0"
                  max="8"
                  value={subtitleStyle.outlineWidthPx}
                  onChange={(event) =>
                    setSubtitleStyle((current) => ({ ...current, outlineWidthPx: Number(event.target.value) }))
                  }
                />
                <span>px</span>
              </label>
              <label>
                批次行寬{" "}
                <input
                  aria-label="字幕批次每行最多字數"
                  type="number"
                  min={SUBTITLE_WRAP_MANUAL_MIN}
                  max={SUBTITLE_WRAP_MANUAL_MAX}
                  placeholder="自動 12/20"
                  value={subtitleStyle.maxCharactersPerLine ?? ""}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    setSubtitleStyle((current) => ({
                      ...current,
                      // Commit the raw integer while typing; Main clamps to
                      // The Main process clamps 6–60 on save, so partial input never snaps around.
                      maxCharactersPerLine: raw === "" ? undefined : Math.floor(Number(raw) || 0),
                    }));
                  }}
                />
                <span>字{subtitleStyle.maxCharactersPerLine === undefined ? "（中文 12／英文或混合 20）" : ""}</span>
              </label>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void saveStyle()}>
                儲存顯示格式
              </button>
            </section>
            {selected && (
              <section className={`cue-review-editor ${overlappingIds.has(selected.id) ? "has-time-overlap" : ""}`}>
                <header>
                  <div>
                    <span className={`review-status status-${selected.reviewStatus ?? "CONFIRMED"}`}>
                      {statusLabel(selected.reviewStatus)}
                    </span>
                    <strong>
                      {cueScope(selected) === "INTRO" ? "片頭" : "正片"} · {cueOrigin(selected)}
                    </strong>
                    {selected.speaker && <small>說話者：{selected.speaker}</small>}
                  </div>
                  <button
                    type="button"
                    className="danger-text"
                    disabled={busy || generating || buildingPreview}
                    onClick={() => void deleteSelectedCue()}
                  >
                    刪除這筆（Delete）
                  </button>
                </header>
                <div className="cue-fields">
                  <label>
                    開始（分:秒.毫秒）
                    <TimecodeInput
                      label="字幕開始"
                      valueMs={selected.startMs}
                      maxMs={selectedTimelineDurationMs}
                      onChange={(value) => patchCue(selected.id, "startMs", value / 1000)}
                    />
                  </label>
                  <label>
                    結束（分:秒.毫秒）
                    <TimecodeInput
                      label="字幕結束"
                      valueMs={selected.endMs}
                      maxMs={selectedTimelineDurationMs}
                      onChange={(value) => patchCue(selected.id, "endMs", value / 1000)}
                    />
                  </label>
                  <label className="cue-text-field">
                    字幕文字
                    <textarea
                      ref={selectedTextEditorRef}
                      value={selected.text}
                      onChange={(event) => patchCue(selected.id, "text", event.target.value)}
                    />
                  </label>
                </div>
                {isEditableVisualDraft(selected) && (
                  <section className="cue-visual-draft-tools" aria-label="AI 畫面情境草稿工具">
                    <h3>畫面情境草稿調整</h3>
                    <label>
                      字幕語言（也用於下一次畫面分析）
                      <select
                        aria-label="修正文案語言"
                        value={visualDraftLanguage}
                        onChange={(event) => setVisualDraftLanguage(event.target.value)}
                      >
                        <option value="zh-TW">繁體中文</option>
                        <option value="zh-CN">簡體中文</option>
                        <option value="en">English</option>
                        <option value="ja">日本語</option>
                        <option value="ko">한국어</option>
                      </select>
                    </label>
                    <label>
                      修正內容／AI 指示（「套用本機」不呼叫 AI；「重新產生」才會呼叫）
                      <textarea
                        aria-label="本機修正指示"
                        value={localCorrectionText}
                        onChange={(event) => setLocalCorrectionText(event.target.value)}
                        placeholder="輸入這筆字幕的最終文案"
                      />
                    </label>
                    <div className="cue-review-actions">
                      <button
                        type="button"
                        disabled={busy || !localCorrectionText.trim()}
                        onClick={() => void applyLocalVisualCorrection()}
                      >
                        套用本機修正文案
                      </button>
                      <button
                        type="button"
                        disabled={busy || !localCorrectionText.trim() || !window.sourceApp.regenerateSubtitleVisualCue}
                        onClick={() => void regenerateSelectedVisualDrafts()}
                      >
                        依指示用附近畫面重新產生（最多 10 筆）
                      </button>
                      <button type="button" disabled={busy || !canMergePrevious} onClick={() => void mergeVisualDraft(previousVisualDraft)}>
                        與前一筆畫面草稿合併
                      </button>
                      <button type="button" disabled={busy || !canMergeNext} onClick={() => void mergeVisualDraft(nextVisualDraft)}>
                        與下一筆畫面草稿合併
                      </button>
                      <button
                        type="button"
                        disabled={busy || selected.text.trim().length < 2 || selected.endMs - selected.startMs < 2}
                        onClick={() => void splitVisualDraft()}
                      >
                        在時間中點拆分
                      </button>
                    </div>
                  </section>
                )}
                {(selected.visualSummary ||
                  selected.eventSummary ||
                  selected.peopleSummary?.length ||
                  selected.locationSummary?.length ||
                  selected.animalSpecies?.length) && (
                  <div className="ai-evidence">
                    <h3>AI 判斷依據（請人工核對）</h3>
                    <dl>
                      {selected.visualSummary && (
                        <>
                          <dt>畫面</dt>
                          <dd>{selected.visualSummary}</dd>
                        </>
                      )}
                      {selected.eventSummary && (
                        <>
                          <dt>事件</dt>
                          <dd>{selected.eventSummary}</dd>
                        </>
                      )}
                      {selected.peopleSummary?.length ? (
                        <>
                          <dt>人物</dt>
                          <dd>{selected.peopleSummary.join("、")}</dd>
                        </>
                      ) : null}
                      {selected.locationSummary?.length ? (
                        <>
                          <dt>地點</dt>
                          <dd>{selected.locationSummary.join("、")}</dd>
                        </>
                      ) : null}
                      {selected.animalSpecies?.length ? (
                        <>
                          <dt>物種</dt>
                          <dd>{selected.animalSpecies.join("、")}</dd>
                        </>
                      ) : null}
                      {selected.speciesExplanation ? (
                        <>
                          <dt>物種說明</dt>
                          <dd>{selected.speciesExplanation}</dd>
                        </>
                      ) : null}
                    </dl>
                    <div className="ai-score-row">
                      <span>
                        主題相關 <strong>{selected.topicRelevanceScore ?? "–"}</strong>
                      </span>
                      <span>
                        聲畫符合 <strong>{selected.transcriptVisualMatchScore ?? "–"}</strong>
                      </span>
                      <span>
                        AI 信心 <strong>{selected.aiConfidence ?? "–"}</strong>
                      </span>
                    </div>
                    {selected.aiWarnings?.length ? (
                      <ul>
                        {selected.aiWarnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
                <div className="cue-review-actions">
                  <button
                    type="button"
                    className="reject-cue"
                    disabled={busy}
                    onClick={() => void setStatus(selected.id, "REJECTED")}
                  >
                    排除並保存
                  </button>
                  <button type="button" disabled={busy} onClick={() => void setStatus(selected.id, "DRAFT")}>
                    改回待確認並保存
                  </button>
                  {reviewQueueIds.includes(selected.id) ? (
                    <button
                      type="button"
                      className="confirm-cue"
                      disabled={busy}
                      onClick={() => void confirmReviewAndAdvance()}
                    >
                      ✓ 修改完成、保存並下一筆
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="confirm-cue"
                      disabled={busy}
                      onClick={() => void setStatus(selected.id, "CONFIRMED")}
                    >
                      ✓ 確認並立即保存
                    </button>
                  )}
                </div>
              </section>
            )}
          </main>
        </div>
        <SharedIntroPreviewHistory
          refreshKey={previewHistoryRevision}
          title="片頭頁／字幕頁共用預覽"
          collapsible
          defaultCollapsed
        />
        {notice && (
          <div className="subtitle-result-notice" role="status">
            {notice}
          </div>
        )}
        </div>
        <footer className="settings-footer">
          <p>
            每筆確認、取消確認、上下移與刪除都會立即保存；底部按鈕只用來保存尚未確認的文字／時間修改。來源保持唯讀。
          </p>
          <div>
            {exporting && (
              <button className="cancel-button" onClick={() => void window.sourceApp.cancelSubtitleExport()}>
                取消匯出
              </button>
            )}
            <button
              className="secondary-button"
              disabled={busy || generating || buildingPreview || !localDirty}
              onClick={() => void save()}
            >
              保存未確認修改
            </button>
            <button
              className="secondary-button"
              disabled={busy || generating || buildingPreview || !counts.draft || !window.sourceApp.saveSubtitleAiDraft}
              onClick={() => void saveAiDraftFile()}
            >
              保存 {counts.draft} 筆 .ai-draft.srt
            </button>
            {savedDraftToken && (
              <button
                className="primary-button"
                disabled={busy || generating || buildingPreview || counts.draft > 0}
                onClick={() => void promoteSavedAiDraft()}
              >
                升級已確認草稿為正式 SRT
              </button>
            )}
            <button
              className="primary-button"
              disabled={busy || generating || buildingPreview || !counts.confirmed}
              onClick={() => void exportFile()}
            >
              匯出 {counts.confirmed} 筆已確認 SRT
            </button>
          </div>
        </footer>
        {lineWidthCueId && (
          <div className="inline-close-guard subtitle-line-width-dialog" role="dialog" aria-label="調整單筆字幕行寬">
            <strong>調整這一筆字幕的每行字數</strong>
            <p>中文預設 12；英文或中英混合預設 20。可直接輸入，或用鍵盤 ↑／↓ 微調。</p>
            <label>
              每行字數
              <input
                autoFocus
                aria-label="單筆字幕每行字數"
                type="number"
                min={SUBTITLE_WRAP_MANUAL_MIN}
                max={SUBTITLE_WRAP_MANUAL_MAX}
                step="1"
                value={lineWidthDraft}
                onChange={(event) => setLineWidthDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveLineWidth(false);
                }}
              />
              字
            </label>
            <button className="primary-button" disabled={busy} onClick={() => void saveLineWidth(false)}>
              儲存這一筆
            </button>
            <button className="secondary-button" disabled={busy} onClick={() => void saveLineWidth(true)}>
              恢復中文 12／英文或混合 20 自動預設
            </button>
            <SafeDefaultButton
              className="secondary-button"
              disabled={busy}
              onClick={() => setLineWidthCueId(undefined)}
            >
              取消，不修改
            </SafeDefaultButton>
          </div>
        )}
        {positionCueId &&
          (() => {
            const cue = cues.find((item) => item.id === positionCueId);
            if (!cue) return null;
            const position = resolveSubtitleCuePosition(cue.position, subtitleStyle.verticalPositionPercent, 100, 100);
            const positionButton = (label: string, direction: "UP" | "DOWN" | "LEFT" | "RIGHT", symbol: string) => (
              <button
                type="button"
                aria-label={`${label}第 ${visibleCues.findIndex((item) => item.id === cue.id) + 1} 筆字幕`}
                disabled={busy || generating || buildingPreview}
                onClick={(event) => void nudgePositionAndSave(cue.id, direction, event.shiftKey)}
              >
                {symbol} {label}
              </button>
            );
            return (
              <div
                ref={positionNudgeRef}
                className="inline-close-guard subtitle-position-dialog"
                role="dialog"
                aria-label="調整單筆字幕畫面位置"
                aria-describedby="subtitle-position-help"
                tabIndex={0}
                onKeyDown={(event) => handlePositionKeyDown(event, cue.id)}
              >
                <strong>調整這一筆字幕的位置</strong>
                <p id="subtitle-position-help">方向鍵微調 1%；Shift＋方向鍵移動 5%。每次調整都會立即保存。</p>
                <output aria-live="polite">
                  X {position.xPercent}%　Y {position.yPercent}%
                </output>
                <div className="subtitle-position-pad" role="group" aria-label="字幕位置方向控制">
                  <span />
                  {positionButton("上移", "UP", "↑")}
                  <span />
                  {positionButton("左移", "LEFT", "←")}
                  {positionButton("下移", "DOWN", "↓")}
                  {positionButton("右移", "RIGHT", "→")}
                </div>
                <button
                  className="secondary-button"
                  disabled={busy || generating || buildingPreview}
                  onClick={() => void resetPositionAndSave(cue.id)}
                >
                  恢復中央／全域高低位置
                </button>
                <SafeDefaultButton
                  className="secondary-button"
                  disabled={busy || generating || buildingPreview}
                  onClick={() => setPositionCueId(undefined)}
                >
                  完成
                </SafeDefaultButton>
              </div>
            );
          })()}
        {forceReviewPrompt && (
          <div className="inline-close-guard" role="alertdialog" aria-label="強制重新校對字幕">
            <strong>依目前片頭／正片主軸逐筆重新校對？</strong>
            <p>
              App 會先依目前順序、IN／OUT 與疊化時間刷新字幕對位，再以短區段 Proxy
              逐筆詢問「一致」或「不一致，修改」。字幕文字不會刪除。
            </p>
            <button className="primary-button" disabled={busy} onClick={() => void forceReReview()}>
              確認，開始逐筆校對
            </button>
            <SafeDefaultButton className="secondary-button" disabled={busy} onClick={() => setForceReviewPrompt(false)}>
              取消，不重設
            </SafeDefaultButton>
          </div>
        )}
        {closePrompt && (
          <div className="inline-close-guard" role="alertdialog" aria-label="字幕未保存">
            <strong>字幕有未保存修改</strong>
            <p>要先保存再離開，還是放棄這次修改？</p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                if (await save()) {
                  setClosePrompt(false);
                  onClose();
                }
              }}
            >
              保存並離開
            </button>
            <button
              className="danger-secondary-button"
              disabled={busy}
              onClick={() => {
                setLocalDirty(false);
                setClosePrompt(false);
                onClose();
              }}
            >
              放棄並離開
            </button>
            <SafeDefaultButton className="secondary-button" disabled={busy} onClick={() => setClosePrompt(false)}>
              返回編輯
            </SafeDefaultButton>
          </div>
        )}
      </section>
    </div>
  );
}
