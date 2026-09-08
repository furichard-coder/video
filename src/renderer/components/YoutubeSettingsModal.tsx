import { useEffect, useState } from "react";
import type { BrowserUploadPlatform, YoutubeBrowser, YoutubeSettingsSnapshot } from "../../shared/domain";

interface Props {
  onClose(): void;
  onSettingsChanged?(): void;
}

export function YoutubeSettingsModal({ onClose, onSettingsChanged }: Props) {
  const [snapshot, setSnapshot] = useState<YoutubeSettingsSnapshot>();
  const [preferredBrowser, setPreferredBrowser] = useState<YoutubeBrowser>("CHROME");
  const [targetChannelName, setTargetChannelName] = useState("漫步風光");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [portalBusy, setPortalBusy] = useState<BrowserUploadPlatform>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const adopt = (next: YoutubeSettingsSnapshot) => {
    setSnapshot(next); setPreferredBrowser(next.preferredBrowser); setTargetChannelName(next.targetChannelName); onSettingsChanged?.();
  };

  useEffect(() => {
    void window.sourceApp.getYoutubeSettings().then(adopt).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const save = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try { adopt(await window.sourceApp.updateYoutubeSettings({ preferredBrowser, targetChannelName })); setNotice("YouTube 設定已保存。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const chooseClient = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const next = await window.sourceApp.chooseYoutubeOAuthClient();
      if (next) { adopt(next); setNotice("已安全匯入 Desktop app OAuth client；現在可使用 Google 官方登入頁連結頻道。"); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    setConnecting(true); setError(undefined); setNotice(`正在等候 Google 官方授權；請在瀏覽器選擇「${targetChannelName.trim() || "目標頻道"}」所屬帳號／頻道。`);
    try {
      await window.sourceApp.updateYoutubeSettings({ preferredBrowser, targetChannelName });
      const next = await window.sourceApp.connectYoutube();
      adopt(next); setNotice(`已連結 YouTube 頻道「${next.channelTitle}」。App 沒有取得或保存 Google 密碼。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setNotice(undefined); }
    finally { setConnecting(false); }
  };

  const disconnect = async () => {
    setBusy(true); setError(undefined);
    try { adopt(await window.sourceApp.disconnectYoutube()); setNotice("已移除 App 內的 YouTube 授權；Google 端撤銷採最佳努力處理。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const openPortal = async (platform: BrowserUploadPlatform) => {
    setPortalBusy(platform); setError(undefined); setNotice(undefined);
    try { setNotice((await window.sourceApp.openPlatformPortal(platform)).message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPortalBusy(undefined); }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !connecting && onClose()}>
    <section className="youtube-settings-modal" role="dialog" aria-modal="true" aria-label="平台上傳設定">
      <header className="modal-header"><div><span className="eyebrow">PUBLISHING ACCOUNTS · SAFE OAUTH</span><h2>平台帳號與上傳設定</h2><p>YouTube 使用 Google 官方 OAuth；BiliBili／TikTok 使用官方登入／投稿頁。帳號密碼只交給平台官方頁面，本 App 不收集、不顯示也不保存密碼。</p></div><button className="icon-button" type="button" disabled={connecting} onClick={onClose} aria-label="關閉">×</button></header>
      <div className="youtube-settings-body">
        {!snapshot ? <div className="loading-shell"><span className="spinner" /><p>正在讀取平台帳號設定…</p></div> : <>
          <section className="youtube-setting-section account-status-section"><h3>1. YouTube 登入帳號</h3><div className={`youtube-login-status ${snapshot.connected ? "is-ready" : "is-blocked"}`}><span>{snapshot.connected ? "✓ Google 官方授權有效" : "尚未連結 Google 帳號"}</span><strong>{snapshot.channelTitle ?? "尚未取得 YouTube 頻道"}</strong><small>{snapshot.channelId ? `頻道 ID：${snapshot.channelId}` : "連結後會在這裡顯示實際上傳頻道與 ID。"}</small><p><strong>密碼不會顯示在這裡。</strong> 登入時只在 Google 官方網頁輸入帳號與密碼；本 App 只保存 Windows 加密的授權 token，並以頻道名稱／ID 核對上傳目的地。</p></div>{snapshot.connected ? <button className="danger-secondary-button" type="button" disabled={busy || connecting} onClick={() => void disconnect()}>登出／中斷 YouTube 連結</button> : <><button className="youtube-connect-button" type="button" disabled={!snapshot.clientConfigured || connecting || busy} onClick={() => void connect()}>{connecting ? "等待 Google 官方頁授權…" : "使用 Google 官方登入頁連結 YouTube"}</button>{!snapshot.clientConfigured && <p className="inline-notice">首次使用須先完成下方「OAuth 應用設定」，再回到這裡登入。</p>}{connecting && <button className="cancel-button" type="button" onClick={() => void window.sourceApp.cancelYoutubeConnect()}>取消登入／連結</button>}</>}</section>
          <section className="youtube-setting-section"><h3>2. 目標頻道與瀏覽器</h3><label>目標頻道名稱<input value={targetChannelName} maxLength={100} onChange={(event) => setTargetChannelName(event.target.value)} /><small>上傳前會精確核對已連結頻道；預設為「漫步風光」，名稱不符就阻擋。</small></label><fieldset><legend>Google 授權／觀看瀏覽器</legend>{snapshot.browsers.map((browser) => <label className="youtube-browser-option" key={browser.id}><input type="radio" name="youtube-browser" checked={preferredBrowser === browser.id} onChange={() => setPreferredBrowser(browser.id)} /><span><strong>{browser.label}</strong><small>{browser.available ? browser.executablePath : "未在常見安裝位置偵測到；會安全改用另一個瀏覽器或系統預設"}</small></span></label>)}</fieldset><button className="secondary-button" type="button" disabled={busy || connecting} onClick={() => void save()}>儲存頻道與瀏覽器設定</button></section>
          <section className="youtube-setting-section"><h3>3. YouTube OAuth 應用設定（首次使用）</h3><p>請在 Google Cloud 啟用 YouTube Data API v3，建立應用程式類型為 <strong>Desktop app</strong> 的 OAuth client，再匯入下載的 JSON。這不是您的 Google 帳號密碼。</p><div className="youtube-status-row"><span className={snapshot.clientConfigured ? "is-ready" : ""}>{snapshot.clientConfigured ? "✓ OAuth 應用已設定" : "尚未設定 OAuth 應用"}</span><small>{snapshot.clientIdHint ?? "Client ID 與 secret 不會寫入專案檔"}</small></div><button className="secondary-button" type="button" disabled={busy || connecting || !snapshot.encryptionAvailable} onClick={() => void chooseClient()}>選擇 OAuth client JSON…</button>{!snapshot.encryptionAvailable && <p className="inline-error">Windows 安全儲存不可用，已禁止匯入憑證。</p>}</section>
          <aside className="youtube-api-warning"><strong>重要平台限制</strong><p>若 Google／YouTube API 專案尚未通過 YouTube 稽核，API 上傳可能被平台強制設為「私人」，即使 App 要求「不公開」。完成後請在 YouTube Studio 核對可見度與版權檢查。</p></aside>
          <section className="youtube-setting-section"><h3>4. BiliBili 登入／投稿</h3><p>登入狀態由 BiliBili 官方網站與瀏覽器管理；App 看不到也不保存帳號密碼。預覽完成後會複製路徑並選取 MP4，仍由您確認分區、標題、版權與發布。</p><button className="bilibili-upload-button" type="button" disabled={Boolean(portalBusy)} onClick={() => void openPortal("BILIBILI")}>{portalBusy === "BILIBILI" ? "開啟中…" : "開啟 BiliBili 官方登入／投稿頁"}</button></section>
          <section className="youtube-setting-section"><h3>5. TikTok 登入／投稿</h3><p>登入狀態由 TikTok Studio 與瀏覽器管理；App 看不到也不保存帳號密碼。官方 API 需要開發者 App、OAuth 與核准的發布權限，本版維持官方頁面人工確認。</p><button className="tiktok-upload-button" type="button" disabled={Boolean(portalBusy)} onClick={() => void openPortal("TIKTOK")}>{portalBusy === "TIKTOK" ? "開啟中…" : "開啟 TikTok 官方登入／投稿頁"}</button></section>
        </>}
        {notice && <p className="inline-notice" role="status">{notice}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <footer className="settings-footer"><p>YouTube refresh token 使用 Windows 安全儲存加密；所有平台密碼都只留在平台官方登入頁，不進 App、`.swproj` 或預覽紀錄。</p><button className="primary-button" type="button" disabled={connecting} onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}
