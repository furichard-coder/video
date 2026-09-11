import { useEffect, useRef, useState } from "react";
import { DEFAULT_ZOOM_ENHANCEMENT_PRESET, DEFAULT_ZOOM_PERCENT, INTRO_MAX_SEGMENT_MS, INTRO_MAX_SEGMENTS, INTRO_MIN_SEGMENT_MS, MAX_ZOOM_PERCENT, MIN_ZOOM_PERCENT, type IntroSuggestion, type MainExclusionRange, type PreviewResult, type ProjectManifest, type SourceAsset, type ZoomEnhancementPreset, type ZoomSegment, type ZoomSegmentUpdateResult } from "../../shared/domain";
import { retainedDurationMs } from "../../shared/editing-rules";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../format";
import { ConcatRenderModal } from "./ConcatRenderModal";
import { TimeRangeFields } from "./MinuteSecondFields";
import { SafeDefaultButton } from "./SafeDefaultButton";

function formatPlayerTime(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const ms = value % 1_000;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function safeRetainedDuration(asset: SourceAsset, ranges: MainExclusionRange[]): number | undefined {
  try { return retainedDurationMs({ ...asset, mainExclusionRanges: ranges }); }
  catch { return undefined; }
}

const ZOOM_ENHANCEMENT_OPTIONS: Array<{ id: ZoomEnhancementPreset; label: string; detail: string }> = [
  { id: "BALANCED", label: "建議：平衡優化", detail: "輕度消噪＋適度銳利化，適合一般放大" },
  { id: "DETAIL", label: "細節優先", detail: "較強銳利化、較輕消噪，適合乾淨日景" },
  { id: "DENOISE", label: "消噪優先", detail: "較強消噪、輕度銳利化，適合低光素材" },
  { id: "OFF", label: "關閉優化", detail: "只套用放大與中心點" },
];

interface PreviewModalProps {
  asset: SourceAsset;
  project: ProjectManifest;
  onClose(): void;
  onAssetUpdated(asset: SourceAsset): void;
  onProjectUpdated(project: ProjectManifest): void;
  onOpenExternal(asset: SourceAsset): void;
  onOpenIntro(): void;
}

export function PreviewModal({ asset, project, onClose, onAssetUpdated, onProjectUpdated, onOpenExternal, onOpenIntro }: PreviewModalProps) {
  const [preview, setPreview] = useState<PreviewResult>();
  const [previewError, setPreviewError] = useState<string>();
  const [editorError, setEditorError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ranges, setRanges] = useState<MainExclusionRange[]>(() => structuredClone(asset.mainExclusionRanges ?? []));
  const [zoomSegments, setZoomSegments] = useState<ZoomSegment[]>(() => structuredClone(asset.zoomSegments ?? []));
  const [selectedZoomId, setSelectedZoomId] = useState<string | undefined>(() => asset.zoomSegments?.[0]?.id);
  const [addSavedZoomToIntro, setAddSavedZoomToIntro] = useState(true);
  const [renderSavedZoomToMp4, setRenderSavedZoomToMp4] = useState(false);
  const [introInsertRank, setIntroInsertRank] = useState(() => project.introSegments.length + 1);
  const [clipRenderSelection, setClipRenderSelection] = useState<IntroSuggestion>();
  const [introAddedRank, setIntroAddedRank] = useState<number>();
  const [introAddedTargetDurationMs, setIntroAddedTargetDurationMs] = useState<number>();
  const [previewRetry, setPreviewRetry] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const variant = asset.kind === "VIDEO" ? "VIDEO_PROXY" : "IMAGE_PREVIEW";
  const durationMs = asset.mediaInfo?.durationMs ?? 0;
  const allowed = asset.previewRange ?? { inMs: 0, outMs: durationMs };
  const draftRetainedDurationMs = safeRetainedDuration(asset, ranges);
  const displayWidth = asset.mediaInfo?.displayWidth ?? asset.mediaInfo?.width ?? 16;
  const displayHeight = asset.mediaInfo?.displayHeight ?? asset.mediaInfo?.height ?? 9;
  const activeZoom = zoomSegments.find((segment) => currentMs >= segment.startMs && currentMs < segment.endMs);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    let completed = false;
    setPreviewError(undefined);
    void window.sourceApp
      .ensureMetadata(asset.id)
      .then((updated) => {
        if (active) onAssetUpdated(updated);
        return window.sourceApp.ensurePreview(asset.id, variant);
      })
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
      if (!completed) void window.sourceApp.cancelPreview(asset.id, variant);
    };
  }, [asset.id, variant, previewRetry]);

  useEffect(() => {
    setRanges(structuredClone(asset.mainExclusionRanges ?? []));
    setZoomSegments(structuredClone(asset.zoomSegments ?? []));
    setSelectedZoomId(asset.zoomSegments?.[0]?.id);
  }, [asset.id, asset.mainExclusionRanges, asset.zoomSegments]);

  useEffect(() => setIntroInsertRank((current) => Math.max(1, Math.min(current, project.introSegments.length + 1))), [project.introSegments.length]);

  const seek = (nextMs: number) => {
    const player = videoRef.current;
    const clamped = Math.max(0, Math.min(durationMs || Number.MAX_SAFE_INTEGER, Math.round(nextMs)));
    if (player) player.currentTime = clamped / 1000;
    setCurrentMs(clamped);
  };

  const togglePlayback = async () => {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) await player.play(); else player.pause();
  };

  const patchRange = (id: string, field: "startMs" | "endMs", valueMs: number) => {
    setRanges((current) => current.map((range) => range.id === id ? { ...range, [field]: Math.round(valueMs) } : range));
  };

  const addRange = () => {
    const startMs = Math.max(allowed.inMs, Math.min(Math.round(currentMs), Math.max(allowed.inMs, allowed.outMs - 100)));
    const endMs = Math.min(allowed.outMs, Math.max(startMs + 100, startMs + 1_000));
    setRanges((current) => [...current, { id: crypto.randomUUID(), startMs, endMs }]);
    setNotice(undefined); setEditorError(undefined);
  };

  const saveRanges = async (nextRanges = ranges) => {
    setEditorError(undefined); setNotice(undefined);
    try {
      const result = await window.sourceApp.setMainExclusionRanges(asset.id, nextRanges);
      setRanges(result.asset.mainExclusionRanges ?? []);
      onAssetUpdated(result.asset); onProjectUpdated(result.project);
      setNotice(result.mergedRangeCount ? `已保存；${result.mergedRangeCount} 個重疊或相鄰區段已自動合併。` : "正片排除區段已保存；來源與代理檔均未修改。");
    } catch (reason) { setEditorError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const addZoomSegment = () => {
    const startMs = Math.max(allowed.inMs, Math.min(Math.round(currentMs), Math.max(allowed.inMs, allowed.outMs - 100)));
    const endMs = Math.min(allowed.outMs, Math.max(startMs + 100, startMs + 3_000));
    const id = crypto.randomUUID();
    setZoomSegments((current) => [...current, { id, startMs, endMs, zoomPercent: DEFAULT_ZOOM_PERCENT, centerXPercent: 50, centerYPercent: 50, enhancementPreset: DEFAULT_ZOOM_ENHANCEMENT_PRESET }]);
    setSelectedZoomId(id);
    setNotice(undefined); setEditorError(undefined);
  };

  const patchZoom = (id: string, patch: Partial<Omit<ZoomSegment, "id">>) => {
    setZoomSegments((current) => current.map((segment) => segment.id === id ? { ...segment, ...patch } : segment));
  };

  const setZoomBoundary = (id: string, field: "start" | "end", valueMs: number) => {
    patchZoom(id, field === "start" ? { startMs: valueMs } : { endMs: valueMs });
  };

  const saveZooms = async (nextSegments = zoomSegments): Promise<ZoomSegmentUpdateResult | undefined> => {
    setEditorError(undefined); setNotice(undefined);
    try {
      const result = await window.sourceApp.setZoomSegments(asset.id, nextSegments);
      setZoomSegments(result.asset.zoomSegments ?? []);
      onAssetUpdated(result.asset); onProjectUpdated(result.project);
      setNotice("局部放大與畫質優化已保存，會套用到正片、片頭與 4K 片段輸出；來源影片未修改。");
      return result;
    } catch (reason) { setEditorError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  };

  const validateIntroRange = (range: { inMs: number; outMs: number }, latestProject: ProjectManifest) => {
    const lengthMs = range.outMs - range.inMs;
    const segmentMaximum = Math.min(INTRO_MAX_SEGMENT_MS, latestProject.introSegmentMaxDurationMs);
    if (lengthMs < INTRO_MIN_SEGMENT_MS || lengthMs > segmentMaximum) throw new Error(`加入片頭的放大時段必須介於 3 秒與目前每段上限 ${segmentMaximum / 1000} 秒。`);
    if (latestProject.introSegments.length >= INTRO_MAX_SEGMENTS) throw new Error(`片頭已達 ${INTRO_MAX_SEGMENTS} 段上限。`);
    const usedMs = latestProject.introSegments.reduce((sum, segment) => sum + segment.outMs - segment.inMs, 0);
    if (usedMs + lengthMs > latestProject.introTargetDurationMs) throw new Error("加入後會超過目前片頭目標時間；為避免改動既有片段與總時間，請先到片頭頁縮短、移除片段或手動增加目標時間。");
  };

  const saveZoomsWithActions = async () => {
    const saved = await saveZooms();
    if (!saved) return;
    const target = (saved.asset.zoomSegments ?? []).find((segment) => segment.id === selectedZoomId);
    if ((addSavedZoomToIntro || renderSavedZoomToMp4) && !target) {
      setEditorError("請先點選一個局部放大區段，再選擇加入片頭或輸出 MP4。");
      return;
    }
    let latestProject = saved.project;
    try {
      if (target && addSavedZoomToIntro) {
        const targetRange = { inMs: target.startMs, outMs: target.endMs };
        validateIntroRange(targetRange, latestProject);
        const next = [...latestProject.introSegments];
        const insertAt = Math.max(0, Math.min(next.length, introInsertRank - 1));
        next.splice(insertAt, 0, makeManualIntroSegment(targetRange));
        latestProject = await window.sourceApp.setIntroSegments(next);
        onProjectUpdated(latestProject);
        setIntroAddedRank(insertAt + 1);
        setIntroAddedTargetDurationMs(latestProject.introTargetDurationMs);
      }
      if (target && renderSavedZoomToMp4) setClipRenderSelection(makeManualIntroSegment({ inMs: target.startMs, outMs: target.endMs }));
      if (target && addSavedZoomToIntro) setNotice(`已保存並把此時段加入片頭第 ${Math.min(introInsertRank, latestProject.introSegments.length)} 順位；既有片段 IN／OUT 與片頭目標時間保持不變，來源影片未修改。`);
    } catch (reason) { setEditorError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const makeManualIntroSegment = (range: { inMs: number; outMs: number }): IntroSuggestion => ({
    id: crypto.randomUUID(), assetId: asset.id, fileName: asset.fileName, inMs: range.inMs, outMs: range.outMs,
    score: 0, reasons: ["從刪除／排除編輯器手動選取"], origin: "MANUAL",
  });


  return (<>
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="preview-modal expanded-preview-modal" role="dialog" aria-modal="true" aria-label={`預覽 ${asset.fileName}`}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">個別預覽 · 衍生代理</span>
            <h2>{asset.fileName}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉">×</button>
        </header>

        <div className="preview-stage">
          {!preview && !previewError && <div className="large-loading"><span className="spinner" /><p>正在建立安全預覽，不會修改來源檔…</p></div>}
          {previewError && <div className="preview-error"><strong>無法預覽此檔案</strong><p>{previewError}</p><small>來源仍保留在清單中；可重建代理或使用外部播放器查看唯讀原檔。</small><div className="preview-recovery-actions"><button type="button" onClick={() => { setPreviewError(undefined); setPreviewRetry((value) => value + 1); }}>重新建立代理</button><button type="button" onClick={() => onOpenExternal(asset)}>用外部播放器查看</button></div></div>}
          {preview && asset.kind === "IMAGE" && <div className="preview-image-shell" style={{ "--preview-aspect": `${displayWidth} / ${displayHeight}` } as React.CSSProperties}><img src={preview.url} alt={asset.fileName} style={{ aspectRatio: `${displayWidth} / ${displayHeight}` }} /></div>}
          {preview && asset.kind === "VIDEO" && (
            <div className={`preview-video-shell preview-aspect-frame ${displayWidth >= displayHeight ? "is-landscape" : "is-portrait"}`} style={{ "--preview-aspect": `${displayWidth} / ${displayHeight}` } as React.CSSProperties}>
              <video ref={videoRef} src={preview.url} autoPlay playsInline preload="metadata" aria-label={`放大播放 ${asset.fileName}`} tabIndex={0} style={{ aspectRatio: `${displayWidth} / ${displayHeight}`, transform: activeZoom ? `scale(${activeZoom.zoomPercent / 100})` : "scale(1)", transformOrigin: activeZoom ? `${activeZoom.centerXPercent}% ${activeZoom.centerYPercent}%` : "50% 50%" }} onClick={() => void togglePlayback()} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); void togglePlayback(); } }} onLoadedMetadata={(event) => { setCurrentMs(Math.round(event.currentTarget.currentTime * 1000)); }} onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1000))} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}>
                此裝置無法播放預覽代理。
              </video>
            </div>
          )}
        </div>

        {asset.kind === "VIDEO" && durationMs > 0 && <section className="main-exclusion-editor">
          <div className="precision-transport">
            <button type="button" onClick={() => void togglePlayback()} aria-label={playing ? "暫停放大預覽" : "播放放大預覽"}>{playing ? "❚❚ 暫停" : "▶ 播放"}</button>
            <strong>{formatPlayerTime(currentMs)} / {formatPlayerTime(durationMs)}</strong>
            <input aria-label="放大預覽播放頭" type="range" min="0" max={durationMs} step="10" value={currentMs} onChange={(event) => seek(Number(event.target.value))} />
          </div>
          <div className="exclusion-heading"><div><span className="eyebrow">MAIN EXCLUSION RANGES</span><h3>正片排除區段</h3><p>只從正片輸出扣除；來源、proxy、metadata 與 Intro 均不變。重疊或相鄰區段保存時會自動排序、合併。</p></div><button type="button" onClick={addRange}>＋ 新增排除區段</button></div>
          <div className="exclusion-timeline" aria-label="正片排除區段時間軸">{ranges.map((range) => <span key={range.id} title={`${formatDuration(range.startMs)}–${formatDuration(range.endMs)}`} style={{ left: `${(range.startMs / durationMs) * 100}%`, width: `${((range.endMs - range.startMs) / durationMs) * 100}%` }} />)}</div>
          {ranges.length ? <div className="exclusion-rows">{ranges.map((range, index) => <div className="exclusion-row" key={range.id}>
            <strong>區段 {index + 1}</strong>
            <TimeRangeFields className="inline-time-range" startLabel={`排除 ${index + 1} 開始`} endLabel={`排除 ${index + 1} 結束`} startMs={range.startMs} endMs={range.endMs} maxMs={durationMs} onStartChange={(value) => patchRange(range.id, "startMs", value)} onEndChange={(value) => patchRange(range.id, "endMs", value)} />
            <button type="button" onClick={() => patchRange(range.id, "startMs", currentMs)}>目前設為開始</button>
            <button type="button" onClick={() => patchRange(range.id, "endMs", currentMs)}>目前設為結束</button>
            <button className="range-remove-button" type="button" aria-label={`刪除正片排除區段 ${index + 1}`} onClick={() => setRanges((current) => current.filter((item) => item.id !== range.id))}>刪除區段</button>
          </div>)}</div> : <p className="empty-exclusion-note">目前沒有排除區段，完整 IN／OUT 會進入正片。</p>}
          <div className="exclusion-actions"><span>{ranges.length ? `編輯中 ${ranges.length} 段；保存後重算正片時間。` : "未排除任何範圍。"}</span><button type="button" disabled={!ranges.length} onClick={() => { setRanges([]); void saveRanges([]); }}>一鍵清除排除區段</button><button className="primary-button" type="button" onClick={() => void saveRanges()}>保存排除區段</button></div>
          {draftRetainedDurationMs === 0 && <div className="notice error" role="status">這支素材的有效 IN／OUT 已全部排除，將不參與正片輸出；Intro 仍可獨立使用來源片段。</div>}
        </section>}

        {asset.kind === "VIDEO" && durationMs > 0 && <section className="zoom-clip-editor">
          <div className="exclusion-heading"><div><span className="eyebrow">SOURCE RANGE · ZOOM · INTRO · 4K</span><h3>片段時段／局部放大／畫質優化</h3><p>原本重複的「固定時間段／片頭素材」已整合至此。放大量 0% 代表維持原構圖；仍可把這段加入片頭或從唯讀原檔輸出 4K MP4。區段不可重疊。</p></div><button type="button" onClick={addZoomSegment}>＋ 新增片段時段</button></div>
          {zoomSegments.length ? <div className="zoom-segment-rows">{zoomSegments.map((segment, index) => <article key={segment.id} className={`${activeZoom?.id === segment.id ? "is-active" : ""} ${selectedZoomId === segment.id ? "is-selected" : ""}`} onClick={() => setSelectedZoomId(segment.id)}>
            <strong>時段 {index + 1}</strong>
            <TimeRangeFields className="inline-time-range" startLabel={`片段 ${index + 1} 開始`} endLabel={`片段 ${index + 1} 結束`} startMs={segment.startMs} endMs={segment.endMs} maxMs={durationMs} onStartChange={(value) => patchZoom(segment.id, { startMs: value })} onEndChange={(value) => patchZoom(segment.id, { endMs: value })} />
            <button type="button" onClick={() => setZoomBoundary(segment.id, "start", currentMs)}>目前設為開始</button>
            <button type="button" onClick={() => setZoomBoundary(segment.id, "end", currentMs)}>目前設為結束</button>
            <label>放大量<div className="percent-input"><input aria-label={`局部放大 ${index + 1} 倍數`} type="number" min={MIN_ZOOM_PERCENT - 100} max={MAX_ZOOM_PERCENT - 100} step="1" value={segment.zoomPercent - 100} onChange={(event) => patchZoom(segment.id, { zoomPercent: Number(event.target.value) + 100 })} /><span>%</span></div><small>0%＝不放大</small></label>
            <label>中心 X<div className="percent-input"><input aria-label={`局部放大 ${index + 1} 中心 X`} type="number" min="0" max="100" step="1" value={segment.centerXPercent} onChange={(event) => patchZoom(segment.id, { centerXPercent: Number(event.target.value) })} /><span>%</span></div></label>
            <label>中心 Y<div className="percent-input"><input aria-label={`局部放大 ${index + 1} 中心 Y`} type="number" min="0" max="100" step="1" value={segment.centerYPercent} onChange={(event) => patchZoom(segment.id, { centerYPercent: Number(event.target.value) })} /><span>%</span></div></label>
            <label className="zoom-enhancement-select">銳利化／消噪<select aria-label={`局部放大 ${index + 1} 畫質優化`} value={segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET} onChange={(event) => patchZoom(segment.id, { enhancementPreset: event.target.value as ZoomEnhancementPreset })}>{ZOOM_ENHANCEMENT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{ZOOM_ENHANCEMENT_OPTIONS.find((option) => option.id === (segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET))?.detail}</small></label>
            <button className="range-remove-button" type="button" aria-label={`刪除局部放大區段 ${index + 1}`} onClick={() => { setZoomSegments((current) => current.filter((item) => item.id !== segment.id)); setSelectedZoomId((current) => current === segment.id ? undefined : current); }}>刪除時段</button>
          </article>)}</div> : <p className="empty-exclusion-note">尚未設定片段時段；新增後預設 0% 放大並勾選加入片頭。</p>}
          <div className="zoom-save-panel"><div className="zoom-save-options"><label><input type="checkbox" checked={addSavedZoomToIntro} disabled={!selectedZoomId} onChange={(event) => setAddSavedZoomToIntro(event.target.checked)} /> 儲存後直接加入片頭（預設勾選）</label>{addSavedZoomToIntro && <label>片頭順位<select aria-label="加入片頭順位" value={introInsertRank} onChange={(event) => setIntroInsertRank(Number(event.target.value))}>{Array.from({ length: Math.min(INTRO_MAX_SEGMENTS, project.introSegments.length + 1) }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 位</option>)}</select></label>}<label><input type="checkbox" checked={renderSavedZoomToMp4} disabled={!selectedZoomId} onChange={(event) => setRenderSavedZoomToMp4(event.target.checked)} /> 儲存後開啟此時段的 4K MP4 輸出</label></div><div className="exclusion-actions"><span>{selectedZoomId ? `已選擇片段時段 ${zoomSegments.findIndex((item) => item.id === selectedZoomId) + 1}；勾選項會在保存成功後執行。` : activeZoom ? `目前預覽：放大 ${activeZoom.zoomPercent - 100}% · 中心 ${activeZoom.centerXPercent}% / ${activeZoom.centerYPercent}%` : "請新增或點選一個片段時段。"}</span><button type="button" disabled={!zoomSegments.length} onClick={() => { setZoomSegments([]); setSelectedZoomId(undefined); void saveZooms([]); }}>清除全部時段</button><button className="primary-button" type="button" onClick={() => void saveZoomsWithActions()}>保存片段設定</button></div></div>
          {notice && <div className="notice success" role="status">{notice}</div>}
          {editorError && <div className="notice error" role="alert">{editorError}</div>}
        </section>}

        <footer className="modal-details">
          <span>{asset.kind === "VIDEO" ? formatDuration(asset.mediaInfo?.durationMs) : `照片 · ${(asset.imageDurationMs ?? 5_000) / 1000} 秒`}</span>
          <span>{formatResolution(asset.mediaInfo?.width, asset.mediaInfo?.height)}</span>
          <span>{formatBytes(asset.sizeBytes)}</span>
          <span>{formatDate(asset.mediaInfo?.captureTime ?? asset.fileCreatedAt)}</span>
          {asset.kind === "VIDEO" && <button className="modal-external-button" type="button" onClick={() => onOpenExternal(asset)}>↗ 外部開啟</button>}
          <span className="safe-note">來源唯讀 · 此 preview 不可作正式輸出</span>
        </footer>
      </section>
    </div>
    {clipRenderSelection && <ConcatRenderModal purpose="CLIP" assets={project.sources} mainClips={[clipRenderSelection]} initialResolution="4K" onClose={() => setClipRenderSelection(undefined)} />}
    {introAddedRank !== undefined && <div className="modal-backdrop intro-added-backdrop" role="presentation"><section className="intro-added-confirmation" role="dialog" aria-modal="true" aria-label="片頭片段加入成功"><span className="eyebrow">INTRO SAVED</span><h2>已加入片頭第 {introAddedRank} 順位</h2><p>片段已寫入目前專案；既有片段的 IN／OUT 與片頭目標時間 {formatDuration(introAddedTargetDurationMs)} 都保持不變。要現在前往片頭頁確認播放、順序與內容嗎？</p><div><SafeDefaultButton className="secondary-button" type="button" onClick={() => { setIntroAddedRank(undefined); setIntroAddedTargetDurationMs(undefined); }}>留在片段設定</SafeDefaultButton><button className="primary-button" type="button" onClick={() => { setIntroAddedRank(undefined); setIntroAddedTargetDurationMs(undefined); onOpenIntro(); }}>前往片頭確認</button></div></section></div>}
  </>);
}
