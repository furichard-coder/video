import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppInfo, BackgroundJobSnapshot, ImportProgress, ProjectHistoryState, ProjectManifest, SortMode, SourceAsset, ViewMode } from "../shared/domain";
import { mainRenderSelections } from "../shared/editing-rules";
import { AssetCard } from "./components/AssetCard";
import { ConcatRenderModal } from "./components/ConcatRenderModal";
import { IntroStudio } from "./components/IntroStudio";
import { PlaylistModal } from "./components/PlaylistModal";
import { PreviewModal } from "./components/PreviewModal";
import { ExternalOpenModal } from "./components/ExternalOpenModal";
import { PlayerSettingsModal } from "./components/PlayerSettingsModal";
import { VolumeSegmentsModal } from "./components/VolumeSegmentsModal";
import { PlacementModal } from "./components/PlacementModal";
import { BgmStudio } from "./components/BgmStudio";
import { SubtitleStudio } from "./components/SubtitleStudio";
import { ConfirmMainRemovalModal } from "./components/ConfirmMainRemovalModal";
import { MediaInsertionModal } from "./components/MediaInsertionModal";
import { AiSettingsModal } from "./components/AiSettingsModal";
import { DisplaySettingsModal } from "./components/DisplaySettingsModal";
import { YoutubeSettingsModal } from "./components/YoutubeSettingsModal";
import { OutputHistoryModal } from "./components/OutputHistoryModal";
import { MaterialEditorModal, type MaterialEditorSection } from "./components/MaterialEditorModal";
import { formatBytes } from "./format";
import { applyUiTextSize, applyUiZoom, readUiTextSize, readUiZoom, stepUiZoom, type UiTextSize, type UiZoomPercent } from "./ui-preferences";

function projectScopeNeedsReview(project: ProjectManifest, scope: "MAIN" | "INTRO"): boolean {
  const timelineRevision = scope === "INTRO" ? (project.introTimelineRevision ?? project.timelineRevision) : (project.mainTimelineRevision ?? project.timelineRevision);
  const reviewRevision = scope === "INTRO" ? (project.introSubtitleReviewRevision ?? project.subtitleTimelineRevision) : (project.mainSubtitleReviewRevision ?? project.subtitleTimelineRevision);
  return timelineRevision !== reviewRevision;
}

type MainWorkspace = "SOURCES" | "INTRO" | "BGM" | "SUBTITLES" | "OUTPUTS" | "PUBLISH";

const SORT_LABELS: Record<SortMode, string> = {
  MANUAL_ORDER: "自訂順序",
  SMART_SEQUENCE: "智慧順序（時間 → 檔名 → 加入）",
  FILE_NAME: "自然檔名",
  CAPTURE_OR_FILE_TIME: "拍攝／檔案時間",
  ADDED_ORDER: "加入順序",
};

function playCloseChime(): void {
  if (typeof AudioContext === "undefined") return;
  try {
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.48);
    gain.connect(context.destination);
    [659.25, 783.99].forEach((frequency, index) => {
      const tone = context.createOscillator();
      tone.type = "sine";
      tone.frequency.value = frequency;
      tone.connect(gain);
      tone.start(context.currentTime + index * 0.14);
      tone.stop(context.currentTime + 0.32 + index * 0.14);
    });
    setTimeout(() => { void context.close(); }, 650);
  } catch {
    // Sound is a friendly enhancement; close confirmation remains usable without it.
  }
}

export function App() {
  const [project, setProject] = useState<ProjectManifest>();
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [historyState, setHistoryState] = useState<ProjectHistoryState>({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
  const [historyBusy, setHistoryBusy] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("GRID");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [selectedAsset, setSelectedAsset] = useState<SourceAsset>();
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showConcatRender, setShowConcatRender] = useState(false);
  const [showIntroStudio, setShowIntroStudio] = useState(false);
  const [showPlayerSettings, setShowPlayerSettings] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showDisplaySettings, setShowDisplaySettings] = useState(false);
  const [showYoutubeSettings, setShowYoutubeSettings] = useState(false);
  const [showOutputHistory, setShowOutputHistory] = useState(false);
  const [uiTextSize, setUiTextSize] = useState<UiTextSize>(() => readUiTextSize());
  const [uiZoom, setUiZoom] = useState<UiZoomPercent>(() => readUiZoom());
  const [externalAsset, setExternalAsset] = useState<SourceAsset>();
  const [externalOpeningId, setExternalOpeningId] = useState<string>();
  const [volumeAsset, setVolumeAssetState] = useState<SourceAsset>();
  const [placementQueue, setPlacementQueue] = useState<string[]>([]);
  const [showBgm, setShowBgm] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(false);
  const [confirmRemoveAsset, setConfirmRemoveAsset] = useState<SourceAsset>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [lastRemovedMainId, setLastRemovedMainId] = useState<string>();
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [projectFilePath, setProjectFilePath] = useState<string>();
  const [projectFileBusy, setProjectFileBusy] = useState(false);
  const [saveState, setSaveState] = useState<"SAVED" | "SAVING" | "ERROR">("SAVED");
  const [savedAt, setSavedAt] = useState<string>();
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJobSnapshot[]>([]);
  const [mediaInsertionVideo, setMediaInsertionVideoState] = useState<SourceAsset>();
  const [draggingAssetId, setDraggingAssetId] = useState<string>();
  const [dragTargetAssetId, setDragTargetAssetId] = useState<string>();
  const [showCloseConfirmation, setShowCloseConfirmation] = useState(false);
  const [materialEditorAsset, setMaterialEditorAsset] = useState<SourceAsset>();
  const [materialEditorSection, setMaterialEditorSection] = useState<MaterialEditorSection>("CLIP");
  const [activeWorkspace, setActiveWorkspace] = useState<MainWorkspace>("SOURCES");
  const draggingAssetIdRef = useRef<string | undefined>(undefined);
  const dragOrderRef = useRef<string[]>([]);
  const dragOriginIndexRef = useRef<number | undefined>(undefined);

  const setVolumeAsset = (asset?: SourceAsset) => {
    if (!asset) { setVolumeAssetState(undefined); setMaterialEditorAsset(undefined); return; }
    if (materialEditorAsset?.id === asset.id) { setMaterialEditorAsset(undefined); setVolumeAssetState(asset); return; }
    setMaterialEditorAsset(asset);
    setMaterialEditorSection("VOLUME");
  };
  const setMediaInsertionVideo = (asset?: SourceAsset) => {
    if (!asset) { setMediaInsertionVideoState(undefined); setMaterialEditorAsset(undefined); return; }
    if (materialEditorAsset?.id === asset.id) { setMaterialEditorAsset(undefined); setMediaInsertionVideoState(asset); return; }
    setMaterialEditorAsset(asset);
    setMaterialEditorSection("INSERT");
  };

  useEffect(() => {
    void Promise.all([window.sourceApp.getProject(), window.sourceApp.getProjectFileState(), window.sourceApp.getAppInfo(), window.sourceApp.getUserPreferences()])
      .then(([restored, fileState, info, preferences]) => { setProject(restored); setProjectFilePath(fileState.filePath); setAppInfo(info); setViewMode(preferences.viewMode); })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); });
    window.sourceApp.onImportProgress(setProgress);
    return () => window.sourceApp.clearImportProgressListeners();
  }, []);

  useEffect(() => {
    if (!window.sourceApp.onProjectChanged) return;
    window.sourceApp.onProjectChanged((change) => {
      setProject((current) => {
        if (!current || current.id !== change.projectId) {
          setSelectedAsset(undefined); setShowPlaylist(false); setShowConcatRender(false); setShowIntroStudio(false); setShowBgm(false); setShowSubtitles(false);
        }
        return structuredClone(change.project);
      });
      if (change.filePath !== undefined) setProjectFilePath(change.filePath);
      setSaveState("SAVED"); setSavedAt(change.updatedAt);
      setNotice(`專案「${change.project.name}」已同步保存（${change.changedSections.join("、")}）。`);
    });
    return () => window.sourceApp.clearProjectChangedListeners?.();
  }, []);

  useEffect(() => {
    const getJobs = window.sourceApp.getBackgroundJobs;
    const onJobs = window.sourceApp.onBackgroundJobs;
    if (!getJobs || !onJobs) return;
    void getJobs().then(setBackgroundJobs).catch(() => undefined);
    onJobs(setBackgroundJobs);
    return () => window.sourceApp.clearBackgroundJobsListeners?.();
  }, []);

  useEffect(() => applyUiTextSize(uiTextSize), [uiTextSize]);
  useEffect(() => applyUiZoom(uiZoom), [uiZoom]);

  const changeUiZoom = useCallback((direction: -1 | 1) => {
    setUiZoom((current) => stepUiZoom(current, direction));
  }, []);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      changeUiZoom(event.deltaY < 0 ? 1 : -1);
    };
    const onZoomKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const zoomIn = event.key === "ArrowUp" || event.key === "+" || event.key === "=";
      const zoomOut = event.key === "ArrowDown" || event.key === "-" || event.key === "_";
      if (!zoomIn && !zoomOut && event.key !== "0") return;
      event.preventDefault();
      if (event.key === "0") setUiZoom(100);
      else changeUiZoom(zoomIn ? 1 : -1);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onZoomKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onZoomKey);
    };
  }, [changeUiZoom]);

  useEffect(() => {
    window.sourceApp.onAppCloseRequested(() => {
      setShowCloseConfirmation(true);
      playCloseChime();
    });
    return () => window.sourceApp.clearAppCloseRequestedListeners();
  }, []);

  useEffect(() => {
    if (!project) return;
    void window.sourceApp.getProjectHistoryState().then(setHistoryState).catch(() => undefined);
  }, [project]);

  const updateAsset = useCallback((updated: SourceAsset) => {
    setProject((current) =>
      current
        ? { ...current, sources: current.sources.map((asset) => (asset.id === updated.id ? updated : asset)) }
        : current,
    );
    setSelectedAsset((current) => (current?.id === updated.id ? updated : current));
  }, []);
  const replaceProject = useCallback((updated: ProjectManifest) => setProject(structuredClone(updated)), []);

  const sortedAssets = useMemo(
    () => project ? project.timelineOrder.map((id) => project.sources.find((asset) => asset.id === id)).filter((asset): asset is SourceAsset => Boolean(asset)) : [],
    [project],
  );
  const pendingAssets = useMemo(() => project ? project.pendingAssetIds.map((id) => project.sources.find((asset) => asset.id === id)).filter((asset): asset is SourceAsset => Boolean(asset)) : [], [project]);
  const totalBytes = useMemo(
    () => project?.sources.reduce((sum, asset) => sum + asset.sizeBytes, 0) ?? 0,
    [project?.sources],
  );
  const sortedVideos = useMemo(
    () => sortedAssets.filter((asset) => asset.kind === "VIDEO"),
    [sortedAssets],
  );
  const mainClips = useMemo(() => project ? mainRenderSelections(project) : [], [project]);
  const timelineDurationMs = useMemo(() => mainClips.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0), [mainClips]);

  const closeProjectViews = () => {
    setSelectedAsset(undefined); setShowPlaylist(false); setShowConcatRender(false); setShowIntroStudio(false);
    setExternalAsset(undefined); setVolumeAssetState(undefined); setShowBgm(false); setShowSubtitles(false);
    setConfirmRemoveAsset(undefined); setPlacementQueue([]); setLastRemovedMainId(undefined);
    setMediaInsertionVideoState(undefined); setShowAiSettings(false); setShowYoutubeSettings(false);
    setShowOutputHistory(false);
  };
  const openWorkspace = (workspace: MainWorkspace) => {
    closeProjectViews(); setActiveWorkspace(workspace);
    if (workspace === "INTRO") setShowIntroStudio(true);
    else if (workspace === "BGM") setShowBgm(true);
    else if (workspace === "SUBTITLES") setShowSubtitles(true);
    else if (workspace === "OUTPUTS") setShowOutputHistory(true);
    else if (workspace === "PUBLISH") setShowYoutubeSettings(true);
  };

  const runHistory = useCallback(async (direction: "UNDO" | "REDO") => {
    if (historyBusy) return;
    setHistoryBusy(true); setError(undefined); setNotice(undefined);
    try {
      const restored = direction === "UNDO" ? await window.sourceApp.undoProject() : await window.sourceApp.redoProject();
      closeProjectViews();
      setProject(restored);
      setNotice(direction === "UNDO" ? "已復原上一步專案修改；來源媒體未受影響。" : "已重做下一步專案修改；來源媒體未受影響。");
      setHistoryState(await window.sourceApp.getProjectHistoryState());
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setHistoryBusy(false); }
  }, [historyBusy]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      const key = event.key.toLowerCase();
      const direction = key === "y" || (key === "z" && event.shiftKey) ? "REDO" : key === "z" ? "UNDO" : undefined;
      if (!direction) return;
      event.preventDefault();
      const available = direction === "UNDO" ? historyState.canUndo : historyState.canRedo;
      if (available) void runHistory(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyState, runHistory]);

  const saveProjectFile = async (saveAs: boolean) => {
    setProjectFileBusy(true); setSaveState("SAVING"); setError(undefined); setShowFileMenu(false);
    try {
      const result = saveAs ? await window.sourceApp.saveProjectAs() : await window.sourceApp.saveProject();
      if (!result) return;
      setProject(result.project); setProjectFilePath(result.filePath); setSaveState("SAVED"); setSavedAt(result.project.updatedAt);
      setNotice(`專案「${result.project.name}」已安全儲存。來源媒體與 cache 未複製或修改。`);
    } catch (reason) { setSaveState("ERROR"); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setProjectFileBusy(false); }
  };

  const openProjectFile = async () => {
    setProjectFileBusy(true); setError(undefined); setShowFileMenu(false);
    try {
      const result = await window.sourceApp.openProject();
      if (!result) return;
      closeProjectViews(); setProject(result.project); setProjectFilePath(result.filePath);
      setNotice(`已開啟專案「${result.project.name}」；來源檔仍以唯讀引用。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setProjectFileBusy(false); }
  };

  const runImport = async (mode: "FILES" | "FOLDER") => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setProgress({ phase: "DISCOVERING", discovered: 0, processed: 0 });
    try {
      const result = mode === "FILES" ? await window.sourceApp.chooseFiles() : await window.sourceApp.chooseFolder();
      setProject(result.project);
      setPlacementQueue(result.addedAssetIds.filter((id) => result.project.pendingAssetIds.includes(id)));
      if (!result.cancelled) {
        setNotice(
          `已加入 ${result.addedCount} 項${result.duplicateCount ? `，略過 ${result.duplicateCount} 個重複項目` : ""}${
            result.unsupportedCount ? `，略過 ${result.unsupportedCount} 個不支援檔案` : ""
          }。`,
        );
        if (result.errors.length) setError(result.errors.join("\n"));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  const moveAsset = async (assetId: string, toIndex: number) => {
    try { setProject(await window.sourceApp.moveTimelineAsset(assetId, toIndex)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const beginGridDrag = (assetId: string) => {
    if (!project || viewMode !== "GRID") return;
    const originIndex = project.timelineOrder.indexOf(assetId);
    if (originIndex < 0) return;
    draggingAssetIdRef.current = assetId;
    dragOriginIndexRef.current = originIndex;
    dragOrderRef.current = [...project.timelineOrder];
    setDraggingAssetId(assetId);
    setDragTargetAssetId(assetId);
  };

  const moveGridDragOver = (targetAssetId: string) => {
    const sourceAssetId = draggingAssetIdRef.current;
    if (!sourceAssetId || sourceAssetId === targetAssetId) return;
    const nextOrder = [...dragOrderRef.current];
    const sourceIndex = nextOrder.indexOf(sourceAssetId);
    const targetIndex = nextOrder.indexOf(targetAssetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, sourceAssetId);
    dragOrderRef.current = nextOrder;
    setDragTargetAssetId(targetAssetId);
    setProject((current) => current ? { ...current, timelineOrder: nextOrder, sortMode: "MANUAL_ORDER" } : current);
  };

  const finishGridDrag = async () => {
    const sourceAssetId = draggingAssetIdRef.current;
    if (!sourceAssetId) return;
    const originIndex = dragOriginIndexRef.current;
    const finalIndex = dragOrderRef.current.indexOf(sourceAssetId);
    draggingAssetIdRef.current = undefined;
    dragOriginIndexRef.current = undefined;
    dragOrderRef.current = [];
    setDraggingAssetId(undefined);
    setDragTargetAssetId(undefined);
    if (originIndex === finalIndex || finalIndex < 0) return;
    setError(undefined);
    try {
      const updated = await window.sourceApp.moveTimelineAsset(sourceAssetId, finalIndex);
      setProject(updated);
      setNotice(`已將素材移到第 ${finalIndex + 1} 項；順序已保存到專案。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try { setProject(await window.sourceApp.getProject()); } catch { /* Keep the last visible state if reload also fails. */ }
    }
  };

  const decidePlacement = async (assetId: string, placement: import("../shared/domain").PlacementRequest) => {
    const updated = await window.sourceApp.placeAsset(assetId, placement);
    setProject(updated);
    setPlacementQueue((current) => current.filter((id) => id !== assetId));
  };

  const changeSort = async (sortMode: SortMode) => {
    setError(undefined);
    try {
      setProject(await window.sourceApp.setSortMode(sortMode));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const changeViewMode = async (next: ViewMode) => {
    const previous = viewMode; setViewMode(next); setError(undefined);
    try { await window.sourceApp.updateUserPreferences({ viewMode: next }); }
    catch (reason) { setViewMode(previous); setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const removeAsset = async (asset: SourceAsset) => {
    setRemoveBusy(true);
    try {
      setProject(await window.sourceApp.removeMainAsset(asset.id));
      setLastRemovedMainId(asset.id);
      setNotice(`已從正片移除 ${asset.fileName}；來源檔、proxy 與 Intro 引用仍保留。`);
      setConfirmRemoveAsset(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setRemoveBusy(false); }
  };

  const restoreMainAsset = async (assetId: string) => {
    try {
      const updated = await window.sourceApp.restoreMainAsset(assetId);
      setProject(updated); setLastRemovedMainId(undefined);
      const asset = updated.sources.find((item) => item.id === assetId);
      setNotice(`已恢復 ${asset?.fileName ?? "素材"} 到原本的正片位置與設定。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const openExternalDirect = async (asset: SourceAsset) => {
    setExternalOpeningId(asset.id); setError(undefined);
    try {
      const result = await window.sourceApp.openExternalMedia(asset.id, "ORIGINAL");
      if (result.status === "USE_INTERNAL") {
        setSelectedAsset(asset);
        setError(result.message ?? "外部播放器無法啟動，已改用 App 內建預覽。");
      } else {
        setNotice(result.message ?? `已使用 ${result.playerLabel} 開啟 ${asset.fileName} 的唯讀意圖原檔；實際來源保護仍取決於外部播放器。`);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setExternalOpeningId(undefined); }
  };

  if (!project) {
    return <main className="app-shell loading-shell"><span className="spinner" /><p>正在恢復來源專案…</p></main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left"><div className="brand-lockup"><span className="brand-mark">SW</span><div><strong>SceneryWalker</strong><small>素材整理與預覽</small></div></div><div className="file-menu"><button className="file-menu-button" type="button" aria-haspopup="menu" aria-expanded={showFileMenu} disabled={projectFileBusy} onClick={() => setShowFileMenu((value) => !value)}>檔案 ▾</button>{showFileMenu && <div className="file-menu-popover" role="menu"><div className="file-menu-project"><strong>{project.name}</strong><small title={projectFilePath}>{projectFilePath ?? "尚未另存為專案檔"}</small></div><button role="menuitem" type="button" disabled={!projectFilePath} onClick={() => void saveProjectFile(false)}>儲存專案</button><button role="menuitem" type="button" onClick={() => void saveProjectFile(true)}>另存專案…</button><button role="menuitem" type="button" onClick={() => void openProjectFile()}>開啟舊專案…</button></div>}</div></div>
        <div className="topbar-actions">
          <div className="history-controls" aria-label="復原與重做">
            <button type="button" disabled={historyBusy || !historyState.canUndo} title="復原上一步（Ctrl+Z）" onClick={() => void runHistory("UNDO")}>↶ 復原</button>
            <button type="button" disabled={historyBusy || !historyState.canRedo} title="重做下一步（Ctrl+Y）" onClick={() => void runHistory("REDO")}>↷ 重做</button>
          </div>
          <span className="version-pill" aria-label={`軟體版本 ${appInfo?.version ?? "讀取中"}`}>版本 v{appInfo?.version ?? "…"}</span>
          <button className="settings-button display-settings-button" type="button" aria-label="Aa 設定" title="介面文字與縮放設定" onClick={() => setShowDisplaySettings(true)}>Aa 設定 · {uiZoom}%</button>
          <button className="settings-button ai-settings-button" type="button" onClick={() => setShowAiSettings(true)}>✦ AI 帳號／故事</button>
          <button className="settings-button youtube-settings-button" type="button" onClick={() => setShowYoutubeSettings(true)}>平台上傳設定</button>
          <button className="settings-button output-history-button" type="button" onClick={() => setShowOutputHistory(true)}>▣ 預覽檔案庫</button>
          <button className="settings-button" type="button" onClick={() => setShowPlayerSettings(true)}>⚙ 播放設定</button>
          <div className="protection-pill"><span>●</span><div><strong>來源唯讀保護已開啟</strong><small>移除清單 ≠ 刪除檔案</small></div></div><span className={`save-state save-state-${saveState}`} role="status">{saveState === "SAVING" ? "保存中…" : saveState === "ERROR" ? "保存失敗" : `已保存${savedAt ? ` ${new Date(savedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}` : ""}`}</span>
        </div>
      </header>

      <section className="hero">
        <div>
          <span className="eyebrow">SOURCE ORGANIZER · PHASE 1</span>
          <h1>把素材放進來，<br />先整理出正確順序。</h1>
          <p>匯入多個影片與照片，依拍攝／檔案時間、自然檔名與加入順序排列。先放心預覽，不碰原始檔。</p>
          <div className="hero-actions">
            <button className="primary-button" type="button" disabled={busy} onClick={() => void runImport("FILES")}><span>＋</span> 選擇多個檔案</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void runImport("FOLDER")}>選擇來源資料夾</button>
            {busy && <button className="cancel-button" type="button" onClick={() => void window.sourceApp.cancelImport()}>取消載入</button>}
          </div>
        </div>
        <div className="hero-summary">
          <div><strong>{project.sources.length}</strong><span>素材項目</span></div>
          <div><strong>{formatBytes(totalBytes)}</strong><span>來源總大小</span></div>
          <div><strong>{project.sources.filter((asset) => asset.kind === "VIDEO").length}</strong><span>影片</span></div>
          <div><strong>{project.sources.filter((asset) => asset.kind === "IMAGE").length}</strong><span>照片</span></div>
        </div>
      </section>

      {busy && (
        <section className="progress-banner" aria-live="polite">
          <span className="spinner" />
          <div><strong>{progress?.phase === "ADDING" ? "正在加入來源清單" : "正在找尋支援的媒體"}</strong><span>{progress?.currentName ?? "請稍候…"}</span></div>
          <span>{progress?.processed ?? 0} / {progress?.discovered ?? 0}</span>
        </section>
      )}
      {backgroundJobs.length > 0 && <section className="background-jobs-banner" aria-live="polite" aria-label="背景工作進度"><div><strong>背景工作</strong><span>關閉功能視窗不會中斷；完成後結果會保存到專案或預覽檔案庫。</span></div><div className="background-jobs-list">{backgroundJobs.slice(0, 4).map((job) => <span className={`background-job is-${job.status.toLowerCase()}`} key={job.id}><b>{job.status === "RUNNING" ? "●" : job.status === "COMPLETED" ? "✓" : job.status === "CANCELLED" ? "Ⅱ" : "!"}</b>{job.label}{job.status === "RUNNING" && job.percent !== undefined ? ` ${job.percent}%` : job.status === "COMPLETED" ? " 完成" : job.status === "FAILED" ? " 失敗" : " 已取消"}</span>)}</div></section>}
      {notice && <div className="notice success notice-with-action" role="status"><span>{notice}</span>{lastRemovedMainId && project.excludedMainAssetIds.includes(lastRemovedMainId) && <button type="button" onClick={() => void restoreMainAsset(lastRemovedMainId)}>撤銷，恢復正片</button>}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}

      <section className="library-section">
        <nav className="workspace-nav" aria-label="主要工作區"><button className={activeWorkspace === "SOURCES" ? "active" : ""} onClick={() => openWorkspace("SOURCES")}>01 素材與順序</button><button className={activeWorkspace === "INTRO" ? "active" : ""} onClick={() => openWorkspace("INTRO")}>02 片頭</button><button className={activeWorkspace === "BGM" ? "active" : ""} onClick={() => openWorkspace("BGM")}>03 配樂</button><button className={activeWorkspace === "SUBTITLES" ? "active" : ""} onClick={() => openWorkspace("SUBTITLES")}>04 字幕</button><button className={activeWorkspace === "OUTPUTS" ? "active" : ""} onClick={() => openWorkspace("OUTPUTS")}>05 預覽輸出／成品庫</button><button className={activeWorkspace === "PUBLISH" ? "active" : ""} onClick={() => openWorkspace("PUBLISH")}>06 發布</button></nav>
        <div className="library-toolbar">
          <div><span className="eyebrow">PROJECT SOURCE MANIFEST</span><h2>素材清單</h2></div>
          <div className="toolbar-actions">
            <label className="sort-control"><span>排序</span><select value={project.sortMode} onChange={(event) => void changeSort(event.target.value as SortMode)}>{Object.entries(SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="segmented-control" aria-label="檢視方式"><button type="button" className={viewMode === "GRID" ? "active" : ""} onClick={() => void changeViewMode("GRID")}>網格</button><button type="button" className={viewMode === "LIST" ? "active" : ""} onClick={() => void changeViewMode("LIST")}>清單</button></div>
            <button className="secondary-button" type="button" disabled={!sortedAssets.length} onClick={() => { setMaterialEditorAsset(sortedAssets[0]); setMaterialEditorSection("CLIP"); }}>素材工作區</button><button className="play-all-button" type="button" disabled={!mainClips.length} onClick={() => setShowPlaylist(true)}>▶ 總體預覽</button>
            <button className="concat-button" type="button" disabled={!mainClips.length} title={!mainClips.length ? "正片沒有可供輸出的保留影片片段" : undefined} onClick={() => setShowConcatRender(true)}>⇄ 產出串連預覽</button>
            <button className="ai-intro-button" type="button" onClick={() => setShowIntroStudio(true)}>✦ AI 精彩片頭</button>
            <button className="music-button" type="button" onClick={() => setShowBgm(true)}>♫ 配樂 {project.bgmTracks.length ? `(${project.bgmTracks.length})` : ""}</button>
            <button className="subtitle-button" type="button" onClick={() => setShowSubtitles(true)}>CC 字幕 {project.subtitleCues.length ? `(${project.subtitleCues.length})` : ""}</button>
          </div>
        </div>
        {viewMode === "GRID" && sortedAssets.length > 1 && <p className="grid-reorder-help">長按卡片或縮圖後拖曳，即時調整前後順序；放開後自動保存。也可使用卡片下方的上移／下移。</p>}

        {sortedAssets.length === 0 ? (
          <div className="empty-state"><div className="empty-frames"><span /><span /><span /></div><h2>{project.sources.length ? "正片清單目前為空" : "尚未加入素材"}</h2><p>{project.sources.length ? "所有素材都已從正片移除或仍待決定。來源檔仍在原位置，可從最近移除區恢復。" : "選擇數個影片／照片，或直接選擇一個來源資料夾。App 只讀取檔案並建立自己的預覽快取。"}</p>{!project.sources.length && <button className="primary-button" type="button" onClick={() => void runImport("FILES")}>開始選擇素材</button>}</div>
        ) : (
          <div className={`asset-collection ${viewMode === "LIST" ? "list-view" : "grid-view"}`}>
            {sortedAssets.map((asset, index) => <AssetCard key={asset.id} asset={asset} index={index} previousFileName={sortedAssets[index - 1]?.fileName} nextFileName={sortedAssets[index + 1]?.fileName} viewMode={viewMode} onOpen={setSelectedAsset} onOpenExternalDirect={(item) => void openExternalDirect(item)} onOpenExternalOptions={setExternalAsset} externalOpening={externalOpeningId === asset.id} onOpenVolume={setVolumeAsset} onOpenMediaInsertion={setMediaInsertionVideo} mediaInsertions={project.mediaInsertions.filter((item) => item.anchorVideoAssetId === asset.id).map((item) => { const inserted = project.sources.find((candidate) => candidate.id === item.insertedAssetId); return { ...item, insertedFileName: inserted?.fileName ?? "找不到素材", insertedKind: inserted?.kind ?? "IMAGE" }; })} availableMediaCount={Math.max(0, project.timelineOrder.length + project.pendingAssetIds.length - 1)} onRemove={setConfirmRemoveAsset} onAssetUpdated={updateAsset} onProjectUpdated={replaceProject} canMoveUp={index > 0} canMoveDown={index < sortedAssets.length - 1} onMove={(delta) => void moveAsset(asset.id, index + delta)} dragging={draggingAssetId === asset.id} dragTarget={Boolean(draggingAssetId && dragTargetAssetId === asset.id && draggingAssetId !== asset.id)} onGridDragStart={beginGridDrag} onGridDragEnter={moveGridDragOver} onGridDragEnd={() => void finishGridDrag()} />)}
          </div>
        )}
        {pendingAssets.length > 0 && <section className="pending-section"><div><span className="eyebrow">PENDING PLACEMENT</span><h3>待決定區 · {pendingAssets.length} 項</h3><p>此區素材尚未進入最終順序，也不會加入串連輸出。</p></div><div className="pending-list">{pendingAssets.map((asset) => <div key={asset.id}><strong>{asset.fileName}</strong><span>{asset.kind === "VIDEO" ? "影片" : "照片"}</span><button onClick={() => setPlacementQueue((current) => [asset.id, ...current.filter((id) => id !== asset.id)])}>決定安插位置</button><button aria-label={`從正片移除 ${asset.fileName}`} onClick={() => setConfirmRemoveAsset(asset)}>從正片移除</button></div>)}</div></section>}
        {project.recentMainRemovals.length > 0 && <section className="recent-removals" aria-label="最近從正片移除"><div><span className="eyebrow">RECENTLY REMOVED</span><h3>最近從正片移除</h3><p>只排除專案引用，磁碟來源與相關設定仍保留。</p></div><div>{[...project.recentMainRemovals].reverse().map((record) => { const asset = project.sources.find((item) => item.id === record.assetId); return asset ? <article key={record.assetId}><strong>{asset.fileName}</strong><span>{record.wasPending ? "原本在待決定區" : `原順序 ${Number(record.previousTimelineIndex) + 1}`}</span><button type="button" onClick={() => void restoreMainAsset(record.assetId)}>恢復正片</button></article> : null; })}</div></section>}
        {project.subtitleCues.length > 0 && (projectScopeNeedsReview(project, "MAIN") || projectScopeNeedsReview(project, "INTRO")) && <button className="subtitle-review-banner" onClick={() => setShowSubtitles(true)}>⚠ 片頭或正片時間線已改變，對應字幕需要複核</button>}
      </section>

      <footer className="app-footer"><span title={projectFilePath}>專案：{project.name}{projectFilePath ? " · 已連結專案檔" : " · App Data 自動恢復"}</span><span>Preview cache：衍生檔、可重建、不可作正式輸出</span><span>串連預覽：低解析交接檢查，非正式 Master</span></footer>

      {selectedAsset && <PreviewModal asset={project.sources.find((asset) => asset.id === selectedAsset.id) ?? selectedAsset} project={project} onClose={() => setSelectedAsset(undefined)} onAssetUpdated={updateAsset} onProjectUpdated={setProject} onOpenExternal={setExternalAsset} onOpenIntro={() => { setSelectedAsset(undefined); setShowIntroStudio(true); }} />}
      {materialEditorAsset && <MaterialEditorModal asset={project.sources.find((asset) => asset.id === materialEditorAsset.id) ?? materialEditorAsset} initialSection={materialEditorSection} onClose={() => setMaterialEditorAsset(undefined)} onOpenSection={(section) => { setMaterialEditorSection(section); if (section === "VOLUME") { setMaterialEditorAsset(undefined); setVolumeAsset(materialEditorAsset); } else if (section === "INSERT") { setMaterialEditorAsset(undefined); setMediaInsertionVideo(materialEditorAsset); } else if (section === "CLIP" || section === "PREVIEW") { setMaterialEditorAsset(undefined); setSelectedAsset(materialEditorAsset); } }} />}
      {showPlaylist && mainClips.length > 0 && <PlaylistModal assets={project.sources} clips={mainClips} onClose={() => setShowPlaylist(false)} onAssetUpdated={updateAsset} />}
      {showConcatRender && mainClips.length > 0 && <ConcatRenderModal assets={project.sources} mainClips={mainClips} introClips={project.introSegments} introSegmentMaxDurationMs={project.introSegmentMaxDurationMs} confirmedSubtitleCount={project.subtitleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" && (cue.timelineScope ?? "MAIN") === "MAIN").length} subtitlesNeedReview={project.subtitleCues.some((cue) => (cue.timelineScope ?? "MAIN") === "MAIN") && projectScopeNeedsReview(project, "MAIN")} projectName={project.name} onClose={() => setShowConcatRender(false)} />}
      {showIntroStudio && <IntroStudio project={project} videos={sortedVideos} onClose={() => setShowIntroStudio(false)} onProjectUpdated={setProject} />}
      {showPlayerSettings && <PlayerSettingsModal onClose={() => setShowPlayerSettings(false)} />}
      {showDisplaySettings && <DisplaySettingsModal textSize={uiTextSize} zoomPercent={uiZoom} onTextSizeChange={setUiTextSize} onZoomChange={setUiZoom} onClose={() => setShowDisplaySettings(false)} />}
      {showYoutubeSettings && <YoutubeSettingsModal onClose={() => setShowYoutubeSettings(false)} />}
      {showOutputHistory && <OutputHistoryModal onOpenYoutubeSettings={() => setShowYoutubeSettings(true)} onClose={() => setShowOutputHistory(false)} />}
      {showAiSettings && <AiSettingsModal project={project} onProjectUpdated={setProject} onClose={() => setShowAiSettings(false)} />}
      {externalAsset && <ExternalOpenModal asset={externalAsset} onClose={() => setExternalAsset(undefined)} />}
      {volumeAsset && <VolumeSegmentsModal asset={project.sources.find((asset) => asset.id === volumeAsset.id) ?? volumeAsset} defaultVolumePercent={project.sourceAudioVolumePercent ?? 100} onClose={() => setVolumeAsset(undefined)} onAssetUpdated={updateAsset} />}
      {placementQueue[0] && (() => { const asset = project.sources.find((item) => item.id === placementQueue[0]); return asset ? <PlacementModal asset={asset} anchors={sortedAssets} onClose={() => setPlacementQueue((current) => current.slice(1))} onDecide={(placement) => decidePlacement(asset.id, placement)} /> : null; })()}
      {showBgm && <BgmStudio project={project} timelineDurationMs={timelineDurationMs} onProjectUpdated={setProject} onClose={() => setShowBgm(false)} />}
      {showSubtitles && <SubtitleStudio project={project} timelineDurationMs={timelineDurationMs} onProjectUpdated={setProject} onOpenAiSettings={() => { setShowSubtitles(false); setShowAiSettings(true); }} onClose={() => setShowSubtitles(false)} />}
      {confirmRemoveAsset && <ConfirmMainRemovalModal asset={confirmRemoveAsset} project={project} busy={removeBusy} onCancel={() => setConfirmRemoveAsset(undefined)} onConfirm={() => void removeAsset(confirmRemoveAsset)} />}
      {mediaInsertionVideo && <MediaInsertionModal project={project} video={project.sources.find((asset) => asset.id === mediaInsertionVideo.id) ?? mediaInsertionVideo} onProjectUpdated={replaceProject} onClose={() => setMediaInsertionVideo(undefined)} />}
      {showCloseConfirmation && <div className="modal-backdrop close-confirm-backdrop" role="presentation"><section className="close-confirm-modal" role="dialog" aria-modal="true" aria-label="再次確認關閉軟體"><div className="close-confirm-mascot" aria-hidden="true">🎬<span>✨</span></div><span className="eyebrow">ONE MORE CHECK</span><h2>今天的剪輯先保存到這裡嗎？</h2><p>專案會保留目前設定，來源影片與照片不會被修改。真的要關閉 SceneryWalker 嗎？</p><div><button className="primary-button" type="button" autoFocus onClick={() => setShowCloseConfirmation(false)}>繼續剪輯</button><button className="secondary-button" type="button" onClick={() => window.sourceApp.confirmAppClose()}>確定關閉</button></div></section></div>}
    </main>
  );
}
