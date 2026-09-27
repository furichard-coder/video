# SceneryWalker 素材整理 App 變更紀錄

本檔案是每次可交付功能變更的簡短索引。完成一個階段後，必須同步更新本檔案、`README.md` 與 `VERIFICATION.md`；只有通過建置／測試的內容才可標記為完成。

## v0.80.0 — 2026-09-27

- 完成舊 checkpoint 的唯讀、copy-on-write recovery 驗證：10 個 level-1 segments（合計約 67.547 GiB、媒體時間約 8976.718 秒）全部可讀並可重用；不重編這 10 段，但 Base Master 必須重跑。
- 舊版已刪除的 `base.partial.mkv` 不可恢復。跨 group xfade、ASS 字幕與浮水印需要 picture pass，因此 10 段不能直接全程 `-c copy`；最後 audio mux 保持 `-c:v copy`。
- 加入／驗證 15 秒 disk monitor 與 EMERGENCY safe pause。v0.79 classifier 命中 ENOSPC，但原始 stderr 未保存；E: 144.45 GiB free 是刪除 partial 後的過時快照，UI 曾顯示「建議再清 20 GiB」的錯誤提示，但沒有執行該清理，實際最低 free 未知。
- QSV GQ25 維持為基準；30 秒 bounded 方案測試出現 SSIM 下降，故回退既有 GQ25。本機 NVENC runtime 不支援，實際為 QSV／CPU filter，慢速瓶頸約 0.10–0.115x；完整長片未實測，不宣稱加速成功。
- 驗證：74 files／459 tests、typecheck、production build、audit、source／packaged smokes 通過。這些數字是本次 run 的紀錄，日後重跑可能修正。
- Windows x64 可攜版獨立封裝於 `release/v0.80.0/SceneryWalkerSourceOrganizer-win32-x64/`，EXE SHA-256：`2445347DC1F96D24A4B463C6CB669F0C0BEF9FA2607BA27D0E40E6BD853B93FC`；未覆蓋 v0.79。

## v0.79.0 — 2026-09-26

- 修正 `UserPreferencesStore.update()` 遺漏 `renderTemporaryFolder` 的問題；先前檔案選擇器與寫入權限檢查雖成功，設定卻未進入持久偏好，估算與轉檔啟動因而繼續回退至 Windows `C:` TEMP。
- Render TEMP 現在會驗證為絕對路徑、保存至 `settings/user-preferences.json`，重開 App 後仍能回讀；選擇後的 estimate 與 `concat:start` 均由同一偏好取得 validated path。
- 新 checkpoint 的 work root 建於新選擇的 TEMP；既有 checkpoint 依舊使用紀錄中的原 work root，不進行跨磁碟搬移，也不觸碰來源、成品或舊 TEMP。
- 本機 `E:\temp` 驗證為健康 NTFS、可寫，測試 marker 已立即移除且沒有留下檔案。

## v0.78.0 — 2026-09-24

- 「精彩片頭」左側片段清單改為縮圖優先的 Flat／Compact UI；片段卡固定使用與 Intro Final 相同的 16:9 canvas，照片與影片一致排列，时长叠在缩图角落。
- 常用功能收敛为 Preview／Trim／Original Audio／BGM／SFX／Delete icon toolbar；每个 icon 具有 selected／enabled／disabled／unavailable／hover／focus 状态、短 Tooltip 与明确 ARIA 名称。排序、影像分析／字幕与缩图重载移入 More menu。
- 裁切、秒数与既有 `InsertionAudioControls` 改为按需展开；仍调用原有 Project State／Audio Engine，没有修改 Preview、Render、排序、删除或混音逻辑。
- Intro thumbnail Renderer state 加入 `assetId + IN/OUT` signature，裁切范围改变后不会继续显示旧缩图；拖曳仍以 segment ID 作为 React／cache state key，并新增排序后图片不串位测试。
- 继续沿用 480px JPEG、IntersectionObserver lazy load、首个非黑有效影格与来源 fingerprint／range／version cache；每个来源最多保留 64 组 Intro thumbnail JPG／marker，旧缩图只从 App-owned cache 依时间回收。

## v0.77.0 — 2026-09-22

- Render Resource Architecture 收斂為 LOW_DISK／BALANCED／HIGH_SPEED 三種明確 profile；UI、estimate、runtime policy 與實際 render request 共用同一份 profile／RAM／TEMP budget，避免只顯示設定值卻未真正套用。
- Peak disk estimate 拆出 retained intermediates、concurrent partial、可重用 picture/base-audio master、audio TEMP、final output 與 mux overhead；完成 downstream 驗證後才依 checkpoint dependency 回收已消費中繼，保留可安全 resume 的 durable master。
- 三種 profile 使用同一份實際專案輸入估算；Low Disk 45 Mbps、Balanced 1.22×、High Speed 1.44× intermediate cap，並保留 runtime RAM／Commit／SSD admission gate 與 adaptive jobs。
- Intro thumbnail 改為 first-valid-frame lazy generation；cache key 包含來源 fingerprint、時間範圍與版本，來源 hash／縮圖 cache 不移動、不覆蓋來源，失敗時保留來源並顯示可診斷狀態。
- UI controls 補足 render profile、RAM／TEMP budget 與片頭段落移動按鈕的可存取名稱；更新 checkpoint／GC／profile 契約測試。

## v0.76.0 — 2026-09-22

- 依 v0.75 真實 checkpoint／diagnostic 釐清 `-28 ENOSPC`：C: 從 87.4 GiB 可用降至 0，work root 約 92.2 GiB、平行 partial 觀測峰值約 118.4 GiB，六個完成片段合計約 74.63 GiB。舊估算漏算 QSV GQ18 實際碼率、parallel partial 與 final/base master 同卷生命週期重疊。
- SSD preflight 改為 selected Render TEMP 與 final output 分卷峰值；納入中繼、partial、audio TEMP、final、mux overhead、existing reusable data 與 `max(20 GiB, remaining × 20%)` reserve。UI 可選／開啟 Render TEMP 並顯示分卷明細。
- Runtime 每 30 秒記錄 disk NDJSON；兩個 volume 都有 WARNING／CRITICAL／EMERGENCY 檢查。壓力過高時停止新 wave、完成安全邊界、保存 `PAUSED_DISK_SPACE`；`-28` 顯示失敗路徑、需要釋放容量與可否續轉。
- Resume offer 先做實體存在／size consistency 檢查，重用前仍執行 ffprobe／SHA-256。舊 05:57:13 checkpoint 的 workRoot／六個 segment 已不存在，因此不能直接續用，UI 不再誤稱為已驗證成果。
- Segment 改用 MKV；Normal／High Speed 從 1 job 開始並依 completed-wave throughput/pressure 自適應。Normal 相容來源啟用 QSV decode，失敗仍安全回退 CPU。
- 180 秒 4K→1440p 受控測試：CPU decode baseline `171.72 s / 31.45 fps / 1.05x`，QSV decode `162.33 s / 33.35 fps / 1.11x`，wall time 改善 5.47%。十輸入 xfade 的 2 jobs 僅比 1 job 多約 4% aggregate throughput，因此不固定預設 2 jobs。
- NVENC 實際 probe 因 driver API 13.0 低於 FFmpeg 要求 13.1 而失敗；本機推薦 H.264 QSV。GQ22 畫質量測低於 GQ18，正式中繼仍保留 GQ18／CQ18／CRF16。
- 驗證：TypeScript、73 files／447 tests、46 個真實 concat integration tests、production build、Electron source／packaged smoke、npm audit 0 vulnerabilities。EXE SHA-256 `1FD6A1F1B3EA0158A51BA2795BD5869C3D83DC6E5E35C627DD80073177797DBC`。

## v0.75.0 — 2026-09-17

- Main 網格每個 clip 新增原音／配音／BGM／SFX 四個獨立 gate；Intro 與 Main insertion 使用同一型別、sanitizer 與 canonical plan。
- 片頭／正片 Audio UI 與 Final Review 分區；Intro rows 改成薄分隔線與 compact audio controls，刪除厚重巢狀 card 視覺。
- 新增正片開始 synthetic SFX：預設 650 ms、可關閉或調整 100–3000 ms；WebAudio 與 FFmpeg 共用同一 cue spec，並與 clip SFX gate 解耦。
- Global／insertion BGM 都在 post-audio 以 25 ms envelope 套 clip gate；關閉期間歌曲 playhead 持續，重新開啟不 restart。
- picture/base 與 final audio signature 分離延伸至 gates、cue 與 global BGM；音訊設定更動後沿用畫面 master，`-c:v copy` 重新 mux。
- manifest 升級 schema 21；schema 20 的 SFX/BGM instance 設定保留，新 gates 全開、cue ON／650 ms。
- 驗證完成：TypeScript、72 files／443 Vitest tests、production build、Electron source／packaged smoke、UI screenshot 與 `npm audit --audit-level=high`（0 vulnerabilities）全部通過；v0.75.0 EXE SHA-256 `EE19DDD3D29D0BD4267A01C09B353874F9237B451A1A3122F74D8DE92A4FAEF1`。

## v0.74.0 — 2026-09-15

- 新增 Main／Intro 共用的 per-instance `InsertionAudioSettings` 與 canonical `InsertionAudioPlan`；同一來源重複出現時設定互不覆蓋。
- 照片實例預設快門 SFX 開啟；SFX／BGM 改為獨立複選。BGM 依穩定 track ID 選擇，並在連續照片／影片間延續播放位置。
- 短 BGM 使用有界 `asplit + acrossfade` 循環；極端重複改用接點平滑並警告。SFX 以獨立 delayed track 疊加，統一 limiter 後再進入既有 Audio Processing。
- Final 改為可复用的 MKV+FLAC 画面／基础原音 master，再以单一 post pass 混入 insertion BGM/SFX 与最终 DSP；第二阶段固定 `-c:v copy`。只改音讯或 post 失败续转不会重新编码影片，App 重开后也可复用。
- 每專案只保留最近一份经过 size、SHA-256、duration、codec 验证的可重建 master。SSD 预估纳入其容量，转档页提供确认后单独清理；来源与既有成品不受影响。
- Main 總體預覽、Intro proxy 預覽、Final Render 與轉出確認摘要讀取同一個 plan。摘要列出每筆 instance 與合併 BGM range。
- manifest 升級 schema 20；遷移保留舊照片快門明確選擇，不憑空開啟 BGM；既有非安插靜音影片 auto-dub 維持，安插實例不再受兩套欄位重複處理。
- Windows 可攜版升級 v0.74.0；內建快門素材繼續執行封裝前 hash gate 與封裝後授權說明。交付 EXE SHA-256：`56C10076E45D2FFB4BE2559B1D781FE67C47EA3D91A23C6FE7EDE762009CC016`。

## v0.73.0 — 2026-09-15

- 以实际 v0.72 长片输出重现 tunnel 末段右侧绿色 blurred-fill；右侧色度饱和显著异常，来源与中央前景正常。
- 高风险的 rotated＋blurred-fill 输入固定使用 CPU decode、canonical orientation 与 planar yuv420p 后再分支；仍保留 QSV hardware encode，且未改变其他9:16或横式素材路径。
- orientation／preview cache／clip cache／render signature 更新，避免继续使用旧错误衍生档或中继。
- 新增 Main-owned post-success power scheduler：明确关闭预设、render／YouTube成功触发、60秒倒数与取消、固定shell-free Windows命令、busy/new-job安全取消。
- YouTube upload 与缩图重试纳入既有防睡眠 guard；要求缩图但失败时不会把上传视为完整成功。
- 新增电源动作、偏好迁移、成功矩阵、倒数取消、固定命令、QSV decode选择与实际 tunnel像素验证。

## v0.72.0 — 2026-09-14

- 修正 QSV hardware decode 不執行 FFmpeg autorotate，令 coded landscape＋Display Matrix 的直式素材在分段輸出側轉 90°。
- 新增單一 canonical orientation resolver；所有 video input 固定 `-noautorotate`，依每支素材 matrix 在 hwdownload 後、layout 前明確且只修正一次，沒有對全部 9:16 強制旋轉。
- Thumbnail／Proxy／Clip Proxy／Intro／Main／Shorts／Final 共用方向結果；中繼與成品 neutralize rotation metadata，Preview cache 版本更新。
- Orientation normalizer version 納入 checkpoint request signature，v0.72 不重用舊方向策略的 completed segments。
- 實際 tunnel 素材 QSV 修正 frame 與 software autorotate reference 完全相同；輸出 upright、rotation side data absent，來源 SHA-256 不變。
- 驗證：65 files／413 tests、TypeScript、build、Electron／packaged smoke、npm audit 全部通過；EXE SHA-256 `58FFFD159BB2BC41F4BEF996B043899DE1AC89F553B481BBBCB55D7D4F255FA0`。

## v0.71.0 — 2026-09-14

- 修正字幕行寬鏈路不一致：共享/UI 已允許 60，但 manifest 載入及 Main validation 仍停在 40；現在單筆與批次統一為 6–60，預設 12／20 不變。
- Manifest schema 19 新增 cue-specific normalized X／Y position；省略時完全沿用舊中央／全域高度。
- 每筆字幕增加滑鼠／觸控方向控制、鍵盤 1% 微調與 Shift 5% 大步進，並在每次操作後立即原子保存；文字框與數字輸入的方向鍵不會被攔截。
- Preview CSS 與 Final ASS 共用同一位置 resolver，覆蓋 16:9／9:16 及 1080P／1440P；timeline 重排／重新對位保留 cue identity 與位置。
- SRT 保持標準文字／時間格式，不寫入 App 專屬位置 metadata。

## v0.70.0 — 2026-09-14

- 新增按需开启、私人 LAN 单一 IP 绑定的 iPhone Safari Remote Control；REST commands 与 SSE live snapshot 共用 Main render command/state authority。
- 手机显示完整 render telemetry；Start 限 Windows prepared job，Pause 在 checkpoint-safe boundary 生效，Cancel 采用 UI + server nonce 两阶段确认。断线不会终止 render。
- 安全层新增 fragment-only 单次 pairing、HttpOnly Strict session cookie、CSRF、exact Origin/Host、private remote address、rate/body limit、expiry、CSP 与 server stop teardown。
- Audio Processing 改为 Proxy Video 同步试听：选择素材／当前 playhead 的约 20 秒 processed audio cache，A/B 保持播放头并以 120 ms drift gate 校正。
- 新增 Stereo Width 与低频／人声 EQ，Preview 与 Final 共用 sanitizer/filter builder。Audio cache 采用 timeline/source/profile version key、atomic partial、cancel/debounce/latest-wins 及 2 GiB／七天 LRU。

## v0.69.0 — 2026-09-14

- 新增 Audio Processing 模組、實際 A/B 試聽／LUFS／Peak 分析，以及 Original 2.0、Enhanced 2.0、Virtual 5.1 中性模式。
- Enhanced／Virtual 在既有畫面 Master 完成後獨立處理音軌，最終 MP4 以 `-c:v copy` 重新封裝，字幕、時間軸、轉場與畫面不重編。
- FFprobe metadata 擴充 codec、channels、channel layout、sample rate、bitrate；AAC／AC-3／E-AC-3 5.1 均以實際短片驗證。
- 無聲片段的第一首 BGM 自動套用沿用既有流程，並進入相同的最終 Audio Processing。
- 保持原始多聲道僅在單支原生多聲道時間段可安全 bitstream preserve 時開放；不安全的混合時間線明確阻擋。

## v0.68.0 — 2026-09-14

- 新增 FFmpeg 實際耗時：第一個 child PID 起算，monotonic 計時跨越分段、等待與 final concat；UI 每秒刷新並與 ETA 分列。
- checkpoint 升級 schema 2，保存本次與累積 elapsed；舊 schema 1 安全遷移為零基準。Crash／Resume 只承接最後 heartbeat，不計入 App 關閉後 downtime。
- Main 每五分鐘及 terminal 狀態 atomic 更新 checkpoint，並保留獨立 timing NDJSON。完成、失敗、人工取消三態都有可稽核的實際耗時；取消清除 checkpoint 後 timing history 仍存在。
- Renderer／background job／output history 顯示完成總耗時、失敗或取消本次耗時，以及 Resume 累積總耗時。
- 驗證：TypeScript、3 files／16 focused tests、53 files／292 非媒體 tests、production build、Electron smoke、packaged smoke 與 `npm audit` 全部通過。v0.67 正式 FFmpeg 仍在執行，因此依安全要求不跑真實媒體 integration／benchmark。
- 交付：`release/v0.68.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.68.0.exe`；SHA-256 `DF87C3894664C0707CF97C88CAA13335600C527D8EBC0F695EEAD1AC9DBC40FD`。

## v0.67.0 — 2026-09-13

- 新增真正 FFmpeg runtime encoder／decoder probe 與 hardware fingerprint profile；NVENC/QSV 能力不再由名稱猜測。
- 本機實測 NVENC H.264/H.265 均因 driver API 版本不足失敗；H.264/H.265 QSV 成功，高速預設改為 H.264 QSV。
- Codec UI 新增 NVENC、不可用原因與明確 H.265 CPU 慢速警告；render 入口禁止靜默 fallback。
- Normal 改為動態 2→3→4，高速可從 3 起步；新增 GPU Compute/VRAM、30 秒後平滑 ETA、20 GiB/5% SSD advisory margin。
- checkpoint segment 加入完整 render profile 欄位；保留已完成 segment 與 final-only retry。
- 六組同專案 3 秒工具驗證以 High Speed H.264 QSV／3 jobs 最快（19.346 秒、1.179x、35.32 FPS、RAM peak 約 3.32 GiB）；60 秒為正式 profile 預設。

## v0.66.0 — 2026-09-13

- 證實 Normal 現有 command 已為 Intel QSV hardware encode；根因改鎖定 CPU decode/filter/transition、多層 intermediate 與重複 normalization，不以增加 RAM 冒充效能優化。
- 新增高速模式與 QSV decode 安全嘗試／CPU fallback；1–2 jobs 起跑，依 CPU/GPU/RAM/Commit/SSD 與完成 wave 實測吞吐逐步升降至最多 4。
- normalized reduction levels 移除重複 fps/scale/pad/audio resample；1080P 在 leaf stage 即固定，final 必要濾鏡仍正確 re-encode。
- UI 新增 encoder/decoder、GPU encode/decode 與完整 FFmpeg/SSD/TEMP telemetry；ETA 改依觀測 `speed=x`。
- 完整決策與驗證見 `docs/adr/0059-bottleneck-aware-high-speed-render.md` 與 `docs/VERIFICATION.md`。
- 同專案 4K 短片段實測最快為 QSV decode＋encode／3 jobs：20.16 FPS、0.673x、CPU 29.63%、RAM peak 3.14 GiB、33.896 秒，比原 Normal 2 jobs 縮短約 32.5%；完整表見 `docs/BENCHMARK_V066.json`。
- 驗證：58 個測試檔／347 個測試、TypeScript、production build、Electron／packaged smoke、npm audit 0 vulnerabilities。
- 交付：`release/v0.66.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.66.0.exe`；SHA-256 `22A4A6F12B15A1FD8E0D8CFAED61ED507BF9B8D2D47401037235BD9F3AA2B34C`。

## v0.65.0 — 2026-09-13

- Normal Mode 改用 Total/Available RAM、CPU/GPU 負載與 Windows Commit 建立 10/14/18 GiB 階段式安全預算；24 GiB 至少保留 6 GiB，32 GiB 以上至少保留 8 GiB。
- 單一 FFmpeg filter graph 限制為最多 10 個視覺輸入；一般模式將 RAM 用於 1–4 個獨立中繼工作，依實際 wave throughput 自動升降 concurrency。
- 新增 CPU/GPU、聚合 FFmpeg RAM、Current Jobs、FPS、speed 與 SSD throughput 的 UI／NDJSON 診斷記錄。
- 完整決策與驗證見 `docs/adr/0058-adaptive-normal-render-concurrency.md` 及 `docs/VERIFICATION.md`。
- 驗證：58 個測試檔／343 個測試、TypeScript、production build、Electron／packaged smoke 及 npm audit 0 vulnerabilities。
- 交付：`release/v0.65.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.65.0.exe`；SHA-256 `942A7A326515935ACDD721B59A193DBED28BC6AEC766E353AB07803DF39360BA`。

## v0.64.0 — 2026-09-13

- 以 Windows Resource-Exhaustion Event ID 2004 確認 OOM 根因為單一巨大 FFmpeg filter graph 造成 Commit exhaustion；記錄的 FFmpeg commit 峰值約 45.86 GiB，非 C 槽 74 GiB 可用容量不足或 32-bit 限制。
- 低記憶體與一般模式皆改為動態 bounded stages，加入 RAM／Pagefile／Commit／TEMP／輸出磁碟預檢、執行中資源監測、2 GiB 低記憶體送段暫停、可理解的 OOM 建議及 warning-confirmation。
- 新增磁碟持久 checkpoint、分段 size／duration／codec／SHA-256 驗證及 restart resume；已完成 segment 不重編，final concat 失敗只重跑 final。
- 新增 1080P／1440P（2K）及橫式／Shorts 直式共用 Render Profile；Preview、字幕、FFmpeg 早期正規化與資源估算同步。新安裝預設 1080P。
- 共享 UI tokens 與四層按鍵狀態改為克制的藍／紫／粉色點綴，補齊焦點、選取、載入、警告、危險與 responsive 狀態。
- 完整決策與公式見 `docs/adr/0057-commit-safe-resumable-render-profile.md`。
- 驗證：57 個測試檔／338 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、A–G 資源／失敗續轉矩陣及 `npm audit` 全部通過。
- 交付：`release/v0.64.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.64.0.exe`；SHA-256 `FD09802B53D53FD622C12E9AEF939E7A079590EAA82D6CD8B5AB8C654ACB5914`。

## v0.63.0 — 2026-09-12

- 串連／片頭輸出改為「低記憶體分段」與「一般轉檔」互斥選擇；低記憶體維持預設，模式只控制既有 staged 或 single-graph pipeline，不更動成片內容。
- 預檢固定並排顯示兩種模式的 SSD 工作空間、RAM 峰值、時間、同時輸入與中繼工作數，並顯示目前磁碟及 RAM。預估改由 Main 讀取實際片段 metadata、插入素材、轉場、目標解析度／codec 與真實分段生命週期動態計算。
- 資源接近或超出時以橘／紅色警告但仍可切換；正式開始前照所選 pipeline 重算，只有輸出磁碟無法保留 1 GiB 才阻擋。
- 驗證：55 個測試檔／330 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實 7 段雙 pipeline 時長／解析度／codec／SSIM 比對及 `npm audit` 全部通過。
- 交付：`release/v0.63.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.63.0.exe`；SHA-256 `195219C2281D913F3536881F327164E1AA8E636ADA51AFF19B873BAF66BF2B72`。

## v0.62.0 — 2026-09-12

- 字幕預覽與 ASS 成片對齊同一 480p 樣式基準、精確垂直百分比、字體、外框／陰影及水平安全寬度；行寬上限提高為 60。
- 片頭段落超出 3–22 秒只作橘色建議，不再拖曳回彈或於輸出時截短；編輯僅保留來源邊界與 0.1 秒步進，極短片段的疊化相容性由既有轉出預檢提示。
- 網格放大預覽固定使用輸出 16:9 Canvas，直式素材套用與 FFmpeg 相同的中央等比＋同源模糊背景政策；共用 Canvas 規則同時定義 Shorts 9:16。
- 插入影片／照片的時間由正式 Timeline plan 歸回主片段；網格同時顯示素材合計、插入量及疊化後區間，後續起點與總長不再另算。
- 驗證：55 個測試檔／328 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實直式模糊背景／插入素材／雙語字幕 FFmpeg integration 與 `npm audit` 全部通過。
- 交付：`release/v0.62.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.62.0.exe`；SHA-256 `47D4B638490BA8E224B3A4F160E2D7E723200B98EC3EBF438A3774F32837178E`。

## v0.61.0 — 2026-09-12

- 串連／片頭輸出新增預設開啟的低記憶體分段模式：每個 filter graph 最多六個畫面輸入，逐層產生已驗證中繼 MP4，final stage 才套字幕／浮水印／配樂與指定成品 codec；暫存成功、失敗、取消皆清除。
- 容量／時間預估納入分段暫存；輸出頁最上方顯示片頭＋正片串接，存在已確認片頭時預設勾選並保留提示頁 review gate。
- 新增預設勾選的 YouTube 全自動上傳：固定走官方 API、不是兒童內容、完整發布資料檢查，60 秒取消窗口後才執行最終上傳；驗證失敗即停止，預設仍是不公開。
- 驗證：54 個測試檔／325 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、七段真實 FFmpeg 分段串連／暫存清理及 `npm audit` 全部通過；YouTube 自動送出採 mock API 驗證，未對真實頻道上傳。
- 交付：`release/v0.61.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.61.0.exe`；SHA-256 `11936932A2BFCD03C161A4D1906AC7DF3D108822F70871FE575FAD2391272450`。

## v0.60.0 — 2026-09-12

- 每筆字幕新增獨立 6–40 字行寬視窗；沒有單筆覆寫時中文預設 12、英文或中英混合預設 20。預覽、SRT 與 ASS 燒錄共用解析規則，單筆保存立即寫入 manifest schema 18。
- 所有影片在網格與放大預覽顯示預設勾選的無聲自動配樂。轉出前以 FFmpeg 實測各 Intro／Main 選用 IN／OUT；無音軌或最大音量 ≤ -50 dB 才使用配樂頁第一首，照片忽略，單片與整次配樂開關皆可停用。
- 驗證：53 個測試檔／320 個測試、TypeScript、production build、Electron smoke、Windows packaged smoke、真實靜音 AAC 片段輸出、畫面快照與 `npm audit` 全部通過。
- 交付：`release/v0.60.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.60.0.exe`；SHA-256 `0C5FE34BE879904209D4A334D8019551882B055EBA4E76FAD3910BCAA19363E6`。v0.59.0 hash 複核仍為 `21DFF2529E1E75C8F606695A970C60ECBE026DBE1EF98C5C38A16096EF48B8EF`。

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
