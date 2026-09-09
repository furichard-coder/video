import { useEffect, useMemo, useState } from "react";
import type { AiPublishAssets, PreviewResolution, YoutubePrivacyStatus, YoutubeSettingsSnapshot, YoutubeUploadProgress, YoutubeUploadResult } from "../../shared/domain";
import { buildYoutubeDescription, chapterText, isValidYoutubeChapterSet, youtubeTextLength } from "../../shared/publish-rules";
import { formatBytes, formatDuration } from "../format";

interface Props {
  renderResult: {
    jobId: string;
    outputPath: string;
    sizeBytes: number;
    resolution?: PreviewResolution;
    durationMs?: number;
    expectedDurationMs?: number;
    aspectRatio?: "PORTRAIT_9_16" | "LANDSCAPE_16_9";
  };
  onOpenSettings(): void;
  onClose(): void;
  publishAssets?: AiPublishAssets;
}

function fileStem(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "SceneryWalker 正片預覽";
  return name.replace(/\.mp4$/i, "").slice(0, 100);
}

function selectedTitle(assets?: AiPublishAssets): string | undefined {
  return assets?.titles.find((item) => item.id === assets.selectedTitleId)?.text;
}

function selectedThumbnail(assets?: AiPublishAssets) {
  return assets?.thumbnails.find((item) => item.id === assets.selectedThumbnailId);
}

export function YoutubeUploadModal({ renderResult, onOpenSettings, onClose, publishAssets }: Props) {
  const [settings, setSettings] = useState<YoutubeSettingsSnapshot>();
  const [activePublishAssets, setActivePublishAssets] = useState<AiPublishAssets | undefined>(publishAssets);
  const [title, setTitle] = useState(selectedTitle(publishAssets) ?? fileStem(renderResult.outputPath));
  const [description, setDescription] = useState(() => publishAssets ? buildYoutubeDescription(publishAssets).text : "SceneryWalker 正片預覽（不公開連結供人工檢查）。");
  const [thumbnailPath, setThumbnailPath] = useState(selectedThumbnail(publishAssets)?.outputPath);
  const [privacyStatus, setPrivacyStatus] = useState<YoutubePrivacyStatus>("unlisted");
  const [madeForKids, setMadeForKids] = useState<"UNSET" | "NO" | "YES">("UNSET");
  const [progress, setProgress] = useState<YoutubeUploadProgress>();
  const [uploading, setUploading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [result, setResult] = useState<YoutubeUploadResult>();
  const [error, setError] = useState<string>();

  const applyPublishAssets = (assets: AiPublishAssets) => {
    setActivePublishAssets(assets);
    setTitle(selectedTitle(assets) ?? fileStem(renderResult.outputPath));
    setDescription(buildYoutubeDescription(assets).text);
    setThumbnailPath(selectedThumbnail(assets)?.outputPath);
  };
  const refreshSettings = () => window.sourceApp.getYoutubeSettings().then(setSettings).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  useEffect(() => {
    void refreshSettings();
    void window.sourceApp.getUserPreferences().then((preferences) => setPrivacyStatus(preferences.youtubeUploadDefaults.privacyStatus)).catch(() => undefined);
    if (!publishAssets) void window.sourceApp.getAiPublishAssets?.().then((assets) => { if (assets) applyPublishAssets(assets); }).catch(() => undefined);
    window.sourceApp.onYoutubeUploadProgress(setProgress);
    return () => window.sourceApp.clearYoutubeUploadProgressListeners();
  }, []);
  const changePrivacy = (value: YoutubePrivacyStatus) => {
    setPrivacyStatus(value);
    void window.sourceApp.updateUserPreferences({ youtubeUploadDefaults: { privacyStatus: value } }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const channelMatches = useMemo(() => Boolean(settings?.connected && settings.channelTitle?.trim().toLocaleLowerCase() === settings.targetChannelName.trim().toLocaleLowerCase()), [settings]);
  const thumbnail = selectedThumbnail(activePublishAssets);
  const thumbnailPreviewUrl = thumbnail?.outputPath ? `preview-media://publish-thumbnail/${encodeURIComponent(thumbnail.id)}?v=${encodeURIComponent(thumbnail.outputPath)}` : thumbnail?.previewUrl;
  const videoPreviewUrl = `preview-media://output/${encodeURIComponent(renderResult.jobId)}`;
  const chapters = activePublishAssets?.chapters ?? [];
  const chaptersBlock = chapterText(chapters).trim();
  const chaptersIncluded = !chaptersBlock || description.includes(chaptersBlock);
  const durationMs = renderResult.durationMs ?? renderResult.expectedDurationMs;
  const chaptersValid = !chapters.length || isValidYoutubeChapterSet(chapters, durationMs ?? Number.MAX_SAFE_INTEGER);
  const titleLength = youtubeTextLength(title.trim());

  const startUpload = async () => {
    if (madeForKids === "UNSET" || !reviewConfirmed) return;
    setUploading(true); setError(undefined); setResult(undefined);
    try {
      setResult(await window.sourceApp.uploadYoutubeVideo({ jobId: renderResult.jobId, title, description, privacyStatus, madeForKids: madeForKids === "YES", ...(thumbnailPath ? { thumbnailPath } : {}) }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("取消") ? "已取消 YouTube 上傳；本機輸出影片仍完整保留。" : message);
    } finally { setUploading(false); }
  };

  return <div className="modal-backdrop nested-modal" role="presentation">
    <section className="youtube-upload-modal" role="dialog" aria-modal="true" aria-label="上傳正片預覽到 YouTube">
      <header className="modal-header"><div><span className="eyebrow">YOUTUBE PREVIEW DELIVERY · v0.45</span><h2>{reviewing ? "上傳前集中確認" : "上傳正片預覽到 YouTube"}</h2><p>{reviewing ? "逐項看過影片、縮圖、文字、頻道與可見度後，才可開始上傳。" : "任何解析度都可上傳供人工預覽；預設「不公開」，不通知訂閱者。"}</p></div><button className="icon-button" type="button" disabled={uploading} onClick={onClose} aria-label="關閉">×</button></header>
      {result ? <div className="youtube-upload-complete"><span className="complete-mark">✓</span><h3>影片已交給 YouTube 處理</h3><p>已要求以「{result.requestedPrivacyStatus === "unlisted" ? "不公開" : "私人"}」上傳到「{result.channelTitle ?? settings?.channelTitle}」。請開啟影片或 YouTube Studio 再確認處理狀態、可見度與版權檢查。</p>{result.thumbnailStatus === "FAILED" && <p className="inline-warning">影片已成功上傳，但縮圖失敗：{result.thumbnailError ?? "未知錯誤"}{thumbnailPath && <button className="secondary-button" onClick={async () => { try { await window.sourceApp.retryYoutubeThumbnail?.(result.videoId, thumbnailPath); setResult({ ...result, thumbnailStatus: "UPLOADED", thumbnailError: undefined }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}>重試縮圖</button>}</p>}{result.thumbnailStatus === "UPLOADED" && <p className="inline-notice">影片與選定縮圖都已送出。</p>}<div className="output-path-box"><span>預覽連結</span><strong>{result.videoUrl}</strong></div><div className="concat-footer-actions"><button className="secondary-button" type="button" onClick={() => navigator.clipboard?.writeText(result.videoUrl)}>複製連結</button><button className="youtube-connect-button" type="button" onClick={() => void window.sourceApp.openYoutubeVideo(result.videoId)}>用設定的瀏覽器觀看</button><button className="primary-button" type="button" onClick={onClose}>完成</button></div></div> : reviewing ? <div className="youtube-upload-body youtube-final-review">
        <section className="youtube-review-media-grid">
          <article><header><strong>① 影片畫面與聲音</strong><small>{renderResult.resolution ?? "既有 MP4"} · {durationMs ? formatDuration(durationMs) : "片長待播放器讀取"}</small></header><video src={videoPreviewUrl} controls preload="metadata" aria-label="YouTube 上傳影片預覽" /><p title={renderResult.outputPath}>{renderResult.outputPath}</p></article>
          <article><header><strong>② 最終縮圖</strong><small>{thumbnailPath ? "實際上傳檔" : "尚未指定上傳檔"}</small></header>{thumbnailPreviewUrl ? <img src={thumbnailPreviewUrl} alt="YouTube 最終縮圖預覽" /> : <div className="youtube-review-empty">未選擇縮圖；YouTube 將自動擷取影片畫面。</div>}<p title={thumbnailPath}>{thumbnailPath ?? "未帶入自訂縮圖"}</p></article>
        </section>
        <section className="youtube-review-copy"><span>③ 標題 · {titleLength}/100</span><h3>{title}</h3><span>④ 實際送出的說明 · {description.length}/5000</span><pre>{description}</pre></section>
        <section className="youtube-review-checklist" aria-label="YouTube 上傳檢查清單">
          <div className={channelMatches ? "is-ready" : "is-blocked"}><strong>{channelMatches ? "✓" : "!"} 頻道</strong><span>{settings?.channelTitle ?? "尚未連結"}</span></div>
          <div className={titleLength > 0 && titleLength <= 100 ? "is-ready" : "is-blocked"}><strong>{titleLength > 0 && titleLength <= 100 ? "✓" : "!"} 標題</strong><span>{titleLength}/100 字</span></div>
          <div className={chaptersIncluded && chaptersValid ? "is-ready" : "is-blocked"}><strong>{chaptersIncluded && chaptersValid ? "✓" : "!"} 章節</strong><span>{chapters.length ? !chaptersValid ? "格式或時間無效" : `${chapters.length} 段${chaptersIncluded ? "已帶入" : "未帶入說明"}` : "本次沒有章節"}</span></div>
          <div className={madeForKids !== "UNSET" ? "is-ready" : "is-blocked"}><strong>{madeForKids !== "UNSET" ? "✓" : "!"} 觀眾</strong><span>{madeForKids === "YES" ? "兒童內容" : madeForKids === "NO" ? "不是兒童內容" : "尚未確認"}</span></div>
          <div className="is-ready"><strong>✓ 可見度</strong><span>{privacyStatus === "unlisted" ? "不公開" : "私人"}</span></div>
        </section>
        {activePublishAssets?.stale && <p className="inline-warning">AI 發布素材標記為需複核；請確認目前文字與縮圖仍符合最新時間線。</p>}
        <label className="youtube-review-confirm"><input type="checkbox" checked={reviewConfirmed} disabled={uploading} onChange={(event) => setReviewConfirmed(event.target.checked)} /><span><strong>我已播放檢查影片，並確認縮圖、標題、說明、章節、頻道、觀眾及可見度。</strong><small>YouTube 的轉碼、著作權與社群規範結果仍需在 Studio 再確認。</small></span></label>
        {uploading && <section className="render-progress" aria-live="polite"><div><strong>{progress?.phase === "AUTHORIZING" ? "正在更新 Google 授權" : progress?.phase === "STARTING" ? "正在建立可續傳工作" : progress?.phase === "FINALIZING" ? "YouTube 正在完成影片" : "正在上傳影片"}</strong><span>{Math.round(progress?.percent ?? 0)}%</span></div><progress max="100" value={progress?.percent ?? 0} /><small>{formatBytes(progress?.bytesUploaded ?? 0)} / {formatBytes(progress?.totalBytes ?? renderResult.sizeBytes)}</small></section>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <footer className="youtube-upload-actions">{uploading ? <button className="cancel-button" type="button" onClick={() => void window.sourceApp.cancelYoutubeUpload()}>取消上傳</button> : <><button className="secondary-button" type="button" onClick={() => { setReviewing(false); setReviewConfirmed(false); }}>返回修改</button><button className="youtube-connect-button" type="button" disabled={!reviewConfirmed || !channelMatches || !title.trim() || titleLength > 100 || madeForKids === "UNSET" || !chaptersIncluded || !chaptersValid} onClick={() => void startUpload()}>確認內容並開始上傳</button></>}</footer>
      </div> : <div className="youtube-upload-body">
        <section className="youtube-upload-source"><span>選定的正片預覽</span><strong title={renderResult.outputPath}>{renderResult.outputPath}</strong><small>{renderResult.resolution ?? "既有 MP4"} · {formatBytes(renderResult.sizeBytes)}</small></section>
        {!settings ? <div className="loading-shell"><span className="spinner" /><p>正在確認 YouTube 帳號…</p></div> : <>
          <div className={`youtube-channel-card ${channelMatches ? "is-ready" : "is-blocked"}`}><span>{channelMatches ? "將上傳到" : "上傳已阻擋"}</span><strong>{settings.channelTitle ?? "尚未連結頻道"}</strong><small>{channelMatches ? `目標名稱已核對：${settings.targetChannelName}` : settings.connected ? `目前頻道與目標「${settings.targetChannelName}」不符` : "請先匯入 OAuth client 並完成 Google 授權"}</small><button className="secondary-button" type="button" disabled={uploading} onClick={onOpenSettings}>YouTube 設定／連結</button></div>
          <label className="youtube-upload-field">影片標題<input value={title} maxLength={100} disabled={uploading} onChange={(event) => setTitle(event.target.value)} /><small>{titleLength}/100</small></label>
          <label className="youtube-upload-field">說明<textarea value={description} maxLength={5_000} disabled={uploading} onChange={(event) => setDescription(event.target.value)} /><small>{description.length}/5000{chapters.length ? ` · ${chaptersIncluded ? `已含 ${chapters.length} 段章節` : "章節已被移除"}` : ""}</small></label>
          {activePublishAssets && <button className="secondary-button youtube-restore-copy" type="button" onClick={() => applyPublishAssets(activePublishAssets)}>重新帶入 AI 標題／說明／章節／縮圖</button>}
          {thumbnailPath ? <p className="inline-notice">已帶入縮圖：{thumbnailPath}</p> : thumbnail && <p className="inline-warning">已選縮圖候選，但尚未合成或匯入 JPG／PNG；本次不會上傳自訂縮圖。</p>}
          <fieldset className="youtube-upload-options"><legend>可見度（沿用上次選擇）</legend><label><input type="radio" name="youtube-privacy" checked={privacyStatus === "unlisted"} disabled={uploading} onChange={() => changePrivacy("unlisted")} /><span><strong>不公開（預設）</strong><small>知道連結的人可觀看，不出現在頻道影片頁或一般搜尋。</small></span></label><label><input type="radio" name="youtube-privacy" checked={privacyStatus === "private"} disabled={uploading} onChange={() => changePrivacy("private")} /><span><strong>私人</strong><small>只有已登入的頻道擁有者可觀看。</small></span></label></fieldset>
          <fieldset className="youtube-upload-options"><legend>觀眾設定（必選）</legend><label><input type="radio" name="youtube-kids" checked={madeForKids === "NO"} disabled={uploading} onChange={() => setMadeForKids("NO")} /><span><strong>不是兒童內容</strong></span></label><label><input type="radio" name="youtube-kids" checked={madeForKids === "YES"} disabled={uploading} onChange={() => setMadeForKids("YES")} /><span><strong>是兒童內容</strong></span></label></fieldset>
          <aside className="youtube-api-warning"><strong>上傳前確認</strong><p>下一步會集中顯示實際影片、縮圖、標題、說明、章節、頻道、觀眾與可見度；尚未按最後確認前不會上傳。</p></aside>
        </>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <footer className="youtube-upload-actions"><button className="secondary-button" type="button" onClick={onClose}>返回</button><button className="primary-button" type="button" disabled={!channelMatches || !title.trim() || titleLength > 100 || madeForKids === "UNSET"} onClick={() => { setReviewing(true); setReviewConfirmed(false); setError(undefined); }}>檢查上傳內容</button></footer>
      </div>}
    </section>
  </div>;
}
