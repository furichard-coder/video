import { useEffect, useMemo, useRef, useState } from "react";
import type { MediaInsertion, PreviewRange, ProjectManifest, SourceAsset } from "../../shared/domain";
import { imageDurationMs, retainedRangesForAsset } from "../../shared/editing-rules";
import { formatDuration } from "../format";
import { MinuteSecondFields } from "./MinuteSecondFields";
import { ClipRangeControl } from "./ClipRangeControl";

interface Props {
  project: ProjectManifest;
  video: SourceAsset;
  onProjectUpdated(project: ProjectManifest): void;
  onClose(): void;
}

const ALL_FOLDERS = "__ALL_FOLDERS__";
function sourceFolder(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : normalized;
}
function folderLabel(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts.at(-1) ?? folder;
}

function InsertionMediaPreview({ asset }: { asset: SourceAsset }) {
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const load = async () => {
    setLoading(true); setError(undefined);
    try { setUrl((await window.sourceApp.ensurePreview(asset.id, asset.kind === "VIDEO" ? "VIDEO_PROXY" : "IMAGE_PREVIEW")).url); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  if (!url) return <div className="insertion-preview-trigger"><button type="button" disabled={loading} onClick={() => void load()}>{loading ? "載入預覽…" : `預覽${asset.kind === "VIDEO" ? "影片" : "照片"}`}</button>{error && <small className="inline-error">{error}</small>}</div>;
  return asset.kind === "VIDEO"
    ? <div className="insertion-video-preview"><video ref={videoRef} className="insertion-media-preview" src={url} preload="metadata" aria-label={`等比例預覽 ${asset.fileName}`} onClick={() => { const player = videoRef.current; if (!player) return; if (player.paused) void player.play(); else player.pause(); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} /><button type="button" onClick={() => { const player = videoRef.current; if (!player) return; if (player.paused) void player.play(); else player.pause(); }}>{playing ? "❚❚ 暫停" : "▶ 播放"}</button></div>
    : <img className="insertion-media-preview" src={url} alt={`${asset.fileName} 預覽`} />;
}

export function MediaInsertionModal({ project, video, onProjectUpdated, onClose }: Props) {
  const insertions = useMemo(() => project.mediaInsertions.filter((item) => item.anchorVideoAssetId === video.id).sort((a, b) => a.atMs - b.atMs || a.sequenceIndex - b.sequenceIndex), [project.mediaInsertions, video.id]);
  const insertedIds = useMemo(() => new Set(project.mediaInsertions.map((item) => item.insertedAssetId)), [project.mediaInsertions]);
  const availableMedia = useMemo(() => [...project.timelineOrder, ...project.pendingAssetIds].map((id) => project.sources.find((asset) => asset.id === id)).filter((asset): asset is SourceAsset => Boolean(asset && asset.id !== video.id && !insertedIds.has(asset.id))), [project.sources, project.timelineOrder, project.pendingAssetIds, video.id, insertedIds]);
  const folders = useMemo(() => [...new Set(availableMedia.map((asset) => sourceFolder(asset.sourcePath)))].sort((left, right) => left.localeCompare(right, "zh-Hant", { numeric: true })), [availableMedia]);
  const [folderFilter, setFolderFilter] = useState(ALL_FOLDERS);
  const filteredMedia = useMemo(() => folderFilter === ALL_FOLDERS ? availableMedia : availableMedia.filter((asset) => sourceFolder(asset.sourcePath) === folderFilter), [availableMedia, folderFilter]);
  const defaultAtMs = useMemo(() => { const range = retainedRangesForAsset(video)[0]; return range ? Math.round((range.inMs + range.outMs) / 2) : 0; }, [video]);
  const [selectedAssetId, setSelectedAssetId] = useState(filteredMedia[0]?.id ?? "");
  const selectedAsset = project.sources.find((asset) => asset.id === selectedAssetId);
  const selectedDefaultRange = useMemo<PreviewRange>(() => selectedAsset?.kind === "VIDEO" ? selectedAsset.previewRange ?? { inMs: 0, outMs: selectedAsset.mediaInfo?.durationMs ?? 0 } : { inMs: 0, outMs: selectedAsset ? imageDurationMs(selectedAsset) : 0 }, [selectedAsset]);
  const [newAtMs, setNewAtMs] = useState(defaultAtMs);
  const [newSourceRange, setNewSourceRange] = useState<PreviewRange>(selectedDefaultRange);
  const [drafts, setDrafts] = useState<Record<string, { atMs: number; range: PreviewRange }>>(() => Object.fromEntries(insertions.map((item) => [item.id, { atMs: item.atMs, range: { inMs: item.sourceInMs, outMs: item.sourceOutMs } }])));
  const [busyId, setBusyId] = useState<string>();
  const [importingFolder, setImportingFolder] = useState(false);
  const [metadataLoadingId, setMetadataLoadingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => { setNewSourceRange(selectedDefaultRange); }, [selectedAssetId, selectedDefaultRange.inMs, selectedDefaultRange.outMs]);
  useEffect(() => {
    if (selectedAssetId && filteredMedia.some((asset) => asset.id === selectedAssetId)) return;
    setSelectedAssetId(filteredMedia[0]?.id ?? "");
  }, [filteredMedia, selectedAssetId]);
  useEffect(() => {
    if (!selectedAsset || selectedAsset.kind !== "VIDEO" || selectedAsset.metadataState !== "PENDING") return;
    let active = true; setMetadataLoadingId(selectedAsset.id);
    void window.sourceApp.ensureMetadata(selectedAsset.id)
      .then(() => window.sourceApp.getProject())
      .then((updated) => { if (active) onProjectUpdated(updated); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setMetadataLoadingId(undefined); });
    return () => { active = false; };
  }, [selectedAsset?.id, selectedAsset?.kind, selectedAsset?.metadataState, onProjectUpdated]);
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const insertion of insertions) if (!next[insertion.id]) next[insertion.id] = { atMs: insertion.atMs, range: { inMs: insertion.sourceInMs, outMs: insertion.sourceOutMs } };
      return next;
    });
  }, [insertions]);

  const chooseAnotherFolder = async () => {
    setImportingFolder(true); setError(undefined); setNotice(undefined);
    try {
      const result = await window.sourceApp.chooseFolder();
      if (result.cancelled) { setNotice("已取消切換資料夾，專案內容未改變。"); return; }
      onProjectUpdated(result.project);
      const firstAdded = result.addedAssetIds.map((id) => result.project.sources.find((asset) => asset.id === id)).find((asset): asset is SourceAsset => Boolean(asset));
      if (firstAdded) { setFolderFilter(sourceFolder(firstAdded.sourcePath)); setSelectedAssetId(firstAdded.id); }
      else setFolderFilter(ALL_FOLDERS);
      setNotice(`已從另一個資料夾唯讀加入 ${result.addedCount} 項${result.duplicateCount ? `，略過 ${result.duplicateCount} 個重複項目` : ""}${result.unsupportedCount ? `，略過 ${result.unsupportedCount} 個不支援檔案` : ""}。請選擇要安插的素材。`);
      if (result.errors.length) setError(result.errors.join("\n"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setImportingFolder(false); }
  };

  const addInsertion = async () => {
    setBusyId("new"); setError(undefined); setNotice(undefined);
    try {
      if (!selectedAsset) throw new Error("請選擇要安插的照片或影片。");
      const updated = await window.sourceApp.addMediaInsertion(video.id, selectedAsset.id, newAtMs, selectedAsset.kind === "VIDEO" ? newSourceRange : undefined);
      onProjectUpdated(updated); setSelectedAssetId("");
      setNotice(`${selectedAsset.kind === "VIDEO" ? "影片" : "照片"}已安插；來源檔未修改，且不會在正片中重複播放。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  const updateInsertion = async (insertion: MediaInsertion) => {
    setBusyId(insertion.id); setError(undefined); setNotice(undefined);
    try {
      const draft = drafts[insertion.id] ?? { atMs: insertion.atMs, range: { inMs: insertion.sourceInMs, outMs: insertion.sourceOutMs } };
      const updated = await window.sourceApp.updateMediaInsertion(insertion.id, draft.atMs, draft.range);
      onProjectUpdated(updated); setNotice("安插時間與片段範圍已更新；字幕時間軸已標記需要複核。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  const removeInsertion = async (insertion: MediaInsertion) => {
    setBusyId(insertion.id); setError(undefined); setNotice(undefined);
    try {
      const updated = await window.sourceApp.removeMediaInsertion(insertion.id); onProjectUpdated(updated);
      setNotice("已取消安插，素材已恢復到原本正片順位；來源檔未刪除。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  const moveInsertion = async (insertion: MediaInsertion, toIndex: number) => {
    setBusyId(insertion.id); setError(undefined);
    try { onProjectUpdated(await window.sourceApp.moveMediaInsertion(insertion.id, toIndex)); setNotice("同一安插點的接續順序已保存。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  return <div className="modal-backdrop" role="presentation"><section className="photo-insertion-modal media-insertion-modal" role="dialog" aria-modal="true" aria-label={`於影片時段插入照片或影片 ${video.fileName}`}>
    <header className="modal-header"><div><span className="eyebrow">MEDIA INSERTION · NON-DESTRUCTIVE</span><h2>於影片時段插入照片／影片</h2><p>{video.fileName}</p></div><button className="icon-button" type="button" aria-label="關閉" disabled={Boolean(busyId)} onClick={onClose}>×</button></header>
    <div className="photo-insertion-body">
      <div className="readonly-note"><span>●</span><div><strong>來源唯讀</strong><small>只在 manifest 保存安插點與插入影片的 IN／OUT；輸出時展開為主影片前段 → 安插素材 → 主影片後段，絕不裁切或改寫原檔。</small></div></div>
      <section className="photo-insertion-new"><h3>新增安插</h3><div className="insertion-folder-toolbar">
        <label>來源資料夾<select aria-label="切換安插來源資料夾" value={folderFilter} onChange={(event) => { const value = event.target.value; setFolderFilter(value); setSelectedAssetId((value === ALL_FOLDERS ? availableMedia : availableMedia.filter((asset) => sourceFolder(asset.sourcePath) === value))[0]?.id ?? ""); }}><option value={ALL_FOLDERS}>全部資料夾（{availableMedia.length} 項）</option>{folders.map((folder) => <option key={folder} value={folder}>{folderLabel(folder)} · {availableMedia.filter((asset) => sourceFolder(asset.sourcePath) === folder).length} 項</option>)}</select></label>
        <div><button className="secondary-button" type="button" disabled={importingFolder || Boolean(busyId)} onClick={() => void chooseAnotherFolder()}>{importingFolder ? "正在讀取資料夾…" : "切換／加入其他資料夾…"}</button>{importingFolder && <button className="cancel-button" type="button" onClick={() => void window.sourceApp.cancelImport()}>取消讀取</button>}</div>
        <small title={folderFilter === ALL_FOLDERS ? undefined : folderFilter}>{folderFilter === ALL_FOLDERS ? "目前顯示專案內所有可安插素材。" : `目前資料夾：${folderFilter}`}</small>
      </div>{filteredMedia.length ? <div className="photo-insertion-form media-insertion-form">
        <label>選擇照片或影片<select aria-label="選擇要安插的素材" value={selectedAssetId} onChange={(event) => setSelectedAssetId(event.target.value)}><option value="">請選擇</option>{filteredMedia.map((asset) => <option key={asset.id} value={asset.id}>{asset.kind === "VIDEO" ? "影片" : "照片"} · {asset.fileName} · {formatDuration(asset.kind === "VIDEO" ? asset.mediaInfo?.durationMs : imageDurationMs(asset))}{project.pendingAssetIds.includes(asset.id) ? " · 新加入／待決定" : ""}</option>)}</select></label>
        <MinuteSecondFields label="主影片安插時間" valueMs={newAtMs} maxMs={video.mediaInfo?.durationMs} onChange={setNewAtMs} />
        <button className="primary-button" type="button" disabled={busyId === "new" || importingFolder || !selectedAssetId || (selectedAsset?.kind === "VIDEO" && !selectedAsset.mediaInfo?.durationMs)} onClick={() => void addInsertion()}>{busyId === "new" ? "正在安插…" : metadataLoadingId === selectedAssetId ? "正在讀取影片資訊…" : "確認安插素材"}</button>
      </div> : <p className="empty-inline">{availableMedia.length ? "此資料夾目前沒有可安插素材，請切換其他資料夾。" : "目前沒有可安插素材；可從其他資料夾唯讀加入。"}</p>}
      {selectedAsset && <div className="selected-insertion-media"><p>將插入 <strong>{selectedAsset.fileName}</strong> · {selectedAsset.kind === "VIDEO" ? metadataLoadingId === selectedAsset.id ? "正在讀取影片時長與規格" : "影片片段" : `${imageDurationMs(selectedAsset) / 1000} 秒照片`}{project.pendingAssetIds.includes(selectedAsset.id) ? " · 新加入素材確認安插前不會混入正片" : ""}</p><InsertionMediaPreview asset={selectedAsset} />{selectedAsset.kind === "VIDEO" && selectedAsset.mediaInfo?.durationMs ? <ClipRangeControl compact showTimeFields durationMs={selectedAsset.mediaInfo.durationMs} range={newSourceRange} onChange={(range) => setNewSourceRange(range)} /> : null}</div>}
      <small>安插點需位於主影片的保留範圍，並距兩端至少 0.75 秒。同一時間可加入多個項目，會依接續順序播放。</small></section>
      <section className="photo-insertion-existing"><h3>此影片的安插素材 · {insertions.length}</h3>{insertions.length ? insertions.map((insertion, index) => {
        const inserted = project.sources.find((asset) => asset.id === insertion.insertedAssetId); const draft = drafts[insertion.id] ?? { atMs: insertion.atMs, range: { inMs: insertion.sourceInMs, outMs: insertion.sourceOutMs } };
        const samePoint = insertions.filter((item) => item.atMs === insertion.atMs); const samePointIndex = samePoint.findIndex((item) => item.id === insertion.id);
        return <article className="media-insertion-row" key={insertion.id}><span className="sequence-number-static">{String(index + 1).padStart(2, "0")}</span><div><strong>{inserted?.fileName ?? "找不到來源"}</strong><small>{inserted ? `${inserted.kind === "VIDEO" ? "影片" : "照片"} · 使用 ${formatDuration(insertion.sourceOutMs - insertion.sourceInMs)}` : "來源離線"}</small></div>
          {inserted && <InsertionMediaPreview asset={inserted} />}
          <MinuteSecondFields label={`${inserted?.fileName ?? "素材"} 安插時間`} valueMs={draft.atMs} maxMs={video.mediaInfo?.durationMs} onChange={(value) => setDrafts((current) => ({ ...current, [insertion.id]: { ...draft, atMs: value } }))} />
          {inserted?.kind === "VIDEO" && inserted.mediaInfo?.durationMs ? <ClipRangeControl compact showTimeFields durationMs={inserted.mediaInfo.durationMs} range={draft.range} onChange={(range) => setDrafts((current) => ({ ...current, [insertion.id]: { ...draft, range } }))} /> : null}
          <div className="insertion-row-actions"><button type="button" disabled={Boolean(busyId) || samePointIndex <= 0} onClick={() => void moveInsertion(insertion, Math.max(0, index - 1))}>↑ 接前</button><button type="button" disabled={Boolean(busyId) || samePointIndex < 0 || samePointIndex >= samePoint.length - 1} onClick={() => void moveInsertion(insertion, Math.min(insertions.length - 1, index + 1))}>↓ 接後</button><button type="button" disabled={Boolean(busyId)} onClick={() => void updateInsertion(insertion)}>保存時間／片段</button><button className="remove-button" type="button" disabled={Boolean(busyId)} onClick={() => void removeInsertion(insertion)} aria-label={`取消安插 ${inserted?.fileName ?? "素材"}`}>取消安插</button></div>
        </article>;
      }) : <p className="empty-inline">尚未在這支影片內安插照片或影片。</p>}</section>
      {notice && <div className="notice success" role="status">{notice}</div>}{error && <div className="notice error" role="alert">{error}</div>}
    </div>
    <footer className="modal-footer"><span>主影片保留範圍：{retainedRangesForAsset(video).map((range) => `${formatDuration(range.inMs)}–${formatDuration(range.outMs)}`).join("、") || "無"}</span><button className="secondary-button" type="button" disabled={Boolean(busyId)} onClick={onClose}>完成</button></footer>
  </section></div>;
}
