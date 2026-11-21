import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import type { MaterialAnalysisProvider, ProjectManifest, StandaloneSubtitleWorkspace, SubtitleAiCheckProgress, SubtitleAiCheckProposal, SubtitleCue } from "../../shared/domain";

interface Props {
  workspace: StandaloneSubtitleWorkspace;
  videoUrl?: string;
  onUpdated(workspace: StandaloneSubtitleWorkspace): void;
  onProjectUpdated?(project: ProjectManifest): void;
  onError(message: string): void;
}

interface PlaybackSegment {
  src: string;
  inMs: number;
  outMs: number;
  projectStartMs: number;
}

const formatTime = (ms: number) => {
  const safeMs = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(safeMs % 1_000).padStart(3, "0")}`;
};
const formatCueDuration = (startMs: number, endMs: number) => `${(Math.max(0, endMs - startMs) / 1_000).toFixed(3)}s`;
const sourceForWorkspace = (workspace: StandaloneSubtitleWorkspace) =>
  workspace.previewUrl ?? `source-media://subtitle/${workspace.id}`;

/** Runtime segment metadata is accepted without widening the shared workspace contract. */
function getPlaybackSegments(workspace: StandaloneSubtitleWorkspace, videoUrl?: string): PlaybackSegment[] {
  const rawSegments = (workspace as StandaloneSubtitleWorkspace & { segments?: unknown }).segments;
  if (Array.isArray(rawSegments) && rawSegments.length) {
    let projectStartMs = 0;
    const segments: PlaybackSegment[] = [];
    for (const raw of rawSegments) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const src = [item.src, item.url, item.videoUrl, item.path].find((value) => typeof value === "string");
      const inMs = Number(item.inMs ?? item.startMs ?? 0);
      const outMs = Number(item.outMs ?? item.endMs ?? workspace.videoDurationMs);
      if (typeof src !== "string" || !Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) continue;
      segments.push({ src, inMs, outMs, projectStartMs });
      projectStartMs += outMs - inMs;
    }
    if (segments.length) return segments;
  }
  return [{ src: videoUrl ?? sourceForWorkspace(workspace), inMs: 0, outMs: workspace.videoDurationMs, projectStartMs: 0 }];
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function AiEvidencePanel({ workspaceId, proposal, onError }: { workspaceId: string; proposal: SubtitleAiCheckProposal; onError(message: string): void }) {
  const [open, setOpen] = useState(false);
  const [frames, setFrames] = useState<Array<{ timeMs: number; url: string }>>([]);
  const load = async () => {
    if (open || frames.length || !window.sourceApp.getSubtitleEvidenceFrame) return;
    setOpen(true);
    try {
      const loaded = await Promise.all(proposal.evidenceTimesMs.map(async (timeMs) => ({ timeMs, url: (await window.sourceApp.getSubtitleEvidenceFrame!(workspaceId, timeMs)).url })));
      setFrames(loaded);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  return <details className="standalone-subtitle-review__evidence" onToggle={(event) => { if (event.currentTarget.open) void load(); }}>
    <summary>查看原字幕開始／中段／結束與相鄰畫面</summary>
    <div>{frames.map((frame) => <figure key={frame.timeMs}><img src={frame.url} alt={`AI 審核畫面 ${formatTime(frame.timeMs)}`} /><figcaption>{formatTime(frame.timeMs)}</figcaption></figure>)}</div>
    {open && !frames.length && <span>載入畫面中…</span>}
  </details>;
}

export function StandaloneSubtitleReview({ workspace, videoUrl, onUpdated, onProjectUpdated, onError }: Props) {
  const [cues, setCues] = useState(workspace.cues);
  const [savedCues, setSavedCues] = useState(workspace.cues);
  const [selectedId, setSelectedId] = useState(workspace.cues[0]?.id);
  const [activeId, setActiveId] = useState<string>();
  const [frameUrl, setFrameUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [projectTimeMs, setProjectTimeMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [interactiveConfirmation, setInteractiveConfirmation] = useState(true);
  const [aiProvider, setAiProvider] = useState<MaterialAnalysisProvider>("CHATGPT");
  const [displayLanguage, setDisplayLanguage] = useState<"zh-TW" | "zh-CN" | "en" | "ja" | "ko">("zh-TW");
  const [aiTitle, setAiTitle] = useState("");
  const [aiDescription, setAiDescription] = useState("");
  const [aiProgress, setAiProgress] = useState<SubtitleAiCheckProgress>();
  const [aiProposals, setAiProposals] = useState<SubtitleAiCheckProposal[]>([]);
  const [editingProposalId, setEditingProposalId] = useState<string>();
  const [editedProposal, setEditedProposal] = useState<{ text: string; startMs: number; endMs: number }>();
  const [exportNotice, setExportNotice] = useState<string>();
  const segments = useMemo(() => getPlaybackSegments(workspace, videoUrl), [workspace, videoUrl]);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const pendingSeekSeconds = useRef<number | undefined>(undefined);
  const resumeOnSegmentLoad = useRef(false);
  const handoffSegmentIndex = useRef<number | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const cueRefs = useRef(new Map<string, HTMLLIElement>());
  const manualScrollUntil = useRef(0);
  const programmaticScrollUntil = useRef(0);
  const manualScrollTimer = useRef<number | undefined>(undefined);
  const [followResumeRevision, setFollowResumeRevision] = useState(0);
  const dirty = useMemo(() => JSON.stringify(cues) !== JSON.stringify(savedCues), [cues, savedCues]);
  const selected = cues.find((cue) => cue.id === selectedId);
  const activeIndex = cues.findIndex((cue) => cue.id === activeId);
  const currentSegment = segments[Math.min(segmentIndex, segments.length - 1)];

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    setCues(workspace.cues);
    setSavedCues(workspace.cues);
    setSelectedId(workspace.cues[0]?.id);
    setActiveId(undefined);
    setProjectTimeMs(0);
    setSegmentIndex(0);
  }, [workspace.id]);

  useEffect(() => {
    let mounted = true;
    const api = window.sourceApp;
    api.onSubtitleAiCheckProgress?.((progress) => {
      if (mounted) setAiProgress(progress);
      void api.getSubtitleAiCheckJob?.().then((snapshot) => {
        if (mounted && snapshot?.workspaceId === workspace.id) setAiProposals(snapshot.proposals);
      }).catch((error) => { if (mounted) onError(error instanceof Error ? error.message : String(error)); });
    });
    void api.getSubtitleAiCheckJob?.().then((snapshot) => {
      if (mounted && snapshot?.workspaceId === workspace.id) {
        setAiProgress(snapshot.progress);
        setAiProposals(snapshot.proposals);
        setAiEnabled(snapshot.options.enabled);
        setInteractiveConfirmation(snapshot.options.interactiveConfirmation);
        setAiProvider(snapshot.options.provider);
        setDisplayLanguage(snapshot.options.displayLanguage);
        setAiTitle(snapshot.options.title);
        setAiDescription(snapshot.options.description);
      }
    }).catch((error) => { if (mounted) onError(error instanceof Error ? error.message : String(error)); });
    return () => { mounted = false; api.clearSubtitleAiCheckProgressListeners?.(); };
  }, [workspace.id, onError]);

  useEffect(() => {
    let active = true;
    setFrameUrl(undefined);
    if (!selected || !window.sourceApp.getSubtitleEvidenceFrame) return;
    void window.sourceApp.getSubtitleEvidenceFrame(workspace.id, selected.startMs)
      .then((result) => { if (active) setFrameUrl(result.url); })
      .catch((error) => { if (active) onError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [workspace.id, selectedId, selected?.startMs, onError]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        void save();
        return;
      }
      if (isTextEntryTarget(event.target)) return;
      const video = videoRef.current;
      if (!video) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (video.paused) void video.play(); else video.pause();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        seekProjectTime(projectTimeMs + (event.key === "ArrowLeft" ? -2000 : 2000));
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = Math.max(0, Math.min(cues.length - 1, (selected ? cues.findIndex((cue) => cue.id === selected.id) : -1) + (event.key === "ArrowUp" ? -1 : 1)));
        if (cues[next]) setSelectedId(cues[next].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (activeIndex < 0 || Date.now() < manualScrollUntil.current) return;
    const list = listRef.current;
    const row = cueRefs.current.get(activeId!);
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const relativeCenter = rowRect.height > 0
      ? list.scrollTop + rowRect.top - listRect.top + rowRect.height / 2
      : row.offsetTop + row.clientHeight / 2;
    const top = Math.max(0, relativeCenter - list.clientHeight * 0.45);
    programmaticScrollUntil.current = Date.now() + 1_200;
    if (typeof list.scrollTo === "function") list.scrollTo({ top, behavior: "smooth" });
    else list.scrollTop = top;
    console.info("[SUBTITLE] focus", { workspace: "standalone", cueId: activeId, reason: followResumeRevision ? "manual-override-expired-or-active-change" : "active-change", top });
  }, [activeId, activeIndex, followResumeRevision]);

  useEffect(() => () => {
    if (manualScrollTimer.current !== undefined) window.clearTimeout(manualScrollTimer.current);
  }, []);

  const save = async (next = cues): Promise<StandaloneSubtitleWorkspace | undefined> => {
    if (!window.sourceApp.saveStandaloneSubtitleWorkspace) return undefined;
    setBusy(true);
    try {
      const updated = await window.sourceApp.saveStandaloneSubtitleWorkspace(workspace.id, next);
      setCues(updated.cues);
      setSavedCues(updated.cues);
      onUpdated(updated);
      return updated;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const seekProjectTime = useCallback((timeMs: number) => {
    const bounded = Math.max(0, Math.min(segments.reduce((sum, segment) => sum + segment.outMs - segment.inMs, 0), timeMs));
    const foundIndex = segments.findIndex((segment) => bounded < segment.projectStartMs + segment.outMs - segment.inMs);
    const index = foundIndex >= 0 ? foundIndex : Math.max(0, segments.length - 1);
    const segment = segments[index] ?? segments[segments.length - 1];
    if (!segment || !videoRef.current) return;
    resumeOnSegmentLoad.current = false;
    handoffSegmentIndex.current = undefined;
    if (!videoRef.current.paused) videoRef.current.pause();
    setSegmentIndex(index);
    setProjectTimeMs(bounded);
    const seconds = (segment.inMs + bounded - segment.projectStartMs) / 1000;
    pendingSeekSeconds.current = seconds;
    if (index === segmentIndex) videoRef.current.currentTime = seconds;
  }, [segments, segmentIndex]);

  const update = (id: string, patch: Partial<SubtitleCue>) =>
    setCues((current) => current.map((cue) => cue.id === id ? { ...cue, ...patch, userEdited: true } : cue));

  const remove = (id: string) => setCues((current) => current.filter((cue) => cue.id !== id));

  const mergeNext = () => {
    if (!selected) return;
    const index = cues.findIndex((cue) => cue.id === selected.id);
    const next = cues[index + 1];
    if (!next) return;
    const merged = { ...selected, endMs: next.endMs, text: [selected.text, next.text].filter(Boolean).join(" "), userEdited: true };
    setCues((current) => current.filter((cue) => cue.id !== next.id).map((cue) => cue.id === selected.id ? merged : cue));
  };

  const split = () => {
    if (!selected || selected.endMs - selected.startMs < 2) return;
    const midpoint = Math.floor((selected.startMs + selected.endMs) / 2);
    const chars = [...selected.text];
    const splitAt = Math.max(1, Math.floor(chars.length / 2));
    const second: SubtitleCue = { ...selected, id: crypto.randomUUID(), startMs: midpoint, text: chars.slice(splitAt).join("").trim() || selected.text, userEdited: true };
    update(selected.id, { endMs: midpoint, text: chars.slice(0, splitAt).join("").trim() || selected.text });
    setCues((current) => {
      const index = current.findIndex((cue) => cue.id === selected.id);
      return [...current.slice(0, index + 1), second, ...current.slice(index + 1)];
    });
    setSelectedId(second.id);
  };

  const exportSrt = async () => {
    const api = window.sourceApp;
    if (!api.chooseSubtitleOutput || !api.exportStandaloneSubtitleWorkspace) return;
    setBusy(true);
    try {
      if (dirty && api.saveStandaloneSubtitleWorkspace) {
        const updated = await api.saveStandaloneSubtitleWorkspace(workspace.id, cues);
        setCues(updated.cues);
        setSavedCues(updated.cues);
        onUpdated(updated);
      }
      const output = await api.chooseSubtitleOutput(workspace.videoPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") + ".srt");
      if (!output) return;
      const result = await api.exportStandaloneSubtitleWorkspace(workspace.id, output.token);
      setExportNotice(result.backupPath
        ? `已匯出 SRT；原檔已先備份：${result.backupPath}`
        : `已匯出 SRT：${result.outputPath}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const startAiCheck = async () => {
    if (!aiEnabled || !window.sourceApp.startSubtitleAiCheck) return;
    try {
      if (dirty && !await save(cues)) return;
      const snapshot = await window.sourceApp.startSubtitleAiCheck({
        workspaceId: workspace.id, enabled: aiEnabled, interactiveConfirmation, provider: aiProvider,
        displayLanguage, title: aiTitle, description: aiDescription,
      });
      setAiProgress(snapshot.progress);
      setAiProposals(snapshot.proposals);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const pauseAiCheck = async () => {
    try { await window.sourceApp.pauseSubtitleAiCheck?.(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const resumeAiCheck = async () => {
    try {
      if (dirty && !await save(cues)) return;
      const snapshot = await window.sourceApp.resumeSubtitleAiCheck?.();
      if (snapshot) { setAiProgress(snapshot.progress); setAiProposals(snapshot.proposals); }
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const stopAiCheck = async () => {
    try {
      const snapshot = await window.sourceApp.stopSubtitleAiCheck?.();
      if (snapshot) { setAiProgress(snapshot.progress); setAiProposals(snapshot.proposals); }
    }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const aiAction = async (proposal: SubtitleAiCheckProposal, action: "KEEP" | "APPLY" | "EDIT" | "SKIP") => {
    if (!window.sourceApp.applySubtitleAiCheckAction) return;
    try {
      if ((action === "APPLY" || action === "EDIT") && dirty && !await save(cues)) return;
      const result = await window.sourceApp.applySubtitleAiCheckAction({
        workspaceId: workspace.id, proposalId: proposal.id, action,
        ...(action === "EDIT" && editedProposal ? {
          editedText: editedProposal.text, editedStartMs: editedProposal.startMs, editedEndMs: editedProposal.endMs,
        } : {}),
      });
      setAiProposals((current) => current.map((item) => item.id === proposal.id ? result.proposal : item));
      if (action === "APPLY" || action === "EDIT") {
        setCues(result.workspace.cues);
        setSavedCues(result.workspace.cues);
        onUpdated(result.workspace);
        if (result.project) onProjectUpdated?.(result.project);
      }
      if (result.conflict) onError("字幕在 AI 建議產生後已有較新的人工修改；已保留人工內容，未套用舊建議。");
      setEditingProposalId(undefined);
      setEditedProposal(undefined);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const advanceSegment = (resume: boolean) => {
    if (segmentIndex < segments.length - 1) {
      if (handoffSegmentIndex.current !== undefined) {
        resumeOnSegmentLoad.current = resumeOnSegmentLoad.current || resume;
        return;
      }
      handoffSegmentIndex.current = segmentIndex;
      const nextIndex = segmentIndex + 1;
      setSegmentIndex(nextIndex);
      setProjectTimeMs(segments[nextIndex].projectStartMs);
      pendingSeekSeconds.current = segments[nextIndex].inMs / 1000;
      resumeOnSegmentLoad.current = resumeOnSegmentLoad.current || resume;
    }
  };

  const onVideoTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (handoffSegmentIndex.current !== undefined) return;
    const segment = segments[segmentIndex];
    const sourceTimeMs = event.currentTarget.currentTime * 1000;
    if (sourceTimeMs >= segment.outMs - 1 && segmentIndex < segments.length - 1) {
      advanceSegment(!event.currentTarget.paused);
      return;
    }
    const time = Math.max(segment.projectStartMs, Math.min(segment.projectStartMs + segment.outMs - segment.inMs, segment.projectStartMs + (sourceTimeMs - segment.inMs)));
    setProjectTimeMs(time);
    const cue = cues.find((item) => time >= item.startMs && time < item.endMs);
    if (cue?.id !== activeId) {
      setActiveId(cue?.id);
      if (cue) setSelectedId(cue.id);
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      void save();
    }
  };

  const returnToCurrentCue = () => {
    manualScrollUntil.current = 0;
    if (manualScrollTimer.current !== undefined) window.clearTimeout(manualScrollTimer.current);
    manualScrollTimer.current = undefined;
    setFollowResumeRevision((revision) => revision + 1);
  };

  const seekAdjacentCue = (direction: -1 | 1) => {
    if (!selected) return;
    const index = cues.findIndex((cue) => cue.id === selected.id);
    const target = cues[index + direction];
    if (!target) return;
    setSelectedId(target.id);
    seekProjectTime(target.startMs);
  };

  return (
    <section className="standalone-subtitle-review" aria-label="獨立字幕審核">
      <header className="standalone-subtitle-review__header">
        <h2>獨立字幕審核</h2>
        <span role="status">{dirty ? "尚未儲存" : "已儲存"}</span>
        <button type="button" disabled={!dirty || busy} onClick={() => void save()}>儲存草稿</button>
        <button type="button" disabled={busy} onClick={() => void exportSrt()}>匯出 SRT</button>
      </header>
      {exportNotice && <p role="status">{exportNotice}</p>}
      <div className="standalone-subtitle-review__workspace">
        <div className="standalone-subtitle-review__left">
          {selected && <div className="standalone-subtitle-review__editor" aria-label="編輯選取字幕">
            <label>文字<textarea aria-label="字幕文字" value={selected.text} onChange={(event) => update(selected.id, { text: event.target.value })} /></label>
            <label>開始（毫秒）<input aria-label="開始時間" type="number" value={selected.startMs} onChange={(event) => update(selected.id, { startMs: Number(event.target.value) })} /></label>
            <label>結束（毫秒）<input aria-label="結束時間" type="number" value={selected.endMs} onChange={(event) => update(selected.id, { endMs: Number(event.target.value) })} /></label>
            <button type="button" onClick={mergeNext} disabled={!cues[cues.findIndex((cue) => cue.id === selected.id) + 1]}>與下一筆合併</button>
            <button type="button" onClick={split} disabled={selected.endMs - selected.startMs < 2}>從中點拆分</button>
            <button type="button" onClick={() => remove(selected.id)}>刪除字幕</button>
          </div>}
          <ol ref={listRef} className="standalone-subtitle-review__list" aria-label="字幕 cue 清單" onKeyDown={onListKeyDown}
            onWheel={() => {
              manualScrollUntil.current = Date.now() + 4000;
              if (manualScrollTimer.current !== undefined) window.clearTimeout(manualScrollTimer.current);
              manualScrollTimer.current = window.setTimeout(() => setFollowResumeRevision((revision) => revision + 1), 4000);
            }}
            onPointerDown={() => {
              manualScrollUntil.current = Date.now() + 4000;
              if (manualScrollTimer.current !== undefined) window.clearTimeout(manualScrollTimer.current);
              manualScrollTimer.current = window.setTimeout(() => setFollowResumeRevision((revision) => revision + 1), 4000);
            }}
            onScroll={() => {
              if (Date.now() < programmaticScrollUntil.current) return;
              manualScrollUntil.current = Date.now() + 4000;
              if (manualScrollTimer.current !== undefined) window.clearTimeout(manualScrollTimer.current);
              manualScrollTimer.current = window.setTimeout(() => setFollowResumeRevision((revision) => revision + 1), 4000);
            }}>
            {cues.map((cue, index) => <li key={cue.id} ref={(element) => { if (element) cueRefs.current.set(cue.id, element); else cueRefs.current.delete(cue.id); }} className={cue.id === activeId ? "is-active" : undefined}>
              <button type="button" aria-pressed={cue.id === selectedId} aria-label={`選取第 ${index + 1} 筆 ${cue.text}`} onClick={() => setSelectedId(cue.id)} onDoubleClick={() => seekProjectTime(cue.startMs)}>
                <span>{index + 1}</span><span>{formatTime(cue.startMs)}</span><span>{formatTime(cue.endMs)}</span><span>{formatCueDuration(cue.startMs, cue.endMs)}</span><span>{cue.text}</span>
                {cue.aiConfidence !== undefined && <span>{cue.aiConfidence}%</span>}
              </button>
              <button type="button" aria-label={`刪除第 ${index + 1} 筆`} onClick={() => remove(cue.id)}>刪除</button>
            </li>)}
          </ol>
        </div>
        <div className="standalone-subtitle-review__right">
          <div className="standalone-subtitle-review__preview">
            <video ref={videoRef} controls src={currentSegment?.src} onLoadedMetadata={(event) => {
              const segment = segments[segmentIndex];
              if (pendingSeekSeconds.current !== undefined) {
                event.currentTarget.currentTime = pendingSeekSeconds.current;
                pendingSeekSeconds.current = undefined;
                handoffSegmentIndex.current = undefined;
              } else if (segment && event.currentTarget.currentTime < segment.inMs / 1000) event.currentTarget.currentTime = segment.inMs / 1000;
              if (resumeOnSegmentLoad.current) {
                resumeOnSegmentLoad.current = false;
                void event.currentTarget.play();
              }
            }} onTimeUpdate={onVideoTimeUpdate} onEnded={() => {
              advanceSegment(true);
            }} />
            {activeId && <div className="standalone-subtitle-review__overlay" aria-live="polite">{cues.find((cue) => cue.id === activeId)?.text}</div>}
            {frameUrl && <img src={frameUrl} alt={`字幕畫面 ${formatTime(selected?.startMs ?? 0)}`} />}
          </div>
          <div className="standalone-subtitle-review__playback">
            <span>專案時間 {formatTime(projectTimeMs)}</span>
            <button type="button" aria-label="上一筆字幕" disabled={!selected || cues.findIndex((cue) => cue.id === selected.id) <= 0} onClick={() => seekAdjacentCue(-1)}>上一筆字幕</button>
            <button type="button" aria-label="下一筆字幕" disabled={!selected || cues.findIndex((cue) => cue.id === selected.id) >= cues.length - 1} onClick={() => seekAdjacentCue(1)}>下一筆字幕</button>
            <button type="button" aria-label="倒退兩秒" onClick={() => seekProjectTime(projectTimeMs - 2000)}>−2 秒</button>
            <button type="button" aria-label="前進兩秒" onClick={() => seekProjectTime(projectTimeMs + 2000)}>+2 秒</button>
            <button type="button" aria-label="回到目前字幕" disabled={!activeId} onClick={returnToCurrentCue}>回到目前字幕</button>
            <label>播放速度<select aria-label="播放速度" value={playbackRate} onChange={(event) => {
              const rate = Number(event.target.value);
              setPlaybackRate(rate);
              if (videoRef.current) videoRef.current.playbackRate = rate;
            }}><option value={0.5}>0.5×</option><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
            <span className="standalone-subtitle-review__shortcuts">Space 播放／暫停 · ←／→ 2 秒 · ↑／↓ 上下 cue · Ctrl+Enter 儲存</span>
          </div>
        </div>
      </div>
      <details className="standalone-subtitle-review__ai-check">
        <summary>AI 逐筆審核</summary>
        <div className="standalone-subtitle-review__ai-options">
          <label><input aria-label="啟用逐筆 AI 檢查" type="checkbox" checked={aiEnabled} onChange={(event) => setAiEnabled(event.target.checked)} />啟用逐筆 AI 檢查</label>
          <label><input aria-label="逐筆互動確認" type="checkbox" checked={interactiveConfirmation} onChange={(event) => setInteractiveConfirmation(event.target.checked)} />逐筆互動確認</label>
          <label>Provider<select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as MaterialAnalysisProvider)}><option value="CHATGPT">OpenAI</option><option value="GEMINI">Gemini</option></select></label>
          <label>語言<select value={displayLanguage} onChange={(event) => setDisplayLanguage(event.target.value as typeof displayLanguage)}><option value="zh-TW">繁體中文</option><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option></select></label>
          <label>標題<input value={aiTitle} onChange={(event) => setAiTitle(event.target.value)} /></label>
          <label>說明<textarea value={aiDescription} onChange={(event) => setAiDescription(event.target.value)} /></label>
          <div className="standalone-subtitle-review__ai-actions">
            <button type="button" disabled={!aiEnabled || aiProgress?.status === "RUNNING"} onClick={() => void startAiCheck()}>開始</button>
            <button type="button" disabled={aiProgress?.status !== "RUNNING"} onClick={() => void pauseAiCheck()}>暫停</button>
            <button type="button" disabled={aiProgress?.status !== "PAUSED"} onClick={() => void resumeAiCheck()}>繼續</button>
            <button type="button" disabled={!aiProgress || !["RUNNING", "PAUSED"].includes(aiProgress.status)} onClick={() => void stopAiCheck()}>停止</button>
          </div>
          {aiProgress && <p role="status">{aiProgress.status} · {aiProgress.processed}/{aiProgress.total} · {aiProgress.provider ?? "—"} / {aiProgress.modelId ?? "—"}{aiProgress.error ? ` · ${aiProgress.error}` : ""}</p>}
        </div>
        <div className="standalone-subtitle-review__proposals">
          {aiProposals.filter((proposal) => proposal.status === "PENDING" || proposal.status === "EDITING").map((proposal) => <article key={proposal.id}>
            <h3>Cue {proposal.cueIndex + 1} · {proposal.decision}</h3>
            <p>{proposal.reason}</p>
            <p>文字建議：{proposal.suggestedText ?? "保持原文"}</p>
            <p>時間：{formatTime(proposal.suggestedStartMs ?? cues.find((cue) => cue.id === proposal.cueId)?.startMs ?? 0)}–{formatTime(proposal.suggestedEndMs ?? cues.find((cue) => cue.id === proposal.cueId)?.endMs ?? 0)} · 時間信心 {Math.round(proposal.timingConfidence * 100)}% · 整體信心 {Math.round(proposal.confidence * 100)}%</p>
            <p>畫面時間：{proposal.evidenceTimesMs.map(formatTime).join("、") || "—"} · {proposal.provider}/{proposal.modelId}</p>
            <AiEvidencePanel workspaceId={workspace.id} proposal={proposal} onError={onError} />
            {editingProposalId === proposal.id && editedProposal ? <div>
              <label>文字<input value={editedProposal.text} onChange={(event) => setEditedProposal({ ...editedProposal, text: event.target.value })} /></label>
              <label>開始毫秒<input type="number" value={editedProposal.startMs} onChange={(event) => setEditedProposal({ ...editedProposal, startMs: Number(event.target.value) })} /></label>
              <label>結束毫秒<input type="number" value={editedProposal.endMs} onChange={(event) => setEditedProposal({ ...editedProposal, endMs: Number(event.target.value) })} /></label>
              <button type="button" onClick={() => void aiAction(proposal, "EDIT")}>確認修改</button>
            </div> : <div className="standalone-subtitle-review__ai-actions">
              <button type="button" onClick={() => void aiAction(proposal, "KEEP")}>保留原字幕</button>
              <button type="button" disabled={!proposal.suggestedText && proposal.suggestedStartMs === undefined && proposal.suggestedEndMs === undefined} onClick={() => void aiAction(proposal, "APPLY")}>套用建議</button>
              <button type="button" onClick={() => {
                setEditingProposalId(proposal.id);
                setEditedProposal({ text: proposal.suggestedText ?? cues.find((cue) => cue.id === proposal.cueId)?.text ?? "", startMs: proposal.suggestedStartMs ?? cues.find((cue) => cue.id === proposal.cueId)?.startMs ?? 0, endMs: proposal.suggestedEndMs ?? cues.find((cue) => cue.id === proposal.cueId)?.endMs ?? 0 });
              }}>編輯後套用</button>
              <button type="button" onClick={() => void aiAction(proposal, "SKIP")}>略過</button>
            </div>}
          </article>)}
        </div>
      </details>
    </section>
  );
}
