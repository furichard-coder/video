# 第一階段驗證紀錄

## v0.58.0 字幕寬度可調與透明 master bus（2026-09-12）

| 項目           | 結果                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每行字數覆寫   | PASS；字幕顯示格式新增 6–40 手動覆寫，留空維持自動換行；消毒鉗制（3→6、100→40、非數字→自動）與偏好持久化皆有單元測試。                                            |
| 預覽即成品斷行 | PASS；預覽浮層與 ASS 燒錄共用 `shared/subtitle-text`，480P 與 4K 跨解析度斷行數一致有測試鎖定；手動覆寫 6 字時斷行數大於自動。                                    |
| Master 透明化  | PASS；`acompressor` -6dB/ratio4 → -1dB/ratio2，整合測試斷言新鏈；合成素材 A/B 量測：detector 頻段 burst 仍壓低約 4 dB、底噪不動、非 detector 大音量段多保留約 1.9 dB 對比，峰值仍受限。 |
| 完整回歸       | PASS；TypeScript、51 個 Vitest 測試檔／306 個測試、production build、Windows packaged smoke 與 `npm audit`（0 漏洞）全數通過；CI 雙矩陣（FFmpeg 8.1.2＋latest）全綠。 |

v0.58.0 可攜版位於 `release\\v0.58.0\\SceneryWalkerSourceOrganizer-win32-x64\\SceneryWalkerSourceOrganizer-v0.58.0.exe`，EXE 大小 `244441088` bytes，資料夾大小 `407336281` bytes，SHA-256 `346D3335345F41A8BC54AA0C1C9066DCC3EEBC5F1253C81153E0E8AC1CD994AB`。封裝 smoke 已結束，未留下 v0.58.0 程序；未修改來源媒體、未上傳影片，也未安排關機或睡眠。

## v0.57.0 背景轉檔與併發字幕（2026-09-12）

| 項目         | 結果                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 背景轉檔     | PASS；轉檔中 × 只關視窗不取消，主畫面背景工作列顯示即時進度；重開轉檔頁接回監控模式（可取消、不重複啟動），完成／失敗就地提示並刷新輸出檔案庫。 |
| 字幕併發安全 | PASS；render 全程使用 `getProject()` 深拷貝快照，轉檔中字幕修改與 SRT 匯出不影響進行中的成品；Renderer 測試鎖定 × 不觸發取消。                    |
| 完整回歸     | PASS；TypeScript、50 個 Vitest 測試檔／297 個測試、production build、Windows packaged smoke 與 `npm audit`（0 漏洞）全數通過；CI 雙矩陣全綠。      |

v0.57.0 可攜版位於 `release\\v0.57.0\\SceneryWalkerSourceOrganizer-win32-x64\\SceneryWalkerSourceOrganizer-v0.57.0.exe`，EXE 大小 `244441088` bytes，資料夾大小 `407330249` bytes，SHA-256 `9AB302272211E6F936B31AF166FBA514FD8D070313DBFA56297AA618B2BC409C`。封裝 smoke 已結束，未留下 v0.57.0 程序；未修改來源媒體、未上傳影片，也未安排關機或睡眠。

## v0.56.0 字幕逐筆即時保存與列內操作（2026-09-11）

| 項目             | 結果                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 單筆確認即時保存 | PASS；格內文字修改後直接按該列「確認」，`setSubtitleCues` 立即收到最新文字、時間與 `CONFIRMED`，不需再按底部保存。成功訊息只在 Main 寫入回傳後顯示。                                                                  |
| 文字游標         | PASS；每列維持原生 textarea，測試可取得焦點、將 selectionStart 放在字串中間並繼續修改；編號選取與 Delete 快捷鍵不攔截文字輸入。                                                                                       |
| 每列四項操作     | PASS；每一筆都有確認、刪除、上移、下移。首筆上移與末筆下移停用；合法移動會交換相鄰輸出時間及來源錨點、兩筆改為 `DRAFT` 並立即保存。                                                                                   |
| 批量與強制校對   | PASS；全部確認／取消確認、Shift 複選確認／取消確認均即時保存；逐筆強制校對只有在目前 cue 寫入成功後才前進。                                                                                                           |
| 刪除與來源安全   | PASS；單筆、Shift 批量與 Delete 鍵刪除仍先要求確認，只改專案字幕清單；影片、照片、MP3、Proxy、SRT 與 MP4 不受影響。                                                                                                   |
| UI 畫面檢查      | PASS；隔離 userData 截圖顯示版本 v0.56.0、八個工作區與主要控制無裁切。Windows 畫面控制未取得原生 App surface，因此沒有操作使用者桌面上的視窗或 Chrome／YouTube。                                                      |
| 完整回歸         | PASS；TypeScript、49 個 Vitest 測試檔／296 個測試、production build、Electron smoke、Windows packaged smoke 與 `npm audit --audit-level=high` 全數通過。Vite 仍只有既有的單一 bundle 超過 500 kB 提示，不影響 build。 |

v0.56.0 可攜版位於 `release\v0.56.0\SceneryWalkerSourceOrganizer-win32-x64\SceneryWalkerSourceOrganizer-v0.56.0.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392653860` bytes，SHA-256 `9F749DF3A780E83741AD587C69E235FE0945A6288A18087B686906A3D46658EF`。封裝 smoke 與截圖程序均已結束，未留下 v0.56.0 程序；未修改來源媒體、未上傳影片，也未安排關機或睡眠。

## v0.55.0 版本化交付、安全游標與快速逐筆字幕校對（2026-09-11）

| 項目             | 結果                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本化 EXE       | PASS；封裝實際產生 `SceneryWalkerSourceOrganizer-v0.55.0.exe`，packaged smoke 由 `package.json` 解析相同檔名並成功啟動。                                                                                              |
| 安全預設游標     | PASS；共用安全按鍵同時取得 focus 與送出實際矩形；Main 拒絕 NaN、零尺寸、負座標及超出 renderer 的矩形，轉成實體螢幕點後才呼叫固定 Windows helper。關閉確認預設為「繼續剪輯」。                                         |
| 字幕短區段 Proxy | PASS；Renderer 對字幕來源 0.5–1.5 秒呼叫精確 `ensureClipPreview`，不再要求整支 `VIDEO_PROXY`；圖片走 `IMAGE_PREVIEW`。真實 FFmpeg 產生／命中、H.264 probe、損壞重建及來源 SHA-256 不變皆通過。                        |
| 快取重看         | PASS；新建與舊 marker 首次驗證後保存輸出 size／mtime；未變更重看不必再啟動 ffprobe。手動破壞 clip 後 fingerprint 不符，實際重新驗證並重建。                                                                           |
| 強制逐筆校對     | PASS；Main 先以現行時間軸自我映射並刷新 `sourceOutMs`，再設為 `DRAFT`；UI 顯示第 N／總數、畫面一致、內容不一致進入文字／時間編輯、略過與結束。流程明示由人判斷，不宣稱 AI 自動確認畫面語意。                          |
| 片頭加入時間保護 | PASS；手動影片／照片與局部放大加入不再呼叫平均分配或增加目標時間；UI 回歸確認原 6–9 秒片段不變、3:00 目標不變，容量不足會阻擋。明確按「套用上限並均衡」的既有功能仍保留。                                             |
| UI 畫面檢查      | PASS；隔離 userData 截圖顯示版本 v0.55.0、八個工作區與主要控制無裁切；Windows 畫面控制未取得原生 App surface，因此沒有操作使用者桌面上的既有視窗。                                                                    |
| 完整回歸         | PASS；TypeScript、49 個 Vitest 測試檔／295 個測試、production build、Electron smoke、Windows packaged smoke 與 `npm audit --audit-level=high` 全數通過。Vite 仍只有既有的單一 bundle 超過 500 kB 提示，不影響 build。 |

v0.55.0 可攜版位於 `release\v0.55.0\SceneryWalkerSourceOrganizer-win32-x64\SceneryWalkerSourceOrganizer-v0.55.0.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392648922` bytes，SHA-256 `8092E84F6F1B75D3F6EB021F8747679FB9BE2C330B6F989F6DFE5C73B16CFCAA`。封裝 smoke 與截圖程序均已結束，未留下 v0.55.0 程序；未修改來源媒體、未上傳影片，也未安排關機或睡眠。

## v0.54.0 本機人聲保護與片頭／正片配樂範圍（2026-09-11）

| 項目                    | 結果                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 預設與輸入驗證          | PASS；舊偏好自動補入全部預設勾選、6 dB 最大壓低、1.5 dB EQ 與 -1 dB ceiling；Main 僅接受 3–6 dB、0.5–4 dB 及 -1／-2 dB。                                                             |
| 平滑人聲包絡線          | PASS；真實 FFmpeg 測試影片完成 `asplit`、1–4 kHz detector、`sidechaincompress`、dry-floor/wet blend；6 dB floor 為 `0.501187`，攻擊／恢復預設 45／500 ms。                           |
| EQ／Compressor／Limiter | PASS；預設 filter graph 含 2.5 kHz -1.5 dB EQ、program compressor 與 -1 dB `0.891251` limiter；停用主開關則回到舊 0.95 limiter 且不套 sidechain／EQ／compressor。                    |
| 環境聲保留與誠實邊界    | PASS；UI 預設勾選遠處人群／市集及場景自然聲保留，並明示純聲學偵測不理解談話內容、無法百分之百分類聲音，需人工聽檢；本功能不送出音訊。                                                |
| 配樂片頭／正片複選      | PASS；Renderer 顯示兩個子選項並傳入明確 scope。只選片頭的服務整合測試把 3.2 秒片頭於 2.9 秒提示頁邊界截止，1.4–2.9 秒淡出；只選正片時在 5.6 秒正片起點啟動。                         |
| 秒數／順序字幕映射      | PASS；正片前段照片 5→7 秒使後續字幕 5.2→7.2 秒；片頭前段 5→3 秒使後續字幕 5.1→3.1 秒。另有正片／片頭拖曳換序、插入素材、IN／OUT 與 0.3→0.7 秒疊化回歸。                              |
| 強制重新校對            | PASS；Main 僅把所選範圍非排除字幕設為 `DRAFT` 並使該 scope review revision 過期，文字／頭尾不變、`REJECTED` 與另一範圍不變；Renderer 有二次確認、逐筆播放提示及 0 筆確認時禁止匯出。 |
| 真實媒體與唯讀          | PASS；多組真實 H.264／AAC／MP3 輸出套用新濾鏡後可 probe，既有來源與 MP3 SHA-256 前後一致；partial、取消、離線配樂 gate 仍通過。                                                      |
| 完整回歸                | PASS；TypeScript、48 個 Vitest 測試檔／293 個測試、production build、Electron smoke、Windows packaged smoke 與 `npm audit --audit-level=high` 全數通過。                             |

v0.54.0 可攜版位於 `release\v0.54.0\SceneryWalkerSourceOrganizer-win32-x64\SceneryWalkerSourceOrganizer.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392635293` bytes，SHA-256 `13EF59AD462EA0E38A587D1BF69215B383EF9A179132C5D991AEADB603E3FE00`。封裝 smoke 已結束且未留下 v0.54.0 程序；沒有強制關閉使用者程式、沒有上傳影片，也沒有安排關機或睡眠。

## v0.53.0 片頭獨立轉出／YouTube 測試與字幕視覺一致（2026-09-11）

| 項目               | 結果                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 正片／僅片頭選擇   | PASS；共用轉出頁可在 `CONCAT` 與 `INTRO` 間切換，Intro request 只含目前片頭片段，不含正片，輸出紀錄維持 `purpose=INTRO`。                                                                                                |
| 自動片頭嵌入字幕   | PASS；片頭頁與共用轉出頁都有本次字幕勾選；只允許已確認且 revision 最新的 Intro cue，Main cue 不會混入。                                                                                                                  |
| Intro 實際字幕輸出 | PASS；真實 FFmpeg 由唯讀測試來源產出 640×360 H.264 片頭字幕 MP4，媒體可 probe、ASS 暫存已清除、來源 SHA-256 前後相同。                                                                                                   |
| YouTube 片頭測試   | PASS；Renderer 完成 Intro 後提供 Chrome＋檔案總管拖放及官方 API；Main IPC 接受 `INTRO` output history，仍阻擋單一 `CLIP`。片頭上傳 UI 顯示片頭檔名／說明且不自動讀入正片 AI 標題、縮圖或章節。自動測試未對真實頻道發布。 |
| 字幕字級一致       | PASS；字幕頁與第一輸出語言共用 480p profile，480p 36px→ASS 36，4K 36px→ASS 162；第二翻譯語言的 1080p 字級與位置保持獨立。字幕預覽畫布以 854×480 比例及 container-height 單位呈現。                                       |
| 疊化字幕定位       | PASS；Main／Intro 邏輯片段起點會扣除 0.3／0.5／0.7 秒重疊，再映射到輸出片段；Intro＋Main 與正片開始提示頁的時間位移單元測試通過。                                                                                        |
| 完整回歸           | PASS；TypeScript、48 個 Vitest 測試檔／284 個測試、production build、Electron smoke、Windows packaged smoke 與 `npm audit --audit-level=high` 全數通過。                                                                 |

v0.53.0 可攜版位於 `release\v0.53.0\SceneryWalkerSourceOrganizer-win32-x64\SceneryWalkerSourceOrganizer.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392608647` bytes，SHA-256 `514119FDD60474F9C9A454F356618EE2F4939202AB0FEFD8D0DA521C59697E93`。本輪沒有上傳任何影片、沒有修改來源媒體，也沒有排程關機或睡眠。

## v0.52.0 字幕時間線同步、Gemini 圖片辨識、格內編輯與轉檔防睡眠（2026-09-11）

| 項目                  | 結果                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正片／片頭字幕同步    | PASS；正片換序、插入照片、片頭換序與疊化 0.3→0.7 秒都有 deterministic 測試；可對應字幕隨素材與來源內時間搬移，不可對應文字保留為待確認。                                                      |
| 時間基準單一化        | PASS；manifest schema 17 保存 0.3／0.5／0.7 秒，Main／Intro plan、字幕預覽、AI 素材字幕、發布章節與轉檔設定共用同一值。                                                                       |
| 字幕格內直接編輯      | PASS；每格具原生 textarea，焦點、游標定位與輸入不被卡片選取／Delete 快捷鍵攔截；編號按鈕保留單選及 Shift 連續複選。                                                                           |
| 介面放大文字          | PASS；16／18／20／22 px 之外新增 24 px「超大」與 26 px「特大」，Renderer 持久化測試通過。                                                                                                     |
| Gemini 圖片／物種分析 | PASS；Gemini strict JSON 傳輸與正規化以模擬 HTTPS transport 驗證，包含常用中文物種名、物品／場景、簡化字幕、信心與不確定警告。為保護 API 額度與照片隱私，本輪自動測試未呼叫真實 Gemini 帳號。 |
| Google Lens 移除      | PASS；domain、preload、IPC 與素材分析 UI 均不再提供 Lens 人工貼回；照片預設 Gemini，ChatGPT／Codex 保留為替代路徑。                                                                           |
| 轉檔防睡眠／防關閉    | PASS；reference-counted power guard 只啟用一次並在最後工作結束後解除；Windows 未成功啟用 blocker 時阻擋轉檔。Renderer 顯示防護狀態並停用關閉，Main 另行阻擋確認關閉與 session-end。           |
| 完整回歸              | PASS；TypeScript、48 個 Vitest 測試檔／280 個測試、production build、Electron smoke、Windows packaged smoke 與 `npm audit --audit-level=high` 全數通過。                                      |

v0.52.0 可攜版位於 `release\v0.52.0\SceneryWalkerSourceOrganizer-win32-x64\SceneryWalkerSourceOrganizer.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392599946` bytes，SHA-256 `156B096C3A0DF04EC88AB0082209CDA3E6CF466F2E50B4FAABDAD743DEE0E765`。強制關機、斷電、硬體重置或作業系統當機不屬於 App 可保證阻止的範圍。

## v0.51.0 重疊字幕、AI 數量與轉檔預檢（2026-09-10）

| 項目               | 結果                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 照片分析重疊回歸   | PASS；AI 簡化字幕不再被重疊 gate 丟棄，結果含完整新建議及既有字幕文字／時間。                                                                 |
| 重疊字幕進入審核   | PASS；新 cue 以 `DRAFT` 保存、舊 cue 保留；Main／Intro 同範圍新舊兩側同步紅框，時間移開後紅框即消失。兩筆 `CONFIRMED` 仍被 domain gate 阻擋。 |
| AI 目標字幕數      | PASS；Renderer 可輸入 1–300，Service 驗證範圍並對較長片段做多點分散取樣；3 秒測試素材要求 3 筆，實際產出 3 筆。                               |
| 轉檔容量／時間預估 | PASS；Main／Intro／Clip／Shorts 顯示估計檔案大小、時間、目前空間與完成後餘量；本機 Windows `statfs` 實際讀到 C 槽 `20277022720` bytes 可用。  |
| 1 GB 空間 gate     | PASS；純函式測試確認預估輸出後不足 1 GiB 時 `canRender=false`；Main process 在 FFmpeg 啟動前重新讀取目的磁碟並阻擋。                          |
| Shorts GPU 預設    | PASS；Shorts 明確傳送 `H265_QSV` 與預估片長，不再使用 legacy 未指定 codec fallback。                                                          |
| 來源與舊成品       | PASS；本輪測試、分析與預估未改寫來源媒體、既有 MP4／SRT 或剪輯規則內容；僅依要求追加產品變更紀錄。                                            |

完整驗證：TypeScript PASS；Vitest 45 個測試檔／271 個測試 PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit --audit-level=high` 0 vulnerabilities。v0.51.0 可攜版位於 `release\\v0.51.0\\SceneryWalkerSourceOrganizer-win32-x64\\SceneryWalkerSourceOrganizer.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392570581` bytes，SHA-256 `20B5089CFB0EAFC42DD80F3FA80B53D9C166DEF071B87443AF409CD6D9A30BC5`。

## v0.50.0 GPU 與素材影像字幕分析（2026-09-10）

| 項目             | 結果                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| QSV 編碼器探測   | PASS；本機 FFmpeg 暴露 `hevc_qsv`／`h264_qsv`，一秒測試輸出均成功；NVIDIA NVENC 不作為預設，因本機驅動 API 不相容。                |
| GPU 選項與預設   | PASS；新偏好預設 `H265_QSV`，UI 顯示 QSV H.265／H.264 與 CPU 備援，舊 `H265`／`H264` 偏好仍可讀取。                                |
| 照片分析入口     | PASS；照片卡預設勾選，結果先回傳可編輯 `DRAFT`，確認後才寫入字幕。                                                                 |
| 影片多影格分析   | PASS；輸入一個或多個來源時間點，分析遵守目前 IN／OUT，cue 保存來源 asset 與 source time。                                          |
| 物種／地點證據   | PASS；沿用既有 StoryFrameAnalysis schema，包含 `animalSpecies`、`speciesExplanation`、地點、警告與信心。                           |
| Google Lens 邊界 | PASS；只開啟外部人工入口並支援貼回文字，不自動上傳本機檔案。                                                                       |
| 完整驗證         | PASS；TypeScript、完整 Vitest、production build、Electron smoke、Windows packaged smoke 與 `npm audit --audit-level=high` 均通過。 |

完整驗證：TypeScript PASS；Vitest 43 個測試檔／265 個測試 PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit --audit-level=high` 0 vulnerabilities。v0.50.0 可攜版位於 `release\\v0.50.0\\SceneryWalkerSourceOrganizer-win32-x64\\SceneryWalkerSourceOrganizer.exe`，EXE 大小 `244441088` bytes，資料夾大小 `392549806` bytes，SHA-256 `445B7A7AB112DF111DBE1F488B2DBAB7B217CFA79D52734E165919635493662F`。

## v0.49.0 增量驗證（2026-09-10）

| 項目                        | 結果                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube Chrome 人工拖放交接 | PASS；只接受成品索引內存在的 Main／既有 MP4，打開官方上傳頁、複製完整路徑並選取檔案；Intro／Clip 被阻擋，最終拖放與發布不自動執行。                                       |
| 官方 API 備援               | PASS；既有 YouTube OAuth／集中確認流程保留為第二選項，預設仍為不公開且需人工確認。                                                                                        |
| H.265／H.264                | PASS；UI 與持久偏好預設 H.265，實際 FFmpeg 以 `libx265`＋`hvc1` 產生 HEVC MP4；H.264 路徑與舊輸出紀錄相容。                                                               |
| 單次浮水印                  | PASS；輸出頁預設勾選，Main 再驗證；實際 opt-out 輸出回報未套用且來源 SHA-256 前後一致。                                                                                   |
| 浮水印 UX                   | PASS；modal 內容限制寬度、禁止橫向溢出，時間／位置／樣式欄位採 auto-fit，footer 可換行，小視窗改為單欄。                                                                  |
| ChatGPT 主生成／Gemini 輔助 | PASS；Codex／ChatGPT 優先、OpenAI API 備援、離線 fallback 最後；Gemini 只復核既有 title/thumbnail ID，未設定或失敗不會丟失主結果。API Key 使用既有 Windows 加密憑證保存。 |
| 標題與縮圖工作台            | PASS；選定結果、標題、縮圖依序優先顯示，標題 100 字 gate、片頭優先可追溯影格與候選縮圖合成維持。                                                                          |
| 動物物種字幕證據            | PASS；OpenAI/Codex strict schema、正規化、cache 版本與字幕顯示均包含物種及說明；prompt 明定不確定時使用較寬分類／疑似、降低信心並警告。                                   |
| 來源與舊版                  | PASS；來源媒體、根目錄 7 份 SOP 與 v0.48.0 以前 release 未修改；封裝 smoke 未留下 v0.49.0 程序，也未關閉使用者正在執行的 v0.47/v0.48 視窗。                               |

完整驗證：TypeScript PASS；Vitest 43 個測試檔／262 個測試 PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit --audit-level=high` 0 vulnerabilities。封裝 EXE 大小 `244441088` bytes，資料夾大小 `392502872` bytes，SHA-256 `82248E2C79CBB6C94BA4D81E5CCEF285DE6DE2C50704518D0C6ADB10768EA427`。

## v0.48.0 增量驗證（2026-09-10）

| 項目               | 結果                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 草漯沙丘浮水印預設 | PASS；中文左下兩行、英文右下，排程 0／360／15 秒、淡入淡出 1 秒，1080p 字級 51／41 px與邊距 63 px。                                             |
| 專案設定與遷移     | PASS；Manifest schema 16 保存完整設定，舊 schema 補入預設，錯誤時間、字級、透明度或重疊角落由 Main process 阻擋。                               |
| 實際浮水印輸出     | PASS；360p 真實 H.264/AAC 串連輸出回報 `watermarkApplied=true`，4K filter 轉換為 102／82 px、126 px 邊距；來源 SHA-256 前後不變。               |
| 片頭優先 AI 畫面   | PASS；已選 Intro 中點先列入，再由 canonical Main timeline 補足；候選帶 `INTRO`／`MAIN` 與實際來源時間。                                         |
| AI 標題／縮圖顯示  | PASS；結果容器可捲動，產生後顯示 3 個標題、三張 1280×720 本機合成縮圖、選定結果、provider 與警告。                                              |
| AI provider 合約   | PASS；OpenAI `store:false` strict schema 與 Codex ephemeral/read-only prompt 都包含片頭摘要及候選來源；遠端不可用時保留 honest local fallback。 |
| 嵌入式字幕修改邊界 | PASS（規格）；已燒入 MP4 的文字不可直接替換，字幕修改須建立不覆寫的新版本；SRT 可直接修改另存。                                                 |
| 來源與既有交付     | PASS；根目錄 SOP、來源媒體及 v0.47.0 以前 release 未修改。                                                                                      |

完整驗證：TypeScript PASS；Vitest 41 個測試檔／255 個測試 PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit --audit-level=high` 0 vulnerabilities。封裝 EXE 大小 `244441088` bytes，資料夾大小 `392468831` bytes，SHA-256 `0EFD15D90B3F316137695004C820B0848E6052A12DA6FC018B459E34F45B25D4`。

## v0.47.0 增量驗證（2026-09-09）

| 項目           | 結果                                                               |
| -------------- | ------------------------------------------------------------------ |
| 字幕頁預設收折 | PASS；進入字幕頁只顯示精簡切換列，共用預覽清單不占用同步影片區域。 |
| 展開／收起     | PASS；`aria-expanded` 與可見內容同步，展開後可再次收起。           |
| 共用功能保留   | PASS；展開時仍使用既有 `OutputLibrary`，片頭頁顯示方式不變。       |

完整驗證：TypeScript PASS；Vitest 39 個測試檔／248 個測試 PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit --audit-level=high` 0 vulnerabilities。封裝 EXE 大小 `244441088` bytes，SHA-256 `4960B3F17D56A8EF8623C378A1C6B9E305FB2F07AA7B07DB6C218D265587B971`。

## v0.46.0 增量驗證（2026-09-09）

| 項目                 | 結果                                                       |
| -------------------- | ---------------------------------------------------------- |
| AI 字幕預設狀態      | PASS；AI 產出 cue 維持 `CONFIRMED`，可直接編輯與匯出。     |
| 全部確認／取消確認   | PASS；依目前顯示範圍切換所有非排除 cue，並保留待保存狀態。 |
| Shift 複選與批量操作 | PASS；可連續多選後確認、取消確認或刪除。                   |
| 單筆刪除             | PASS；清單每筆旁可獨立刪除，安全確認後只更新 manifest。    |
| 來源保護             | PASS；刪除字幕不移除影片、照片、來源檔或代理快取。         |

完整驗證：TypeScript PASS；Vitest 39 個測試檔／247 個測試 PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit --audit-level=high` 0 vulnerabilities。封裝 EXE SHA-256 `23C36C69FFD0AF4FAD6DDDDF03795C219A59C929C9FA4BD04B45C4320366BADA`。

## v0.45.0 增量驗證（2026-09-09）

| 項目                               | 結果                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| YouTube description composition    | PASS；中文、英文、章節及 hashtags 使用同一個實際 upload payload，長文優先保留章節與 hashtags。          |
| 集中人工確認 gate                  | PASS；未進入確認頁或未勾選檢查聲明時不能呼叫 upload。                                                   |
| 影片／縮圖唯讀預覽                 | PASS；只接受 OutputHistory job ID 與目前 manifest 的 thumbnail candidate ID，不接受 Renderer 任意路徑。 |
| 頻道／標題／章節／觀眾／可見度摘要 | PASS；集中確認頁逐項顯示。                                                                              |
| 真實頻道發布                       | 本輪未執行；避免測試自動建立 YouTube 影片，需使用者在 App 最後確認頁另行驗收。                          |

完整驗證：TypeScript PASS；Vitest 39 files／246 tests PASS；production build PASS；Electron smoke PASS；Windows packaged smoke PASS；`npm audit` 0 vulnerabilities。封裝 EXE 大小 `244441088` bytes，SHA-256 `48173E3ADC5114898B787656D4A3264578D07EF51AC9665110A6256E9C482DF9`。

## v0.43.0 增量驗證（2026-09-09）

| 項目                         | 結果                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| AI 發布素材第七頁            | PASS；可編輯 topic、5 筆標題上限、說明／hashtags、章節與提示詞貼回。               |
| Shorts                       | PASS；使用 `purpose=SHORTS`、`shortsSource=INTRO`，選定 Intro 片段不改動原 Intro。 |
| YouTube 縮圖 partial success | PASS；影片成功與縮圖失敗分開回報，單元測試覆蓋 `thumbnails/set` 失敗。             |
| v0.42 partial 限制           | PASS；遠端 AI 只做診斷，本機 fallback 明確標示；未宣稱 AI 圖片生成。               |
| publish rules                | PASS；title counting、chapter rules、user-edited merge 測試新增。                  |

## v0.40.0 增量驗證（2026-09-09）

| 檢查                                   | 結果                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 六步主要工作區導覽                     | PASS；一次只開啟一個主要工作區入口                                                                                                                                         |
| Material Editor workspace              | PASS；集中素材編輯入口並保留既有安全子編輯器                                                                                                                               |
| OutputLibrary reusable actions         | PASS；Intro／字幕共用 compact query/actions                                                                                                                                |
| Subtitle/BGM dirty close guard         | PASS；三選一保存語意，不直接丟棄未保存修改                                                                                                                                 |
| default CONFIRMED 文案                 | PASS；字幕頁不再描述 AI cue 必須先逐項確認才能使用                                                                                                                         |
| Renderer／Main TypeScript typecheck    | PASS                                                                                                                                                                       |
| Vitest 完整單元、整合與 UI 回歸        | PASS，34 suites／233 tests                                                                                                                                                 |
| Production build／npm audit            | PASS；0 high vulnerabilities                                                                                                                                               |
| Electron smoke／Windows packaged smoke | PASS                                                                                                                                                                       |
| v0.40.0 Windows x64 交付               | PASS；`release/v0.40.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe` SHA-256 `3B36990A83DAB304010557EC89B3764283B3DA265C619ACDC7BA2B8DAB0D137F` |
| 根目錄 SOP、來源媒體、既有 release     | 未修改                                                                                                                                                                     |

## v0.41.0 增量驗證（2026-09-09）

| 檢查                                           | 結果                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concat／Intro／字幕／全域成品庫 purpose filter | PASS；CONCAT＋UNKNOWN、INTRO、CLIP 依用途篩選                                                                                                                              |
| 播放／開啟位置／複製路徑共用動作               | PASS；`OutputRecordActions` 集中查詢、錯誤處理與可用性判斷                                                                                                                 |
| 全域成品庫獨有操作                             | PASS；既有 MP4 登記、歷史紀錄移除及三平台交接仍由 OutputHistoryModal 提供                                                                                                  |
| Renderer／Main TypeScript typecheck            | PASS                                                                                                                                                                       |
| Vitest 完整單元、整合與 UI 回歸                | PASS，35 suites／235 tests                                                                                                                                                 |
| Production build／npm audit                    | PASS；0 high vulnerabilities                                                                                                                                               |
| Electron smoke／Windows packaged smoke         | PASS                                                                                                                                                                       |
| v0.41.0 Windows x64 交付                       | PASS；`release/v0.41.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe` SHA-256 `7BA397D447DCB638E131FDC66039C21353F19A304E37373A44239AD07EA618EA` |
| 根目錄 SOP、來源媒體、既有 release             | 未修改                                                                                                                                                                     |

## v0.39.0 增量驗證（2026-09-09）

| 檢查                                    | 結果                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| SubtitleStyleProfile 預覽／burn-in 共用 | PASS；ASS 實際輸出檢查位置、字級、顏色、陰影與外框的解析度換算                         |
| 分:秒.毫秒時間輸入                      | PASS；字幕與 BGM 欄位採共用元件並保留整數毫秒                                          |
| autosave 狀態與背景更新草稿保護         | PASS；主畫面顯示保存狀態，字幕／配樂 dirty 編輯不被 project snapshot 靜默覆蓋          |
| TimelinePlan 實際引用                   | PASS；ProjectStore、字幕 burn-in、字幕 preview cache、BGM 匯入與輸出驗證共用同一計畫層 |
| 音量相容                                | PASS；新專案／新素材 100%、BGM 35%、上限 300%，既有有效值保留；0.95 limiter 不變       |
| Renderer／Main TypeScript typecheck     | PASS                                                                                   |

## v0.38.0 增量驗證（2026-09-09）

| 檢查                                                     | 結果                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 字幕永久嵌入可取消                                       | PASS；控制項只在真正編碼時停用，已勾選狀態可於開始前直接取消；重新啟用仍受確認／複核 gate 保護 |
| AI 字幕重跑模式                                          | PASS；fill blanks、replace AI scope、preserve user-edited 已納入資料模型與 ProjectStore        |
| Main／Intro revision 與 project:changed                  | PASS；schema 14 migration、事件快照與背景工作專案擁有者欄位完成                                |
| 共享 TimelinePlan                                        | PASS；交接重疊位置與總時長測試通過                                                             |
| Renderer／Main TypeScript typecheck                      | PASS                                                                                           |
| Vitest 完整單元、整合與 UI 回歸                          | PASS，33 suites／232 tests                                                                     |
| Production build／Electron smoke／Windows packaged smoke | PASS；v0.39.0 EXE SHA-256 `136F23BAD38BA4922BDA8BF4DBFB0EE266046931BA42360DB40A14FA7B32C185`   |
| 根目錄 SOP、來源媒體、既有 release                       | 未修改                                                                                         |

## v0.37.0 增量驗證（2026-09-08）

| 檢查                                       | 結果                                                      |
| ------------------------------------------ | --------------------------------------------------------- |
| AI 新字幕 cue 預設已確認                   | PASS；AI story pipeline 與 UI 回歸覆蓋                    |
| 字幕文字／時間／狀態保存與舊 manifest 相容 | PASS；既有 optional `reviewStatus` 缺失仍按已確認遷移     |
| Shift 連續選取                             | PASS；以字幕清單目前排序建立選取範圍                      |
| 批次取消確認                               | PASS；只改 `reviewStatus`，不刪除 cue 內容                |
| 批次刪除與確認                             | PASS；只呼叫 `setSubtitleCues`，來源媒體與 proxy 不受影響 |
| SRT export validation／revision gate       | PASS；沿用既有 `setSubtitleCues` 與輸出流程               |
| Renderer／Main TypeScript typecheck        | PASS                                                      |
| Vitest 完整單元、整合與 UI 回歸            | PASS，32 suites／229 tests                                |
| Production build                           | PASS                                                      |
| npm 高風險弱點掃描                         | PASS，0 vulnerabilities                                   |
| Windows packaged smoke                     | PASS；`npm run smoke:packaged`                            |
| 根目錄 7 份 SOP                            | 未修改                                                    |

v0.37.0 可攜版 EXE：`release/v0.37.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`

SHA-256：`8A03EC8DBAC457EFE6CE01F9110E74588667A8F90E61A5CAB6380244B7834089`；檔案大小 `244441088` bytes。既有 v0.36.1 及更早 release 未覆寫。

## v0.36.1 增量驗證（2026-09-08）

| 檢查                                           | 結果                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| 已持久化開啟字幕嵌入、但沒有已確認字幕時可取消 | PASS；勾選可安全取消，重新啟用仍受字幕條件保護 |
| 字幕嵌入提示文字                               | PASS；明確說明開始輸出前可取消且來源唯讀       |
| Renderer／Main TypeScript typecheck            | PASS                                           |
| Vitest 完整單元、整合與 UI 回歸                | PASS，32 suites／228 tests                     |
| Production build                               | PASS                                           |
| Windows packaged smoke                         | PASS；`npm run smoke:packaged`                 |
| npm 高風險弱點掃描                             | PASS，0 vulnerabilities                        |
| 根目錄 7 份 SOP                                | 未修改                                         |

v0.36.1 可攜版 EXE：`release/v0.36.1/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`

SHA-256：`9959B6CA644187EFD95A3B8266F49DFE97CB2F1E9E23367DFBA14E2EB5A5A829`；檔案大小 `244441088` bytes。封裝排除既有 `.upload-staging` 暫存 MP4，未刪除或修改該檔案。

## v0.36.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| 關閉功能視窗後背景工作                        | PASS；Main process 保留 AI 配樂、AI 片頭、AI 字幕、字幕預覽與串連輸出控制器 |
| 主畫面背景工作狀態                            | PASS；顯示執行中／完成／失敗／取消與進度摘要                                |
| AI 片頭分析結果保存                           | PASS；保存 `introAnalysisResult`，重開片頭頁可明確套用，不靜默覆蓋手動順序  |
| 主動取消                                      | PASS；功能內取消按鈕仍可中止，partial 輸出沿用既有清理規則                  |
| TypeScript renderer/main typecheck            | PASS                                                                        |
| Vitest 完整單元、整合與 UI 回歸               | PASS，32 suites／227 tests                                                  |
| Production build                              | PASS                                                                        |
| Electron hidden-window startup smoke          | PASS                                                                        |
| Windows v0.36.0 packaged `.exe` startup smoke | PASS                                                                        |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                     |
| 根目錄 7 份 SOP                               | 未修改                                                                      |

v0.36.0 可攜版 EXE SHA-256：`526AFA53A3C7F43340D71B684F413D97A5B72B5664E99F9C1D3E8F08ADD6F5A6`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.36.0`。既有 v0.35.0 及更早 release 未覆寫；封裝驗證未關閉使用者原本已開啟的舊版視窗。

## v0.35.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 「只搜尋有 royalty-free／授權線索」勾選       | PASS；UI 可切換，偏好持久化，生成請求帶入條件                                                       |
| 授權線索篩選                                  | PASS；沒有 `rightsEvidence` 的候選在篩選模式會被丟棄，結果保留 `royaltyFreeOnly` 狀態               |
| OpenAI／Codex 搜尋提示                        | PASS；兩條 AI 路徑都要求 YouTube Audio Library、Creative Commons 或明示授權線索，並回傳逐筆證據欄位 |
| 授權語意                                      | PASS；UI 與警告明示不等於法律上的無版權，仍需人工核對條款                                           |
| 舊專案／manifest 相容                         | PASS；新增欄位採安全預設，不改來源檔與既有 cache                                                    |
| TypeScript renderer/main typecheck            | PASS                                                                                                |
| Vitest 完整單元、整合與 UI 回歸               | PASS，32 suites／227 tests                                                                          |
| Production build                              | PASS                                                                                                |
| Electron hidden-window startup smoke          | PASS                                                                                                |
| Windows v0.35.0 packaged `.exe` startup smoke | PASS                                                                                                |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                                             |
| 根目錄 7 份 SOP                               | 未修改                                                                                              |

v0.35.0 可攜版 EXE SHA-256：`50396CBBACDCC680683E649724A779DC0BABFDB89DE467A94990990FD6EB0139`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.35.0`。既有 v0.33.0 與更早 release 未覆寫；封裝驗證未關閉使用者原本已開啟的 v0.33.0 視窗。

## v0.34.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                             |
| --------------------------------------------- | ---------------------------------------------------------------- |
| AI 配樂建議持久化                             | PASS；完整搜尋結果寫入目前專案 manifest，關閉／重開配樂頁可恢復  |
| 專案重開恢復                                  | PASS；ProjectStore 回歸測試確認曲名、連結、來源與提醒完整保留    |
| 取消／失敗保留舊結果                          | PASS；只有成功完成的結果才覆寫上一份結果                         |
| 來源與授權邊界                                | PASS；建議仍不是正式音訊來源，不下載、不修改 MP3、不改寫來源媒體 |
| TypeScript renderer/main typecheck            | PASS                                                             |
| Vitest 完整單元、整合與 UI 回歸               | PASS，33 suites／226 tests                                       |
| Production build                              | PASS                                                             |
| Electron hidden-window startup smoke          | PASS                                                             |
| Windows v0.34.0 packaged `.exe` startup smoke | PENDING                                                          |
| npm 高風險弱點掃描                            | PENDING                                                          |
| 根目錄 7 份 SOP                               | 未修改                                                           |

v0.34.0 可攜版 EXE SHA-256：`PENDING`

## v0.33.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 專案主題輸入                                  | PASS；只讀取 manifest 的主題、地點、故事摘要與觀眾承諾，不分析來源媒體                                                             |
| OpenAI 即時搜尋 adapter                       | PASS；Responses request 使用 `store: false`、`web_search`、來源 include 與 strict JSON schema；以受控 response 測試                |
| Codex／ChatGPT 備援                           | PASS；API 失敗後才檢查登入，使用 ephemeral／ignore-user-config／read-only／結構化輸出；本機 `codex login status` 為 ChatGPT 已登入 |
| YouTube 多筆建議                              | PASS；至少 3 筆安全可核對連結才接受，UI 顯示試聽、來源及加入參考                                                                   |
| TikTok／抖音選項                              | PASS；勾選狀態重開恢復，趨勢結果附觀察日期／證據，無結果時不冒充即時熱門                                                           |
| URL 與外部開啟                                | PASS；只允許官方 HTTPS YouTube watch／youtu.be／TikTok 音樂與 Creative Center，惡意／任意 URL 阻擋                                 |
| 授權邊界                                      | PASS；只供試聽，不下載、不自動混音，加入參考後仍需本機授權 MP3                                                                     |
| 取消／併發                                    | PASS；可取消，Renderer 關閉會 abort，同時只執行一個搜尋                                                                            |
| TypeScript renderer/main typecheck            | PASS                                                                                                                               |
| 針對性 Vitest                                 | PASS，5 files／85 tests                                                                                                            |
| Vitest 完整單元、整合與 UI 回歸               | PASS，32 suites／225 tests                                                                                                         |
| Production build                              | PASS                                                                                                                               |
| Electron hidden-window startup smoke          | PASS                                                                                                                               |
| Windows v0.33.0 packaged `.exe` startup smoke | PASS                                                                                                                               |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                                                                            |
| 根目錄 7 份 SOP                               | 未修改                                                                                                                             |

v0.33.0 可攜版 EXE SHA-256：`BF378148939BA50D0C0756B5DDA9627E1F70F7173CCC9A2F9ECA457AAD971720`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.33.0`。v0.32.0 與更早 release 未覆寫，也未強制關閉使用者正在執行的舊版視窗；封裝 smoke 結束後未留下 v0.33.0 背景程序。真實網路建議內容會在使用者於配樂頁主動按下搜尋後產生，因此本輪未替使用者耗用 API／ChatGPT 查詢，也未把當下研究結果寫入專案。

## v0.32.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 提示頁背景選擇                                | PASS；可選正片開場或目前任一已確認片頭段，顯示順位、檔名與 IN／OUT                                 |
| 原始素材重新連結                              | PASS；Main process 依 segment ID 回查 Project Store，FFmpeg 參數使用所選原檔及 IN 點，不使用 proxy |
| 過期／偽造背景                                | PASS；不存在於目前 Intro 清單的 segment ID 阻擋輸出，UI 對舊偏好安全退回正片開場                   |
| 背景偏好持久化                                | PASS；片頭段 ID 經清理後保存，重新開啟仍可恢復                                                     |
| 片頭滑鼠拖曳                                  | PASS；拖入新順位時清單數字即時更新，放開後 `setIntroSegments` 保存新順序                           |
| 鍵盤／既有排序                                | PASS；往前／往後按鈕保留，拖曳不影響 IN／OUT、移除、循環播放與輸出                                 |
| 來源保護                                      | PASS；真實 FFmpeg 回歸確認來源 SHA-256 不變                                                        |
| TypeScript renderer/main typecheck            | PASS                                                                                               |
| 針對性 Vitest                                 | PASS，3 files／94 tests                                                                            |
| Vitest 完整單元、整合與 UI 回歸               | PASS，63 suites／219 tests                                                                         |
| Production build                              | PASS                                                                                               |
| Electron hidden-window startup smoke          | PASS                                                                                               |
| Windows v0.32.0 packaged `.exe` startup smoke | PASS                                                                                               |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                                            |
| 根目錄 7 份 SOP                               | 未修改                                                                                             |

v0.32.0 可攜版 EXE SHA-256：`743C5A4992E4797FDAF59CEDB58DD2478FC3F14EA255010E4BAEFD8316921E56`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.32.0`。v0.31.0 與更早 release 未覆寫，也未強制關閉使用者目前開啟的舊版視窗；封裝 smoke 結束後未留下 v0.32.0 背景程序。

## v0.31.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Intro＋Main 強制提示頁 gate                   | PASS；勾選或沿用串接時自動跳出設定，取消即取消串接，未確認不得開始輸出                 |
| 3–7 秒與兩行文字設定                          | PASS；秒數、兩行文字、各行字級、間距、30%–85% 半透明遮罩均有前後端驗證                 |
| 沙丘前案預設                                  | PASS；3 秒、62% 暗色遮罩、兩行白字、0.3 秒柔和疊化，背景取第一個正片唯讀來源           |
| 基本轉場                                      | PASS；柔和疊化、淡至黑、直接切換皆建立可預測的 FFmpeg graph 與片長                     |
| 真實 FFmpeg 中英文／空格路徑                  | PASS；`草漯沙丘／旅程開始` 提示頁完成 360P H.264／AAC 輸出，片長誤差不超過 150ms       |
| 字幕時間線                                    | PASS；片頭字幕時間不變，正片字幕依提示頁及轉場淨增時間正確後移                         |
| BGM／聲音                                     | PASS；提示頁為靜音底，勾選 BGM 時仍沿用既有整體混音與 0.95 limiter                     |
| 暫存與 Windows 命令列                         | PASS；兩個 UTF-8 文字暫存與唯一 filter script 完成／失敗／取消後清除，文字不放入命令列 |
| 偏好持久化與舊設定                            | PASS；上次提示頁設定可重開恢復，舊偏好缺欄位時補安全預設，manifest schema 不變         |
| 來源 SHA-256                                  | PASS；真實輸出測試前後完全相同                                                         |
| TypeScript renderer/main typecheck            | PASS                                                                                   |
| Vitest 完整單元、整合與 UI 回歸               | PASS，31 files／218 tests                                                              |
| Production build                              | PASS                                                                                   |
| Electron hidden-window startup smoke          | PASS                                                                                   |
| Windows v0.31.0 packaged `.exe` startup smoke | PASS                                                                                   |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                                |
| 根目錄 7 份 SOP                               | 未修改                                                                                 |

v0.31.0 可攜版 EXE SHA-256：`1B5D5D0BF403B2403BD3A0677A7778AD44D30633AFDAB088BC1FB42A679CDC80`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.31.0`。v0.30.0 與更早 release 未覆寫，也未強制關閉使用者目前開啟的舊版視窗；封裝 smoke 結束後未留下 v0.31.0 背景程序。

## v0.30.0 增量驗證（2026-09-08）

| 檢查                                          | 結果                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Intro＋Main 與字幕長 filter graph             | PASS；FFmpeg 使用唯一 `-filter_complex_script`，不再以巨大 `-filter_complex` 參數啟動                   |
| filter script 內容與生命週期                  | PASS；整合測試在 runner 啟動時讀到完整 xfade graph，完成後暫存檔為空清單；失敗／取消亦由 `finally` 清理 |
| 真實 FFmpeg 串連／字幕路徑                    | PASS；完整 concat integration 使用 H.264／AAC 測試素材完成，來源 hash 不變                              |
| 自動輸出資料夾與檔名                          | PASS；沿用 `PREVIEW_OUTPUT`，失效時退回 Videos；中文／空格檔名可用，撞名產生 `_02` 且不覆寫             |
| 一次性 token 與競態保護                       | PASS；Renderer 不提交路徑，自動檔在開始前若已存在即阻擋並要求重新產生                                   |
| 本次 MP4 配樂選項                             | PASS；正片預設勾選、可取消，Renderer 實際傳入 `includeBgm`；正片／Intro 偏好分開保存                    |
| 配樂關閉與既有混音                            | PASS；關閉時 Main service 不加入 BGM input；開啟時沿用時間、source IN／OUT、fade、音量與 limiter        |
| 舊 manifest、偏好與 cache                     | PASS；manifest schema／previewer version 未變，舊偏好缺欄位時正片安全補 `true`、Intro 補 `false`        |
| TypeScript renderer/main typecheck            | PASS                                                                                                    |
| Vitest 完整單元、整合與 UI 回歸               | PASS，31 files／215 tests                                                                               |
| Production build                              | PASS                                                                                                    |
| Electron hidden-window startup smoke          | PASS                                                                                                    |
| Windows v0.30.0 packaged `.exe` startup smoke | PASS                                                                                                    |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                                                 |
| 根目錄 7 份 SOP                               | 大小／mtime 未變更                                                                                      |

v0.30.0 可攜版 EXE SHA-256：`3608273CE7A3D24DF302B99F7CF91ABF96797DD1ABD02051DBD68CBBA0807737`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.30.0`。v0.29.0 與更早 release 未覆寫，也未強制關閉使用者目前開啟的舊版視窗；封裝 smoke 結束後未留下 v0.30.0 背景程序。

## v0.29.0 增量驗證（2026-09-07）

| 檢查                                          | 結果                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 片頭頁勾選配樂後建立 480P 共用預覽            | PASS；Renderer 實際傳入 `includeBgm: true`，完成後顯示並播放共用 MP4                       |
| 片頭輸出頁配樂勾選與重開沿用                  | PASS；一般偏好持久化，舊設定缺欄位時安全補 `false`                                         |
| 精確 BGM／素材原音混音鏈                      | PASS；沿用已實測的 Timeline、source IN／OUT、fade、0–200% gain 與 0.95 limiter FFmpeg 路徑 |
| 配樂預覽 cache 命中／失效                     | PASS；有／無配樂使用不同 key，BGM 設定、大小、mtime、片頭來源與預覽器版本共同綁定          |
| 字幕 480P 預覽登錄共用歷史                    | PASS；同一 persistent output history 可由片頭頁、字幕頁與片頭輸出頁讀取                    |
| 預覽播放／開啟位置／複製路徑                  | PASS；以持久化 output job ID 在 Main process 重新驗證檔案後執行                            |
| 本機 MP3 播放／開啟位置／複製路徑             | PASS；IPC 只接受 manifest 既有 track ID，並驗證絕對路徑及檔案存在                          |
| 字幕文字修改與單筆刪除                        | PASS；按鈕或 Delete 經確認後立即保存，輸入欄位焦點時不攔截 Delete                          |
| 第三方 YouTube 轉檔與廣告自動化               | 未實作；保留授權 MP3 流程並提供官方 YouTube Audio Library 入口                             |
| TypeScript renderer/main typecheck            | PASS                                                                                       |
| Vitest 完整單元、整合與 UI 回歸               | PASS，30 files／212 tests                                                                  |
| Production build                              | PASS                                                                                       |
| Electron hidden-window startup smoke          | PASS                                                                                       |
| Windows v0.29.0 packaged `.exe` startup smoke | PASS                                                                                       |
| npm 高風險弱點掃描                            | PASS，0 vulnerabilities                                                                    |
| 根目錄 7 份 SOP                               | 大小／mtime 未變更                                                                         |

v0.29.0 可攜版 EXE SHA-256：`9B2C31E6706427CBF0F506B1B77C03B15EFF3A4183D3481F86259999DE1EAD4C`

檔案大小：`244441088` bytes。ProductVersion 與 FileVersion 均為 `0.29.0`。v0.28.0 與更早 release 未覆寫，也未強制關閉使用者目前開啟的舊版視窗。

## v0.28.0 增量驗證（2026-09-07）

| 檢查                                           | 結果                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| v0.27 保存的 OpenAI Key 實際故事模型 preflight | FAIL（預期且已正確辨識）；API 回覆 `credit_balance_exhausted`，不是片頭 proxy 或字幕 UI 問題                 |
| 昂貴媒體處理前的 API preflight                 | PASS；額度失敗時不先 probe／解碼來源或建立故事板                                                             |
| 本機 Codex 執行程式與 ChatGPT 登入             | PASS；`codex-cli 0.147.0`，登入狀態為 ChatGPT                                                                |
| Codex 結構化視覺字幕實測                       | PASS；既有低解析三格故事板回傳繁中字幕、畫面／事件／地點、分數及警告                                         |
| App 整體 AI diagnostic                         | PASS；OpenAI API 失敗後確認 Codex／ChatGPT 登入備援，exit 0                                                  |
| Windows 封裝版 AI diagnostic                   | PASS；v0.28.0 EXE 可偵測同一 Codex／ChatGPT 登入，exit 0                                                     |
| 安全執行參數                                   | PASS；安全參數陣列、stdin prompt、`--ephemeral`、`--ignore-user-config`、唯讀 sandbox、App AI cache 工作目錄 |
| 結構化結果完整性                               | PASS；JSON Schema 加 Main process 的筆數、唯一 index、欄位與分數驗證；暫存 schema 完成後清除                 |
| 多候選批次與 cache                             | PASS；每批最多 12 張，來源／時間／故事背景／模型／backend／analyzer version 共同組 key；第二次不重跑 Codex   |
| 語音選項邊界                                   | PASS；Codex 備援不冒充語音辨識，勾選時在讀取音訊前要求可用 OpenAI API                                        |
| 來源 SHA-256                                   | PASS；Codex fallback 整合測試前後完全相同                                                                    |
| TypeScript renderer/main typecheck             | PASS                                                                                                         |
| Vitest 完整單元、整合與 UI 回歸                | PASS，30 files／209 tests                                                                                    |
| Production build                               | PASS                                                                                                         |
| Electron hidden-window startup smoke           | PASS                                                                                                         |
| Windows v0.28.0 packaged `.exe` startup smoke  | PASS                                                                                                         |
| npm 高風險弱點掃描                             | PASS，0 vulnerabilities                                                                                      |
| 根目錄 7 份 SOP                                | 大小／mtime 未變更                                                                                           |

v0.28.0 可攜版 EXE SHA-256：`84B25D7D9E02B14EB3CE9B8B2C47FC73AE94180694FE3AD69855C67281F7A9BC`

檔案大小：`244441088` bytes。v0.27.0 與更早 release 未覆寫，也未強制關閉使用者目前開啟的舊版視窗。GitHub Electron checksum 端點兩次回覆 504 後，改用本機已安裝且同版本的 Electron 44.0.0 runtime 建立暫存 ZIP 完成相同封裝；`package-win.mjs` 新增可選 `ELECTRON_ZIP_DIR`，平常仍維持原下載流程。

為避免未經確認改寫使用者目前專案，本輪沒有批次寫入 17 段正式字幕；已用同一 App adapter 對既有低解析故事板執行一次真實 Codex 結構化模型請求，並另以來源副本整合測試驗證草稿保存與 cache。

## v0.27.0 增量驗證（2026-09-06）

| 檢查                                                     | 結果                                                  |
| -------------------------------------------------------- | ----------------------------------------------------- |
| Intro 影片拉桿可保存超過每段輸出上限的來源範圍           | PASS；ProjectStore 保留完整 IN／OUT，重開仍一致       |
| 少於 3 秒、超出來源及超過 50 段仍安全阻擋                | PASS                                                  |
| 超時卡片／拉桿顯示橘紅警示，輸出按鈕不因 soft cap 停用   | PASS；Renderer UI                                     |
| 產出前再次確認且安全預設焦點為「返回調整」               | PASS；Renderer UI                                     |
| 確認後保持 IN、OUT 截為 `IN + introSegmentMaxDurationMs` | PASS；12 秒範例 UI 與 3 秒 FFmpeg service integration |
| Intro 單獨輸出、Main 前置 Intro 使用同一 canonical cap   | PASS；Renderer 與 Main service 雙層驗證               |
| 480P 字幕片頭預覽套用 cap，cache key 包含目前每段上限    | PASS；實作檢查與完整回歸                              |
| Manifest schema 13、舊專案與既有 proxy/cache             | 相容；schema 與 previewer version 不變                |
| TypeScript renderer/main typecheck                       | PASS                                                  |
| Vitest 完整單元、整合與 UI 回歸                          | PASS，29 files／202 tests                             |
| Production build                                         | PASS                                                  |
| Electron hidden-window startup smoke                     | PASS                                                  |
| Windows v0.27.0 packaged `.exe` startup smoke            | PASS                                                  |
| npm 高風險弱點掃描                                       | PASS，0 vulnerabilities                               |
| 根目錄 SOP 與來源媒體                                    | 未修改                                                |

v0.27.0 可攜版 EXE SHA-256：`2F9164184D0F9A0DEBD6A639C29BB753374B540466A9BA881AA74D6B6EDE2E79`

檔案大小：`244441088` bytes。v0.26.0 與更早 release 未覆寫；未強制關閉使用者目前開啟的舊版視窗。

## v0.26.0 增量驗證（2026-09-06）

| 檢查                                                                         | 結果                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 網格「編碼」標籤與值左右排列                                                 | PASS；`dt` 固定不縮排／不換行，兩欄比例改為 1.12／0.88                             |
| codec 值較長時保持單行並省略，不擠壓標籤                                     | PASS；Production CSS build                                                         |
| `preview-v3` 版本變更即使來源 size／mtime 不變仍局部換 cache key             | PASS；SourceService 單元測試，既有 metadata 保留                                   |
| 太短／毀損 MP4 不作 cache hit                                                | PASS；損壞 cache 自動重新建立並通過 ffprobe                                        |
| 新影片 proxy 寫 marker 前驗證 H.264、尺寸與正時長                            | PASS；PreviewCache integration                                                     |
| cache hit 再驗證可播放性                                                     | PASS；PreviewCache integration                                                     |
| 合成 10-bit HEVC `.MOV`（中文／空格路徑、rotation metadata）轉 H.264/AAC MP4 | PASS；直式顯示比例正確，來源 SHA-256 不變                                          |
| 使用者 `IMG_1728.MOV` 既有完整代理                                           | PASS；H.264/AAC、852×480、35.561 秒                                                |
| 使用者 `IMG_1741.MOV` targeted probe                                         | PASS；4K60、10-bit HEVC Main10、HLG/BT.2020、Dolby Vision profile 8、rotation −90° |
| 同支 `IMG_1741.MOV` 完整代理                                                 | PASS；H.264/AAC、270×480、29.97 fps、36.2867 秒、9,454,517 bytes，49.19 秒完成     |
| Apple HEVC MOV 軟體優先效能比較                                              | PASS；同支 5 秒區段軟體 8.38 秒、通用 hardware-auto 14.60 秒                       |
| `IMG_1741.MOV` 完整驗證前後來源 SHA-256                                      | PASS；`1D68B2BD1E35DE66DBDC251D118224C1893ECE59B389872E0BB9F3FE68D9A830`           |
| TypeScript renderer/main typecheck                                           | PASS                                                                               |
| Vitest 完整單元、整合與 UI 回歸                                              | PASS，29 files／199 tests                                                          |
| Production build                                                             | PASS                                                                               |
| Electron hidden-window startup smoke                                         | PASS；驗證腳本亦修正成功後仍等待 30 秒的非必要 timeout                             |
| Windows v0.26.0 packaged `.exe` startup smoke                                | PASS                                                                               |
| npm 高風險弱點掃描                                                           | PASS，0 vulnerabilities                                                            |
| 診斷 MP4 暫存檔                                                              | 已清除；未留下測試影片                                                             |
| 根目錄 SOP 與來源媒體                                                        | 未修改                                                                             |

v0.26.0 可攜版 EXE SHA-256：`AF3EB1F8B9C3A4D862A2F62A488702CDD8C77BA34CD0B49CF7B428CCDD579C1A`

檔案大小：`244441088` bytes。v0.25.0 與更早 release 未覆寫；未強制關閉使用者目前開啟的舊版視窗。

## v0.25.0 增量驗證（2026-09-06）

| 檢查                                            | 結果                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 字幕片頭／正片複選範圍與至少選一項 gate         | PASS；Renderer UI、偏好持久化與輸入驗證                                                    |
| 舊字幕預設歸入正片；片頭／正片使用獨立時間基準  | PASS；manifest migration、ProjectStore 回歸                                                |
| AI 只分析勾選範圍並保留另一範圍草稿／已確認字幕 | PASS；AI story integration                                                                 |
| 片頭照片可建立畫面／地點／故事知識型字幕候選    | PASS；候選建立與視覺分析路徑                                                               |
| AI 完成後自動建立 480P 片頭字幕代理             | PASS；Renderer 與 Main service 整合                                                        |
| 代理進度、取消、App cache 命中／失效及來源唯讀  | PASS；cache service 測試，代理不列入輸出歷史                                               |
| 片頭代理播放／拖曳與字幕依時間動態同步          | PASS；Renderer UI 回歸                                                                     |
| 逐筆文字修改即時更新預覽                        | PASS；Renderer UI 回歸                                                                     |
| 字幕位置、字級、色彩、陰影、外框調整與重開沿用  | PASS；Renderer UI、偏好 sanitize／持久化                                                   |
| 片頭／正片字幕正式燒錄映射到各自輸出時間線      | PASS；subtitle burn-in filter 測試                                                         |
| 離線 BGM 不阻擋字幕審核代理                     | PASS；專用 render request 明確排除 BGM                                                     |
| Manifest schema 13、舊專案與既有 cache          | 相容；新增欄位皆具預設／migration，未改寫來源                                              |
| TypeScript renderer/main typecheck              | PASS                                                                                       |
| Vitest 完整單元、整合與 UI 回歸                 | PASS，29 files／196 tests                                                                  |
| Production build                                | PASS                                                                                       |
| Electron hidden-window startup smoke            | PASS；輸出 `SMOKE_READY`，測試程序因電腦已有舊版多程序執行而由驗證端停止，不關閉使用者視窗 |
| Windows v0.25.0 packaged `.exe` startup smoke   | PASS                                                                                       |
| npm 高風險弱點掃描                              | PASS，0 vulnerabilities                                                                    |
| 根目錄 7 份 SOP 與來源媒體                      | 未修改                                                                                     |

v0.25.0 可攜版 EXE SHA-256：`4F003EF25501DFD649F57AA33B3AE44D56C02E92D05D0E2CA6E5F31691E7A1BC`

檔案大小：`244441088` bytes。v0.24.0 release 未覆寫，且未關閉使用者正在執行的舊版視窗。

## v0.24.0 增量驗證（2026-09-06）

| 檢查                                                    | 結果                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| 已儲存的片段／音量／安插設定在網格顯示不同狀態色        | PASS；片段琥珀、音量青色、安插綠色，並保留文字狀態與無障礙名稱 |
| 未設定按鈕維持原樣，狀態由 manifest 內容推導            | PASS；Renderer UI 回歸                                         |
| 從網格新增 Intro 時，自動以新增片段實際長度增加片頭目標 | PASS；不再套用 180 秒上限                                      |
| 片頭總長超過 3 分鐘仍可儲存／輸出                       | PASS；ProjectStore、分析與 render gate 已移除 hard cap         |
| 超過 3 分鐘改為紅色時間與警示，不阻擋操作               | PASS；Intro Studio UI 測試                                     |
| 片頭每段 3–22 秒、最多 50 段等既有安全規則              | PASS；完整 domain／ProjectStore 回歸                           |
| Manifest schema 13、舊專案與 cache                      | 相容；本版不變更 schema                                        |
| TypeScript renderer/main typecheck                      | PASS                                                           |
| Vitest 完整單元、整合與 UI 回歸                         | PASS，28 files／190 tests                                      |
| Production build                                        | PASS                                                           |
| Electron hidden-window startup smoke                    | PASS                                                           |
| Windows v0.24.0 packaged `.exe` startup smoke           | PASS                                                           |
| npm 高風險弱點掃描                                      | PASS，0 vulnerabilities                                        |
| 根目錄 7 份 SOP 與來源媒體                              | 未修改                                                         |

v0.24.0 可攜版 EXE SHA-256：`404FEC5DBF34A28E02B51F42FCE0A47027A4F8E14916D3B38009EA26DA46CA88`

## v0.23.0 增量驗證（2026-09-06）

| 檢查                                                | 結果                                        |
| --------------------------------------------------- | ------------------------------------------- |
| 網格片段加入 Intro 前自動增加目前目標秒數           | PASS；3 秒目標＋3 秒片段先更新為 6 秒再保存 |
| 片頭增加目標後不受舊目標誤擋，180 秒 hard gate 保留 | PASS；Renderer／ProjectStore 回歸           |
| 加入成功顯示 canonical 順位與新時間上限             | PASS；Renderer UI 測試                      |
| 同英文前綴／日期的相鄰檔名優先保留尾端時間／流水號  | PASS；獨立演算法與卡片整合測試              |
| 英文前綴、年份或日期不一致時優先保留檔名前端        | PASS；前後相鄰與首末邊界測試                |
| 網格標題＋兩行時間／大小、規格／編碼緊湊排版        | PASS；Production CSS build                  |
| 完整檔名、排序、asset ID 與來源檔不變               | PASS；UI／domain 回歸                       |
| TypeScript renderer/main typecheck                  | PASS                                        |
| Vitest 完整單元、整合與 UI 回歸                     | PASS，28 files／188 tests                   |
| Production build                                    | PASS                                        |
| Electron hidden-window startup smoke                | PASS                                        |
| Windows v0.23.0 packaged `.exe` startup smoke       | PASS                                        |
| npm 高風險弱點掃描                                  | PASS，0 vulnerabilities                     |
| 根目錄 7 份 SOP 與來源媒體                          | 未修改                                      |

v0.23.0 可攜版 EXE SHA-256：`E7F9F7ABB49EECC1E3928C68D37FCE8975B1EDBA6A0CC335512C13CDA530310D`

## v0.22.0 增量驗證（2026-09-06）

| 檢查                                                             | 結果                                     |
| ---------------------------------------------------------------- | ---------------------------------------- |
| 網格隱藏重複來源路徑／逐卡唯讀文字，保留全域唯讀狀態             | PASS；Renderer UI 回歸                   |
| 網格 metadata 與工具列高度壓縮                                   | PASS；Production CSS build               |
| 75%–150% UI 縮放、設定按鈕、Ctrl 滾輪／鍵盤與重開恢復            | PASS；local storage UI 測試              |
| 片段／排除／安插／音量分與秒雙欄，Enter 起點分 → 起點秒 → 終點分 | PASS；Renderer UI 測試                   |
| 固定時段併入局部放大、0% 無放大預設、舊 scale 內部相容           | PASS；domain／Renderer 回歸              |
| 新時段預設加入片頭、顯示 canonical 順位並可跳到片頭確認          | PASS；Renderer／ProjectStore 整合測試    |
| Intro 最多 50 段、總長 180 秒、每段 3–22 秒 gate                 | PASS；ProjectStore／Renderer 回歸        |
| Intro 預設整體依序循環、最後接第一、可切單段循環、暫停停止推進   | PASS；雙素材 UI 播放測試                 |
| Manifest schema 13 與舊 cache／專案相容                          | PASS；未升級 schema，完整 migration 回歸 |
| TypeScript renderer/main typecheck                               | PASS                                     |
| Vitest 完整單元、整合與 UI 回歸                                  | PASS，27 files／184 tests                |
| Production build                                                 | PASS                                     |
| Electron hidden-window startup smoke                             | PASS                                     |
| Windows v0.22.0 packaged `.exe` startup smoke                    | PASS                                     |
| npm 高風險弱點掃描                                               | PASS，0 vulnerabilities                  |
| 根目錄 7 份 SOP 與來源媒體                                       | 未修改                                   |

v0.22.0 可攜版 EXE SHA-256：`077E4C71AA9AA232DE8FEB63A104A9C0958D5BCD13C887E9BDA7EA5B1A66AEE3`

## v0.21.0 增量驗證（2026-09-05）

| 檢查                                                                   | 結果                                    |
| ---------------------------------------------------------------------- | --------------------------------------- |
| 網格卡片片段／音量／安插短標籤與箭頭圖示單列                           | PASS；完整 `aria-label`／`title` 保留   |
| 局部放大四組銳利化／消噪預設及 `BALANCED` 建議預設                     | PASS                                    |
| FFmpeg 只在指定來源時段套用 hqdn3d／unsharp                            | PASS；filter graph 與真實 4K 輸出       |
| 放大設定保存、IN／OUT 裁切、schema 12 → 13 與重開恢復                  | PASS                                    |
| 勾選後指定順位加入片頭，3–22 秒／總長／30 段 gate                      | PASS                                    |
| 勾選後開啟該來源時段 4K MP4 確認頁，未按 OK 不寫檔                     | PASS                                    |
| 片頭預設使用 `source-media` 唯讀原檔並於 IN／OUT 循環                  | PASS；UI／range reset 測試              |
| 原檔 codec 失敗後才由使用者切換短代理；無靜默等待                      | PASS                                    |
| 原檔協定只接受 64 位 asset ID、由 manifest 解路徑、byte-range 唯讀串流 | PASS；Main process gate／Electron smoke |
| 原始 16:9／9:16 比例、播放器操作列不遮畫面                             | PASS；既有 display dimensions 回歸      |
| 關閉視窗二次確認、短提示音與安全預設焦點                               | PASS；Renderer UI；自動 smoke bypass    |
| TypeScript renderer/main typecheck                                     | PASS                                    |
| Vitest 完整單元、整合與 UI 回歸                                        | PASS，27 files／182 tests               |
| Production build                                                       | PASS                                    |
| Electron hidden-window startup smoke                                   | PASS                                    |
| Windows v0.21.0 packaged `.exe` startup smoke                          | PASS                                    |
| npm 高風險弱點掃描                                                     | PASS，0 vulnerabilities                 |
| 代表 4K 區段輸出前後來源 SHA-256                                       | PASS；來源不變                          |
| 根目錄 7 份 SOP                                                        | 未修改                                  |

v0.21.0 可攜版 EXE SHA-256：`1DAEADD217430AA11648AF658C86A8A931194E69CA1D1C5F2406E010840437F1`

封裝內容 `resources/app.asar` SHA-256：`E709FAF3ADA838630D5D991239713215A084D86CF0394A28324C86B4BFCA492B`。

檔案大小：`244441088` bytes。既有 v0.20.0 可攜版未覆寫，且封裝／smoke 完成後沒有留下 v0.21.0 背景程序。

## v0.20.0 增量驗證（2026-09-05）

| 檢查                                                                 | 結果                                      |
| -------------------------------------------------------------------- | ----------------------------------------- |
| 正片排除與片頭預覽獨立比例框、16:9／9:16 `contain`、控制列在畫面外   | PASS                                      |
| 片頭只轉選定 3–22 秒區段代理，不先轉完整來源                         | PASS；`VIDEO_CLIP_PROXY`                  |
| 區段代理 cache key 綁定來源 fingerprint、IN／OUT、大小／mtime 與版本 | PASS；建立／命中／來源 SHA-256 測試       |
| 自動硬體解碼、軟體含音訊、軟體無聲三級 fallback                      | PASS                                      |
| 局部放大 100%–400%、中心 X／Y 0%–100%、重疊與越界 gate               | PASS                                      |
| IN／OUT 縮短後局部放大安全裁切、timeline revision 與重開保存         | PASS                                      |
| 正片／片頭畫面預覽與 FFmpeg 輸出共用來源時間局部放大                 | PASS                                      |
| 固定時間段加入目前片頭，遵守 3–22 秒／總長／30 段 gate               | PASS                                      |
| 固定時間段從原始來源輸出實際 3840×2160 H.264/AAC MP4                 | PASS；真實 FFmpeg、來源 SHA-256 不變      |
| 4K 時間段不混入 BGM、字幕或片頭；唯一 partial 與取消規則沿用         | PASS                                      |
| schema 1–11 → 12 migration                                           | PASS；舊編輯資料保留，補空 `zoomSegments` |
| TypeScript renderer/main typecheck                                   | PASS                                      |
| Vitest 完整單元、整合與 UI 回歸                                      | PASS，27 files／179 tests                 |
| Production build                                                     | PASS                                      |
| Electron hidden-window startup smoke                                 | PASS                                      |
| Windows v0.20.0 packaged `.exe` startup smoke                        | PASS                                      |
| npm 高風險弱點掃描                                                   | PASS，0 vulnerabilities                   |
| 根目錄 7 份 SOP 大小／修改時間                                       | 未變更                                    |

v0.20.0 可攜版 EXE SHA-256：`2AA13D3DEB855CE4CA8B1DB01EE75B32F2B1BA7909FD1CEBFB5CCBAEF092E0F3`

檔案大小：`244441088` bytes。既有 v0.19.0 EXE SHA-256 仍為 `3642B43BEDFEAA03263C83F30EE50D7B82499CD0E9F246C0DFCBD91BF2A5168B`，未被覆寫。

## v0.19.0 增量驗證（2026-09-05）

| 檢查                                                          | 結果                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 片頭每段上限 3–22 秒、新專案 15 秒                            | PASS                                                                                       |
| 套用上限後依總片頭長度及來源容量盡量均分                      | PASS                                                                                       |
| 改為 12 秒、保存、重新載入專案後仍為 12 秒                    | PASS                                                                                       |
| schema 10 → 11 migration 保留既有 3–22 秒片段                 | PASS                                                                                       |
| AI 片頭文字指示與指定單一基底影片                             | PASS                                                                                       |
| 片頭 4K 選項實際規格 3840×2160                                | PASS；低解析來源為等比放大                                                                 |
| UTF-8／BOM SRT 匯入、逗號／小數點毫秒、多行與 Unicode         | PASS                                                                                       |
| SRT 畸形、空白、倒置時間與重疊安全阻擋                        | PASS                                                                                       |
| 匯入 cue 可逐項修改時間與文字，來源 SRT byte-for-byte 不變    | PASS                                                                                       |
| 正片／片頭頁各自顯示歷史輸出並透過安全外部播放器路由開啟      | PASS                                                                                       |
| preview-v2 rotation-aware 比例、SAR 1:1、30 fps 與 cache 失效 | PASS                                                                                       |
| 使用者回報片頭第三段來源代表測試                              | PASS；來源 4K/60 HEVC，於 294.761 秒起實際產生 10.010 秒、854×480 H.264/AAC proxy          |
| 第三段來源 SHA-256                                            | `1AF60BA2B5CD3386F22433CE96EDF3424288012354A5E892614F066ACF2ED950`；只讀測試前後來源未改寫 |
| 第三段舊失敗原因                                              | 舊 cache 僅有中斷的 `.partial.mp4`，沒有完成 `video-preview.mp4`；來源本身可解碼           |
| TypeScript renderer/main typecheck                            | PASS                                                                                       |
| Vitest 完整單元、整合與 UI 回歸                               | PASS，27 files／173 tests                                                                  |

| Production build | PASS |
| Electron hidden-window startup smoke | PASS |
| Windows v0.19.0 packaged `.exe` startup smoke | PASS |
| npm 高風險弱點掃描 | PASS，0 vulnerabilities |
| 根目錄 7 份 SOP 大小／修改時間 | 未變更 |

v0.19.0 可攜版 EXE SHA-256：`3642B43BEDFEAA03263C83F30EE50D7B82499CD0E9F246C0DFCBD91BF2A5168B`

檔案大小：`244441088` bytes。既有 v0.18.0 EXE SHA-256 仍為 `5C012FDF1DA9646B49C7925E1B17A614A3DA5D83D064EB9A732D63DEA148332B`，未被覆寫。

日期：2026-09-05  
範圍：v0.18.0；完整回歸 v0.17.0 全部功能；新增知識型字幕預設、可選語音轉錄、片頭時間／排序／手動素材、固定色彩預設及全部預覽等比例顯示。

## 結果

| 檢查                                                                            | 結果                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript renderer/main typecheck                                              | PASS                                                                                                                                              |
| Vitest 單元、整合與 UI 測試                                                     | PASS，26 files／159 tests                                                                                                                         |
| AI 字幕預設畫面／主題／地點知識，不抽取或轉錄素材原音                           | PASS；勾選後才執行語音支線                                                                                                                        |
| 片頭分析前設定 0:03–3:00、重跑、3–22 秒影片／3–7 秒照片                         | PASS                                                                                                                                              |
| 片頭往前／往後、專案素材與其他資料夾影片／照片手動加入                          | PASS                                                                                                                                              |
| 人物／事件／故事／地點優先的 OpenAI 片頭排序                                    | PASS；語意 55%、本機畫面訊號 20%                                                                                                                  |
| 五組固定色溫／增豔、片頭預覽與 FFmpeg 輸出、同步正片                            | PASS，含真實 FFmpeg 與來源 SHA-256                                                                                                                |
| 網格／安插／放大／總體／片頭／字幕預覽不裁切且控制列不遮畫面                    | PASS，`contain` 與外置控制列                                                                                                                      |
| 繁中／英文／簡中／日文／韓文選擇、最多兩種與重複語言 gate                       | PASS                                                                                                                                              |
| 每種字幕上／中／下位置、24–96 px（1080p 基準）與長句自動換行                    | PASS，ASS 內容／UI 測試                                                                                                                           |
| 已確認 cue 與 timeline revision gate                                            | PASS；無確認字幕或時間線已變更時阻擋                                                                                                              |
| OpenAI Responses 新請求、`store:false`、自然口語且同數量同順序                  | PASS，HTTP 合約測試                                                                                                                               |
| OpenAI 失敗後 Google Cloud Basic v2 後援                                        | PASS；API Key 只放 `X-Goog-Api-Key` header                                                                                                        |
| Google Cloud API Key Windows 加密、重開恢復、清除與無明文落盤                   | PASS                                                                                                                                              |
| 翻譯 cache key 綁定內容／語言／版本、命中不重送                                 | PASS                                                                                                                                              |
| 真實 FFmpeg/libass 雙語 MP4、解析度／codec、畫面像素與來源 SHA-256              | PASS                                                                                                                                              |
| 臨時 ASS 成功／失敗後清除                                                       | PASS                                                                                                                                              |
| 網格「刪除／排除部分片段」入口恢復                                              | PASS；既有多區段編輯、來源唯讀語意保留                                                                                                            |
| 中央縮圖左鍵直接外部播放、右鍵 proxy／原檔選擇、底部重複按鈕移除                | PASS                                                                                                                                              |
| App 偏好 JSON 原子保存、無效值拒絕與重開恢復                                    | PASS                                                                                                                                              |
| 網格／清單、0.3／0.5／0.7、360p／480p／720p／4K、Intro 串接及上傳準備沿用       | PASS                                                                                                                                              |
| 素材／資料夾／專案／預覽／歷史 MP4／SRT／BGM／播放器／OAuth 最近資料夾          | PASS，Unicode／空格路徑                                                                                                                           |
| YouTube 不公開／私人沿用；兒童內容每支影片重新確認                              | PASS                                                                                                                                              |
| 故事背景麥克風錄音／停止／轉文字、繁中預設與英文切換                            | PASS，WebM MIME＋記憶體傳輸                                                                                                                       |
| 麥克風權限只允許 App 視窗的音訊、不允許攝影機；track 完成後停止                 | PASS                                                                                                                                              |
| 語音輸入 MIME／25 MB gate、無聲／權限／API 失敗可理解錯誤                       | PASS                                                                                                                                              |
| OpenAI 完整測試依序驗證 Key／project、故事模型及語音模型                        | PASS，HTTP 合約測試                                                                                                                               |
| 401／403／404／429 API 額度／429 暫時 rate limit 分類、Request ID 與 reset 資訊 | PASS                                                                                                                                              |
| 目前加密 Key live diagnostic                                                    | 已執行；Key 驗證成功，但實際模型請求回傳 `credit_balance_exhausted`；使用者最新回報 Request ID `req_bc5685c00e9f4d4ca7c16345a40f8500`；未輸出 Key |
| 上方「Aa 設定」與 16／18／20／22 px 全介面文字級距                              | PASS，預設 18 px 舒適級                                                                                                                           |
| 網格檔名、時間、規格、編碼、路徑與操作文字隨 root scale 一起調整                | PASS                                                                                                                                              |
| 文字大小即時套用、local storage 保存與 App 重開恢復                             | PASS                                                                                                                                              |
| 網格左鍵長按 gate、任意拖曳與 01／02 即時序號更新                               | PASS                                                                                                                                              |
| 放開後以 asset ID／目標索引保存 `MANUAL_ORDER`                                  | PASS                                                                                                                                              |
| 既有上移／下移鍵盤 fallback 與排序回歸                                          | PASS                                                                                                                                              |
| OpenAI API profile 多帳號、作用中切換與重開恢復                                 | PASS                                                                                                                                              |
| API Key 與一般設定分離、Windows safeStorage adapter、無明文落盤                 | PASS                                                                                                                                              |
| 缺少金鑰、OS 加密不可用、401 與 429 可理解錯誤                                  | PASS                                                                                                                                              |
| Codex 登入不可重用的 UI 與 runtime gate                                         | PASS                                                                                                                                              |
| OpenAI transcription multipart、中文／空格檔名、說話者與時間解析                | PASS                                                                                                                                              |
| Responses API 低解析影像、`store:false`、strict JSON schema 與故事背景          | PASS                                                                                                                                              |
| AI 語音 cue 對映來源／正片時間、人物／事件／地點／主題證據                      | PASS，真實 FFmpeg 測試影片＋mock provider                                                                                                         |
| AI 分析 cache 命中、取消、人工 confirmed 保留與來源 SHA-256                     | PASS                                                                                                                                              |
| 字幕工作台同步 proxy、DRAFT／CONFIRMED／REJECTED 與只匯出 confirmed             | PASS                                                                                                                                              |
| 片頭 OpenAI 故事比對與缺少設定時本機 fallback                                   | PASS                                                                                                                                              |
| JPG／JPEG／PNG／HEIC／HEIF／MOV 等白名單與大小寫副檔名                          | PASS                                                                                                                                              |
| 照片預設 5 秒、可選 3／4／5／6／7 秒，越界拒絕                                  | PASS                                                                                                                                              |
| 照片預設快門聲、逐張關閉、無效 IPC 值拒絕與 manifest 保存                       | PASS                                                                                                                                              |
| 總體預覽在照片出現時載入 App 自有快門聲 URL                                     | PASS                                                                                                                                              |
| 影片網格開啟照片／影片安插設定、指定主片來源時間與即時摘要                      | PASS                                                                                                                                              |
| 插入影片獨立 IN／OUT 雙把手、縮短／放寬來源範圍與 UI 預覽                       | PASS                                                                                                                                              |
| 同一安插時間接續多張照片／影片、接前／接後與重開保存                            | PASS                                                                                                                                              |
| 安插點限制在保留範圍且距邊緣 0.75 秒；排除區／過近／重複素材拒絕                | PASS                                                                                                                                              |
| 安插後素材不再獨立重複播放；依虛擬原順位恢復且不受取消順序影響                  | PASS                                                                                                                                              |
| 變更 IN／OUT 或 Main exclusion 若使安插失效則阻擋，不靜默移動                   | PASS                                                                                                                                              |
| 真實主片依安插點展開前段／照片或裁短影片／後段並成功輸出 H.264／AAC             | PASS                                                                                                                                              |
| 安插前後主片、插入影片與照片來源 SHA-256 完全相同                               | PASS                                                                                                                                              |
| 沙丘快門聲原檔／封裝副本 SHA-256                                                | PASS，皆為 `0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93`                                                                     |
| 沙丘快門聲原檔／封裝副本 ffprobe                                                | PASS，MP3 stereo、24 kHz、1.632 秒、160 kbps                                                                                                      |
| 照片時長保存、重開、timeline revision 與字幕複核                                | PASS                                                                                                                                              |
| 總體預覽按每張照片設定時長輪播                                                  | PASS                                                                                                                                              |
| 橫式／直式照片放大以 display dimensions 等比例 contain，不裁切／拉伸            | PASS                                                                                                                                              |
| 真實照片＋影片串連 MP4 依照片設定時長輸出                                       | PASS                                                                                                                                              |
| 照片串連前後來源 SHA-256 相同                                                   | PASS                                                                                                                                              |
| 左上角檔案選單：儲存、另存命名與開啟舊專案                                      | PASS                                                                                                                                              |
| `.swproj` 完整 project manifest round-trip 與持續保存                           | PASS                                                                                                                                              |
| 專案檔唯一 partial／可恢復替換；成功後無 partial 殘留                           | PASS                                                                                                                                              |
| 損壞／未知 schema 專案不取代目前專案、不覆寫原檔                                | PASS                                                                                                                                              |
| 圖片縮圖與放大 preview                                                          | PASS                                                                                                                                              |
| 影片縮圖、H.264 低解析 proxy 與播放器                                           | PASS                                                                                                                                              |
| Cache hit 與來源 size/mtime 變更失效                                            | PASS                                                                                                                                              |
| 來源內容在 probe/preview 前後 SHA-256 相同                                      | PASS                                                                                                                                              |
| Manifest 保存、重開恢復                                                         | PASS                                                                                                                                              |
| 正片移除只刪除使用引用；來源／proxy／metadata 與設定保留                        | PASS                                                                                                                                              |
| 安全確認預設焦點在取消；Toast／最近移除一鍵原位恢復                             | PASS                                                                                                                                              |
| 正片與 Intro 引用獨立；同來源 Intro 單段移除不影響其他 segment／正片            | PASS                                                                                                                                              |
| AI 重新分析不會自動復活手動排除 segment；主動恢復後重回原索引                   | PASS                                                                                                                                              |
| 移除狀態與恢復紀錄重開 manifest 後仍存在                                        | PASS                                                                                                                                              |
| 疊化選項只有 0.3／0.5／0.7 秒；解析度為 360p／480p／720p／4K                    | PASS                                                                                                                                              |
| 兩支合成測試影片串連為 640×360 H.264／AAC MP4                                   | PASS                                                                                                                                              |
| 0.3 秒疊化後輸出片長符合 `總片長 − 疊化總長`                                    | PASS                                                                                                                                              |
| 有聲＋無聲影片可完成影像疊化、音訊淡化／補靜音                                  | PASS                                                                                                                                              |
| 串連前後兩支來源 SHA-256 完全相同                                               | PASS                                                                                                                                              |
| 取消產出先讓 FFmpeg 寫完 MPEG-4 結尾；有效短 MP4 保留，過早取消清理無效 partial | PASS，真實 FFmpeg graceful cancel＋ffprobe                                                                                                        |
| 網格內 VIDEO_PROXY 播放／暫停與雙把手 IN／OUT                                   | PASS                                                                                                                                              |
| IN／OUT 保存、重開恢復且來源內容不變                                            | PASS                                                                                                                                              |
| 720p filter 與實際 1280×720 裁切串連輸出                                        | PASS                                                                                                                                              |
| 4K filter 與實際 3840×2160 H.264 MP4                                            | PASS                                                                                                                                              |
| 本機片頭短區段抽樣、建議排名與版本化 cache hit                                  | PASS                                                                                                                                              |
| 同一來源兩個不同 IN／OUT 組成 Intro 預覽                                        | PASS                                                                                                                                              |
| 副檔名大小寫正規化、全域與覆寫優先序                                            | PASS                                                                                                                                              |
| `.mp4`／`.mov` 路由、自訂副檔名與設定重開恢復                                   | PASS                                                                                                                                              |
| VLC／Windows Media Player／MPC-HC 本機動態偵測                                  | PASS，三者皆找到可用安裝路徑                                                                                                                      |
| 自訂 `.exe` 中文／空格路徑驗證與持久化                                          | PASS                                                                                                                                              |
| 外部開啟 proxy／original 分流與安全參數陣列                                     | PASS                                                                                                                                              |
| 指定播放器遺失／啟動失敗的系統預設與 App 內 fallback                            | PASS                                                                                                                                              |
| 外部開啟代理或原檔前後來源 SHA-256 相同                                         | PASS                                                                                                                                              |
| 網格外部播放左鍵直接依路由開啟唯讀意圖原檔，不先顯示選項                        | PASS                                                                                                                                              |
| 網格影片縮圖左鍵直接依副檔名路由外部播放，不開 App 放大視窗                     | PASS                                                                                                                                              |
| 縮圖行為調整後照片 App 內放大、網格 proxy、IN／OUT、音量與安插控制              | PASS，維持原行為                                                                                                                                  |
| 網格外部播放右鍵／鍵盤選單動作開啟原有 proxy／原檔選項                          | PASS                                                                                                                                              |
| 放大影片依 display dimensions 維持橫式／直式比例                                | PASS                                                                                                                                              |
| 放大影片自訂播放／seek 控制列位於影像外，不遮住內容                             | PASS                                                                                                                                              |
| AI Intro 素材預覽依 display dimensions／rotation 維持 16:9、9:16 等來源比例     | PASS，`aspect-ratio`＋`contain`，不裁切或拉伸                                                                                                     |
| 安插視窗依既有來源資料夾切換與素材數量顯示                                      | PASS                                                                                                                                              |
| 安插視窗原生加入其他資料夾、取消讀取與去重／錯誤提示                            | PASS                                                                                                                                              |
| 新資料夾素材確認前留在 pending；確認後才安插，取消安插恢復原 pending 位置       | PASS，重開 manifest 後語意不變                                                                                                                    |
| 待決定影片只在選取時 lazy probe 基本 metadata，不深掃整個資料夾                 | PASS                                                                                                                                              |
| 待決定來源安插／取消前後來源 SHA-256                                            | PASS，完全相同                                                                                                                                    |
| schema 1–9 manifest → schema 10 migration                                       | PASS，來源與既有欄位保留；新增片頭目標與色彩設定安全預設                                                                                          |
| 未知 schema／不相容 manifest                                                    | PASS，停止載入且原 manifest byte-for-byte 不覆寫                                                                                                  |
| 片段音量 0／80／100／200%、多區段、無效值、越界與重疊                           | PASS                                                                                                                                              |
| 安插與音量 UI 的 `M:SS`／`M:SS.xx`／`H:MM:SS.xx` 解析及錯誤提示                 | PASS，Renderer 傳 Main process 整數毫秒                                                                                                           |
| IN／OUT 縮短後超界音量區段裁切／移除及 UI 提示                                  | PASS                                                                                                                                              |
| 真實 MP4 未覆蓋區段採專案原音 80%、0% 靜音與 200% 增益 dB 量測                  | PASS                                                                                                                                              |
| 補充素材逐筆待決定、前／後錨點、上移下移與重開恢復                              | PASS                                                                                                                                              |
| Pending 素材不能透過 IPC 混入串連輸出                                           | PASS                                                                                                                                              |
| 90° display rotation 的手機素材方向判斷                                         | PASS，coded 854×480 → display 480×854                                                                                                             |
| 直式中央等比＋同源放大模糊左右背景                                              | PASS，實際輸出 640×360 且 filter 使用 split/blur/overlay                                                                                          |
| MP3 0／35／100／200%、source/timeline、淡入淡出驗證                             | PASS                                                                                                                                              |
| 真實 MP3 混音、0.95 limiter 與音樂 SHA-256 不變                                 | PASS                                                                                                                                              |
| 離線 BGM 阻擋輸出並指出曲名                                                     | PASS                                                                                                                                              |
| 字幕 cue CRUD、排序、重疊／空白／總時間驗證                                     | PASS                                                                                                                                              |
| Timeline revision 改變後字幕複核 gate                                           | PASS                                                                                                                                              |
| 放大預覽精確播放頭、毫秒時間、播放／暫停、目前位置設 IN／OUT                    | PASS                                                                                                                                              |
| Main exclusion 單段／多段、排序、重疊／相鄰自動合併、越界拒絕                   | PASS                                                                                                                                              |
| Main exclusion 單段刪除、一鍵清除、IN／OUT 縮短裁切／移除與重開恢復             | PASS                                                                                                                                              |
| 全部有效範圍排除時保留來源卡、正片輸出安全 gate、Intro 不受影響                 | PASS                                                                                                                                              |
| 中段排除真實輸出片長與保留片段順序                                              | PASS，無黑畫面／靜音占位                                                                                                                          |
| 排除後音量 0／80／100／200% 來源時間映射                                        | PASS，真實輸出 dB 量測                                                                                                                            |
| 排除後 xfade、BGM 時間／limiter、rotation-aware 同源 blur                       | PASS，真實媒體整合輸出                                                                                                                            |
| 正片排除前後來源 SHA-256                                                        | PASS，完全相同                                                                                                                                    |
| UTF-8 SRT 連續序號與 `HH:MM:SS,mmm`                                             | PASS                                                                                                                                              |
| SRT 取消／覆寫後無 partial 或 replaced 殘留                                     | PASS                                                                                                                                              |
| App 上方版本、畫面 Undo／Redo、Ctrl+Z／Ctrl+Y／Ctrl+Shift+Z                     | PASS                                                                                                                                              |
| 50 步 session history、開啟／另存重設、復原前後來源 SHA-256                     | PASS                                                                                                                                              |
| Intro 每段 3–22 秒、最多 30 段、總長最多 180 秒                                 | PASS，ProjectStore／Analyzer／Renderer 三層 gate                                                                                                  |
| 素材原音預設 80%、BGM 預設 35%、全域 0–200%                                     | PASS，UI／migration／真實 dB 量測                                                                                                                 |
| 多 MP3 依序排列並同時套用於 Main／Intro                                         | PASS                                                                                                                                              |
| 多 YouTube URL 只建立 pending 參考；權利確認＋本機 MP3 後才可輸出               | PASS，不執行任意網路下載                                                                                                                          |
| 未解析 YouTube 參考與離線 BGM 阻擋輸出                                          | PASS                                                                                                                                              |
| 完成／取消保留的 MP4 依 `.mp4` 外部播放器路由播放                               | PASS，安全參數陣列；測試不殘留播放器程序                                                                                                          |
| YouTube client secret／refresh token OS 加密、設定重開恢復                      | PASS，持久化檔無明文                                                                                                                              |
| 平台設定顯示 YouTube 授權狀態、頻道名稱與頻道 ID                                | PASS                                                                                                                                              |
| UI 不提供平台密碼欄位；密碼只在 Google／BiliBili／TikTok 官方頁輸入             | PASS，無 `password` input；OAuth／固定官方 URL                                                                                                    |
| OAuth Desktop PKCE loopback、Chrome→Edge→系統預設 fallback                      | PASS，啟動器／HTTP 合約測試                                                                                                                       |
| 登入頻道精確名稱 gate、預設不公開、只允許私人／不公開                           | PASS                                                                                                                                              |
| Resumable upload metadata／chunk、取消、進度與輸出 SHA-256 不變                 | PASS，mock YouTube API；未執行真實頻道上傳                                                                                                        |
| BiliBili／TikTok 官方投稿頁交接、Unicode／空格 MP4 路徑                         | PASS，固定官方 URL、複製路徑與 Explorer 選取                                                                                                      |
| BiliBili／TikTok 非 MP4／不存在／空檔／未知平台安全阻擋                         | PASS，未開啟外部頁面                                                                                                                              |
| BiliBili／TikTok 交接前後完成 MP4 SHA-256                                       | PASS，完全相同；未執行真實平台發布                                                                                                                |
| 預覽成品索引自動登記完整／取消後有效 MP4，App 重開恢復                          | PASS，持久 JSON 索引                                                                                                                              |
| 升級前既有 MP4 透過原生多選視窗加入、重複去除、ffprobe gate                     | PASS，Unicode／空格路徑                                                                                                                           |
| 成品移除只刪索引；磁碟 MP4 存在且 SHA-256 不變                                  | PASS                                                                                                                                              |
| 檔案移動／離線仍保留歷史項目並安全停用操作                                      | PASS                                                                                                                                              |
| Intro＋Main 預設串接、可取消及 Main process 精確片段 gate                       | PASS，Intro 在前、Main 在後；結果記錄片頭段數                                                                                                     |
| 60 秒上傳準備預設勾選、倒數中取消與輸出前取消勾選                               | PASS，均不啟動上傳且 MP4 保留                                                                                                                     |
| 取消後較短 MP4 不自動啟動上傳倒數                                               | PASS，僅完整正片會啟動                                                                                                                            |
| Production build                                                                | PASS                                                                                                                                              |
| Electron hidden-window startup smoke                                            | PASS                                                                                                                                              |
| Windows x64 packaged `.exe` startup smoke                                       | PASS                                                                                                                                              |
| npm 高風險弱點掃描                                                              | PASS，0 vulnerabilities                                                                                                                           |
| 根目錄 7 份 SOP 大小／修改時間                                                  | 未變更                                                                                                                                            |

v0.18.0 可攜版 EXE SHA-256：`5C012FDF1DA9646B49C7925E1B17A614A3DA5D83D064EB9A732D63DEA148332B`

檔案大小：`244441088` bytes。既有 v0.17.0 EXE SHA-256 仍為 `ABAC2FF03D6150FDC3EE0624823389379B940144D22767D3086666D1591F9C81`，未被覆寫。

v0.16.0 既有 EXE 仍為：`BB1F8393905C93EB2B660B2AEC40F55FC06926B8DF32282E8C3A571194153336`，未覆寫。

## 啟動

一般使用者可直接啟動：

```text
release\v0.18.0\SceneryWalkerSourceOrganizer-win32-x64\SceneryWalkerSourceOrganizer.exe
```

開發環境也可雙擊 `啟動素材整理App.cmd`，或在本目錄執行：

可雙擊 `啟動素材整理App.cmd`，或在本目錄執行：

```powershell
npm start
```

## 已知限制

- 已提供 Windows x64 可攜版資料夾；尚未製作安裝程式、程式圖示與數位簽章。
- 文字大小是本機介面偏好，不寫入或跟隨 `.swproj`；「最大」在小視窗可能較擁擠，可放大視窗或改用「清楚」。
- 網格拖曳需先按住滑鼠左鍵約 0.28 秒再移動，以減少預覽與操作按鈕誤觸；表單、播放器和工具按鈕不會啟動排序。
- FFmpeg／ffprobe 目前使用本機 PATH；正式封裝前應評估固定版本隨 App 發布。
- 拍攝時間先讀 ffprobe 可取得的常見 tag；ExifTool、時區可信度與多機校時尚未進入本階段。
- 「總體預覽」仍是依序播放 cache preview 的播放清單；「產出串連預覽」才會另外建立低解析 MP4。
- 正片串連會依每張照片的 3–7 秒設定輸出；片頭字幕分析也能讀取人工加入的照片畫面。Intro 不再設 3 分鐘硬上限，超過時只警示；最多 50 段，每段 3–22 秒。
- 照片／影片安插使用主影片的來源時間，不是套用轉場後的成片時間；0.3／0.5／0.7 秒疊化會讓相鄰畫面與音效依既有 acrossfade 規則重疊。
- 安插視窗選擇其他資料夾時會遞迴列舉該資料夾內支援的媒體；可取消讀取，影片 metadata 則在選取時才延遲分析。資料量很大的資料夾仍可能需要等待初次列舉完成。
- 一個素材只能安插到一支主影片且本版不支援巢狀安插；安插後會離開獨立正片卡片，需在主影片的安插設定中取消後才回到原順位。
- 快門聲沿用草漯沙丘前案核准檔案並以 70% 增益混入，最終仍套用 0.95 peak limiter；若已驗證的音效資源遺失或雜湊不符，含照片輸出會安全阻擋。
- HEIC／HEIF 是否可建立縮圖與輸出取決於封裝時使用的 FFmpeg build 是否含相應 decoder；失敗時 App 會保留來源並顯示格式／codec 錯誤。
- 「AI 精彩片頭」先以本機視覺統計縮小候選；只有設定 OpenAI API Key 與故事背景後才進行人物／事件／地點／主題比對。AI 結果仍可能錯誤，人工確認優先。
- OpenAI API 用量、帳務與 rate limit 仍屬於 Key 所屬 project；目前保存的 Key 實測回覆 `credit_balance_exhausted`。v0.28.0 起知識型字幕可在此情況改用本機 Codex 官方執行程式管理的 ChatGPT 登入，App 不讀取或保存 Codex token；語音、翻譯與 API 本身仍是分開的能力與額度。
- 雙語翻譯的 OpenAI／Google 請求格式、優先序、後援與 cache 已以注入回應完整測試；目前沒有保存 Google Cloud Translation Key，因此未對外執行 Google live 翻譯。可在「AI 帳號／故事」設定保存後按「測試 Google 翻譯」。
- AI 字幕目前以最多 240 秒的 16 kHz 單聲道 MP3 分塊轉錄，最多建立 100 筆草稿；長片成本與時間依 API 帳號、片長及候選數而異。
- 4K 是預覽編碼選項；低解析來源放大不會增加真實畫面細節，且編碼時間與檔案大小明顯增加。
- 外部播放器是獨立視窗，不是嵌入 App；網格左鍵依使用者指定直接開啟唯讀意圖原檔，但 App 無法保證第三方播放器的實際寫入行為。右鍵選項視窗仍預選較安全的 cache proxy。
- 自動測試以注入的啟動器驗證 EXE 與媒體參數，不在測試期間真的打開 VLC／WMP／MPC-HC，以免干擾使用者或留下背景程序；本機安裝偵測與封裝 App 啟動已實測。
- Windows 系統預設播放器由目前檔案關聯決定；若關聯本身損壞，App 會提示回到內建 proxy。
- 字幕可 AI 建草稿、同步影像審核、完整編輯、匯出已確認 SRT，並在串連輸出以 FFmpeg/libass 真正燒錄一至兩種語言。翻譯仍可能有語意錯誤，繁中原稿與譯文都應人工預覽。
- 字幕頁的總時間是已排定影片裁切後、尚未扣除輸出時疊化的基準；每次順序或 IN／OUT 變更都會強制標記複核。
- BGM 可匯入 MP3；YouTube URL 僅保存為待確認來源參考，不會由 App 任意下載或轉檔，必須另指定合法取得的本機 MP3。source span 與 timeline span 必須相同，不提供音樂變速；超出影片尾端的部分隨輸出結束裁切。
- 上一步／下一步最多保存目前工作階段 50 個 manifest 狀態；重開 App、開啟另一個專案或另存新專案後會重新建立歷史，不把復原歷史寫入 `.swproj`。
- YouTube 上傳只接受持久預覽成品庫中仍存在的正片串連預覽，或由使用者透過原生視窗明確加入的既有 MP4；不接受 Renderer 傳入任意路徑或 Intro。需自行建立 Google Desktop OAuth client。尚未通過 Google 稽核的 API project 可能把上傳限制為私人，本輪只驗證 OAuth／upload 合約，沒有使用真實頻道憑證執行 live upload。
- v0.15.0 起的新輸出會自動加入預覽成品庫；升級前的檔案因儲存位置可由使用者任選，App 不會危險地掃描整顆磁碟，需在歷史頁按一次「加入以前的 MP4」。
- 60 秒倒數的動作是開啟 YouTube 最後確認頁，不是無人值守上傳；仍必須確認頻道、標題、兒童內容與不公開／私人設定。
- BiliBili／TikTok 本版是官方投稿頁交接，不是背景 API 自動發布：App 會複製完成檔路徑、在檔案總管選取 MP4 並開啟官方頁面；平台登入、標題、分區／隱私、版權與最後發布仍由使用者確認。真正 API 上傳需另取得各平台開發者應用、身分驗證與核准權限。
- 取消產出若發生得太早、FFmpeg 尚未寫出可由 ffprobe 驗證的有效媒體，App 不會留下無法播放的假 MP4；只有已具足夠有效畫面的取消結果才會安全改名保留。
- Main exclusion 可把一個來源展開成多個保留片段；若任一保留片段短於所選 xfade 所需 handles，輸出會明確阻擋並要求調整區段或轉場，不會凍結格或製造假 handles。
- 放大預覽 seek 使用 10 ms UI 步進，但實際定位精度仍受 proxy keyframe、瀏覽器解碼器與來源 frame rate 限制；不宣稱 sample/frame-accurate 專業剪輯定位。
- 多軌 Timeline、正式 Master render、HDR 與無人值守自動發布仍未啟用；YouTube 由使用者確認後走官方 API，BiliBili／TikTok 由官方頁面人工完成。

## v0.42.0 增量驗證（2026-09-09）

| 項目                   | 結果                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| 字幕永久嵌入勾選可取消 | PASS；`ConcatRenderModal` 在尚未開始輸出時允許已勾選狀態取消，只有重新啟用才需要確認字幕與時間線。 |
| TypeScript             | PASS；`npm run typecheck`                                                                          |
| Vitest                 | PASS；35 suites / 235 tests                                                                        |
| 來源保護               | PASS；本輪只修改 UI 判斷、測試期望 schema 15 與文件，未修改來源媒體。                              |

## v0.44.0 增量驗證（2026-09-09）

| 項目                    | 結果                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| OpenAI publish contract | PASS；mock 覆蓋 Responses、`store:false`、strict schema、低解析 image inputs 與 invalid candidate rejection。 |
| Codex publish contract  | PASS；mock 覆蓋 ephemeral、ignore-user-config、read-only sandbox、output schema、schema cleanup。             |
| Provider honesty        | PASS；只有真正 provider 成功才標示 OPENAI_API／CODEX_CHATGPT，否則 LOCAL_FALLBACK 並保留失敗原因。            |
| Full publish schema     | PASS；titles、description、English summary、hashtags、thumbnail candidate IDs、chapters、warnings 驗證。      |
| 完整測試                | PASS；39 suites／243 tests。                                                                                  |
