# SceneryWalker 素材整理 App 變更紀錄

本檔案是每次可交付功能變更的簡短索引。完成一個階段後，必須同步更新本檔案、`README.md` 與 `VERIFICATION.md`；只有通過建置／測試的內容才可標記為完成。

## v0.43.0 — 2026-09-09

- 完成 AI 發布素材第七主頁與可編輯 topic／title／description／hashtags／chapters／thumbnail 候選流程。
- 新增 Intro→Shorts 可見流程；Shorts 驗證 Intro 片段來源與順序，使用 9:16 輸出並進共享成品庫。
- YouTube upload 支援人工確認後的縮圖；`videos.insert` 與 `thumbnails.set` 失敗狀態分離，支援縮圖重試。
- 明確保留本機 fallback 限制，不宣稱尚未實作的遠端 Structured Outputs 或 AI 圖片生成。

## v0.40.0 — 2026-09-09

- 主畫面加入六步主要工作區導覽，設定入口集中；素材編輯、輸出成品庫與細節 modal 可依目前工作區開啟。
- 新增 Material Editor workspace 與共享 OutputLibrary compact provider；Intro／字幕頁不再各自維護播放／位置／複製清單邏輯。
- Subtitle/BGM dirty close guard 提供保存並離開、放棄並離開、返回編輯；更新 AI 字幕預設已確認文案。

## v0.41.0 — 2026-09-09

- Concat、Intro、字幕與全域成品庫共用 `useOutputLibrary`、`OutputRecordActions` 與 purpose filter，移除重複的播放／開啟位置／複製路徑查詢與錯誤處理。
- OutputHistoryModal 保留既有 MP4 登記、歷史紀錄移除及 YouTube／BiliBili／TikTok 發布交接；共用元件只承擔一般檔案動作。

## v0.39.0 — 2026-09-09

- 字幕預覽與 MP4 burn-in 共用 `SubtitleStyleProfile`，位置、字級、顏色、陰影與外框依輸出解析度等比套用。
- 字幕／配樂時間欄位採共用分:秒.毫秒輸入；ProjectStore、burn-in、字幕預覽與 BGM 輸出引用共享 `TimelinePlan`。
- 主畫面顯示 autosave 狀態；字幕與配樂工作區在收到背景專案快照時保護未保存的 local draft。
- 新專案／新素材原音 100%、BGM 35%、可調 0–300%，既有有效值照舊遷移；新增 schema 14 相容欄位。
- 驗證：typecheck、33 suites／232 tests、build、npm audit、Electron smoke、Windows packaged smoke 通過。
- 交付：`release/v0.39.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `136F23BAD38BA4922BDA8BF4DBFB0EE266046931BA42360DB40A14FA7B32C185`。

## v0.38.0 — 2026-09-09

- Project manifest schema 14、Main／Intro revision、`project:changed` canonical snapshot、背景工作 project ownership 與安全切換 gate。
- AI 字幕重跑模式與共享 `TimelinePlan` 基礎層；字幕永久嵌入在開始輸出前可直接取消。
- 交付：`release/v0.38.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `C93B4625D8805A1EAE683DD831FF2AFAF0CA17AAB8C00E95B5D0409FB1843779`。

## v0.37.0 — 2026-09-08

- AI 字幕新 cue 預設為 `CONFIRMED`，可直接預覽與匯出；既有 `DRAFT`／`REJECTED` 狀態仍保留。
- 字幕頁新增 Shift 連續選取、批次取消確認與批次刪除；批次刪除需明確確認，來源影片、照片與代理檔不受影響。
- 字幕 cue 編輯與保存、SRT 驗證及 timeline revision gate 維持原流程。
- 驗證：32 suites／229 tests、TypeScript、production build、npm audit（0 vulnerabilities）、Windows packaged smoke 通過。
- 交付：`release/v0.37.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`。
- Windows EXE SHA-256：`8A03EC8DBAC457EFE6CE01F9110E74588667A8F90E61A5CAB6380244B7834089`。

## v0.36.1 — 2026-09-08

- 修正字幕永久嵌入選項在持久偏好為開啟、但目前沒有已確認字幕或字幕需要複核時被鎖定的問題。
- 使用者現在可在開始輸出前取消嵌入；未勾選時仍安全阻擋不完整字幕的啟用。
- 更新 UI 說明文字，明確表示取消不會修改來源檔。
- 修正 Windows 封裝忽略規則，避免把既有大型 `.upload-staging` 暫存 MP4 複製進 EXE。
- 驗證：32 suites／228 tests、TypeScript、production build、Windows packaged smoke 通過。
- 交付：`release/v0.36.1/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`。
- Windows EXE SHA-256：`9959B6CA644187EFD95A3B8266F49DFE97CB2F1E9E23367DFBA14E2EB5A5A829`。

## v0.36.0 — 2026-09-08

- AI 配樂、AI 片頭分析、AI 字幕、字幕片頭預覽與片頭／正片串連預覽改為主程式背景工作；關閉功能視窗不會中斷。
- 主畫面顯示背景工作狀態；完成結果沿用既有專案 manifest 或預覽檔案庫保存規則。
- AI 片頭分析結果保存至專案，重開片頭頁可由使用者明確套用，避免靜默覆蓋既有手動順序。
- 功能內的取消按鈕仍保留，取消與失敗狀態會在背景工作列顯示。
- 驗證：32 suites／227 tests、TypeScript、production build、Electron smoke、Windows packaged smoke 通過；npm audit 為 0 vulnerabilities。
- Windows EXE SHA-256：`526AFA53A3C7F43340D71B684F413D97A5B72B5664E99F9C1D3E8F08ADD6F5A6`。

## v0.35.0 — 2026-09-08

- 配樂頁新增「只搜尋有 royalty-free／授權線索的音樂」選項。
- OpenAI 與 Codex／ChatGPT 搜尋提示會要求 YouTube Audio Library、Creative Commons 或明示授權線索。
- Main process 會排除沒有 `rightsEvidence` 的候選，並將 `royaltyFreeOnly` 寫入搜尋結果。
- 選項偏好與最近搜尋結果可持久保存，重新開啟 App 或專案後恢復。
- UI 明確標示：授權線索不是法律上的無版權保證，仍須逐首核對原始條款。
- 驗證：32 suites／227 tests、TypeScript、production build、Electron smoke、Windows packaged smoke 皆通過；npm audit 為 0 vulnerabilities。
- 交付：`release/v0.35.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`。

## 文件維護規則

- 新功能或修正完成後，先更新本檔案，再更新 `README.md` 的版本摘要與 `docs/VERIFICATION.md` 的驗證結果。
- 若只完成程式修改但尚未驗證，記錄為進行中，不得宣稱已交付。
- 不在本檔案記錄來源媒體內容、API key、密碼或其他敏感資料。
## v0.42.0 — 2026-09-09

- 修正永久嵌入字幕勾選項的可逆性：輸出前可隨時取消，已勾選狀態不再因字幕複核提示而呈現不可操作。
- 保留啟用時的字幕確認／時間線複核 gate；取消不寫入來源、不改動已產出檔案。
## v0.44.0 — 2026-09-09

- 接上 OpenAI Responses strict `json_schema` 與 Codex／ChatGPT ephemeral read-only provider；fallback 順序為 OpenAI → Codex → LOCAL_FALLBACK。
- AI 發布輸入限制為低解析候選影格、topic 與 canonical timeline 摘要，並加入 project／timeline revision gate。
- 外部 AI paste-back 改為完整 publish schema 驗證。
