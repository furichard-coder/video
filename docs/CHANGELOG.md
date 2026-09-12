# SceneryWalker 素材整理 App 變更紀錄

本檔案是每次可交付功能變更的簡短索引。完成一個階段後，必須同步更新本檔案、`README.md` 與 `VERIFICATION.md`；只有通過建置／測試的內容才可標記為完成。

## v0.59.0 — 2026-09-12

- 無聲影片片段轉出時自動鋪上第一首配樂（沿用該配樂音量／淡入淡出，只鋪該片段的輸出區間）；網格卡片對無聲片顯示預設勾選的「無聲自動配音」，取消則該片段保持無聲；轉出結果會報告自動配音片段數。
- 網格卡片顯示每個轉出片段在串聯後的時間段（串聯後 mm:ss→mm:ss，與轉出用同一套時間軸計算＋目前疊化秒數）；顯示設定可開關、也可選擇含不含「片頭＋即將開始提示頁」總時間。
- 字幕每行字數輸入改為打字時不亂跳（存檔時才夾到 6–40）；預覽浮層多行生長方向與燒錄錨點一致，不會再往上溢出畫面。
- 配音開關不動時間軸版本，不觸發字幕重審。
- 驗證：52 個測試檔／311 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke 與 `npm audit` 全部通過。
- 交付：`release/v0.59.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.59.0.exe`；SHA-256 `21DFF2529E1E75C8F606695A970C60ECBE026DBE1EF98C5C38A16096EF48B8EF`。

## v0.58.0 — 2026-09-12

- 字幕顯示格式新增「每行字數」6–40 手動覆寫，留空維持原本依寬度自動換行；隨顯示預設保存並直通 ASS 燒錄。
- 字幕頁預覽浮層改用與燒錄完全相同的共用換行邏輯，看到的斷行即成品斷行（480P 預覽與 4K 輸出換行一致）。
- Master bus 改為透明峰值保護（acompressor -6dB/ratio4 → -1dB/ratio2），不再磨平整體動態，保留逐段 ducking 的對比；實測 detector 頻段 burst 仍壓低約 4 dB、底噪不動、非 detector 大音量段落多保留約 1.9 dB 對比，峰值仍受限。
- 音訊設定頁補充最有效組合說明與 EQ／上限本來就細微的提示。
- 驗證：51 個測試檔／306 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke 與 `npm audit` 全部通過。
- 交付：`release/v0.58.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.58.0.exe`；SHA-256 `346D3335345F41A8BC54AA0C1C9066DCC3EEBC5F1253C81153E0E8AC1CD994AB`。

## v0.57.0 — 2026-09-12

- 片頭／正片轉檔改為背景工作：轉檔中按 × 回主畫面，編碼繼續，主畫面背景工作列顯示即時進度；重開轉檔頁會接回監控（可取消，不會重複啟動），完成後成品出現在輸出檔案庫。
- 轉檔期間字幕修改與 SRT 匯出照常可用；轉檔使用開始時的專案快照，事後字幕修改不影響進行中的成品，UI 已明示此語意。
- 驗證：50 個測試檔／297 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke 與 `npm audit` 全部通過。
- 交付：`release/v0.57.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.57.0.exe`；SHA-256 `9AB302272211E6F936B31AF166FBA514FD8D070313DBFA56297AA618B2BC409C`。

## v0.56.0 — 2026-09-11

- 字幕列新增鄰接的單筆確認／刪除／上移／下移；格內 textarea 維持原生文字游標及直接編輯。
- 單筆、全部及 Shift 複選的確認／取消確認改為 Main 寫入成功後即時完成；強制逐筆校對只有保存成功才進入下一筆。
- 上下移交換同範圍相鄰字幕的時間與來源位置，兩筆回到待確認並立即保存；刪除仍不觸碰影片、照片或代理檔。
- 底部只保留未確認文字／時間修改的備援保存，不再是確認字幕的必要步驟。
- 驗證：49 個測試檔／296 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke 與 `npm audit` 全部通過。
- 交付：`release/v0.56.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.56.0.exe`；SHA-256 `9F749DF3A780E83741AD587C69E235FE0945A6288A18087B686906A3D46658EF`。

## v0.55.0 — 2026-09-11

- Windows EXE 檔名開始帶版本；封裝 smoke 依 `package.json` 解析同一版本檔名。
- App 小型確認視窗把鍵盤焦點及滑鼠游標放到安全預設動作；關閉確認固定為「繼續剪輯」。Renderer 矩形先在 Main 受視窗邊界驗證，再用固定 Windows helper 定位，不拼接 shell 字串。
- 字幕逐筆預覽由整支影片代理改為精確 cue IN／OUT 的短區段代理；有效 cache 保存已驗證輸出 fingerprint，重看免重複 ffprobe，損壞／變更仍會重建。
- 強制字幕校對先依目前片頭／正片主軸與疊化重新對位，再提供逐筆一致／不一致修改流程；字幕來源 OUT 會跟著新片段邊界更新。
- 手動加入片頭影片、照片或局部放大時，既有各段 IN／OUT 與目標總時間維持不變；不再自動均衡或增加上限，剩餘容量不足時明確阻擋。
- 驗證：49 個測試檔／295 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實短區段 FFmpeg cache／損壞重建、來源 hash 與 `npm audit` 全部通過。
- 交付：`release/v0.55.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.55.0.exe`；SHA-256 `8092E84F6F1B75D3F6EB021F8747679FB9BE2C330B6F989F6DFE5C73B16CFCAA`。

## v0.54.0 — 2026-09-11

- 所有影片轉檔預設啟用本機人聲／突發聲音保護：1–4 kHz sidechain detector、3–6 dB 有界平滑壓低、可關閉 EQ、Compressor 與 -1／-2 dB Peak Ceiling Limiter。
- 遠處人群／市集氛圍及腳步／微弱招呼以較高門檻與較慢 attack／release 優先保留；UI 明示純聲學偵測不能理解內容是否私密，仍需人工聽檢。
- 串連預覽的配樂可獨立勾選片頭及正片。片頭單選在正片提示頁前 1.5 秒淡出；正片單選在提示頁結束後才啟動配樂時間線。
- 片頭／正片秒數、IN／OUT、順序、插入或疊化更動後，字幕依片段與來源內時間逐筆重新映射；新增「強制重新校對」可保留文字／時間並將所選範圍有效字幕改為待確認。
- 新偏好相容舊設定；來源影片、原始音軌與 MP3 均保持唯讀，既有 partial／取消／磁碟預檢／防睡眠安全流程不變。
- 驗證：48 個測試檔／293 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實 FFmpeg 聲音保護濾鏡與 `npm audit` 全部通過。
- 交付：`release/v0.54.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `13EF59AD462EA0E38A587D1BF69215B383EF9A179132C5D991AEADB603E3FE00`。

## v0.53.0 — 2026-09-11

- 串連預覽頁新增正片／僅片頭切換；獨立片頭可沿用同一套安全轉檔設定，完成後以 Chrome 拖放或 YouTube 官方 API 作不公開測試。
- 自動片頭輸出新增「永久嵌入已確認片頭字幕」選項；Intro 僅讀取 `INTRO` 字幕，不混用正片字幕。
- 字幕頁與實際輸出統一為 480p 字級基準；第一語言共用同一份大小／位置偏好並依輸出解析度等比例換算，第二翻譯語言維持獨立設定。
- 字幕 ASS 時間改用扣除疊化後的片段起點，避免後續片段字幕逐段偏移。
- 片頭 YouTube 測試不自動套用正片的 AI 標題、縮圖或章節；BiliBili／TikTok 仍只接受正片／Shorts／已確認既有成品。
- 驗證：48 個測試檔／284 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實片頭字幕 FFmpeg 輸出、來源 SHA-256 與 `npm audit` 全部通過。
- 交付：`release/v0.53.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `514119FDD60474F9C9A454F356618EE2F4939202AB0FEFD8D0DA521C59697E93`。

## v0.49.0 — 2026-09-10

- YouTube 新增並預設採用 Chrome 上傳頁＋檔案總管選取最新 MP4 的人工拖放交接；官方 API 保留為第二選項，發布仍需人工確認。
- 轉檔新增 H.265 預設／H.264 相容選項與預設勾選的單次浮水印控制；輸出紀錄保存 codec，浮水印設定頁修正窄視窗重疊。
- AI 發布素材改為 ChatGPT 主生成、Gemini 可選第二復核；標題與縮圖結果提前呈現，提示詞加強 100 字、具體畫面與短縮圖文案規則。
- AI 字幕影格分析新增動物物種與說明，含不確定性約束。
- 驗證：43 個測試檔／262 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實 H.265 編碼、浮水印 opt-out、來源 SHA-256 與 `npm audit` 全部通過。
- 交付：`release/v0.49.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `82248E2C79CBB6C94BA4D81E5CCEF285DE6DE2C50704518D0C6ADB10768EA427`。

## v0.48.0 — 2026-09-10

- 新增獨立浮水印工作區與 schema 16 專案設定；草漯沙丘預設為中文「漫步／風光」左下兩行、英文「SceneryWalker」右下，1080p 基準 51／41 px、63 px 邊距、文字／底框不透明度 82%／24%。
- 可設定首次顯示、開始間隔、停留時間、淡入淡出、位置、排列、字級、透明度、安全邊距及正片／片頭／Shorts 範圍；預設每 360 秒顯示 15 秒。正片與片頭實際 FFmpeg 輸出會套用，固定片段檢查不套用。
- AI 發布候選改為片頭優先並依實際來源時間擷取，再由正片補足三張；OpenAI／Codex prompt 同時包含主題、故事、片頭順序、正片摘要與候選來源。
- 修正 AI 發布結果被視窗裁切：結果區可捲動，完成後自動顯示 provider、選定標題、選定縮圖與警告；三張候選會自動以來源影格本機合成 1280×720 JPG。
- 文件明確鎖定字幕修改邊界：SRT 可直接修改；已燒入 MP4 的字幕不能直接換字，須從乾淨影片或唯讀來源建立新版本且不得覆寫舊成品。
- 驗證：41 個測試檔／255 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、`npm audit` 全部通過。
- 交付：`release/v0.48.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `0EFD15D90B3F316137695004C820B0848E6052A12DA6FC018B459E34F45B25D4`。

## v0.47.0 — 2026-09-09

- 字幕頁的片頭／字幕共用預覽紀錄改為預設收起，可明確展開或再次收起，不再壓縮上方同步影片預覽。
- 展開後沿用同一個 `OutputLibrary` 與播放／開啟位置／複製路徑動作；片頭頁呈現不變。
- 新增字幕頁預設收起、展開、再次收起的 UI 回歸測試。
- 驗證：39 個測試檔／248 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、`npm audit` 全部通過。
- 交付：`release/v0.47.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `4960B3F17D56A8EF8623C378A1C6B9E305FB2F07AA7B07DB6C218D265587B971`。

## v0.46.0 — 2026-09-09

- AI 字幕產出後維持全部 `CONFIRMED`，不再要求逐筆確認才能使用。
- 字幕頁新增全部確認／全部取消確認、確認選取／取消確認／刪除選取與每筆獨立刪除；Shift 連續選取可套用批量操作。
- 刪除仍以安全確認保護，且只移除 manifest 字幕項，不觸碰來源媒體或代理快取。
- 驗證：39 個測試檔／247 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、`npm audit` 全部通過。
- 交付：`release/v0.46.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer.exe`；SHA-256 `23C36C69FFD0AF4FAD6DDDDF03795C219A59C929C9FA4BD04B45C4320366BADA`。

## v0.45.0 — 2026-09-09

- YouTube 說明自動整合中文說明、English summary、有效章節時間與 hashtags；5,000 字上限會優先保留章節及 hashtags。
- 新增上傳前集中確認頁，可直接播放受成品索引保護的 MP4、查看專案內選定的最終縮圖與完整發布文字。
- 頻道、標題、章節、兒童內容及可見度集中顯示；需人工勾選檢查聲明後才可呼叫 YouTube API。
- 從成品庫開啟上傳也會讀取目前專案保存的 AI 發布素材。
- 測試環境只驗證合約、UI gate 與串流權限，不執行真實頻道發布。

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
