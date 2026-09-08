import { useEffect, useMemo, useState } from "react";
import type { PreviewResolution, YoutubePrivacyStatus, YoutubeSettingsSnapshot, YoutubeUploadProgress, YoutubeUploadResult } from "../../shared/domain";
import { formatBytes } from "../format";

interface Props {
  renderResult: { jobId: string; outputPath: string; sizeBytes: number; resolution?: PreviewResolution };
  onOpenSettings(): void;
  onClose(): void;
}

function fileStem(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "SceneryWalker 正片預覽";
  return name.replace(/\.mp4$/i, "").slice(0, 100);
}

export function YoutubeUploadModal({ renderResult, onOpenSettings, onClose }: Props) {
  const [settings, setSettings] = useState<YoutubeSettingsSnapshot>();
  const [title, setTitle] = useState(fileStem(renderResult.outputPath));
  const [description, setDescription] = useState("SceneryWalker 正片預覽（不公開連結供人工檢查）。");
  const [privacyStatus, setPrivacyStatus] = useState<YoutubePrivacyStatus>("unlisted");
  const [madeForKids, setMadeForKids] = useState<"UNSET" | "NO" | "YES">("UNSET");
  const [progress, setProgress] = useState<YoutubeUploadProgress>();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<YoutubeUploadResult>();
  const [error, setError] = useState<string>();

  const refreshSettings = () => window.sourceApp.getYoutubeSettings().then(setSettings).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  useEffect(() => {
    void refreshSettings();
    void window.sourceApp.getUserPreferences().then((preferences) => setPrivacyStatus(preferences.youtubeUploadDefaults.privacyStatus)).catch(() => undefined);
    window.sourceApp.onYoutubeUploadProgress(setProgress);
    return () => window.sourceApp.clearYoutubeUploadProgressListeners();
  }, []);
  const changePrivacy = (value: YoutubePrivacyStatus) => {
    setPrivacyStatus(value);
    void window.sourceApp.updateUserPreferences({ youtubeUploadDefaults: { privacyStatus: value } }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const channelMatches = useMemo(() => Boolean(settings?.connected && settings.channelTitle?.trim().toLocaleLowerCase() === settings.targetChannelName.trim().toLocaleLowerCase()), [settings]);

  const startUpload = async () => {
    if (madeForKids === "UNSET") return;
    setUploading(true); setError(undefined); setResult(undefined);
    try {
      setResult(await window.sourceApp.uploadYoutubeVideo({ jobId: renderResult.jobId, title, description, privacyStatus, madeForKids: madeForKids === "YES" }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("取消") ? "已取消 YouTube 上傳；本機輸出影片仍完整保留。" : message);
    } finally { setUploading(false); }
  };

  return <div className="modal-backdrop nested-modal" role="presentation">
    <section className="youtube-upload-modal" role="dialog" aria-modal="true" aria-label="上傳正片預覽到 YouTube">
      <header className="modal-header"><div><span className="eyebrow">YOUTUBE PREVIEW DELIVERY</span><h2>上傳正片預覽到 YouTube</h2><p>任何解析度都可上傳供人工預覽；預設「不公開」，不通知訂閱者。</p></div><button className="icon-button" type="button" disabled={uploading} onClick={onClose} aria-label="關閉">×</button></header>
      {result ? <div className="youtube-upload-complete"><span className="complete-mark">✓</span><h3>影片已交給 YouTube 處理</h3><p>已要求以「{result.requestedPrivacyStatus === "unlisted" ? "不公開" : "私人"}」上傳到「{result.channelTitle ?? settings?.channelTitle}」。請開啟影片或 YouTube Studio 再確認處理狀態、可見度與版權檢查。</p><div className="output-path-box"><span>預覽連結</span><strong>{result.videoUrl}</strong></div><div className="concat-footer-actions"><button className="secondary-button" type="button" onClick={() => navigator.clipboard?.writeText(result.videoUrl)}>複製連結</button><button className="youtube-connect-button" type="button" onClick={() => void window.sourceApp.openYoutubeVideo(result.videoId)}>用設定的瀏覽器觀看</button><button className="primary-button" type="button" onClick={onClose}>完成</button></div></div> : <div className="youtube-upload-body">
        <section className="youtube-upload-source"><span>選定的正片預覽</span><strong title={renderResult.outputPath}>{renderResult.outputPath}</strong><small>{renderResult.resolution ?? "既有 MP4"} · {formatBytes(renderResult.sizeBytes)}</small></section>
        {!settings ? <div className="loading-shell"><span className="spinner" /><p>正在確認 YouTube 帳號…</p></div> : <>
          <div className={`youtube-channel-card ${channelMatches ? "is-ready" : "is-blocked"}`}><span>{channelMatches ? "將上傳到" : "上傳已阻擋"}</span><strong>{settings.channelTitle ?? "尚未連結頻道"}</strong><small>{channelMatches ? `目標名稱已核對：${settings.targetChannelName}` : settings.connected ? `目前頻道與目標「${settings.targetChannelName}」不符` : "請先匯入 OAuth client 並完成 Google 授權"}</small><button className="secondary-button" type="button" disabled={uploading} onClick={onOpenSettings}>YouTube 設定／連結</button></div>
          <label className="youtube-upload-field">影片標題<input value={title} maxLength={100} disabled={uploading} onChange={(event) => setTitle(event.target.value)} /><small>{title.trim().length}/100</small></label>
          <label className="youtube-upload-field">說明<textarea value={description} maxLength={5_000} disabled={uploading} onChange={(event) => setDescription(event.target.value)} /><small>{description.length}/5000</small></label>
          <fieldset className="youtube-upload-options"><legend>可見度（沿用上次選擇）</legend><label><input type="radio" name="youtube-privacy" checked={privacyStatus === "unlisted"} disabled={uploading} onChange={() => changePrivacy("unlisted")} /><span><strong>不公開（預設）</strong><small>知道連結的人可觀看，不出現在頻道影片頁或一般搜尋。</small></span></label><label><input type="radio" name="youtube-privacy" checked={privacyStatus === "private"} disabled={uploading} onChange={() => changePrivacy("private")} /><span><strong>私人</strong><small>只有已登入的頻道擁有者可觀看。</small></span></label></fieldset>
          <fieldset className="youtube-upload-options"><legend>觀眾設定（必選）</legend><label><input type="radio" name="youtube-kids" checked={madeForKids === "NO"} disabled={uploading} onChange={() => setMadeForKids("NO")} /><span><strong>不是兒童內容</strong></span></label><label><input type="radio" name="youtube-kids" checked={madeForKids === "YES"} disabled={uploading} onChange={() => setMadeForKids("YES")} /><span><strong>是兒童內容</strong></span></label></fieldset>
          <aside className="youtube-api-warning"><strong>上傳前確認</strong><p>這是預覽輸出而非正式 Master。未經 YouTube 稽核的 API 專案可能被平台強制設為私人；App 不會繞過 YouTube 的處理、版權或政策檢查。</p></aside>
        </>}
        {uploading && <section className="render-progress" aria-live="polite"><div><strong>{progress?.phase === "AUTHORIZING" ? "正在更新 Google 授權" : progress?.phase === "STARTING" ? "正在建立可續傳工作" : progress?.phase === "FINALIZING" ? "YouTube 正在完成影片" : "正在上傳影片"}</strong><span>{Math.round(progress?.percent ?? 0)}%</span></div><progress max="100" value={progress?.percent ?? 0} /><small>{formatBytes(progress?.bytesUploaded ?? 0)} / {formatBytes(progress?.totalBytes ?? renderResult.sizeBytes)}</small></section>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <footer className="youtube-upload-actions">{uploading ? <button className="cancel-button" type="button" onClick={() => void window.sourceApp.cancelYoutubeUpload()}>取消上傳</button> : <><button className="secondary-button" type="button" onClick={onClose}>返回</button><button className="youtube-connect-button" type="button" disabled={!channelMatches || !title.trim() || madeForKids === "UNSET"} onClick={() => void startUpload()}>確認並開始上傳</button></>}</footer>
      </div>}
    </section>
  </div>;
}
