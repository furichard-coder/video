# ADR-0010：專案歷史、取消成品、YouTube 預覽上傳與音訊政策

日期：2026-09-03  
狀態：Accepted

## 背景

使用者要求在 App 上方顯示版本、提供上一步／下一步、讓取消中的串連輸出仍盡量留下可播放 MP4，並把完成的正片預覽上傳至指定 YouTube 頻道。同時，配樂需接受多個本機 MP3 或 YouTube 連結，素材原音與 BGM 各自可調；片頭預覽另明確改為最多 3 分鐘、30 段、每段 3–22 秒。

根目錄 SOP 的 90 秒片頭是全域預設；本 App 的最新明確需求是專案級覆寫，只影響 App manifest、建議器與預覽輸出 gate，不修改全域 SOP。

## 決定

- manifest schema 升為 7。舊 schema 1–6 會補入素材原音 80% 等預設；舊音量大於新版上限時安全夾限為 200%。
- 素材原音預設 80%，BGM 預設 35%，所有使用者可調音量範圍為 0%–200%；最後仍套用 0.95 peak limiter。
- 本機 MP3 維持唯讀。YouTube URL 只建立待確認的來源／權利參考，不執行任意下載或轉 MP3；輸出前必須由使用者確認權利並指定自有、已授權或官方 Audio Library 下載的本機 MP3。
- BGM 清單依序排入時間，套用到正片及 Intro；未解析 URL 或離線來源會阻擋輸出。
- Intro 預覽最多 180 秒、最多 30 段，每段 3–22 秒。建議器、人工保存與 renderer 共用常數，Main process 輸出前再次驗證。
- 上一步／下一步保存目前工作階段最多 50 份 manifest 快照；只復原 App 專案資料，永遠不刪除或改寫來源。開啟／另存專案會重設歷史，避免跨專案誤套。
- 使用者取消 FFmpeg 時先送出互動式 `q`，最多等待 8 秒讓 muxer 寫完 MPEG-4 結尾；再以 ffprobe 驗證 partial。有效且至少 300 ms 才成為較短 MP4，否則只移除該 App partial。
- 完成／取消後保留的 MP4 可由既有 `.mp4` 外部播放器路由安全開啟。
- YouTube 使用官方 OAuth 2.0 Desktop App／PKCE loopback 與 resumable upload。設定中的 client secret、refresh token 以 OS safeStorage 加密；登入後必須精確核對目標頻道名稱。
- 上傳只接受本次工作階段已完成的正片預覽，預設 `unlisted`，只允許改為 `private`；不接受任意路徑、Intro 或正式 Master。上傳按鈕由使用者明確觸發，不自動發布。
- OAuth 瀏覽器優先 Chrome，找不到或啟動失敗時用 Edge，再安全退回系統預設。

## 影響

- 取消可以留下尺寸較小但結構完整的 MP4；太早取消時不能保證有成品，UI 必須說明。
- Undo／Redo 是 session 歷史，不進 `.swproj`；專案本身仍照常原子保存。
- Google API project 的驗證狀態可能使實際上傳只能是私人；UI 與文件不可保證平台接受不公開狀態。
- App 不提供規避平台條款的 YouTube 下載器，避免把連結誤當成已具授權的音源。
