# ADR 0042 — YouTube 人工拖放、HEVC、AI 復核與物種證據

日期：2026-09-10

## 決策

1. YouTube 預設採 Chrome 官方上傳頁＋檔案總管選取成品的人工拖放交接；現有 OAuth API 是第二選項。App 不模擬不可可靠驗證的跨程式滑鼠拖曳，也不自動按下發布。
2. 新轉檔偏好為 H.265／HEVC，H.264／AVC 保留為相容選項。每次輸出都保存實際 codec；舊 request 未帶 codec 時仍採 H.264，避免破壞既有呼叫者。
3. 每次轉檔有獨立浮水印開關並預設啟用；專案浮水印內容及排程仍由 schema 16 管理。取消只跳過此次濾鏡。
4. Codex／ChatGPT 是發布素材主生成者。Gemini 2.5 Flash 只在明確啟用且有 API Key 時復核主結果，只能推薦既有標題與縮圖 ID；其失敗不可覆蓋 ChatGPT 結果。
5. 動物物種是字幕影格分析的可選證據。無法從畫面可靠分辨時必須採較寬分類或標示「疑似」，降低 confidence 並加入 warning，不可由主題文字推測物種。

## 理由與邊界

- 使用者可以看見並控制真正送到 YouTube 的檔案；平台最終發布仍是外部、具後果的人工動作。
- HEVC 可減少相近畫質的檔案大小，但編碼較慢且舊播放器相容性較差，因此 H.264 必須保留。
- AI 分工與介面標示保持誠實：Gemini 不冒充主生成、不憑空產生來源畫面，也不繞過人工修改。
- 所有媒體來源保持唯讀；轉檔、縮圖與 AI 分析只建立衍生檔或專案資料。

## 驗證

以 service/unit/Renderer 測試、實際 H.265 FFmpeg 轉檔、來源雜湊、production build、Electron smoke 與 packaged smoke 驗證。完整證據記錄於 `docs/VERIFICATION.md`。
