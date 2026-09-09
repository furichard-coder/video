# Phase 0｜架構、範圍與驗收

## v0.48.0 增量範圍（2026-09-10）

- Manifest schema 16 新增經 Main process 正規化的專案浮水印設定；正片完成輸出與獨立片頭在字幕後套用週期 drawtext，Shorts 明確選用，固定片段檢查不套用。完整決策見 `docs/adr/0039-periodic-project-watermark.md`。
- AI 發布候選先取已確認片頭的實際來源時間，再由 canonical Main timeline 補足；分析影格、縮圖結果與來源時間一致，結果區可捲動並在完成後顯示標題與三張本機合成縮圖。完整決策見 `docs/adr/0040-intro-first-ai-publish-results.md`。
- 已嵌入 MP4 的字幕屬畫面像素，字幕修改時必須由乾淨影片或唯讀來源建立新版本；SRT 可直接修改後另存。完整決策見 `docs/adr/0041-burned-subtitle-revision-boundary.md`。

## v0.30.0 增量範圍（2026-09-08）

- Windows FFmpeg 串接改用唯一、可清理的 filter script，避免 Intro＋Main 或字幕燒錄把 graph 放進命令列而觸發 `spawn ENAMETOOLONG`。
- 輸出頁依上次指定資料夾自動準備不覆寫的 MP4 名稱；仍保留 Windows 原生另存操作，Renderer 只持有一次性 token。
- 正片與 Intro 提供本次 MP4 是否混入 MP3 的明確勾選，並分別保存上次選擇。
- 完整決策見 `docs/adr/0030-filter-script-automatic-output-and-per-render-bgm.md`。

## v0.28.0 增量範圍（2026-09-07）

- AI 知識型字幕在 OpenAI Responses 實際 preflight 失敗後，可改用本機 Codex CLI 所管理的 ChatGPT 登入；不得讀取、複製或保存 Codex auth token。
- Codex 執行固定採 `--ephemeral`、`--ignore-user-config`、唯讀 sandbox、非 Git 工作模式及安全參數陣列；只附加 App cache 的低解析故事板，不交付原始媒體路徑給模型文字內容。
- 多候選依 12 張故事板分批、以 JSON Schema 限制輸出並再次驗證數量與 index；不完整或重複結果整批拒絕，不靜默寫入錯誤字幕。
- Codex 備援限定於預設不含語音的知識型字幕；轉錄、翻譯與片頭語意重排仍沿用既有邊界。完整決策見 `docs/adr/0028-codex-chatgpt-subtitle-fallback.md`。

## v0.27.0 增量範圍（2026-09-06）

- Intro manifest 中的影片 IN／OUT 定義為可超過 `introSegmentMaxDurationMs` 的完整人工檢看範圍；每段最高秒數改為輸出 cap，而不是選取 cap。
- Renderer 以橘紅狀態提示超時並在產出前二次確認；Main service 重新計算 canonical output ranges，防止 UI request 繞過目前上限。
- Intro 單獨輸出、Main 前置 Intro 與字幕 480P Intro review 共用同一個由 IN 起截取 helper；字幕 cache key 亦包含每段上限。
- Manifest schema 與 proxy/cache 版本不變，避免不必要的全面重建；完整決策見 `docs/adr/0027-soft-intro-review-range-and-hard-output-cap.md`。

## v0.26.0 增量範圍（2026-09-06）

- 網格 metadata 的第二欄增加可用寬度，標籤禁止折行；檔名與既有兩行資訊密度不變。
- 預覽 cache 升級 `preview-v3`，來源不變時也會按預覽器版本局部換 key；不主動重掃整個素材庫。
- Apple HEVC MOV 採軟體解碼優先，避免通用硬體協商在舊 GPU／驅動反而延長等待；其他 codec 維持原 fallback。
- 代理在寫入正式 cache marker 前，以及每次 cache hit 時，均用 ffprobe 驗證 H.264、尺寸及有效時長；破損 proxy 自動局部重建。
- MP4 mux 增加 `avc1`、CFR、負時間戳正規化及非同步音訊重採樣，提升 QuickTime/iPhone MOV 的 Chromium seek 相容性。

## v0.25.0 增量範圍（2026-09-06）

- 字幕 cue 新增片頭／正片範圍但維持 schema 13 相容；舊 cue 預設為正片，兩個時間基準分開驗證及保留。
- 字幕頁的範圍與顯示外觀保存在使用偏好；AI 只分析所選範圍，片頭分析完成後產生可取消、可重用的 480P 衍生預覽。
- 片頭字幕預覽 cache key 綁定片頭片段、來源路徑／大小／修改時間／fingerprint、色彩與混音設定；不讀寫來源，且不以 proxy 作正式輸出。
- 完整決策見 `docs/adr/0025-scoped-subtitles-and-synchronized-intro-preview.md`。

## v0.24.0 增量範圍（2026-09-06）

- 網格片段／音量／安插按鈕以保存後 manifest 狀態決定高對比色、已設文字、提示及無障礙名稱。
- Intro 移除 180 秒 hard gate；超過 180 秒改為紅色警示，保存、分析及輸出仍依目前目標時間、50 段與單段 3–22 秒規則運作。
- 完整決策見 `docs/adr/0024-saved-tool-states-and-unbounded-intro-duration.md`。

## v0.23.0 增量範圍（2026-09-06）

- 從網格片段時段加入 Intro 時，先在 180 秒硬上限內把 `introTargetDurationMs` 增加該段長度，再提交片頭清單；成功提示使用 canonical 順位與新上限。
- 網格 metadata 壓縮為兩行雙欄。檔名以前後相鄰項的英文前綴及年份／日期簽名判斷省略方向；顯示不改檔名或實際排序。
- 完整決策見 `docs/adr/0023-auto-expand-intro-target-and-filename-priority.md`。

## v0.22.0 增量範圍（2026-09-06）

- 網格卡片改為只保留必要 metadata；全域唯讀狀態取代逐卡重複文字，完整路徑留在清單檢視。
- 新增可持久化的整體 UI 縮放與 Windows 常見 `Ctrl` 快捷操作，且與既有 root 文字大小偏好互不覆蓋。
- 時間範圍編輯改用分鐘／秒數雙欄與 Enter 焦點順序；領域層仍只接收整數毫秒。
- 固定時段與局部放大合併；0% 使用者放大量映射為 100% 內部 scale，保留 schema 13 相容性。預設加入片頭並回報 canonical 順位。
- Intro 上限為 50 段。預覽預設依目前片頭順序整體循環，也可切換單段循環；兩種模式都只影響播放，不改輸出清單。
- 完整決策見 `docs/adr/0022-compact-grid-split-time-intro-insertion-and-looping.md`。

## v0.20.0 增量範圍（2026-09-05）

- 正片排除編輯與片頭素材預覽使用 display dimensions／rotation 對應的獨立比例框，所有播放及調整介面位於影像外。
- 影片資產新增來源時間基準的局部放大區段，保存 100%–400% 倍數與 X／Y 中心點；正片、片頭及固定片段輸出共用同一決策。
- 固定來源時間段可加入片頭或獨立輸出 3840×2160 MP4；輸出回連唯讀原檔，不使用 proxy。
- 片頭只建立選定 IN／OUT 的短代理，cache key 綁定來源 fingerprint、時間段及預覽器版本；硬體解碼失敗時自動退回軟體／無聲 proxy。
- Manifest schema 12 向後相容 schema 1–11；完整決策見 `docs/adr/0020-source-range-zoom-and-fast-intro-proxy.md`。

## v0.19.0 增量範圍（2026-09-05）

- 片頭每段最高時長成為專案持久設定，3–22 秒、新專案預設 15 秒；設定後盡量均分各段，重開沿用最後值。
- AI 片頭新增文字指示與單一優先基底影片，並沿用可調總長、每段上限與真正 3840×2160 的 4K 預覽輸出。
- 字幕工作台可匯入 UTF-8 SRT，再逐項修改時間與文字；來源 SRT 唯讀。
- 正片／片頭產出頁直接顯示各自歷史成品並用既有安全外部播放器路由開啟。
- preview-v2 依 display dimensions／rotation 維持來源比例，舊 metadata 局部補探測，proxy 失敗可重試或以外部播放器查看原檔。

## v0.18.0 增量範圍（2026-09-05）

- AI 字幕以畫面、主題與地點知識草稿為預設；素材語音轉錄是預設關閉的可選支線。
- 片頭目標時間在分析前設定；自動候選與手動影片／照片可共同調整秒數及先後順序。
- 片頭人物／事件／故事／地點語意符合度優先，本機畫面訊號只作候選與次要分數；API 失敗時明確標示本機備援。
- 五組固定色彩預設保存至 schema 10 manifest，可選擇套用片頭或片頭＋正片；來源與 proxy 不改寫。
- 所有 App 內媒體預覽使用原比例 `contain`，控制列與影像容器分離。

## v0.17.0 增量範圍（2026-09-05）

本輪在既有垂直切片上加入雙語字幕燒錄與網格操作回歸修正，不擴張為多軌 Timeline、正式 Master、HDR 或無人值守發布。詳細決策見 `docs/adr/0017-dual-language-subtitle-burn-in.md`。

## 現況盤點

- 上層資料夾只有影片剪輯 SOP，無既有 App 或技術棧，且不是 Git 儲存庫。
- Windows 本機已有 Node.js 24、npm、FFmpeg／ffprobe 8.1 與 Git。
- Rust／Cargo、.NET 與 ExifTool 未安裝。
- App 固定放在 `video-editor-app`，不把 SOP 當成程式碼，也不修改 SOP。

## 第一階段唯一產品範圍

1. 選擇多個影片／照片或資料夾。
2. 以唯讀方式建立來源清單與最小 manifest。
3. 提供自然檔名、時間、加入順序及綜合智慧排序。
4. 提供個別圖片／影片預覽與依排序連續播放。
5. 提供網格／清單、lazy loading、取消、占位與錯誤 fallback。
6. 從清單移除只改 manifest，不刪除來源檔。
7. 依目前排序將影片產生為低解析串連預覽：0.3／0.5／0.7 秒疊化、360p／480p、可取消。
8. 在網格內播放單支 proxy，並保存每支影片可調的 IN／OUT。
9. 提供 720p 與 4K 預覽輸出選項。
10. 以本機短區段抽樣提出片頭候選，允許逐段預覽、調整、排序、排除及輸出 Intro 預覽。
11. 對補充素材逐筆記錄安插決定，保存自訂 timeline 順序與待決定區。
12. 每支影片提供多段 0%–300% 音量 automation，新專案素材原音預設 100%；既有有效值（包含 80%）照舊保留，實際套用於串連與 Intro。
13. 依 rotation/display metadata 對 9:16 素材建立同源模糊側邊的 16:9 版式。
14. 管理唯讀 MP3、時間範圍、source IN／OUT、淡入淡出與音量，實際混入輸出並限制 peak。
15. 管理字幕 cue、timeline revision 複核與原子 UTF-8 SRT 匯出。
16. 正片與 Intro 均提供非破壞性移除、最近移除與原位恢復；來源資產與兩種引用彼此獨立。
17. 放大影片預覽提供精確 seek，並管理可合併的 Main exclusion ranges；正片時間與輸出只使用扣除後的保留片段。
18. 照片預設使用草漯沙丘前案已核准的相機快門音效，允許逐張關閉，並套用於總體預覽與串連輸出。
19. 影片卡片可把正片照片或影片安插到指定保留時間；插入影片有獨立 IN／OUT，同點可接續多個素材；manifest 保存安插點與原順位，規劃器展開主片前段／安插素材／主片後段且避免重複播放。
20. 以可切換的 OpenAI API profile 對片頭候選和字幕草稿執行人物／事件／地點／主題聲畫比對；API Key 使用 Windows 安全儲存，不進專案 manifest。
21. AI 字幕以 DRAFT／CONFIRMED／REJECTED 狀態逐項同步預覽與人工審核，只有 CONFIRMED 可匯出 SRT。
22. 程式上方提供全介面文字大小設定，四級選項即時套用並跨重開保存，網格資訊不得維持不可讀的小字。
23. 網格素材可用滑鼠左鍵長按直接拖曳任意排序，拖動過程即時更新序號，放開後以既有 Main process API 保存；上移／下移保留作為鍵盤 fallback。
24. 上方顯示 App 版本，並提供目前工作階段 50 步的上一步／下一步與 `Ctrl+Z`／`Ctrl+Y`。
25. 使用者取消產出時先安全結束 FFmpeg 並驗證容器；有效 partial 保留為較短可播放 MP4，無效 partial 才清理。
26. 本機 MP3 與 YouTube 待確認參考可混合排入同一 BGM 清單；BGM 預設 35%，未解析參考不得輸出，App 不任意下載 YouTube 內容。
27. Intro 預覽採專案級目標時間：沒有 180 秒硬上限，超過時顯示紅色警示；最多 50 段、每段 3–22 秒。
28. 本次完成的正片預覽可由使用者確認後，以官方 OAuth／resumable upload 上傳到精確核對的 YouTube 頻道；預設不公開，Chrome 優先、Edge 第二。
29. 安插點與音量區段 UI 統一採 `分鐘:秒數`；內部維持整數毫秒，避免犧牲輸出精度。
30. 本次完成的正片 MP4 可安全交接到 BiliBili／TikTok 官方投稿頁；路徑會複製並在檔案總管選取，平台登入、metadata、隱私／分區與發布仍由使用者確認。
31. 素材安插視窗可依來源資料夾切換清單，並可使用原生 Windows 資料夾選擇器唯讀加入其他資料夾；新來源先停留待決定區，確認安插後才參與正片。
32. AI Intro 片段預覽使用 ffprobe 的 display dimensions／rotation，依來源 16:9、9:16 或其他比例完整 `contain` 顯示，不裁切、不拉伸，控制列不遮住畫面。
33. 網格影片縮圖的主要左鍵動作直接走既有副檔名外部播放器路由並開啟唯讀意圖原檔；照片縮圖、網格 proxy 播放與其他卡片控制維持原行為。
34. 平台設定以官方登入流程管理帳號：YouTube 顯示 OAuth 連結狀態、頻道名稱與 ID，密碼只輸入 Google 官方頁；BiliBili／TikTok 直接開啟官方登入／投稿頁，App 不收集平台密碼。
35. App 產出的所有正片、Intro 與取消後有效 MP4 會持久加入預覽成品索引；使用者也可透過原生多選視窗登記舊版本 MP4。重開後可播放、找出及投稿，移除索引不刪除檔案。
36. 正片輸出可選擇把已確認 Intro 依順序接在 Main 前方；預設啟用、有獨立取消選項，Main process 仍以目前專案資料核對所有範圍與順序。
37. 完整正片輸出後可預設倒數 60 秒開啟 YouTube 最後確認頁；輸出前取消勾選或倒數中取消都會停止流程。倒數只準備上傳，不會跳過人工確認，取消產出所得短片不自動啟動倒數。
38. 網格卡片工具維持扁平單列；局部放大使用可重現的固定消噪／銳利化預設，保存後可明確加入指定片頭順位或開啟 4K 時段輸出。片頭預覽優先透過 asset ID 唯讀串流原檔並在 IN／OUT 循環，codec 不支援時才由使用者切換短代理；一般關閉另有安全二次確認。
39. 網格卡片隱藏重複路徑與逐卡唯讀文字；整體 UI 縮放、分／秒輸入與 Enter 焦點流程均為 renderer 偏好／呈現，不改來源或輸出時間精度。
40. 固定來源時段併入局部放大編輯；新時段預設 0% 放大與加入片頭。Main process 保存成功後回傳 canonical 清單，Renderer 才顯示順位與跳轉確認。
41. Intro 預設依目前片段順位整體循環，最後一段接回第一段；單段循環只重播選取段，暫停狀態不推進。
42. 網格手動加入 Intro 時，將目前時間目標增加該片段長度後再保存；不再套用 180 秒 hard gate，超過 3 分鐘由 Renderer 紅色警示。
43. 網格標題顯示會依排序中的相鄰檔名選擇保留前端或尾端；只改 CSS 省略方向，完整名稱、asset ID、排序與來源路徑均不變。
44. 網格工具按鈕只依 canonical manifest 判斷已設定狀態，並以顏色＋文字＋無障礙名稱三重呈現；視窗內尚未保存的草稿不改按鈕。

明確非目標：多軌圖形 Timeline、EDL、字幕燒錄、正式 Master 渲染、HDR、自動公開發布、任意 YouTube 下載／轉 MP3、全庫 RAW 深度分析、來源 metadata 寫入。使用者主動觸發的 AI 衍生片段分析與使用者確認的正片預覽上傳不屬於自動發布。

## 資料保護規則

- Source adapter 只實作列舉、`stat`、ffprobe/ffmpeg 讀取，不提供 rename、write、move、delete API。
- Renderer 只傳遞 asset ID；串連輸出只能使用原生 save dialog 建立的一次性 token，不可自行要求任意本機寫入路徑。
- 所有外部程式以參數陣列啟動，禁止拼接 shell 指令。
- cache 目標 canonicalize 後必須位於 App 自有 cache root。
- Cache key 綁定 asset ID、canonical source path、size、mtime 與 previewer version。
- Preview cache 可重建且標記 `DERIVED_PREVIEW_ONLY`；不能成為正式 master。
- 清單移除只更新 App manifest；來源與既有 cache 均不刪除。
- 串連輸出先寫唯一 `.partial.mp4`；一般成功才 rename。取消時先向 FFmpeg 送出安全結束，只有 ffprobe 驗證為有效且至少 300 ms 的檔案才保留為較短 MP4，否則只清除該 App 中介檔。
- 精彩片頭分析只在少數時間點讀取短區段；cache 綁定來源 preview fingerprint 與 analyzer version。
- MP3 只能經原生 dialog 加入；Renderer 不可改寫來源音樂路徑。素材原音新專案預設 100%、BGM 預設 35%，最高增益均為 300%，最終混音使用 0.95 peak limiter。YouTube URL 只能成為待確認參考，必須由使用者確認權利並連結本機 MP3，App 不任意下載或轉檔。
- SRT 與 MP4 均先寫唯一 partial；若使用者確認覆寫既有輸出，舊檔只在新 partial 完成後暫時改名，完成失敗時可還原。
- 素材安插只記錄 asset ID、主片來源時間、插入影片 IN／OUT 與原順位；不裁切、搬移或改寫影片／照片。變更 IN／OUT 或排除區段若會讓安插點失效，操作必須阻擋並提示。
- 安插視窗從其他資料夾加入的來源沿用既有白名單、取消與去重流程；加入後只進 `pendingAssetIds`。取消安插會回到原待決定位置，不能因開啟選擇器就自動排入正片。
- 快門聲封裝前必須符合既定 SHA-256；只複製到新版本 App 自有 `resources/assets`，沙丘前案音效原檔維持唯讀，並隨 App 附來源與授權紀錄。
- Codex／ChatGPT 登入 session 不可由獨立 App 讀取或重用；OpenAI API Key 使用 Electron `safeStorage` 加密並與 project manifest 分離，缺少 OS 加密能力時拒絕明文保存。
- AI 只把候選短音訊、低解析三格故事板與已填故事背景送給所選 provider；不傳完整來源影片。取消時不寫入未完成字幕草稿，AI 證據 cache 綁定來源 fingerprint、範圍、模型、背景與 analyzer version。
- 介面文字大小與整體 UI 縮放是 renderer 本機偏好，只寫入 App 的 local storage，不進來源檔、專案 manifest 或輸出。
- 拖曳僅提交 asset ID 與目標索引給既有白名單 IPC；不傳來源路徑，也不新增檔案操作權限。拖曳失敗時重新讀取 canonical manifest，不以畫面暫存順序冒充已保存。
- YouTube OAuth client secret 與 refresh token 使用 OS safeStorage 加密；上傳只接受持久預覽成品庫中仍存在的 Main／明確匯入 MP4，不接受 Renderer 傳入任意本機路徑。登入後須精確核對頻道名稱，隱私只允許不公開或私人。
- BiliBili／TikTok 交接只接受持久預覽成品庫中存在且非空的 Main／明確匯入 MP4；Main process 固定官方 URL，Renderer 只傳平台 enum 與 job ID。未取得開放平台應用與核准權限前，不宣稱自動 API 發布。
- Undo／Redo 只處理 manifest 快照；不觸碰來源、cache、已完成輸出或外部帳號。跨專案開啟／另存時重設歷史，避免誤復原。

## 第一階段驗收對應

| ID | 驗收 | 證據 |
|---|---|---|
| VS-01 | 多檔與資料夾選擇 | 原生 Windows dialog、匯入測試 |
| VS-02 | 來源保持不變 | 匯入／preview 前後來源 SHA-256 測試 |
| VS-03 | 基本資訊 | ffprobe adapter 與 UI 欄位測試 |
| VS-04 | 四種排序 | 自然檔名、時間、加入、智慧排序單元測試 |
| VS-05 | 個別預覽 | 圖片 preview 與影片 proxy/UI 測試 |
| VS-06 | 總體預覽 | 依目前排序逐項播放，不產生合併檔 |
| VS-07 | manifest 恢復 | atomic save/load 測試 |
| VS-08 | 移除不刪檔 | ProjectStore 與 source existence 測試 |
| VS-09 | cache 命中／失效 | preview cache 整合測試 |
| VS-10 | 取消與 fallback | 任務池取消、UI 錯誤狀態測試 |
| VS-11 | 串連選項與確認 gate | UI 測試：三個秒數、兩個解析度、選定路徑後 OK 才啟動 |
| VS-12 | 疊化串連正確性 | FFmpeg filter graph 與實際 H.264／AAC 輸出整合測試 |
| VS-13 | 串連仍保護來源 | 輸出前後 SHA-256 相同、取消不留 partial 測試 |
| VS-14 | 網格播放與雙把手 | UI 測試：VIDEO_PROXY、IN／OUT bar、manifest persistence |
| VS-15 | 720p／4K 規格 | filter graph 與 1280×720 實際輸出測試 |
| VS-16 | 精彩片頭建議 | 本機分析、cache hit、來源不變、UI 可調片段測試 |
| VS-17 | Intro 多片段輸出 | 同一來源多範圍、獨立 IN／OUT、H.264/AAC 輸出測試 |
| VS-18 | 音量 automation | 0/80/100/200%、重疊/越界、IN/OUT 裁切與實際 dB 量測 |
| VS-19 | 補充素材安插 | 待決定、前後錨點、手動移動、重開恢復 |
| VS-20 | 直式手機素材 | display rotation 解析、同源 split/blur/overlay 與實際輸出 |
| VS-21 | BGM 混音 | MP3 唯讀、時間/淡入淡出/增益、offline gate、limiter 與實際輸出 |
| VS-22 | 字幕與 SRT | cue CRUD、重疊/總時間、revision gate、UTF-8 格式與 partial 清理 |
| VS-23 | 舊專案相容 | schema 1–8 → 9 migration 保存來源與既有欄位，舊照片安插轉通用素材安插，既有安插補來源位置，其他舊預設與資料不遺失，未知 schema 不覆寫 |
| VS-24 | 照片時間 | 預設 5 秒、3–7 秒驗證、總體預覽與真實串連輸出、來源 hash 不變 |
| VS-25 | 專案檔 | 原生另存／開啟、完整 schema 9 round-trip、atomic partial、損壞檔不取代目前專案 |
| VS-26 | 正片／Intro 安全移除 | 獨立引用、確認預設安全焦點、最近移除、原位恢復、重開與來源 hash 測試 |
| VS-27 | 放大 seek 與 Main exclusions | 播放頭／目前時間 UI、區段 CRUD、排序合併、IN／OUT 裁切、全部排除 gate |
| VS-28 | 排除後真實輸出 | 保留子片段、片長、無占位、音量／xfade／BGM／直式 blur 與來源 hash 整合測試 |
| VS-29 | 沙丘相機快門音效 | 精確 SHA-256、預設啟用／逐張關閉、總體預覽、真實混音、limiter 與來源不變 |
| VS-30 | 影片時段素材安插 | 保留範圍／邊界驗證、照片／影片、影片獨立 IN／OUT、同點接續排序、原位恢復、schema 9 重開與真實輸出 |
| VS-31 | AI 帳號與憑證 | 多 profile、作用中帳號、環境變數 fallback、OS 加密、無明文、連線錯誤與重開恢復 |
| VS-32 | AI 故事比對管線 | 語音時間對映、低解析故事板、人物／事件／地點／主題證據、cache hit、取消與來源 SHA-256 |
| VS-33 | 字幕人工審核 | 同步 proxy、草稿／確認／排除、文字與時間編輯、只匯出 confirmed、timeline revision gate |
| VS-34 | 全介面文字與縮放 | 上方設定、16／18／20／22 px root scale、75%–150% UI zoom、Ctrl 滾輪／鍵盤、local storage 重開恢復 |
| VS-35 | 網格直接拖曳排序 | 280 ms 長按 gate、拖動時序號即時更新、放開保存、手動排序與字幕 revision 回歸 |
| VS-36 | 版本與專案歷史 | 版本文字、畫面按鈕、Ctrl+Z/Y、50 步 session history、來源 hash 不變 |
| VS-37 | 取消後可播放 MP4 | FFmpeg `q` 安全結束、有效短檔 ffprobe、太早取消清理無效 partial |
| VS-38 | Intro 專案級限制 | 3–22 秒、最多 50 段；總長超過 180 秒只警示，UI／保存／輸出均不硬擋 |
| VS-39 | 新音訊預設與來源政策 | 原音 80%、BGM 35%、0–200%、多 MP3 排序、YouTube pending reference、權利確認與來源 hash |
| VS-40 | YouTube 預覽上傳 | secret 加密、PKCE、精確頻道 gate、不公開預設、resumable 參數、取消與輸出 hash 不變 |
| VS-41 | 分／秒時間 UI | 安插、排除、片段、音量與 IN／OUT 雙欄、Enter 焦點順序、夾限與毫秒保存 |
| VS-42 | BiliBili／TikTok 交接 | 完成 Main job gate、MP4 存在驗證、Unicode／空格路徑、官方 URL、來源 hash 不變 |
| VS-43 | 安插資料夾切換 | 既有資料夾篩選、原生資料夾加入、pending gate、確認安插與取消原位恢復 |
| VS-44 | AI Intro 原始比例 | display dimensions／rotation、直式與橫式 player `aspect-ratio`、`contain` 完整顯示 |
| VS-45 | 影片縮圖外部播放 | 左鍵以 asset ID／ORIGINAL 呼叫安全外部播放器 IPC、不開 App modal，並回歸照片放大及其他卡片控制 |
| VS-46 | 平台登入狀態 | YouTube 官方 OAuth、頻道名稱／ID、無密碼輸入或明文保存；BiliBili／TikTok 固定官方入口 |
| VS-47 | 預覽成品庫 | 跨重開持久化、舊 MP4 明確匯入、Unicode／空格路徑、離線狀態、移除索引不刪檔／不改 hash |
| VS-48 | Intro＋Main 串接 | Renderer 預設選項、可取消、Main process 精確順序／範圍 gate、實際輸出順序與片長 |
| VS-49 | 60 秒上傳準備 | 預設勾選、完整輸出後倒數、取消／取消勾選停止、取消輸出不觸發、最後確認 gate |
| VS-50 | 片頭統一上限與平均分配 | 3–22 秒、預設 15 秒、改成 12 秒重開保存、來源容量不足時可預測縮短 |
| VS-51 | SRT 匯入 | UTF-8／BOM、多行、逗號／小數點毫秒、錯誤／重疊阻擋、逐項編輯與來源唯讀 |
| VS-52 | 片頭文字與基底素材 | 文字指示保存、單一影片優先分析、總長／每段上限傳入分析器 |
| VS-53 | 代理比例與失敗復原 | rotation-aware display dimensions、480p 等比、音訊失敗重試、重新建立／外部原檔 fallback |
| VS-54 | 頁內歷史輸出 | 正片／片頭分流、檔名連結、外部播放與重開索引 |
| VS-55 | 精簡網格資訊 | 網格不重複路徑／唯讀文字、全域唯讀狀態與清單路徑保留 |
| VS-56 | 合併時段／放大 | 單一編輯區、0% 無放大預設、舊 scale 相容、4K 選項保留 |
| VS-57 | 片頭加入確認 | 預設勾選、實際順位提示、前往片頭後可見已保存區段 |
| VS-58 | Intro 循環模式 | 預設整體依序、最後接第一、單段循環、暫停不推進 |
| VS-59 | 手動片頭上限自動擴充 | 先增加新片段秒數、再保存片頭、成功回報新上限，允許超過 180 秒 |
| VS-60 | 相鄰檔名顯示優先序 | 同前綴／日期保留尾端，不同英文／年份／日期保留前端，首末與完整名稱回歸 |
| VS-61 | 網格兩行詳細資料 | 標題及時間／大小、規格／編碼緊湊排列，可讀字級與全域縮放回歸 |
| VS-62 | 網格已保存狀態 | IN／OUT／排除／放大、音量、安插分色與非色彩提示，未設定回歸 |
| VS-63 | 片頭三分鐘警示 | 超過 180 秒紅色摘要及輸出列、保存／預覽／輸出不阻擋 |

## 後續安全階段

完成本切片後才規劃深度 metadata、時區／相機時間可信度、事件排序與 Timeline。正式 Master 渲染、HDR 與無人值守自動公開發布仍需另外階段與授權；本版提供使用者確認的 YouTube 正片預覽上傳，以及 BiliBili／TikTok 官方頁面交接。

## 可攜版交付決定

第一階段使用 Electron 官方工具鏈中的 `@electron/packager` 產生 Windows x64 可攜資料夾與 ASAR。此步驟只封裝既有功能，不加入 installer、auto-update、發布或來源寫入能力。正式公開散佈前仍需獨立處理 icon、數位簽章與 FFmpeg 固定版本。
