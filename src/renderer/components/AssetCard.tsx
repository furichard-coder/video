import { useEffect, useRef, useState } from "react";
import { DEFAULT_IMAGE_DURATION_MS, type MediaInsertion, type PreviewRange, type PreviewResult, type SourceAsset, type ViewMode } from "../../shared/domain";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../format";
import { ClipRangeControl } from "./ClipRangeControl";
import { retainedDurationMs } from "../../shared/editing-rules";
import { filenameDisplayPriority } from "../filename-display";

interface AssetCardProps {
  asset: SourceAsset;
  index: number;
  previousFileName?: string;
  nextFileName?: string;
  viewMode: ViewMode;
  onOpen(asset: SourceAsset): void;
  onRemove(asset: SourceAsset): void;
  onAssetUpdated(asset: SourceAsset): void;
  onOpenExternalDirect(asset: SourceAsset): void;
  onOpenExternalOptions(asset: SourceAsset): void;
  externalOpening: boolean;
  onOpenVolume(asset: SourceAsset): void;
  onOpenMediaInsertion(asset: SourceAsset): void;
  mediaInsertions: Array<MediaInsertion & { insertedFileName: string; insertedKind: "VIDEO" | "IMAGE" }>;
  availableMediaCount: number;
  onProjectUpdated(project: import("../../shared/domain").ProjectManifest): void;
  onMove(delta: -1 | 1): void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  dragging: boolean;
  dragTarget: boolean;
  onGridDragStart(assetId: string): void;
  onGridDragEnter(assetId: string): void;
  onGridDragEnd(): void;
}

export function AssetCard({
  asset,
  index,
  previousFileName,
  nextFileName,
  viewMode,
  onOpen,
  onRemove,
  onAssetUpdated,
  onOpenExternalDirect,
  onOpenExternalOptions,
  externalOpening,
  onOpenVolume,
  onOpenMediaInsertion,
  mediaInsertions,
  availableMediaCount,
  onProjectUpdated,
  onMove,
  canMoveUp,
  canMoveDown,
  dragging,
  dragTarget,
  onGridDragStart,
  onGridDragEnter,
  onGridDragEnd,
}: AssetCardProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [inlinePreview, setInlinePreview] = useState<PreviewResult>();
  const [inlineLoading, setInlineLoading] = useState(false);
  const [range, setRange] = useState<PreviewRange>();
  const [rangeNotice, setRangeNotice] = useState<string>();
  const [imageDurationBusy, setImageDurationBusy] = useState(false);
  const [photoSoundBusy, setPhotoSoundBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragHoldTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragArmedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [dragArmed, setDragArmed] = useState(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "280px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (dragHoldTimerRef.current) clearTimeout(dragHoldTimerRef.current);
  }, []);

  const clearDragHold = () => {
    if (dragHoldTimerRef.current) clearTimeout(dragHoldTimerRef.current);
    dragHoldTimerRef.current = undefined;
  };

  const armDragAfterHold = (event: React.PointerEvent<HTMLElement>) => {
    if (viewMode !== "GRID" || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const interactive = target.closest("button, input, select, textarea, video, a");
    if (interactive && !interactive.classList.contains("thumb-button") && !interactive.classList.contains("drag-sort-hint")) return;
    clearDragHold();
    dragHoldTimerRef.current = setTimeout(() => {
      dragArmedRef.current = true;
      suppressClickRef.current = true;
      setDragArmed(true);
    }, 280);
  };

  const disarmDrag = () => {
    clearDragHold();
    if (!dragging) {
      dragArmedRef.current = false;
      setDragArmed(false);
    }
  };

  const startDrag = (event: React.DragEvent<HTMLElement>) => {
    if (viewMode !== "GRID" || !dragArmedRef.current) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", asset.id);
    onGridDragStart(asset.id);
  };

  const endDrag = () => {
    clearDragHold();
    dragArmedRef.current = false;
    setDragArmed(false);
    onGridDragEnd();
    setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let completed = false;
    const shouldRefreshMetadata = asset.metadataState !== "READY";
    setLoading(true);
    setError(undefined);

    void Promise.all([
      asset.metadataState === "READY"
        ? Promise.resolve(asset)
        : window.sourceApp.ensureMetadata(asset.id),
      window.sourceApp.ensurePreview(asset.id, "THUMBNAIL"),
    ])
      .then(([updated, preview]) => {
        if (!active) return;
        completed = true;
        if (shouldRefreshMetadata) onAssetUpdated(updated);
        setThumbnailUrl(preview.url);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof Error && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (!completed) void window.sourceApp.cancelPreview(asset.id, "THUMBNAIL");
    };
  }, [asset.id, asset.metadataState, visible]);

  useEffect(() => {
    const durationMs = asset.mediaInfo?.durationMs;
    if (!durationMs) return;
    setRange(asset.previewRange ?? { inMs: 0, outMs: durationMs });
  }, [asset.id, asset.mediaInfo?.durationMs, asset.previewRange?.inMs, asset.previewRange?.outMs]);

  const loadInlinePreview = async () => {
    if (inlinePreview) {
      const player = videoRef.current;
      if (!player) return;
      if (player.paused) await player.play();
      else player.pause();
      return;
    }
    setInlineLoading(true);
    setError(undefined);
    try {
      const preview = await window.sourceApp.ensurePreview(asset.id, "VIDEO_PROXY");
      setInlinePreview(preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInlineLoading(false);
    }
  };

  const updateRange = (next: PreviewRange, changed: "IN" | "OUT") => {
    setRange(next);
    const player = videoRef.current;
    if (player) player.currentTime = (changed === "IN" ? next.inMs : Math.max(next.inMs, next.outMs - 500)) / 1000;
  };

  const commitRange = async (next: PreviewRange) => {
    try {
      const result = await window.sourceApp.setPreviewRange(asset.id, next);
      onAssetUpdated(result.asset);
      onProjectUpdated(result.project);
      const adjustments = [
        result.adjustedVolumeSegmentCount ? `${result.adjustedVolumeSegmentCount} 個音量區段` : undefined,
        result.adjustedMainExclusionRangeCount ? `${result.adjustedMainExclusionRangeCount} 個正片排除區段` : undefined,
        result.adjustedZoomSegmentCount ? `${result.adjustedZoomSegmentCount} 個局部放大區段` : undefined,
      ].filter(Boolean);
      setRangeNotice(adjustments.length ? `IN／OUT 已更新，並安全裁切或移除 ${adjustments.join("及")}。` : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const keepPlaybackWithinRange = () => {
    const player = videoRef.current;
    if (!player || !range) return;
    if (player.currentTime * 1000 >= range.outMs) {
      player.pause();
      player.currentTime = range.inMs / 1000;
    }
  };

  const changeImageDuration = async (durationMs: number) => {
    setImageDurationBusy(true);
    setError(undefined);
    try {
      const result = await window.sourceApp.setImageDuration(asset.id, durationMs);
      onProjectUpdated(result.project);
      setRangeNotice(`照片顯示時間已設為 ${result.asset.imageDurationMs! / 1000} 秒；來源檔未修改。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImageDurationBusy(false);
    }
  };

  const changePhotoSound = async (enabled: boolean) => {
    setPhotoSoundBusy(true); setError(undefined);
    try {
      const updated = await window.sourceApp.setPhotoSoundEnabled(asset.id, enabled);
      onProjectUpdated(updated);
      setRangeNotice(enabled ? "已啟用沙丘前案相機快門音效；輸出時於照片出現點播放。" : "已關閉這張照片的相機快門音效。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPhotoSoundBusy(false); }
  };

  const displayTime = asset.mediaInfo?.captureTime ?? asset.fileCreatedAt ?? asset.fileModifiedAt;
  const codec = [asset.mediaInfo?.videoCodec, asset.mediaInfo?.audioCodec].filter(Boolean).join(" / ");
  const fileNamePriority = viewMode === "GRID" ? filenameDisplayPriority(asset.fileName, [previousFileName, nextFileName]) : "START";
  const hasClipEdits = Boolean(asset.mainExclusionRanges?.length || asset.zoomSegments?.length || (asset.previewRange && asset.mediaInfo?.durationMs && (asset.previewRange.inMs > 0 || asset.previewRange.outMs < asset.mediaInfo.durationMs)));
  const hasVolumeEdits = Boolean(asset.volumeSegments?.length);
  const hasInsertionEdits = mediaInsertions.length > 0;

  return (
    <article
      ref={rootRef}
      className={`asset-card ${viewMode === "LIST" ? "is-list" : ""} ${dragArmed ? "is-drag-armed" : ""} ${dragging ? "is-dragging" : ""} ${dragTarget ? "is-drag-target" : ""}`}
      aria-label={`${asset.kind === "VIDEO" ? "影片" : "照片"} ${asset.fileName}，順序 ${index + 1}`}
      aria-grabbed={dragging}
      data-asset-id={asset.id}
      draggable={viewMode === "GRID"}
      onPointerDownCapture={armDragAfterHold}
      onPointerUpCapture={disarmDrag}
      onPointerCancel={disarmDrag}
      onDragStart={startDrag}
      onDragEnter={(event) => { if (viewMode === "GRID") { event.preventDefault(); onGridDragEnter(asset.id); } }}
      onDragOver={(event) => { if (viewMode === "GRID") { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
      onDrop={(event) => { event.preventDefault(); endDrag(); }}
      onDragEnd={endDrag}
      onClickCapture={(event) => { if (suppressClickRef.current) { event.preventDefault(); event.stopPropagation(); suppressClickRef.current = false; } }}
    >
      <div className="thumb-frame">
        {inlinePreview && asset.kind === "VIDEO" ? (
          <video ref={videoRef} className="inline-video" src={inlinePreview.url} autoPlay preload="auto" aria-label={`網格等比例預覽 ${asset.fileName}`} onClick={() => void loadInlinePreview()} onContextMenu={(event) => { event.preventDefault(); onOpenExternalOptions(asset); }} onLoadedMetadata={(event) => { if (range) event.currentTarget.currentTime = range.inMs / 1000; }} onPlay={(event) => { if (range && (event.currentTarget.currentTime * 1000 < range.inMs || event.currentTarget.currentTime * 1000 >= range.outMs)) event.currentTarget.currentTime = range.inMs / 1000; }} onTimeUpdate={keepPlaybackWithinRange} />
        ) : (
          <button
            className="thumb-button"
            type="button"
            disabled={asset.kind === "VIDEO" && externalOpening}
            onClick={() => asset.kind === "VIDEO" ? onOpenExternalDirect(asset) : onOpen(asset)}
            onContextMenu={(event) => { if (asset.kind === "VIDEO") { event.preventDefault(); onOpenExternalOptions(asset); } }}
            onKeyDown={(event) => { if (asset.kind === "VIDEO" && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); onOpenExternalOptions(asset); } }}
            aria-label={asset.kind === "VIDEO" ? `從縮圖以外部播放器直接播放 ${asset.fileName}` : `預覽 ${asset.fileName}`}
            title={asset.kind === "VIDEO" ? "左鍵直接依副檔名設定，以外部播放器開啟唯讀意圖原檔" : "在 App 內等比例放大照片"}
          >
            {thumbnailUrl ? (
              <img src={thumbnailUrl} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className={`thumb-placeholder ${error ? "is-error" : ""}`}>
                {loading ? <span className="spinner" /> : <span className="fallback-icon">{asset.kind === "VIDEO" ? "▶" : "▧"}</span>}
                <span>{loading ? "建立縮圖中" : "無法顯示縮圖"}</span>
              </span>
            )}
            <span className="preview-hint">{asset.kind === "VIDEO" ? (externalOpening ? "正在開啟外部播放器…" : "左鍵以外部播放器播放") : "點擊放大"}</span>
          </button>
        )}
        <span className="sequence-number">{String(index + 1).padStart(2, "0")}</span>
        {viewMode === "GRID" && <span className={`drag-sort-hint ${dragArmed ? "is-armed" : ""}`} aria-hidden="true">{dragArmed ? "放開完成排序" : "⋮⋮ 長按拖曳排序"}</span>}
        <span className="duration-chip">{asset.kind === "VIDEO" ? formatDuration(asset.mediaInfo?.durationMs) : `${(asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS) / 1000} 秒`}</span>
        {asset.kind === "VIDEO" && <button className="inline-play-button" type="button" disabled={inlineLoading} onClick={() => void loadInlinePreview()}>{inlineLoading ? "載入中…" : inlinePreview ? "播放／暫停" : "▶ 網格播放"}</button>}
        {inlinePreview && <button className="inline-expand-button" type="button" onClick={() => onOpen(asset)}>放大</button>}
      </div>

      {asset.kind === "VIDEO" && range && asset.mediaInfo?.durationMs && <ClipRangeControl durationMs={asset.mediaInfo.durationMs} range={range} onChange={updateRange} onCommit={(next) => void commitRange(next)} />}

      <div className="asset-body">
        <div className="asset-heading">
          <div>
            <span className={`kind-badge ${asset.kind.toLowerCase()}`}>{asset.kind === "VIDEO" ? "影片" : "照片"}</span>
            <h3 className={fileNamePriority === "END" ? "prefer-filename-end" : "prefer-filename-start"} title={asset.fileName}>{asset.fileName}</h3>
          </div>
          <button className="remove-button" type="button" onClick={() => onRemove(asset)} title="只從正片排除，不刪除來源檔" aria-label={`從正片移除 ${asset.fileName}`}>
            移除
          </button>
        </div>

        <dl className="asset-facts">
          <div><dt>時間</dt><dd>{formatDate(displayTime)}</dd></div>
          <div><dt>大小</dt><dd>{formatBytes(asset.sizeBytes)}</dd></div>
          <div><dt>規格</dt><dd>{formatResolution(asset.mediaInfo?.width, asset.mediaInfo?.height)}</dd></div>
          <div><dt>編碼</dt><dd>{codec || "讀取中／未提供"}</dd></div>
        </dl>

        {viewMode === "LIST" && <p className="source-path" title={asset.sourcePath}>{asset.sourcePath}</p>}
        {asset.kind === "VIDEO" && asset.mainExclusionRanges?.length ? <p className={`main-exclusion-status ${retainedDurationMs(asset) === 0 ? "is-fully-excluded" : ""}`}>{retainedDurationMs(asset) === 0 ? "此素材有效範圍已全部排除，不參與正片輸出" : `正片排除 ${asset.mainExclusionRanges.length} 段 · 保留 ${formatDuration(retainedDurationMs(asset))}`}</p> : null}
        {asset.kind === "VIDEO" && <><div className="card-tool-row"><button className={`clip-tool-button ${hasClipEdits ? "is-configured" : ""}`} type="button" title={hasClipEdits ? "已儲存片段修正；點擊查看或調整" : "刪除／排除部分片段、局部放大與高解析片段輸出"} aria-label={`刪除／排除部分片段${hasClipEdits ? "，已儲存設定" : ""}`} onClick={() => onOpen(asset)}>✂ {hasClipEdits ? "已設片段" : "片段"}{asset.mainExclusionRanges?.length ? ` (${asset.mainExclusionRanges.length})` : ""}</button><button className={`volume-tool-button ${hasVolumeEdits ? "is-configured" : ""}`} type="button" title={hasVolumeEdits ? "已儲存音量修正；點擊查看或調整" : "設定素材原音的分段音量"} aria-label={`音量區段${hasVolumeEdits ? "，已儲存設定" : ""}`} onClick={() => onOpenVolume(asset)}>♫ {hasVolumeEdits ? "已設音量" : "音量"}{asset.volumeSegments?.length ? ` (${asset.volumeSegments.length})` : ""}</button><button className={`insertion-tool-button ${hasInsertionEdits ? "is-configured" : ""}`} type="button" title={hasInsertionEdits ? "已儲存安插修正；點擊查看或調整" : "在這支影片的指定時間安插照片或影片"} aria-label={`於影片時段插入照片或影片${hasInsertionEdits ? "，已儲存設定" : ""}`} onClick={() => onOpenMediaInsertion(asset)}>▧ {hasInsertionEdits ? "已設安插" : "安插"}{mediaInsertions.length ? ` (${mediaInsertions.length})` : ""}</button><button className="card-icon-button" type="button" disabled={!canMoveUp} title="上移" aria-label={`上移 ${asset.fileName}`} onClick={() => onMove(-1)}>↑</button><button className="card-icon-button" type="button" disabled={!canMoveDown} title="下移" aria-label={`下移 ${asset.fileName}`} onClick={() => onMove(1)}>↓</button></div>{mediaInsertions.length > 0 && <div className="photo-insertion-summary" aria-label={`${asset.fileName} 已安插素材`}>{[...mediaInsertions].sort((a, b) => a.atMs - b.atMs || a.sequenceIndex - b.sequenceIndex).map((item) => <button type="button" key={item.id} onClick={() => onOpenMediaInsertion(asset)}><strong>{item.insertedKind === "VIDEO" ? "影片" : "照片"} · {item.insertedFileName}</strong><span>{formatDuration(item.atMs)} 插入 · 使用 {formatDuration(item.sourceOutMs - item.sourceInMs)}</span></button>)}</div>}{availableMediaCount === 0 && mediaInsertions.length === 0 && <small className="external-open-hint">加入並排定其他照片或影片後，即可指定插入這支影片的時段。</small>}</>}
        {asset.kind === "IMAGE" && <><div className="image-duration-row"><label htmlFor={`image-duration-${asset.id}`}>照片顯示時間</label><select id={`image-duration-${asset.id}`} aria-label={`${asset.fileName} 照片顯示時間`} disabled={imageDurationBusy} value={asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS} onChange={(event) => void changeImageDuration(Number(event.target.value))}>{[3, 4, 5, 6, 7].map((seconds) => <option key={seconds} value={seconds * 1000}>{seconds} 秒</option>)}</select><button className="card-icon-button" type="button" disabled={!canMoveUp} title="上移" aria-label={`上移 ${asset.fileName}`} onClick={() => onMove(-1)}>↑</button><button className="card-icon-button" type="button" disabled={!canMoveDown} title="下移" aria-label={`下移 ${asset.fileName}`} onClick={() => onMove(1)}>↓</button></div><label className="photo-sound-toggle"><input type="checkbox" checked={asset.photoSoundEnabled !== false} disabled={photoSoundBusy} onChange={(event) => void changePhotoSound(event.target.checked)} /><span><strong>預設相機快門音效</strong><small>沿用沙丘前案核准音效 · 輸出增益 70%</small></span></label></>}
        {rangeNotice && <p className="inline-notice">{rangeNotice}</p>}
        {(error || asset.metadataError) && <p className="inline-error">{error ?? asset.metadataError}</p>}
      </div>
    </article>
  );
}
