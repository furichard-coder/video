import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConcatRenderProgress,
  IntroAnalysisProgress,
  IntroAnalysisResult,
  IntroSuggestion,
  ProjectManifest,
  SourceAsset,
  ColorPresetId,
  SubtitlePreviewResult,
} from "../../shared/domain";
import {
  DEFAULT_IMAGE_DURATION_MS,
  DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  DEFAULT_INTRO_TARGET_DURATION_MS,
  INTRO_DURATION_WARNING_MS,
  INTRO_EDIT_MIN_SEGMENT_MS,
  INTRO_MAX_SEGMENT_MS,
  INTRO_MAX_SEGMENTS,
  INTRO_MIN_SEGMENT_MS,
  MAX_IMAGE_DURATION_MS,
  MIN_IMAGE_DURATION_MS,
} from "../../shared/domain";
import { formatDuration, formatMinuteSecondInput, parseMinuteSecondInput } from "../format";
import { ClipRangeControl } from "./ClipRangeControl";
import { ConcatRenderModal } from "./ConcatRenderModal";
import { COLOR_PRESETS, colorPreset } from "../../shared/color-presets";
import { introSegmentsForOutput } from "../../shared/intro-duration";
import { SharedIntroPreviewHistory } from "./SharedIntroPreviewHistory";
import { ShortsStudio } from "./ShortsStudio";
import { InsertionAudioControls } from "./InsertionAudioControls";
import { buildInsertionAudioPlan } from "../../shared/insertion-audio-plan";
import { PHOTO_SOUND_PREVIEW_URL } from "../../shared/domain";

interface IntroStudioProps {
  project: ProjectManifest;
  videos: SourceAsset[];
  onClose: () => void;
  onProjectUpdated: (project: ProjectManifest) => void;
  onOpenMaterialAnalysis?: (asset: SourceAsset) => void;
}

interface IntroPreviewMedia {
  url: string;
  mode: "ORIGINAL" | "CLIP_PROXY" | "IMAGE";
}

interface IntroThumbnailState {
  signature: string;
  url: string;
}

function introThumbnailSignature(item: IntroSuggestion): string {
  return `${item.assetId}:${Math.round(item.inMs)}:${Math.round(item.outMs)}`;
}

function phaseLabel(progress?: IntroAnalysisProgress): string {
  if (!progress || progress.phase === "PREPARING") return "準備影片資訊與有效快取…";
  if (progress.phase === "RANKING") return "正在排序並避免重複片段…";
  return `正在抽樣 ${progress.currentName ?? "影片"}…`;
}

function manualSuggestion(asset: SourceAsset, maxSegmentDurationMs: number): IntroSuggestion {
  if (asset.kind === "IMAGE") {
    const durationMs = Math.max(
      MIN_IMAGE_DURATION_MS,
      Math.min(MAX_IMAGE_DURATION_MS, maxSegmentDurationMs, asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS),
    );
    return {
      id: crypto.randomUUID(),
      assetId: asset.id,
      fileName: asset.fileName,
      inMs: 0,
      outMs: durationMs,
      score: 0,
      reasons: ["手動加入照片"],
      origin: "MANUAL",
      analysisMode: "LOCAL_SIGNAL_ONLY",
    };
  }
  const fullDurationMs = asset.mediaInfo?.durationMs ?? 0;
  const sourceRange = asset.previewRange ?? { inMs: 0, outMs: fullDurationMs };
  if (sourceRange.outMs - sourceRange.inMs < INTRO_MIN_SEGMENT_MS)
    throw new Error(`「${asset.fileName}」可用範圍少於 3 秒，不能加入片頭。`);
  const durationMs = Math.min(5_000, INTRO_MAX_SEGMENT_MS, maxSegmentDurationMs, sourceRange.outMs - sourceRange.inMs);
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    fileName: asset.fileName,
    inMs: sourceRange.inMs,
    outMs: sourceRange.inMs + durationMs,
    score: 0,
    reasons: ["手動加入影片"],
    origin: "MANUAL",
    analysisMode: "LOCAL_SIGNAL_ONLY",
  };
}

export function IntroStudio({ project, videos, onClose, onProjectUpdated, onOpenMaterialAnalysis }: IntroStudioProps) {
  const [assets, setAssets] = useState(project.sources);
  const [analysis, setAnalysis] = useState<IntroAnalysisResult | undefined>(() =>
    project.introAnalysisResult ? structuredClone(project.introAnalysisResult) : undefined,
  );
  const [analysisAppliedAt, setAnalysisAppliedAt] = useState<string>();
  const [progress, setProgress] = useState<IntroAnalysisProgress>();
  const [suggestions, setSuggestions] = useState<IntroSuggestion[]>(() => structuredClone(project.introSegments));
  const [selectedId, setSelectedId] = useState<string | undefined>(() => project.introSegments[0]?.id);
  const [manualAssetId, setManualAssetId] = useState(project.sources[0]?.id ?? "");
  const [targetDurationText, setTargetDurationText] = useState(() =>
    formatMinuteSecondInput(project.introTargetDurationMs ?? DEFAULT_INTRO_TARGET_DURATION_MS),
  );
  const [segmentMaxSecondsText, setSegmentMaxSecondsText] = useState(() =>
    String((project.introSegmentMaxDurationMs ?? DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS) / 1000),
  );
  const [introPrompt, setIntroPrompt] = useState(project.aiStoryContext.introPrompt ?? "");
  const [baseAssetId, setBaseAssetId] = useState(project.aiStoryContext.introBaseAssetId ?? "");
  const [preview, setPreview] = useState<IntroPreviewMedia>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewRetry, setPreviewRetry] = useState(0);
  const [proxyFallbackSegmentId, setProxyFallbackSegmentId] = useState<string>();
  const [analyzing, setAnalyzing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showOutput, setShowOutput] = useState(false);
  const [showShorts, setShowShorts] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewCurrentMs, setPreviewCurrentMs] = useState(0);
  const [loopMode, setLoopMode] = useState<"ALL" | "SINGLE">("ALL");
  const [imageLoopCycle, setImageLoopCycle] = useState(0);
  const [includeBgmPreview, setIncludeBgmPreview] = useState(false);
  const [bgmPreview, setBgmPreview] = useState<SubtitlePreviewResult>();
  const [bgmPreviewProgress, setBgmPreviewProgress] = useState<ConcatRenderProgress>();
  const [buildingBgmPreview, setBuildingBgmPreview] = useState(false);
  const [previewHistoryRevision, setPreviewHistoryRevision] = useState(0);
  const [draggingSuggestionId, setDraggingSuggestionId] = useState<string>();
  const [dragTargetSuggestionId, setDragTargetSuggestionId] = useState<string>();
  const [introThumbnails, setIntroThumbnails] = useState<Record<string, IntroThumbnailState>>({});
  const [thumbnailErrors, setThumbnailErrors] = useState<Record<string, true>>({});
  const [thumbnailReloadRevision, setThumbnailReloadRevision] = useState(0);
  const [expandedSegmentId, setExpandedSegmentId] = useState<string>();
  const [moreMenuSegmentId, setMoreMenuSegmentId] = useState<string>();
  const thumbnailNodesRef = useRef(new Map<string, HTMLElement>());
  const thumbnailObserverRef = useRef<IntersectionObserver | undefined>(undefined);
  const thumbnailRequestsRef = useRef(new Set<string>());
  const videoRef = useRef<HTMLVideoElement>(null);
  const insertionSfxRef = useRef<HTMLAudioElement>(null);
  const insertionBgmRef = useRef<HTMLAudioElement>(null);
  const previousInsertionBgmRef = useRef<string | undefined>(undefined);
  const bgmPreviewRef = useRef<HTMLVideoElement>(null);
  const advancingRef = useRef(false);
  const projectRef = useRef(project);
  const introDragOrderRef = useRef<IntroSuggestion[] | undefined>(undefined);
  const introDraggedIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const api = window.sourceApp as typeof window.sourceApp & {
      ensureIntroThumbnail?: (assetId: string, inMs: number, outMs: number) => Promise<{ url: string }>;
    };
    const ensureIntroThumbnail = api.ensureIntroThumbnail;
    if (!ensureIntroThumbnail) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const segmentId = (entry.target as HTMLElement).dataset.segmentId;
          const item = suggestions.find((candidate) => candidate.id === segmentId);
          if (!item) return;
          const signature = introThumbnailSignature(item);
          if (introThumbnails[item.id]?.signature === signature || thumbnailRequestsRef.current.has(signature)) return;
          observer.unobserve(entry.target);
          thumbnailRequestsRef.current.add(signature);
          setThumbnailErrors((current) => {
            if (!current[item.id]) return current;
            const next = { ...current };
            delete next[item.id];
            return next;
          });
          void ensureIntroThumbnail(item.assetId, item.inMs, item.outMs).then((result) => {
            setIntroThumbnails((current) => ({ ...current, [item.id]: { signature, url: result.url } }));
          }).catch(() => {
            setThumbnailErrors((current) => ({ ...current, [item.id]: true }));
          }).finally(() => {
            thumbnailRequestsRef.current.delete(signature);
          });
        });
      },
      { rootMargin: "160px 0px" },
    );
    thumbnailObserverRef.current = observer;
    thumbnailNodesRef.current.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [suggestions, introThumbnails, thumbnailReloadRevision]);

  const registerThumbnailNode = (segmentId: string, node: HTMLElement | null) => {
    const previous = thumbnailNodesRef.current.get(segmentId);
    if (previous && previous !== node) thumbnailObserverRef.current?.unobserve(previous);
    if (node) {
      node.dataset.segmentId = segmentId;
      thumbnailNodesRef.current.set(segmentId, node);
      thumbnailObserverRef.current?.observe(node);
    } else thumbnailNodesRef.current.delete(segmentId);
  };

  const selected = suggestions.find((item) => item.id === selectedId);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const selectedAsset = selected ? assetById.get(selected.assetId) : undefined;
  const insertionAudioPlan = useMemo(
    () => buildInsertionAudioPlan({ ...project, sources: assets, introSegments: suggestions }, { purpose: "INTRO" }),
    [project, assets, suggestions],
  );
  const insertionAudioByInstance = useMemo(
    () => new Map(insertionAudioPlan.items.map((item) => [item.instanceId, item])),
    [insertionAudioPlan],
  );
  const selectedInsertionAudio = selected
    ? insertionAudioPlan.items.find((item) => item.instanceId === selected.id)
    : undefined;
  const selectedInsertionBgm = selectedInsertionAudio?.bgmTrackId
    ? project.bgmTracks.find((track) => track.id === selectedInsertionAudio.bgmTrackId)
    : undefined;
  const selectedDisplayWidth = selectedAsset?.mediaInfo?.displayWidth ?? selectedAsset?.mediaInfo?.width ?? 16;
  const selectedDisplayHeight = selectedAsset?.mediaInfo?.displayHeight ?? selectedAsset?.mediaInfo?.height ?? 9;
  const selectedActiveZoom = selectedAsset?.zoomSegments?.find(
    (segment) => previewCurrentMs >= segment.startMs && previewCurrentMs < segment.endMs,
  );
  const totalDurationMs = suggestions.reduce((sum, item) => sum + item.outMs - item.inMs, 0);
  const parsedTargetDurationMs = parseMinuteSecondInput(targetDurationText);
  const effectiveTargetDurationMs =
    parsedTargetDurationMs ?? project.introTargetDurationMs ?? DEFAULT_INTRO_TARGET_DURATION_MS;
  const outputSegmentMaxMs = project.introSegmentMaxDurationMs ?? DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS;
  const outputSuggestions = useMemo(
    () => introSegmentsForOutput(suggestions, outputSegmentMaxMs),
    [suggestions, outputSegmentMaxMs],
  );
  const outputTotalDurationMs = outputSuggestions.reduce((sum, item) => sum + item.outMs - item.inMs, 0);
  const warningSuggestions = suggestions.filter((item) => {
    const durationMs = item.outMs - item.inMs;
    return durationMs < INTRO_MIN_SEGMENT_MS || durationMs > outputSegmentMaxMs;
  });
  const hasInvalidSegmentDuration = suggestions.some((item) => {
    const durationMs = item.outMs - item.inMs;
    return durationMs < INTRO_EDIT_MIN_SEGMENT_MS;
  });
  const introLimitExceeded =
    suggestions.length > INTRO_MAX_SEGMENTS ||
    outputTotalDurationMs > effectiveTargetDurationMs ||
    hasInvalidSegmentDuration;
  const introDurationWarning = totalDurationMs > INTRO_DURATION_WARNING_MS;
  const cloudAnalyzedCount =
    analysis?.cloudAnalyzedCount ?? suggestions.filter((item) => item.analysisMode === "OPENAI_STORY_MATCH").length;
  const analysisMode = cloudAnalyzedCount > 0 ? "OPENAI_STORY_MATCH" : "LOCAL_SIGNAL_ONLY";
  const activeColorPreset = colorPreset(project.colorSettings.introPresetId);
  const confirmedIntroSubtitleCount = project.subtitleCues.filter(
    (cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" && (cue.timelineScope ?? "MAIN") === "INTRO",
  ).length;
  const introSubtitlesNeedReview =
    project.subtitleCues.some((cue) => (cue.timelineScope ?? "MAIN") === "INTRO") &&
    (project.introSubtitleReviewRevision ?? project.subtitleTimelineRevision) !==
      (project.introTimelineRevision ?? project.timelineRevision);

  useEffect(() => {
    const closeMoreMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreMenuSegmentId(undefined);
    };
    window.addEventListener("keydown", closeMoreMenu);
    return () => window.removeEventListener("keydown", closeMoreMenu);
  }, []);

  useEffect(() => {
    window.sourceApp.onIntroAnalysisProgress(setProgress);
    window.sourceApp.onSubtitlePreviewProgress(setBgmPreviewProgress);
    void window.sourceApp
      .getUserPreferences()
      .then((preferences) => setIncludeBgmPreview(preferences.renderDefaults.introPreviewIncludeBgm))
      .catch(() => undefined);
    return () => {
      window.sourceApp.clearIntroAnalysisProgressListeners();
      window.sourceApp.clearSubtitlePreviewProgressListeners();
    };
  }, []);

  useEffect(() => {
    projectRef.current = project;
    setAssets(project.sources);
    if (!manualAssetId && project.sources[0]) setManualAssetId(project.sources[0].id);
  }, [project, manualAssetId]);

  useEffect(() => {
    if (!selected || !selectedAsset) {
      setPreview(undefined);
      return;
    }
    let active = true;
    let completed = false;
    const requestedInMs = selected.inMs;
    const requestedOutMs = selected.outMs;
    const useClipProxy = selectedAsset.kind === "VIDEO" && proxyFallbackSegmentId === selected.id;
    setPreview(undefined);
    setPreviewError(undefined);
    void (async () => {
      const ready = await window.sourceApp.ensureMetadata(selected.assetId);
      if (!active) return;
      setAssets((current) => current.map((asset) => (asset.id === ready.id ? ready : asset)));
      if (ready.kind === "IMAGE") {
        const result = await window.sourceApp.ensurePreview(selected.assetId, "IMAGE_PREVIEW");
        if (!active) return;
        completed = true;
        setPreview({ url: result.url, mode: "IMAGE" });
      } else if (useClipProxy) {
        const result = await window.sourceApp.ensureClipPreview(selected.assetId, requestedInMs, requestedOutMs);
        if (!active) return;
        completed = true;
        setPreview({ url: result.url, mode: "CLIP_PROXY" });
      } else {
        completed = true;
        setPreview({
          url: `source-media://asset/${encodeURIComponent(selected.assetId)}?key=${encodeURIComponent(ready.previewCacheKey)}`,
          mode: "ORIGINAL",
        });
      }
    })().catch((reason: unknown) => {
      if (!active || (reason instanceof Error && reason.name === "AbortError")) return;
      setPreviewError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      if (!completed) {
        if (useClipProxy) void window.sourceApp.cancelClipPreview(selected.assetId, requestedInMs, requestedOutMs);
        else if (selectedAsset.kind === "IMAGE") void window.sourceApp.cancelPreview(selected.assetId, "IMAGE_PREVIEW");
      }
    };
  }, [selected?.id, selected?.assetId, selectedAsset?.kind, proxyFallbackSegmentId, previewRetry]);

  const applyProject = (updated: ProjectManifest) => {
    projectRef.current = updated;
    onProjectUpdated(updated);
    setAssets(updated.sources);
    setSuggestions(updated.introSegments);
    setTargetDurationText(formatMinuteSecondInput(updated.introTargetDurationMs ?? DEFAULT_INTRO_TARGET_DURATION_MS));
    setSegmentMaxSecondsText(
      String((updated.introSegmentMaxDurationMs ?? DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS) / 1000),
    );
    setManualAssetId((current) =>
      updated.sources.some((asset) => asset.id === current) ? current : (updated.sources[0]?.id ?? ""),
    );
    setSelectedId((current) =>
      updated.introSegments.some((item) => item.id === current) ? current : updated.introSegments[0]?.id,
    );
  };

  const readTargetDuration = (): number | undefined => {
    const durationMs = parseMinuteSecondInput(targetDurationText);
    if (durationMs === undefined || durationMs < INTRO_MIN_SEGMENT_MS) {
      setError("片頭目標時間至少需要 0:03，例如 1:30 或 4:00。");
      return undefined;
    }
    return durationMs;
  };

  const saveTargetDuration = async (): Promise<number | undefined> => {
    const durationMs = readTargetDuration();
    if (durationMs === undefined) return undefined;
    applyProject(await window.sourceApp.setIntroTargetDuration(durationMs));
    return durationMs;
  };

  const readSegmentMaxDuration = (): number | undefined => {
    const seconds = Number(segmentMaxSecondsText);
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 22) {
      setError("每段最高時間請輸入 3 到 22 秒，例如 15。");
      return undefined;
    }
    return Math.round(seconds * 1000);
  };

  const saveSegmentMaxDuration = async (): Promise<number | undefined> => {
    const durationMs = readSegmentMaxDuration();
    if (durationMs === undefined) return undefined;
    const updated = await window.sourceApp.setIntroSegmentMaxDuration(durationMs);
    applyProject(updated);
    setNotice(
      updated.introSegments.length
        ? `已將每段限制在 ${durationMs / 1000} 秒內，並依片頭總長盡量平均分配；較短來源與照片仍受可用長度限制。`
        : `已保存每段最高 ${durationMs / 1000} 秒；下一次分析會依此平均分配。`,
    );
    return durationMs;
  };

  const applyDurationPlan = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      if ((await saveTargetDuration()) === undefined) return;
      await saveSegmentMaxDuration();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveIntroDirection = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await window.sourceApp.setAiStoryContext({
        ...projectRef.current.aiStoryContext,
        introPrompt: introPrompt.trim(),
        introBaseAssetId: baseAssetId || undefined,
      });
      applyProject(updated);
      setNotice("片頭文字指示與基底素材已保存；重新分析時會優先依此判斷人物、事件與故事。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const applyCompletedAnalysis = async (
    result: IntroAnalysisResult,
    targetDurationMs: number,
  ): Promise<ProjectManifest> => {
    const refreshed = await window.sourceApp.getProject();
    const activeAssetIds = new Set(videos.map((video) => video.id));
    const preserved = refreshed.introSegments.filter(
      (segment) => segment.origin === "MANUAL" || !activeAssetIds.has(segment.assetId),
    );
    const candidates = result.suggestions.filter((segment) => !refreshed.introExcludedSegmentIds.includes(segment.id));
    const next = [...preserved];
    let usedMs = next.reduce((sum, segment) => sum + segment.outMs - segment.inMs, 0);
    for (const candidate of candidates) {
      const durationMs = candidate.outMs - candidate.inMs;
      if (
        next.length >= INTRO_MAX_SEGMENTS ||
        usedMs + durationMs > targetDurationMs ||
        next.some((segment) => segment.id === candidate.id)
      )
        continue;
      next.push(candidate);
      usedMs += durationMs;
    }
    const updated = await window.sourceApp.setIntroSegments(next);
    applyProject(updated);
    setAnalysis(result);
    setAnalysisAppliedAt(result.generatedAt);
    setNotice(
      result.analysisMode === "OPENAI_STORY_MATCH"
        ? `已套用最近 ${result.cloudAnalyzedCount ?? 0} 段 OpenAI 人物／事件／故事比對。`
        : "已套用最近一次片頭分析候選；請逐段確認。",
    );
    return updated;
  };

  const runAnalysis = async () => {
    const analysisVideos = baseAssetId ? videos.filter((video) => video.id === baseAssetId) : videos;
    if (!analysisVideos.length) {
      setError(
        baseAssetId
          ? "指定的基底影片目前不在可分析的正片影片中，請重新選擇。"
          : "正片目前沒有可供自動分析的影片；仍可用下方按鈕手動加入影片或照片。",
      );
      return;
    }
    setError(undefined);
    setNotice(undefined);
    let targetDurationMs: number;
    let maxSegmentDurationMs: number;
    try {
      applyProject(
        await window.sourceApp.setAiStoryContext({
          ...projectRef.current.aiStoryContext,
          introPrompt: introPrompt.trim(),
          introBaseAssetId: baseAssetId || undefined,
        }),
      );
      const saved = await saveTargetDuration();
      if (saved === undefined) return;
      targetDurationMs = saved;
      const savedMaximum = await saveSegmentMaxDuration();
      if (savedMaximum === undefined) return;
      maxSegmentDurationMs = savedMaximum;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setAnalyzing(true);
    setCancelling(false);
    setAnalysis(undefined);
    setProgress({ phase: "PREPARING", processed: 0, total: analysisVideos.length });
    try {
      const result = await window.sourceApp.analyzeIntro(
        analysisVideos.map((video) => video.id),
        targetDurationMs,
        maxSegmentDurationMs,
      );
      const updated = await applyCompletedAnalysis(result, targetDurationMs);
      setNotice(
        result.analysisMode === "OPENAI_STORY_MATCH"
          ? `已完成 ${result.cloudAnalyzedCount ?? 0} 段 OpenAI 人物／事件／故事比對。`
          : "已完成本機候選挑選；OpenAI 語意比對未完成，請查看原因。",
      );
      if (!updated.introSegments.length) setError("沒有產生可用建議；請確認影片 codec 與時長資訊，或手動加入素材。");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("取消") ? "精彩片頭分析已取消。" : message);
    } finally {
      setAnalyzing(false);
      setCancelling(false);
      setProgress(undefined);
    }
  };

  const persistSuggestions = async (next: IntroSuggestion[], focusId?: string) => {
    const updated = await window.sourceApp.setIntroSegments(next);
    applyProject(updated);
    if (focusId) setSelectedId(focusId);
  };

  const addExistingAsset = async (assetId = manualAssetId) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const targetDurationMs = readTargetDuration();
      if (targetDurationMs === undefined) return;
      const maxSegmentDurationMs = readSegmentMaxDuration();
      if (maxSegmentDurationMs === undefined) return;
      if (!assetId) throw new Error("請先選擇要加入片頭的影片或照片。");
      const ready = await window.sourceApp.ensureMetadata(assetId);
      const segment = manualSuggestion(ready, maxSegmentDurationMs);
      if (suggestions.length >= INTRO_MAX_SEGMENTS) throw new Error(`片頭最多只能保留 ${INTRO_MAX_SEGMENTS} 段。`);
      if (totalDurationMs + segment.outMs - segment.inMs > targetDurationMs)
        throw new Error("加入後會超過目前片頭最長時間；請先增加上限或縮短其他片段。");
      const updated = await window.sourceApp.setIntroSegments([...suggestions, segment]);
      applyProject(updated);
      setSelectedId(segment.id);
      setNotice(`已把「${ready.fileName}」加入片頭；來源檔保持唯讀。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const chooseIntroFiles = async () => {
    setImporting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.sourceApp.chooseIntroFiles();
      if (result.cancelled) return;
      applyProject(result.project);
      if (!result.addedAssetIds.length) {
        setNotice(
          result.duplicateCount
            ? "選取檔案已在專案中，請從『專案既有素材』選擇加入片頭。"
            : "沒有加入可用的影片或照片。",
        );
        return;
      }
      const targetDurationMs = readTargetDuration();
      if (targetDurationMs === undefined) return;
      const maxSegmentDurationMs = readSegmentMaxDuration();
      if (maxSegmentDurationMs === undefined) return;
      const next = [...result.project.introSegments];
      let usedMs = next.reduce((sum, segment) => sum + segment.outMs - segment.inMs, 0);
      let lastAddedId: string | undefined;
      for (const assetId of result.addedAssetIds) {
        if (next.length >= INTRO_MAX_SEGMENTS) break;
        const ready = await window.sourceApp.ensureMetadata(assetId);
        const segment = manualSuggestion(ready, maxSegmentDurationMs);
        const durationMs = segment.outMs - segment.inMs;
        if (usedMs + durationMs > targetDurationMs) break;
        next.push(segment);
        usedMs += durationMs;
        lastAddedId = segment.id;
      }
      if (!lastAddedId) throw new Error("新素材加入後會超過目前片頭最長時間，請先增加上限。");
      const updated = await window.sourceApp.setIntroSegments(next);
      applyProject(updated);
      if (lastAddedId) setSelectedId(lastAddedId);
      setNotice(
        `已加入 ${next.length - result.project.introSegments.length} 個手動片頭片段；既有片段範圍與片頭目標時間都沒有重算，新來源也保留在專案待決定區。`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  };

  const updateSuggestion = (id: string, inMs: number, outMs: number, changed?: "IN" | "OUT") => {
    setSuggestions((current) => current.map((item) => (item.id === id ? { ...item, inMs, outMs } : item)));
    const player = videoRef.current;
    if (player && selected?.id === id && changed) player.pause();
  };

  const persistSuggestionRange = async (id: string, inMs: number, outMs: number) => {
    setError(undefined);
    try {
      await persistSuggestions(
        suggestions.map((item) => (item.id === id ? { ...item, inMs, outMs } : item)),
        id,
      );
      setPreviewRetry((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      applyProject(await window.sourceApp.getProject());
    }
  };

  const changeSegmentSeconds = (item: IntroSuggestion, rawSeconds: number) => {
    if (!Number.isFinite(rawSeconds)) return;
    const asset = assetById.get(item.assetId);
    const sourceMaximum = asset?.kind === "VIDEO" ? (asset.mediaInfo?.durationMs ?? item.outMs) / 1000 : rawSeconds;
    const desiredMs = Math.round(
      Math.max(INTRO_EDIT_MIN_SEGMENT_MS / 1000, Math.min(sourceMaximum, rawSeconds)) * 1000,
    );
    if (asset?.kind === "IMAGE") updateSuggestion(item.id, 0, desiredMs);
    else {
      const sourceEndMs = asset?.mediaInfo?.durationMs ?? item.outMs;
      const inMs = Math.min(item.inMs, Math.max(0, sourceEndMs - desiredMs));
      updateSuggestion(item.id, inMs, Math.min(sourceEndMs, inMs + desiredMs));
    }
  };

  const advanceIntroPlayback = () => {
    if (!selected || advancingRef.current) return;
    advancingRef.current = true;
    if (loopMode === "SINGLE" || suggestions.length <= 1) {
      const player = videoRef.current;
      if (player && preview) {
        player.currentTime = preview.mode === "ORIGINAL" ? selected.inMs / 1000 : 0;
        void player.play().catch(() => undefined);
      }
      setPreviewCurrentMs(selected.inMs);
      setImageLoopCycle((value) => value + 1);
    } else {
      const index = suggestions.findIndex((item) => item.id === selected.id);
      const next = suggestions[(Math.max(0, index) + 1) % suggestions.length];
      setSelectedId(next.id);
      setPreviewCurrentMs(next.inMs);
    }
    setTimeout(() => {
      advancingRef.current = false;
    }, 120);
  };

  const keepWithinSelected = () => {
    const player = videoRef.current;
    if (!player || !selected || !preview) return;
    const sourceTimeMs =
      preview.mode === "ORIGINAL" ? player.currentTime * 1000 : selected.inMs + player.currentTime * 1000;
    if (sourceTimeMs < selected.inMs || sourceTimeMs >= selected.outMs - 20) {
      if (previewPlaying) advanceIntroPlayback();
    }
  };

  useEffect(() => {
    if (!selected || selectedAsset?.kind !== "IMAGE" || preview?.mode !== "IMAGE" || !previewPlaying) return;
    const timer = setTimeout(() => advanceIntroPlayback(), Math.max(100, selected.outMs - selected.inMs));
    return () => clearTimeout(timer);
  }, [
    selected?.id,
    selected?.inMs,
    selected?.outMs,
    selectedAsset?.kind,
    preview?.url,
    preview?.mode,
    previewPlaying,
    loopMode,
    imageLoopCycle,
    suggestions,
  ]);

  useEffect(() => {
    const sfx = insertionSfxRef.current;
    if (!sfx || !previewPlaying || !selectedInsertionAudio?.sfxEnabled) return;
    const volume = selected?.insertionAudio?.sfxVolumePercent ?? 70;
    sfx.volume = Math.max(0, Math.min(1, volume / 100));
    sfx.currentTime = 0;
    void sfx.play().catch(() => undefined);
  }, [selected?.id, selectedInsertionAudio?.sfxEnabled, previewPlaying, imageLoopCycle, preview?.url]);

  useEffect(() => {
    const bgm = insertionBgmRef.current;
    if (!bgm) return;
    if (!previewPlaying || !selectedInsertionBgm || !selectedInsertionAudio?.bgmEnabled) {
      bgm.pause();
      return;
    }
    const continuous =
      previousInsertionBgmRef.current === selectedInsertionBgm.id && selectedInsertionAudio.continuousWithPrevious;
    bgm.volume = Math.max(0, Math.min(1, (selected?.insertionAudio?.bgmVolumePercent ?? 28) / 100));
    if (!continuous) {
      try { bgm.currentTime = (selectedInsertionAudio.bgmSourcePositionMs ?? selectedInsertionBgm.sourceInMs) / 1000; }
      catch { /* metadata is still loading */ }
    }
    previousInsertionBgmRef.current = selectedInsertionBgm.id;
    void bgm.play().catch(() => undefined);
  }, [selected?.id, selectedInsertionAudio?.bgmEnabled, selectedInsertionAudio?.continuousWithPrevious, selectedInsertionBgm?.id, previewPlaying, preview?.url]);

  const moveSuggestion = async (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= suggestions.length) return;
    const next = [...suggestions];
    [next[index], next[target]] = [next[target], next[index]];
    setError(undefined);
    try {
      await persistSuggestions(next, next[target].id);
      setNotice("片頭順序已保存；對應字幕已依疊化秒數同步移動。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const beginSuggestionDrag = (event: React.DragEvent<HTMLButtonElement>, id: string) => {
    introDraggedIdRef.current = id;
    introDragOrderRef.current = [...suggestions];
    setDraggingSuggestionId(id);
    setDragTargetSuggestionId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  };

  const dragSuggestionOver = (event: React.DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const draggedId = introDraggedIdRef.current;
    const current = introDragOrderRef.current ?? suggestions;
    if (!draggedId || draggedId === targetId) return;
    const fromIndex = current.findIndex((item) => item.id === draggedId);
    const targetIndex = current.findIndex((item) => item.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const next = [...current];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    introDragOrderRef.current = next;
    setSuggestions(next);
    setDragTargetSuggestionId(targetId);
  };

  const finishSuggestionDrag = async () => {
    const draggedId = introDraggedIdRef.current;
    const next = introDragOrderRef.current;
    introDraggedIdRef.current = undefined;
    introDragOrderRef.current = undefined;
    setDraggingSuggestionId(undefined);
    setDragTargetSuggestionId(undefined);
    if (!draggedId || !next) return;
    const previousIds = projectRef.current.introSegments.map((item) => item.id).join("|");
    if (next.map((item) => item.id).join("|") === previousIds) return;
    setError(undefined);
    try {
      await persistSuggestions(next, draggedId);
      setNotice(
        `已用滑鼠調整片頭順序；目前為第 ${next.findIndex((item) => item.id === draggedId) + 1} 段，對應字幕已依疊化秒數同步移動。`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      applyProject(await window.sourceApp.getProject());
    }
  };

  const removeSuggestion = async (id: string) => {
    try {
      applyProject(await window.sourceApp.removeIntroSegment(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const restoreSuggestion = async (id: string) => {
    try {
      applyProject(await window.sourceApp.restoreIntroSegment(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const reloadIntroThumbnail = (id: string) => {
    setIntroThumbnails((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setThumbnailErrors((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setThumbnailReloadRevision((current) => current + 1);
    setMoreMenuSegmentId(undefined);
  };

  const saveColorSettings = async (introPresetId: ColorPresetId, applyToMain = project.colorSettings.applyToMain) => {
    setError(undefined);
    try {
      applyProject(await window.sourceApp.setProjectColorSettings({ introPresetId, applyToMain }));
      setNotice(applyToMain ? "色彩預設已套用到片頭與正片輸出。" : "色彩預設已套用到片頭預覽與片頭輸出。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const buildBgmSynchronizedPreview = async (enabled = true) => {
    setIncludeBgmPreview(enabled);
    void window.sourceApp
      .updateUserPreferences({ renderDefaults: { introPreviewIncludeBgm: enabled } })
      .catch(() => undefined);
    if (!enabled) {
      bgmPreviewRef.current?.pause();
      return;
    }
    if (!suggestions.length) {
      setError("片頭目前沒有片段，無法建立配樂同步預覽。");
      return;
    }
    if (!project.bgmTracks.some((track) => track.resolutionStatus !== "NEEDS_LOCAL_FILE" && track.sourcePath)) {
      setError("尚未加入可用的本機 MP3；請先到配樂頁加入或指定授權音檔。");
      setIncludeBgmPreview(false);
      return;
    }
    setBuildingBgmPreview(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.sourceApp.buildSubtitleIntroPreview(true);
      setBgmPreview(result);
      setPreviewHistoryRevision((value) => value + 1);
      setNotice(
        `已${result.cacheStatus === "HIT" ? "載入" : "建立"} 480P 配樂同步預覽；素材原音 ${project.sourceAudioVolumePercent ?? 100}%，各首 MP3 依配樂頁時間與音量設定播放。`,
      );
      window.setTimeout(() => {
        const player = bgmPreviewRef.current;
        if (player) void player.play().catch(() => undefined);
      }, 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setIncludeBgmPreview(false);
    } finally {
      setBuildingBgmPreview(false);
      setBgmPreviewProgress(undefined);
    }
  };

  const toggleIntroPlayback = () => {
    if (selectedAsset?.kind === "IMAGE") {
      setPreviewPlaying((current) => !current);
      setImageLoopCycle((value) => value + 1);
      return;
    }
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) void player.play();
    else player.pause();
  };

  return (
    <div className="intro-studio-backdrop">
      <section className="intro-studio" role="dialog" aria-modal="true" aria-label="AI 精彩片頭建議">
        <header className="intro-studio-header">
          <div>
            <span className="eyebrow">STORY-MATCH INTRO · SOURCE TRACEABLE</span>
            <h2>AI 精彩片頭建議</h2>
            <p>本機先挑候選；只有顯示「OpenAI 人物／事件／故事比對」才代表雲端 AI 成功。</p>
          </div>
          <div className="intro-header-actions">
            <fieldset className="intro-loop-mode" aria-label="片頭播放循環方式">
              <legend>播放方式</legend>
              <label>
                <input
                  type="radio"
                  name="intro-loop-mode"
                  value="ALL"
                  checked={loopMode === "ALL"}
                  onChange={() => setLoopMode("ALL")}
                />{" "}
                整體循環
              </label>
              <label>
                <input
                  type="radio"
                  name="intro-loop-mode"
                  value="SINGLE"
                  checked={loopMode === "SINGLE"}
                  onChange={() => setLoopMode("SINGLE")}
                />{" "}
                單段循環
              </label>
            </fieldset>
            <label className="intro-duration-setting">
              <span>片頭最長時間</span>
              <input
                aria-label="片頭最長時間（分鐘:秒數）"
                value={targetDurationText}
                placeholder="1:30"
                disabled={analyzing}
                onChange={(event) => setTargetDurationText(event.target.value)}
              />
            </label>
            <label className="intro-duration-setting">
              <span>每段最高秒數</span>
              <input
                aria-label="片頭每段最高秒數"
                type="number"
                min="3"
                max="22"
                step="0.5"
                value={segmentMaxSecondsText}
                disabled={analyzing}
                onChange={(event) => setSegmentMaxSecondsText(event.target.value)}
              />
            </label>
            {!analyzing && (
              <button className="secondary-button" type="button" onClick={() => void applyDurationPlan()}>
                套用上限並均衡
              </button>
            )}
            {!analyzing && (
              <button className="secondary-button" type="button" onClick={() => void runAnalysis()}>
                {suggestions.length ? "套用時間並重新分析" : "開始分析"}
              </button>
            )}
            <button className="icon-button" type="button" disabled={analyzing} onClick={onClose} aria-label="關閉">
              ×
            </button>
          </div>
        </header>

        {analyzing ? (
          <div className="intro-analysis-state" aria-live="polite">
            <span className="analysis-orbit">
              <i />
              <i />
              <i />
            </span>
            <span className="eyebrow">LOCAL CANDIDATES → OPENAI STORY MATCH</span>
            <h3>{phaseLabel(progress)}</h3>
            <p>
              {progress?.processed ?? 0} / {progress?.total ?? videos.length} 支影片
            </p>
            <progress max={Math.max(1, progress?.total ?? videos.length)} value={progress?.processed ?? 0} />
            <button
              className="cancel-button"
              type="button"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void window.sourceApp.cancelIntroAnalysis();
              }}
            >
              {cancelling ? "正在取消…" : "取消分析"}
            </button>
            <small>OpenAI 不可用時會保留本機候選並明確標示，不會假裝已完成語意判斷。</small>
          </div>
        ) : (
          <div className="intro-studio-layout">
            <aside className="intro-suggestions">
              <div className="intro-summary">
                <div>
                  <strong>{suggestions.length}</strong>
                  <span>片頭片段</span>
                </div>
                <div className={introDurationWarning ? "is-duration-warning" : ""}>
                  <strong>{formatDuration(totalDurationMs)}</strong>
                  <span>目前／上限 {formatDuration(effectiveTargetDurationMs)}</span>
                  {introDurationWarning && <small role="alert">已超過 3 分鐘，仍可繼續使用</small>}
                </div>
                <div className={analysisMode === "OPENAI_STORY_MATCH" ? "is-cloud" : "is-local"}>
                  <strong>{analysisMode === "OPENAI_STORY_MATCH" ? cloudAnalyzedCount : "本機"}</strong>
                  <span>{analysisMode === "OPENAI_STORY_MATCH" ? "OpenAI 語意比對" : "畫面統計備援"}</span>
                </div>
              </div>
              <section className="intro-generation-brief" aria-label="片頭文字與基底素材">
                <h3>片頭文字指示／基底素材</h3>
                <p>
                  描述希望片頭呈現的人物、事件、故事與節奏；選基底影片後，重新分析只從該檔案挑 AI
                  候選。這是依真實來源剪輯，不會憑空生成未拍攝畫面。
                </p>
                <textarea
                  aria-label="片頭 AI 文字指示"
                  placeholder="例如：先呈現主角抵達森林、觀察棲地，再預告環境養護故事；避免只挑漂亮空景。"
                  value={introPrompt}
                  onChange={(event) => setIntroPrompt(event.target.value)}
                />
                <select
                  aria-label="片頭優先基底素材"
                  value={baseAssetId}
                  onChange={(event) => setBaseAssetId(event.target.value)}
                >
                  <option value="">全部正片影片（依故事比對）</option>
                  {videos.map((video) => (
                    <option key={video.id} value={video.id}>
                      {video.fileName}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => void saveIntroDirection()}>
                  保存文字與基底設定
                </button>
              </section>
              <section className="intro-manual-add" aria-label="手動加入片頭素材">
                <h3>手動加入影片／照片</h3>
                <p>可重複使用同一來源的不同片段；來源保持唯讀。</p>
                <div>
                  <select
                    aria-label="專案既有片頭素材"
                    value={manualAssetId}
                    onChange={(event) => setManualAssetId(event.target.value)}
                  >
                    <option value="">選擇專案素材</option>
                    {assets.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.kind === "IMAGE" ? "照片" : "影片"} · {asset.fileName}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={!manualAssetId || importing} onClick={() => void addExistingAsset()}>
                    加入既有素材
                  </button>
                </div>
                <button
                  className="intro-import-button"
                  type="button"
                  disabled={importing}
                  onClick={() => void chooseIntroFiles()}
                >
                  {importing ? "正在加入…" : "從其他資料夾選擇影片／照片…"}
                </button>
              </section>
              <section className="intro-color-settings" aria-label="片頭色溫與增豔">
                <h3>片頭色溫／增豔</h3>
                <p>先在右側看片頭素材效果；輸出使用同一組固定參數。</p>
                <div>
                  {COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      className={preset.id === project.colorSettings.introPresetId ? "is-selected" : ""}
                      type="button"
                      onClick={() => void saveColorSettings(preset.id)}
                    >
                      <strong>{preset.label}</strong>
                      <small>
                        {preset.temperatureLabel} · 彩度 {preset.saturationPercent}%
                      </small>
                      <span>{preset.description}</span>
                    </button>
                  ))}
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={project.colorSettings.applyToMain}
                    onChange={(event) =>
                      void saveColorSettings(project.colorSettings.introPresetId, event.target.checked)
                    }
                  />{" "}
                  沿用相同色彩到後面的正片，保持片頭／正片一致
                </label>
              </section>
              {analysis?.cloudFallbackReason && (
                <div className="intro-analysis-note" role="status">
                  <strong>OpenAI 未完成</strong>
                  <br />
                  {analysis.cloudFallbackReason}
                </div>
              )}
              {project.introAnalysisResult &&
                project.introAnalysisResult.generatedAt !== analysisAppliedAt &&
                !analyzing && (
                  <div className="intro-analysis-note" role="status">
                    <strong>有背景完成的片頭分析</strong>
                    <br />
                    最近完成於 {new Date(project.introAnalysisResult.generatedAt).toLocaleString("zh-TW")}
                    ；關閉視窗期間的結果已保存，尚未自動覆蓋你目前的片頭順序。
                    <button
                      type="button"
                      onClick={() =>
                        void applyCompletedAnalysis(project.introAnalysisResult!, effectiveTargetDurationMs)
                      }
                    >
                      套用最近分析結果
                    </button>
                  </div>
                )}
              {notice && (
                <div className="notice success concat-error" role="status">
                  {notice}
                </div>
              )}
              {error && (
                <div className="notice error concat-error" role="alert">
                  {error}
                </div>
              )}
              {!suggestions.length && (
                <div className="intro-empty-setup">
                  <strong>先設定目標時間，再開始分析</strong>
                  <p>
                    預設 1:30，至少 0:03、沒有 3 分鐘硬上限；超過 3 分鐘時只會顯示紅色警示。也可不執行
                    AI，直接手動加入素材。
                  </p>
                </div>
              )}
              {suggestions.length > 1 && (
                <p className="intro-drag-help">
                  按住片段標題列的 ⠿，拖到想要的順位；放開後自動保存。上下按鈕仍可精確調整。
                </p>
              )}
              <ol className="suggestion-list">
                {suggestions.map((item, index) => {
                  const asset = assetById.get(item.assetId);
                  const thumbnailSignature = introThumbnailSignature(item);
                  const thumbnailState = introThumbnails[item.id];
                  const thumbnailUrl = thumbnailState?.signature === thumbnailSignature ? thumbnailState.url : undefined;
                  const audioState = insertionAudioByInstance.get(item.id);
                  const detailsExpanded = expandedSegmentId === item.id;
                  const moreOpen = moreMenuSegmentId === item.id;
                  const durationMs =
                    asset?.kind === "IMAGE" ? MAX_IMAGE_DURATION_MS : (asset?.mediaInfo?.durationMs ?? item.outMs);
                  const durationWarning =
                    item.outMs - item.inMs < INTRO_MIN_SEGMENT_MS || item.outMs - item.inMs > outputSegmentMaxMs;
                  return (
                    <li
                      key={item.id}
                      ref={(node) => registerThumbnailNode(item.id, node)}
                      data-segment-id={item.id}
                      className={`intro-segment-card ${[
                        item.id === selectedId ? "is-selected" : "",
                        durationWarning ? "is-over-duration-limit" : "",
                        item.id === draggingSuggestionId ? "is-dragging" : "",
                        draggingSuggestionId && item.id === dragTargetSuggestionId && item.id !== draggingSuggestionId
                          ? "is-drag-target"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}`}
                      onDragEnter={(event) => dragSuggestionOver(event, item.id)}
                      onDragOver={(event) => dragSuggestionOver(event, item.id)}
                      onDrop={(event) => {
                        event.preventDefault();
                        void finishSuggestionDrag();
                      }}
                    >
                      <div className="intro-segment-rail">
                        <button
                          className="intro-segment-thumbnail"
                          type="button"
                          data-tooltip="預覽片段｜在右側開啟這一段"
                          title="預覽片段｜在右側開啟這一段"
                          aria-label={`預覽片頭第 ${index + 1} 段 ${item.fileName}`}
                          onClick={() => setSelectedId(item.id)}
                        >
                          {thumbnailUrl ? (
                            <img
                              src={thumbnailUrl}
                              alt={`片頭第 ${index + 1} 段 ${item.fileName} 第一幀縮圖`}
                              loading="lazy"
                              decoding="async"
                              onError={() => setThumbnailErrors((current) => ({ ...current, [item.id]: true }))}
                            />
                          ) : thumbnailErrors[item.id] ? (
                            <span className="intro-thumbnail-error" role="status" aria-label={`片頭第 ${index + 1} 段縮圖載入失敗`}>
                              !
                            </span>
                          ) : (
                            <span role="status" aria-label={`正在載入片頭第 ${index + 1} 段第一幀縮圖`}>
                              ▧
                            </span>
                          )}
                          <span className="intro-thumbnail-duration" aria-hidden="true">
                            {formatDuration(item.outMs - item.inMs)}
                          </span>
                        </button>
                      </div>
                      <div className="intro-segment-body">
                        <div className="intro-segment-header">
                          <button
                            className="suggestion-select"
                            type="button"
                            draggable
                            title={`選擇／預覽片頭第 ${index + 1} 段`}
                            aria-label={`選擇並拖曳片頭第 ${index + 1} 段 ${item.fileName}`}
                            onClick={() => setSelectedId(item.id)}
                            onDragStart={(event) => beginSuggestionDrag(event, item.id)}
                            onDragEnd={() => void finishSuggestionDrag()}
                          >
                            <span className="intro-drag-handle" aria-hidden="true">
                              ⠿
                            </span>
                            <span className="intro-order-number">{String(index + 1).padStart(2, "0")}</span>
                            <div>
                              <strong title={item.fileName}>{item.fileName}</strong>
                              <small>
                                {item.origin === "MANUAL" ? "手動片段" : `精彩分數 ${item.score}`}
                                {item.storyRelevanceScore !== undefined
                                  ? ` · 故事相關 ${item.storyRelevanceScore}`
                                  : ""} · {item.reasons.join("／")}
                              </small>
                            </div>
                          </button>
                          <span className="intro-segment-duration" title="片段長度">
                            {formatDuration(item.outMs - item.inMs)}
                          </span>
                        </div>
                        <div className="intro-segment-toolbar" role="toolbar" aria-label={`片頭第 ${index + 1} 段快速操作`}>
                          <button
                            className={`intro-icon-action ${item.id === selectedId ? "is-selected" : ""}`}
                            type="button"
                            data-tooltip="預覽片段｜在右側開啟並播放此片段"
                            aria-label={`預覽片頭第 ${index + 1} 段 ${item.fileName}`}
                            aria-pressed={item.id === selectedId}
                            onClick={() => setSelectedId(item.id)}
                          >
                            <span aria-hidden="true">▶</span>
                          </button>
                          <button
                            className={`intro-icon-action ${detailsExpanded ? "is-selected" : ""}`}
                            type="button"
                            data-tooltip="裁切與長度｜調整片段起訖與顯示秒數"
                            aria-label={`調整片頭第 ${index + 1} 段裁切與長度`}
                            aria-expanded={detailsExpanded}
                            aria-controls={`intro-details-${item.id}`}
                            onClick={() => {
                              setSelectedId(item.id);
                              setExpandedSegmentId(detailsExpanded ? undefined : item.id);
                            }}
                          >
                            <span aria-hidden="true">✂</span>
                          </button>
                          <button
                            className={`intro-icon-action ${audioState?.hasSourceAudio && audioState.gates.original ? "is-enabled" : "is-disabled"}`}
                            type="button"
                            data-tooltip={audioState?.hasSourceAudio ? "原始音訊｜開啟設定並確認此片段原音" : "原始音訊｜此素材沒有可用原音"}
                            aria-label={`${item.fileName} 原始音訊${audioState?.hasSourceAudio && audioState.gates.original ? "已開啟" : "未開啟"}`}
                            disabled={!audioState?.hasSourceAudio}
                            onClick={() => setExpandedSegmentId(item.id)}
                          >
                            <span aria-hidden="true">◉</span>
                          </button>
                          <button
                            className={`intro-icon-action ${audioState?.bgmEnabled ? "is-enabled" : "is-disabled"}`}
                            type="button"
                            data-tooltip={`背景音樂｜${audioState?.bgmEnabled ? `已使用 ${audioState.bgmTrackName ?? "BGM"}` : "開啟設定或選擇 BGM"}`}
                            aria-label={`${item.fileName} 背景音樂${audioState?.bgmEnabled ? "已開啟" : "未開啟"}`}
                            onClick={() => setExpandedSegmentId(item.id)}
                          >
                            <span aria-hidden="true">♫</span>
                          </button>
                          <button
                            className={`intro-icon-action ${audioState?.sfxEnabled ? "is-enabled" : "is-disabled"}`}
                            type="button"
                            data-tooltip={asset?.kind === "IMAGE" ? `效果音｜${audioState?.sfxEnabled ? "相機快門已開啟" : "開啟設定以使用快門聲"}` : "效果音｜影片片段目前沒有照片快門 SFX"}
                            aria-label={`${item.fileName} 效果音${audioState?.sfxEnabled ? "已開啟" : "未開啟"}`}
                            disabled={asset?.kind !== "IMAGE"}
                            onClick={() => setExpandedSegmentId(item.id)}
                          >
                            <span aria-hidden="true">✦</span>
                          </button>
                          <button
                            className="intro-icon-action intro-remove-button"
                            type="button"
                            data-tooltip="刪除片段｜只從片頭移除，不刪除來源檔"
                            aria-label={`從片頭移除 ${item.fileName} ${formatDuration(item.inMs)} 到 ${formatDuration(item.outMs)}；不刪除來源檔`}
                            onClick={() => void removeSuggestion(item.id)}
                          >
                            <span aria-hidden="true">⌫</span>
                          </button>
                          <div className="intro-more-menu-wrap">
                            <button
                              className={`intro-icon-action ${moreOpen ? "is-selected" : ""}`}
                              type="button"
                              data-tooltip="更多設定｜排序、分析與重新載入縮圖"
                              aria-label={`片頭第 ${index + 1} 段更多設定`}
                              aria-expanded={moreOpen}
                              aria-controls={`intro-more-${item.id}`}
                              onClick={() => setMoreMenuSegmentId(moreOpen ? undefined : item.id)}
                            >
                              <span aria-hidden="true">⋯</span>
                            </button>
                            {moreOpen && (
                              <div id={`intro-more-${item.id}`} className="intro-more-menu" role="menu">
                                <button role="menuitem" type="button" disabled={index === 0} onClick={() => { setMoreMenuSegmentId(undefined); void moveSuggestion(index, -1); }}>
                                  ↑ 往前一個順位
                                </button>
                                <button role="menuitem" type="button" disabled={index === suggestions.length - 1} onClick={() => { setMoreMenuSegmentId(undefined); void moveSuggestion(index, 1); }}>
                                  ↓ 往後一個順位
                                </button>
                                {onOpenMaterialAnalysis && asset && (
                                  <button role="menuitem" type="button" onClick={() => { setMoreMenuSegmentId(undefined); onOpenMaterialAnalysis(asset); }}>
                                    ✦ 影像分析與字幕
                                  </button>
                                )}
                                <button role="menuitem" type="button" onClick={() => reloadIntroThumbnail(item.id)}>
                                  ↻ 重新載入縮圖
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        {detailsExpanded && (
                          <div className="intro-segment-details" id={`intro-details-${item.id}`}>
                            {asset?.kind === "VIDEO" && (
                              <ClipRangeControl
                                compact
                                showTimeFields
                                minimumRangeMs={INTRO_EDIT_MIN_SEGMENT_MS}
                                durationMs={durationMs}
                                range={{ inMs: item.inMs, outMs: item.outMs }}
                                onChange={(range, changed) => updateSuggestion(item.id, range.inMs, range.outMs, changed)}
                                onCommit={(range) => void persistSuggestionRange(item.id, range.inMs, range.outMs)}
                              />
                            )}
                            <label className="intro-segment-seconds">
                              <span>{asset?.kind === "IMAGE" ? "照片顯示秒數" : "檢看片段秒數"}</span>
                              <input
                                aria-label={`${item.fileName}片段秒數`}
                                type="number"
                                min={INTRO_EDIT_MIN_SEGMENT_MS / 1000}
                                max={asset?.kind === "VIDEO" ? (asset.mediaInfo?.durationMs ?? item.outMs) / 1000 : undefined}
                                step="0.1"
                                value={((item.outMs - item.inMs) / 1000).toFixed(1)}
                                onChange={(event) => changeSegmentSeconds(item, Number(event.target.value))}
                                onBlur={() => void persistSuggestionRange(item.id, item.inMs, item.outMs)}
                              />
                              <small>
                                可自由設定；建議每段 {formatDuration(INTRO_MIN_SEGMENT_MS)}–
                                {formatDuration(outputSegmentMaxMs)}
                              </small>
                            </label>
                            {asset && (
                              <InsertionAudioControls
                                project={projectRef.current}
                                scope="INTRO"
                                instanceId={item.id}
                                asset={asset}
                                value={item.insertionAudio}
                                onProjectUpdated={applyProject}
                                compact
                              />
                            )}
                          </div>
                        )}
                        {durationWarning && (
                          <p className="intro-segment-over-limit" role="status">
                            目前為 {formatDuration(item.outMs - item.inMs)}
                            ，超出建議範圍；只顯示提醒，不會限制、拉回或截短成片。
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {project.recentIntroRemovals.length > 0 && (
                <section className="intro-recent-removals" aria-label="最近從片頭移除">
                  <h3>最近從片頭移除</h3>
                  <p>重新分析不會自動復活；只有按下恢復才重新加入。</p>
                  {[...project.recentIntroRemovals].reverse().map((record) => (
                    <div key={record.segment.id}>
                      <span>
                        <strong>{record.segment.fileName}</strong>
                        <small>
                          {formatDuration(record.segment.inMs)} → {formatDuration(record.segment.outMs)}
                        </small>
                      </span>
                      <button type="button" onClick={() => void restoreSuggestion(record.segment.id)}>
                        恢復片頭區段
                      </button>
                    </div>
                  ))}
                </section>
              )}
            </aside>

            <main className="intro-preview-panel">
              <div className="intro-preview-stage">
                {!selected && (
                  <div className="large-loading">
                    <p>尚未選取片段。</p>
                  </div>
                )}
                {selected && !preview && !previewError && (
                  <div className="large-loading">
                    <span className="spinner" />
                    <p>
                      {proxyFallbackSegmentId === selected.id ? "正在建立此區間的快速短代理…" : "正在開啟唯讀原始素材…"}
                    </p>
                  </div>
                )}
                {previewError && (
                  <div className="preview-error">
                    <strong>片段無法預覽</strong>
                    <p>{previewError}</p>
                    <div>
                      {selectedAsset?.kind === "VIDEO" && proxyFallbackSegmentId !== selected?.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewError(undefined);
                            setProxyFallbackSegmentId(selected?.id);
                          }}
                        >
                          改用快速短代理
                        </button>
                      )}
                      {selectedAsset?.kind === "VIDEO" && proxyFallbackSegmentId === selected?.id && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setPreviewError(undefined);
                              setPreviewRetry((value) => value + 1);
                            }}
                          >
                            重試短代理
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPreviewError(undefined);
                              setProxyFallbackSegmentId(undefined);
                            }}
                          >
                            改回原始素材
                          </button>
                        </>
                      )}
                      {selectedAsset?.kind === "VIDEO" && (
                        <button
                          type="button"
                          onClick={() =>
                            void window.sourceApp
                              .openExternalMedia(selectedAsset.id, "ORIGINAL")
                              .catch((reason: unknown) =>
                                setPreviewError(reason instanceof Error ? reason.message : String(reason)),
                              )
                          }
                        >
                          用外部播放器查看原檔
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {selected && selectedAsset && preview && (
                  <div
                    className={`intro-preview-aspect-frame ${selectedDisplayWidth >= selectedDisplayHeight ? "is-landscape" : "is-portrait"}`}
                    style={
                      {
                        "--preview-aspect": `${selectedDisplayWidth} / ${selectedDisplayHeight}`,
                      } as React.CSSProperties
                    }
                  >
                    {selectedInsertionAudio?.sfxEnabled && selectedAsset.kind === "IMAGE" && (
                      <audio ref={insertionSfxRef} src={PHOTO_SOUND_PREVIEW_URL} preload="auto" />
                    )}
                    {selectedInsertionBgm && selectedInsertionAudio?.bgmEnabled && (
                      <audio
                        ref={insertionBgmRef}
                        src={`preview-media://bgm/${encodeURIComponent(selectedInsertionBgm.id)}`}
                        preload="auto"
                        onLoadedMetadata={(event) => {
                          event.currentTarget.currentTime =
                            (selectedInsertionAudio.bgmSourcePositionMs ?? selectedInsertionBgm.sourceInMs) / 1000;
                        }}
                        onTimeUpdate={(event) => {
                          if (event.currentTarget.currentTime >= selectedInsertionBgm.sourceOutMs / 1000 - 0.03)
                            event.currentTarget.currentTime = selectedInsertionBgm.sourceInMs / 1000;
                        }}
                        onEnded={(event) => {
                          event.currentTarget.currentTime = selectedInsertionBgm.sourceInMs / 1000;
                          if (previewPlaying) void event.currentTarget.play().catch(() => undefined);
                        }}
                      />
                    )}
                    {selectedAsset.kind === "VIDEO" && (
                      <>
                        <video
                          className="intro-material-preview"
                          key={`${preview.url}:${selected.id}`}
                          ref={videoRef}
                          src={preview.url}
                          muted={selectedInsertionAudio?.gates.original === false}
                          autoPlay
                          preload="metadata"
                          aria-label={`片頭素材預覽 ${selected.fileName}`}
                          style={{
                            aspectRatio: `${selectedDisplayWidth} / ${selectedDisplayHeight}`,
                            filter: activeColorPreset.cssFilter,
                            transform: selectedActiveZoom
                              ? `scale(${selectedActiveZoom.zoomPercent / 100})`
                              : "scale(1)",
                            transformOrigin: selectedActiveZoom
                              ? `${selectedActiveZoom.centerXPercent}% ${selectedActiveZoom.centerYPercent}%`
                              : "50% 50%",
                          }}
                          onClick={toggleIntroPlayback}
                          onError={() => {
                            setPreview(undefined);
                            setPreviewError(
                              preview.mode === "ORIGINAL"
                                ? "內建播放器無法直接解碼這支原始影片；可改用快速短代理，避免長時間空轉。"
                                : "快速短代理無法建立或解碼；可重試、改回原始素材，或使用外部播放器查看原檔。",
                            );
                          }}
                          onLoadedMetadata={(event) => {
                            event.currentTarget.currentTime = preview.mode === "ORIGINAL" ? selected.inMs / 1000 : 0;
                            setPreviewCurrentMs(selected.inMs);
                            void event.currentTarget.play().catch(() => undefined);
                          }}
                          onPlay={() => setPreviewPlaying(true)}
                          onPause={() => setPreviewPlaying(false)}
                          onEnded={advanceIntroPlayback}
                          onTimeUpdate={(event) => {
                            const sourceMs =
                              preview.mode === "ORIGINAL"
                                ? Math.round(event.currentTarget.currentTime * 1000)
                                : selected.inMs + Math.round(event.currentTarget.currentTime * 1000);
                            setPreviewCurrentMs(sourceMs);
                            keepWithinSelected();
                          }}
                        />
                        <span
                          className={`intro-preview-source-badge ${preview.mode === "ORIGINAL" ? "is-original" : "is-proxy"}`}
                        >
                          {preview.mode === "ORIGINAL" ? "原始素材 · 唯讀播放" : "快速短代理 · fallback"} ·{" "}
                          {loopMode === "ALL" ? "整體循環" : "單段循環"}
                        </span>
                      </>
                    )}
                    {selectedAsset.kind === "IMAGE" && (
                      <img
                        className="intro-material-preview intro-image-preview"
                        src={preview.url}
                        alt={`片頭照片預覽 ${selected.fileName}`}
                        style={{
                          aspectRatio: `${selectedDisplayWidth} / ${selectedDisplayHeight}`,
                          filter: activeColorPreset.cssFilter,
                        }}
                        onLoad={() => {
                          setPreviewPlaying(true);
                          setImageLoopCycle((value) => value + 1);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
              {selected && selectedAsset && (
                <div className="intro-preview-controls">
                  <button type="button" onClick={toggleIntroPlayback}>
                    {previewPlaying ? "❚❚ 暫停" : "▶ 播放"}
                  </button>
                  <span>
                    {selectedAsset.kind === "VIDEO"
                      ? `${formatDuration(Math.max(selected.inMs, previewCurrentMs))} / ${formatDuration(selected.outMs)}`
                      : `${formatDuration(selected.outMs - selected.inMs)} 照片 · ${loopMode === "ALL" ? "之後接下一段" : "單段循環"}`}
                  </span>
                  {selectedAsset.kind === "VIDEO" && (
                    <input
                      aria-label="片頭片段播放位置"
                      type="range"
                      min={selected.inMs}
                      max={selected.outMs}
                      step="50"
                      value={Math.max(selected.inMs, Math.min(selected.outMs, previewCurrentMs || selected.inMs))}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setPreviewCurrentMs(next);
                        if (videoRef.current)
                          videoRef.current.currentTime =
                            preview?.mode === "ORIGINAL" ? next / 1000 : Math.max(0, next - selected.inMs) / 1000;
                      }}
                    />
                  )}
                </div>
              )}
              <section className="intro-bgm-preview-panel" aria-label="片頭配樂同步預覽">
                <header>
                  <label>
                    <input
                      type="checkbox"
                      checked={includeBgmPreview}
                      disabled={buildingBgmPreview}
                      onChange={(event) => void buildBgmSynchronizedPreview(event.target.checked)}
                    />
                    <span>
                      <strong>看片頭時套用配樂</strong>
                      <small>
                        建立共用 480P 檢看檔，精確套用配樂 Timeline／source IN-OUT／淡入淡出／音量，以及素材原音比例與
                        limiter。
                      </small>
                    </span>
                  </label>
                  {includeBgmPreview && bgmPreview && (
                    <button
                      type="button"
                      disabled={buildingBgmPreview}
                      onClick={() => void buildBgmSynchronizedPreview(true)}
                    >
                      重新建立
                    </button>
                  )}
                </header>
                {buildingBgmPreview && (
                  <div className="intro-bgm-building" aria-live="polite">
                    <span className="spinner" />
                    <div>
                      <strong>正在建立配樂同步預覽…</strong>
                      <progress max="100" value={bgmPreviewProgress?.percent ?? 0} />
                    </div>
                    <span>{Math.round(bgmPreviewProgress?.percent ?? 0)}%</span>
                    <button
                      type="button"
                      className="cancel-button"
                      onClick={() => void window.sourceApp.cancelSubtitleIntroPreview()}
                    >
                      取消
                    </button>
                  </div>
                )}
                {includeBgmPreview && bgmPreview && !buildingBgmPreview && (
                  <div className="intro-bgm-player">
                    <video
                      ref={bgmPreviewRef}
                      key={bgmPreview.url}
                      src={bgmPreview.url}
                      controls
                      loop
                      preload="metadata"
                      aria-label="片頭配樂同步 480P 預覽"
                    />
                    <p title={bgmPreview.outputPath}>{bgmPreview.outputPath}</p>
                  </div>
                )}
              </section>
              {selected && (
                <div className="selected-clip-meta">
                  <div>
                    <span className="eyebrow">SELECTED {selectedAsset?.kind === "IMAGE" ? "PHOTO" : "CLIP"}</span>
                    <h3>{selected.fileName}</h3>
                    <p>
                      {selectedAsset?.kind === "IMAGE"
                        ? `顯示 ${formatDuration(selected.outMs - selected.inMs)}`
                        : `${formatDuration(selected.inMs)} → ${formatDuration(selected.outMs)}`}{" "}
                      · {selected.reasons.join("／")}
                    </p>
                    {selected.eventSummary && <p className="semantic-summary">事件：{selected.eventSummary}</p>}
                    {selected.peopleSummary?.length ? (
                      <p className="semantic-summary">人物：{selected.peopleSummary.join("、")}</p>
                    ) : null}
                    {selected.locationSummary?.length ? (
                      <p className="semantic-summary">地點：{selected.locationSummary.join("、")}</p>
                    ) : null}
                    {selected.aiWarnings?.length ? (
                      <p className="semantic-warning">待核對：{selected.aiWarnings.join("；")}</p>
                    ) : null}
                  </div>
                  <strong>{selected.origin === "MANUAL" ? "手動" : selected.score}</strong>
                </div>
              )}
              <div className={`intro-output-bar ${introDurationWarning ? "has-duration-warning" : ""}`}>
                <div>
                  <strong>Intro 預覽輸出</strong>
                  <span>
                    {suggestions.length
                      ? `${suggestions.length} / ${INTRO_MAX_SEGMENTS} 段 · 檢看與實際輸出約 ${formatDuration(outputTotalDurationMs)} / ${formatDuration(effectiveTargetDurationMs)} · 建議每段 ${formatDuration(INTRO_MIN_SEGMENT_MS)}–${formatDuration(outputSegmentMaxMs)}`
                      : "請先分析或手動加入至少一段"}
                  </span>
                  <small className="four-k-note">
                    輸出頁可選真正 3840 × 2160 MP4；低於 4K 的來源只能等比例升頻，不能恢復原本不存在的細節。
                  </small>
                  {warningSuggestions.length > 0 && (
                    <small className="segment-cap-warning-text">
                      有 {warningSuggestions.length} 段超出建議長度；只以橘色提醒，預覽與輸出都保留所選時間。
                    </small>
                  )}
                  {introDurationWarning && (
                    <small className="duration-warning-text">片頭檢看範圍已超過 3 分鐘；這是警示，不會阻擋預覽。</small>
                  )}
                  {introLimitExceeded && (
                    <small>
                      {hasInvalidSegmentDuration
                        ? `片段必須大於 0 秒；目前最小編輯步進為 ${INTRO_EDIT_MIN_SEGMENT_MS / 1000} 秒。`
                        : suggestions.length > INTRO_MAX_SEGMENTS
                          ? `超過 ${INTRO_MAX_SEGMENTS} 段上限。`
                          : "依每段上限截取後，仍超過目前設定的片頭目標時間。"}
                    </small>
                  )}
                </div>
                <div className="concat-footer-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={suggestions.length === 0}
                    onClick={() => setShowShorts(true)}
                  >
                    製作 Shorts
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!suggestions.length || introLimitExceeded || parsedTargetDurationMs === undefined}
                    onClick={() => setShowOutput(true)}
                  >
                    產出 Intro 預覽
                  </button>
                </div>
              </div>
              <SharedIntroPreviewHistory refreshKey={previewHistoryRevision} title="字幕頁／片頭頁共用預覽" />
              <p className="local-ai-disclaimer">
                「本機畫面統計備援」不等於已連上 ChatGPT/OpenAI。只有 OpenAI API project
                有可用額度且每段人物、事件、地點、語音比對成功時，才會標示為 OpenAI 語意比對；所有結果仍需人工確認。
              </p>
            </main>
          </div>
        )}
      </section>
      {showOutput && (
        <ConcatRenderModal
          project={projectRef.current}
          purpose="INTRO"
          assets={assets}
          introClips={suggestions}
          introSegmentMaxDurationMs={outputSegmentMaxMs}
          confirmedSubtitleCount={confirmedIntroSubtitleCount}
          subtitlesNeedReview={introSubtitlesNeedReview}
          projectName={project.name}
          onClose={() => setShowOutput(false)}
        />
      )}
      {showShorts && (
        <ShortsStudio
          project={{ ...project, introSegments: suggestions } as ProjectManifest}
          onProjectUpdated={() => undefined}
          onClose={() => setShowShorts(false)}
        />
      )}
    </div>
  );
}
