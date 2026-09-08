# ADR-0014：平台帳號、預覽成品庫與安全上傳準備

## 狀態

已採用，v0.15.0。

## 決定

- YouTube 帳號連結維持 Google 官方 Desktop OAuth／PKCE 流程。設定頁直接顯示授權狀態、頻道名稱與頻道 ID；App 不提供密碼欄位，也不讀取、顯示或保存 Google／YouTube 密碼。
- BiliBili 與 TikTok 帳號登入仍在各平台官方頁完成。App 只開啟固定官方入口，不代管帳號、密碼或瀏覽器登入狀態。
- 新增 App 級預覽成品索引，位置為 Electron `userData/settings/preview-output-history.json`。每個完成的正片、Intro 或取消後有效短片都記錄 job ID、絕對路徑、類型、建立時間、片長、解析度、大小、取消狀態與專案名稱。
- 舊版未曾登記的 MP4 不在未知資料夾中自動搜尋。使用者可用 Windows 原生多選視窗明確加入；每筆匯入會檢查副檔名、檔案存在與 ffprobe 影片軌。
- 歷史頁可播放、在檔案總管顯示或交接投稿。移除只刪索引項目，不會刪除或修改磁碟 MP4；離線檔仍保留紀錄供核對。
- 正片輸出預設可把目前已確認 Intro 片段放在 Main 前方。Renderer 顯示並允許取消，Main process 依現行 manifest 重新計算、逐項核對順序與 IN／OUT 後才輸出。
- 完整正片成功後，預設啟動 60 秒倒數並開啟 YouTube 最後確認頁。使用者可在輸出前取消勾選，或在倒數中取消；取消只停止上傳準備且保留 MP4。取消產出所得的較短有效 MP4 不會自動進入倒數。

## 理由

平台密碼不應交給本機剪輯 App。官方 OAuth 能讓使用者在平台自己的登入頁授權，同時讓 App 以可撤銷的 token 執行被允許的 API 操作。持久預覽索引解決 App 重開後找不到先前輸出的問題；原生手動匯入則能涵蓋升級前的檔案，又不需要危險或昂貴的全磁碟搜尋。

倒數的目標是縮短「產出完成到準備上傳」的操作距離，但真正上傳仍涉及頻道、標題、觀眾與可見度等重要決策。因此倒數只開啟最後確認頁，不執行無人值守發布。

## 安全與相容性

- 不變更 manifest schema；既有 `.swproj` 與 cache 可直接使用。
- 預覽紀錄只接受 App 實際完成的輸出，或使用者從原生檔案視窗明確選取的 MP4。Renderer 後續只傳 job ID，Main process 每次操作前重新驗證檔案。
- YouTube refresh token 與 OAuth client secret 仍使用 Windows `safeStorage` 加密，且與專案檔及預覽索引分離。
- BiliBili／TikTok 仍需使用者在官方頁面完成登入、metadata、版權及最後發布；未取得核准 API scope 前不宣稱背景自動發布。
- 片頭單獨預覽不提供正片上傳；手動匯入的既有 MP4 必須再由使用者主動按下投稿動作。
- 不修改根目錄 SOP、來源媒體或既有 release。
