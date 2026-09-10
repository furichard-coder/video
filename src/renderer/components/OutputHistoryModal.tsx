import { useState } from "react";
import type { BrowserUploadPlatform, PreviewOutputRecord } from "../../shared/domain";
import { formatBytes, formatDate, formatDuration } from "../format";
import { YoutubeUploadModal } from "./YoutubeUploadModal";
import { OutputRecordActions, useOutputLibrary } from "./OutputLibrary";

interface Props {
  onClose(): void;
  onOpenYoutubeSettings(): void;
}

function purposeLabel(output: PreviewOutputRecord): string {
  if (output.purpose === "INTRO") return "片頭預覽";
  if (output.purpose === "CLIP") return "4K 時間段";
  if (output.purpose === "SHORTS") return "Shorts 直式預覽";
  if (output.purpose === "CONCAT") return output.includedIntroSegmentCount ? `片頭＋正片（${output.includedIntroSegmentCount} 段片頭）` : "正片預覽";
  return "手動加入的既有 MP4";
}

export function OutputHistoryModal({ onClose, onOpenYoutubeSettings }: Props) {
  const { outputs, loading, error, refresh, setOutputs, setError } = useOutputLibrary();
  const [busyId, setBusyId] = useState<string>();
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>();
  const [youtubeOutput, setYoutubeOutput] = useState<PreviewOutputRecord>();
  const [notice, setNotice] = useState<string>();
  const addExisting = async () => {
    setError(undefined); setNotice(undefined);
    try {
      const result = await window.sourceApp.chooseExistingPreviewOutputs();
      setOutputs(result.history.outputs);
      if (!result.cancelled) setNotice(`已加入 ${result.addedCount} 個既有 MP4${result.duplicateCount ? `，略過 ${result.duplicateCount} 個重複紀錄` : ""}。`);
      if (result.errors.length) setError(result.errors.join("\n"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const handoff = async (output: PreviewOutputRecord, platform: BrowserUploadPlatform) => {
    setBusyId(output.jobId); setError(undefined); setNotice(undefined);
    try { setNotice((await window.sourceApp.openPlatformUpload(output.jobId, platform)).message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  const youtubeChromeHandoff = async (output: PreviewOutputRecord) => {
    if (!window.sourceApp.prepareYoutubeChromeHandoff) { setError("請重新啟動新版 App 後再使用 Chrome 拖放交接。"); return; }
    setBusyId(output.jobId); setError(undefined); setNotice(undefined);
    try { setNotice((await window.sourceApp.prepareYoutubeChromeHandoff(output.jobId)).message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  const removeRecord = async (jobId: string) => {
    setBusyId(jobId); setError(undefined);
    try { setOutputs((await window.sourceApp.removePreviewOutputRecord(jobId)).outputs); setNotice("已從歷史清單移除紀錄；磁碟上的 MP4 沒有刪除或修改。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); setConfirmRemoveId(undefined); }
  };

  return <div className="modal-backdrop output-history-backdrop" role="presentation">
    <section className="output-history-modal" role="dialog" aria-modal="true" aria-label="預覽成品紀錄">
      <header className="modal-header"><div><span className="eyebrow">PREVIEW OUTPUT LIBRARY</span><h2>以前轉出的預覽檔案</h2><p>自動保存 App 產出的正片、片頭與取消後有效短片；重新開啟 App 後仍可播放、找出或上傳。</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="關閉">×</button></header>
      <div className="output-history-toolbar"><button className="secondary-button" type="button" disabled={loading} onClick={() => void addExisting()}>＋ 加入以前的 MP4…</button><button type="button" disabled={loading} onClick={() => void refresh()}>重新檢查檔案</button><span>加入只建立索引，不複製、不移動、不刪除影片。</span></div>
      <div className="output-history-body">
        {loading && !outputs.length ? <div className="loading-shell"><span className="spinner" /><p>正在讀取預覽成品紀錄…</p></div> : outputs.length ? <div className="output-history-list">{outputs.map((output) => {
          const canPublish = output.purpose !== "INTRO" && output.purpose !== "CLIP";
          return <article key={output.jobId} className={!output.exists ? "is-offline" : ""}>
            <header><div><span className="kind-badge video">{purposeLabel(output)}</span><h3 title={output.fileName}>{output.fileName}</h3></div><span className={output.exists ? "history-file-ready" : "history-file-offline"}>{output.exists ? "✓ 檔案可用" : "檔案已移動／離線"}</span></header>
            <p className="source-path" title={output.outputPath}>{output.outputPath}</p>
            <dl><div><dt>建立時間</dt><dd>{formatDate(output.createdAt)}</dd></div><div><dt>片長</dt><dd>{formatDuration(output.durationMs)}</dd></div><div><dt>大小</dt><dd>{formatBytes(output.sizeBytes)}</dd></div><div><dt>解析度</dt><dd>{output.resolution ?? "原檔規格"}</dd></div><div><dt>來源</dt><dd>{output.origin === "APP_RENDERED" ? "本 App 產出" : "使用者手動加入"}{output.cancelled ? " · 取消後有效短片" : ""}</dd></div><div><dt>專案</dt><dd>{output.projectName ?? "未記錄"}</dd></div></dl>
            <OutputRecordActions output={output} showPublish={canPublish} onError={setError} onCopySuccess={() => setNotice("已複製完整檔案路徑。")} onYoutube={() => void youtubeChromeHandoff(output)} onYoutubeApi={() => setYoutubeOutput(output)} onPlatform={(platform) => handoff(output, platform)} />
            {confirmRemoveId === output.jobId ? <div className="history-remove-confirm" role="alert"><span>只移除歷史紀錄，磁碟 MP4 不會刪除。</span><button type="button" autoFocus onClick={() => setConfirmRemoveId(undefined)}>取消</button><button className="danger-secondary-button" type="button" disabled={busyId === output.jobId} onClick={() => void removeRecord(output.jobId)}>確認移除紀錄</button></div> : <button className="history-remove-button" type="button" onClick={() => setConfirmRemoveId(output.jobId)}>從清單移除紀錄</button>}
          </article>;
        })}</div> : <div className="empty-state"><h2>尚無預覽成品紀錄</h2><p>下一次產出會自動出現在這裡；也可按「加入以前的 MP4」找回舊檔。</p></div>}
        {notice && <p className="inline-notice" role="status">{notice}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <footer className="settings-footer"><p>歷史頁只保存檔案位置與基本資料；移除紀錄不會刪除 MP4。片頭單獨預覽不提供正片上傳按鈕。</p><button className="primary-button" type="button" onClick={onClose}>完成</button></footer>
    </section>
    {youtubeOutput && <YoutubeUploadModal renderResult={youtubeOutput} onOpenSettings={onOpenYoutubeSettings} onClose={() => setYoutubeOutput(undefined)} />}
  </div>;
}
