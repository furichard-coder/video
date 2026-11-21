# SceneryWalker v0.87 字幕修復與驗收紀錄

## 結論與未完成驗收

字幕頁、獨立影片分析、草稿儲存與動態模型設定已實作。實際 OpenAI 模型清單請求成功；圖片／JSON 請求遭 `HTTP 429 / credit_balance_exhausted` 拒絕。因此**尚未完成使用真實 AI 的 3–5 分鐘字幕生成與內容品質驗收**，不能把 mock 測試當作 API 成功。需要補足 API 額度後再執行有界測試；不需重新轉檔影片。

## 目前專案證據

- 專案：`C:\大雪山\我的素材專案.swproj`；ID `033e4b53-b4fa-4418-95d2-5f7bc4b6df86`。
- 專案存在 **63 筆 DRAFT 字幕、0 筆 confirmed**；不是 312 筆 SRT。頁面捲動問題不代表字幕已清空。
- 最新成功歷史輸出：`E:\大雪山 YT video\SceneryWalker_preview_20260926_0243.mp4`，job `e1e1906b-fefb-4bae-a2c9-a11ab31dee0f`。
- ffprobe：H.264、3840×2160、30000/1001 fps、AAC；時長 **8,970,194 ms**；大小 **74,888,192,283 bytes**。
- 目前專案組合時間線：**8,964,908 ms**；差 **5,286 ms**。
- 該歷史輸出缺少 `projectId`，只有專案名稱关联。雖有完成紀錄，名稱和時長不能證明當前 timeline 未改。因此預設仍可選此影片，但用 **VIDEO_FIRST** 分析，不盲目寫回專案。
- 正式影片大小／修改時間保持原值；未重新編碼、未修改來源、未刪除任何 render checkpoint、MKV 或既有 SRT。

## 根因與修正

| 問題             | v0.86 證據／原因                                                                                                      | v0.87 行為                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 字幕不能捲動     | modal `overflow:hidden`、固定高度；多組控制列放在唯一可捲動子面板之前，把子面板擠到接近 0 高度                        | header/footer 不縮小；整個主內容包在 `min-height:0; flex:1; overflow-y:auto` 的捲動區；可見 scrollbar、鍵盤捲動；窄版單欄 |
| 字幕／草稿看不到 | 專案仍有 63 筆資料，並非檔案清空；被高度／裁切問題遮住                                                                | 真實 Electron DOM 顯示 63 rows，截圖可見最後一筆；AI error 與既有 cue state 分離                                          |
| AI 停在 frame 0  | `runSubtitleVisualJob` 在 extraction 前呼叫固定 2 秒容差的 `assertSubtitleVideoTimelineMatch`；5.286 秒差異直接 throw | compatibility 決定分析模式，不再完全禁止分析                                                                              |
| 帳號按鈕難以操作 | 按鈕已有 handler，沒有以 API key 缺少為條件 disabled；控制區被裁切                                                    | 按鈕移入可捲動內容；無 key 的隔離 profile 實測能開設定                                                                    |
| 手動選片被忽略   | 每次開工作又按歷史優先順序挑選來源                                                                                    | 本次 native picker 的明確選擇優先；工作 checkpoint 保存來源路徑与選擇原因                                                 |
| 固定模型         | UI 原固定 `gpt-5.6-terra/sol/luna`，且 text-only OK probe 不能证明 vision                                             | 動態列表＋最小 JPEG/JSON probe；新帳號 Auto；實際模型進度／log；舊 manual 模型不偷偷替換                                  |

## 分析模式、安全門檻與工作生命週期

`Tolerance = max(2,000 ms, min(10,000 ms, round(ProjectDuration × 0.001)))`。

- PROJECT_AWARE：有本專案 `projectId` 的成功輸出 identity，且在容差內，才使用 timeline 段落與寫入待確認草稿。
- VIDEO_FIRST：外部、人工選取、名稱限定的 legacy 輸出、時長不相容影片，直接使用 `0 → videoDuration`；建立獨立工作區／AI draft SRT。
- 開始前顯示影片、專案時長、差值、容差、mode、取樣量、provider/model、SRT 與 project cue 數。使用者可以改選安全的 VIDEO_FIRST。
- 保存前再次檢查影片 size/mtime，以及 project ID/timelineRevision。專案在工作中改變時，結果改存獨立草稿；影片改變則拒絕保存混合結果。
- 獨立工作區**沒有套回目前專案的按鈕**；可另存 SRT、編輯、刪除、合併、拆分。直接套入不相容時間線被禁止。
- 階段：PREPARING_VIDEO → SCENE_DETECTION／EXTRACTING_FRAMES → AI_ANALYZING → GENERATING_SUBTITLES → DRAFT_READY；FAILED/PAUSED/CANCELLED 保留成功 batch 與 cache。
- Retry/Resume 使用成功 batch cursor、影片 fingerprint、context/options；跨重啟恢復原分析影片。Resume 完成後不再被 UI 改回 RUNNING。

## 取樣／草稿／快取

- Main 每 2 秒預設取樣，可調 1–60；取樣間隔不是字幕長度。
- PROJECT_AWARE Intro/Photo 沿用第 1 秒可用影格與黑畫面後移規則；VIDEO_FIRST 不猜片頭邊界。
- 固定 interval＋FFmpeg scene 補點；早期縮放 scene 分析；dHash 去重；每批 20 張；沒有 300 張／100 段全域截斷。
- JPEG 分析圖最大 1280×720，處理完 batch 釋放圖片；分析結果快取含 provider **實際 model ID**，不同模型不錯用同一快取。明確 scene boundary 與每個 Intro／Photo 取樣不會因 dHash 類似而被刪除。
- 標題／說明只作背景，不能凌駕畫面；未確認地名、物種、年代／高度用中性描述。
- 相同相鄰文字合併、時間不重疊／不超影片、行寬遵守 60 字；語意近似但不同文案仍需人工 review。
- 既有同名 SRT 可先 timestamp backup 或保持不動；分析永遠先產生 draft，不直接覆寫正式 SRT。
- 獨立 review：文字／start/end、confidence、點擊 seek、選定 cue 才抓小型 evidence JPEG、merge/split/delete/save/export；不寫 Project subtitle API。
- `userData/subtitle-workspaces/<fingerprint>/workspace.json` 與 `*.ai-draft.srt`；`userData/jobs/subtitle-visual-job.json`；`userData/jobs/subtitle-v087.log`；`userData/cache/subtitle-vision/<projectId>`。

## Provider／模型／憑證

- OpenAI 使用正式 `/v1/models`、`/v1/responses`，不是 chatgpt.com 登入。Gemini 使用 paginated `models.list` 與 `generateContent`。
- 模型列表只代表 API 可見候選，沒有 capability metadata 的型號標 **UNKNOWN**，不直接宣稱支援 vision。
- 實際最小 64×64 JPEG＋strict JSON 成功才 READY。Auto 根據相容候選／模型家族版本與測試，不只按 created 日期；清單可刷新，移除已消失模型。
- Auto 僅在 model unavailable／確定能力不支援／特定 per-model rate-limit 時，測試並切換同 provider 候選；manual、auth、網路、餘額不足不偷偷 fallback。Gemini 必須由使用者選擇。
- OpenAI、Gemini、舊故事／發布模块共享模型 catalog 根目錄，不能將 literal `auto` 傳給 API。
- 模型／能力 cache 僅保存 credential hash，不保存 secret。金鑰仍由 Windows safeStorage 加密，與 project/SRT/log 分離。
- 本次 GET 成功列出包含 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol` 等模型；**不代表全部通過 vision test**。完整實際清單在 `artifacts/v087-live-validation/report.json`。
- 現有帳號實際選擇 `gpt-5.6-sol`，真實圖片請求回覆 `credit_balance_exhausted`；没有成功產生 AI draft，usage token 未由 API 回傳，不能解讀為已驗證零成本。

## 測試與限制

- 首輪完整 suite：94 files／561 tests PASS。新增後的核心 focused suite：8 files／26 tests PASS；renderer/main typecheck PASS。
- 一次同時執行 4K 取樣的高併發回歸出現 5 files 失敗：4 個 test／1 個 beforeAll 全部 timeout。封裝首次啟動亦曾 exit timeout，複測 PASS；取樣完成後以 `npx vitest run --maxWorkers=2` 單獨重測最新版本：**94 files／565 tests 全部 PASS，240.37 秒**，沒有放寬 timeout／跳過測試。負載與環境為 timeout 的支持證據，不把失敗輪次隱藏。
- 真實 Electron UI：最新建置再次測試 5 個案例 PASS，63 rows、End handler、捲到底、無金鑰設定可開啟；已檢視字幕與帳號設定截圖。
- 1366×768 请求实际 CSS viewport1354×706；1920×1080 请求被主機限制為1522×802；4K 用40% zoom 模擬3806×2004 CSS viewport；125%/150% zoom PASS。**不宣稱已在實體 4K Windows scaling 下驗收**。實體 trackpad 手感未測。
- 模擬 provider＋真實短片 FFmpeg pipeline 測試 PASS；**不是 paid AI E2E 成功**。
- 3 分鐘真實 AI 驗收在 provider preflight 被 API 餘額阻擋，所以沒有全片取樣、沒有正式影片 re-encode。
- 額外完成真實成品 **00:10:00–00:13:00** 的唯讀 FFmpeg 取樣：90 個 interval frames、0 個 scene 切點、0 個視覺重複、90 張保留，5 批（不是 API 請求），最末取樣 00:12:58。實際 API requests = 0。
- 此 3 分鐘取樣在並行測試負載下耗時 **605,325 ms（10:05.325）**；單批 JPEG peak **6,313,794 bytes（約 6.02 MiB）**，結束 JPEG cache **0 bytes**，master size/mtime 不變。它證明完整取樣及清理可行，**不代表字幕品質通過，也不是獨立的速度 benchmark**；本片段去重沒有節省影格，長片前處理效能／去重效果仍需改善與單独量測。
- 封裝：`release/v0.87.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.87.0.exe`，production build／packaged smoke PASS；EXE SHA-256 `2028E1D127431D42C002BF45D4A239C08217BFDD37FDA0216752F4947181507A`，app.asar `BE6BC49F128E1420B6073B2F1A28D6A32EBE6E57BF36530DB98CAE3E8DDA065F`。
- 部分 MOV/MKV codec 可能不能由 Chromium 直接播放；frame analysis 仍使用 FFmpeg，evidence JPEG 可看；未新增全片播放轉碼。
- 新獨立工作區逐筆 AI regenerate 對話尚未整合；已有的 project AI cue regenerate 保持 compatibility gate，避免把外部影片錯套專案。
- 已移除本次診斷用 isolated profile 的 `Local State` 複本及空資料夾；原設定／憑證檔沒有修改。此診斷副本可從原設定重新建立，沒有刪除使用者資料。

## 本版修改檔案（不把舊版本未提交 diff 算成本版）

`package.json`, `package-lock.json`, `src/shared/domain.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/main/main.ts`, `src/main/services/preview-protocol.ts`, `ai-settings.ts`, `ai-model-catalog.ts`, `openai-provider.ts`, `gemini-material-analysis.ts`, `gemini-publish-review.ts`, `standalone-subtitle-store.ts`, `subtitle-video-selection.ts`, `subtitle-frame-extractor.ts`, `subtitle-vision-providers.ts`, `subtitle-vision-fallback.ts`, `src/renderer/components/SubtitleStudio.tsx`, `AiSettingsModal.tsx`, `StandaloneSubtitleReview.tsx`, `src/renderer/styles.css`；相關 focused tests；`scripts/verify-subtitle-ui.mjs`、`verify-subtitle-live-v087.cjs`、`verify-subtitle-frames-v087.cjs`；本報告、README、CURRENT_PRODUCT_SPEC、CHANGELOG、VERIFICATION、PERF_WORKING_NOTES。

## 模型與工具分工

原 Sol 子代理完成 read-only scope 後遭額度限制；主代理接手 compatibility、資料安全、IPC 與整合 review。Luna 負責 scroll/UI、獨立 review 元件、模型 catalog/provider 的有界實作與測試，結果由主代理 review。搜尋、ffprobe、typecheck、test runner、Electron QA、hash 用工具；不掃描全部原始素材、不將長 FFmpeg log 全送模型。

## 後續使用

打開 v0.87 → 字幕檢視 → AI 帳號 → 刷新模型 → 選 Auto 或指定候選 → 保存 → 實際圖片／JSON測試。API 額度恢復後，再分析短影片確認內容；外部／legacy 影片會顯示 VIDEO_FIRST 並產生獨立草稿，不必重做 v0.85 成品。
