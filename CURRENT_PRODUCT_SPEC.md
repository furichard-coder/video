# Current Product Spec — v0.88.0

## v0.88 Continuous Subtitle Review Contract

- Review selection/editing is independent from the active subtitle. Only explicit seek changes the playhead; active text follows exact `startMs <= clock < endMs` and updates from the current draft without rendering the final video.
- Canonical project time drives proxy handoff, photo playback, overlay and active row. Preserve play intent across native ended/pause events, guard repeated handoff, and stop at the actual timeline end. Proxy overlap uses a cut-based ownership rule; it does not reproduce Final xfade pixels or guarantee gapless audio.
- Left review list independently scrolls to a 45% focus line; the right preview stays in place. Manual scrolling overrides following for four seconds. Space/arrow player shortcuts ignore text-entry controls; save does not seek.
- AI existing-subtitle checking is opt-in (OFF); per-cue human confirmation defaults ON. KEEP/EDIT proposals include actual provider/model, evidence, cue/context revision and persisted cursor. Pending decisions pause interactive processing; retry retains completed work. Newer manual edits win.
- External or legacy videos can import an existing SRT into an independent workspace. Project-linked review requires verified output provenance and compatible project time; intro/main relative clocks are not blindly combined. Review never rewrites a formal SRT. Explicit export backs up an existing destination before replacement.
- Live OpenAI single-cue review on 2026-10-03 returned billing/quota 429; no real AI suggestion or content-quality pass is claimed. Full test/package status and remaining limitations are recorded in `docs/V088_SUBTITLE_REVIEW_REPORT.md`.

## v0.87 Subtitle Recovery and Video-First Draft Contract

- Subtitle Studio content uses a flexible, vertically scrollable main region so toolbar controls cannot collapse the cue list; narrow layouts use one column. Existing project cues remain visible and separate from AI error state.
- A confirmed native video selection takes precedence for the current analysis job. The selected path and reason are persisted in its job checkpoint so retries do not silently switch media.
- `PROJECT_AWARE` is allowed only when successful output identity includes the current project ID and its duration is within `max(2,000 ms, min(10,000 ms, round(projectDuration × 0.001)))`. Otherwise use `VIDEO_FIRST`, analyze `0 → videoDuration`, and save an independent review workspace/draft. Independent drafts have no direct apply-to-project action.
- Recheck video size/mtime and project ID/timeline revision before saving. If the project changes, save the result as an independent draft; if the video changes, reject the mixed result. Never overwrite formal SRT during analysis.
- Model choices come from a dynamic provider catalog. Unknown capability is not represented as vision support; READY requires a real minimal JPEG plus strict JSON probe. Auto may try another model only for model-unavailable, confirmed unsupported capability, or qualifying per-model rate limit; manual selection, authentication, network, and insufficient-credit errors do not silently fall back.
- API model-list success does not prove image capability or subtitle generation. For v0.87, `/v1/models` succeeded but image/JSON analysis returned `HTTP 429 / credit_balance_exhausted`; live 3–5 minute subtitle generation and content review remain unverified. A bounded 180-second real-video frame test succeeded without modifying the master. Build, Windows package and packaged smoke passed; final regression status is recorded in `docs/VERIFICATION.md`.

## v0.86 AI Subtitle Draft Safety Contract

- 字幕分析影片優先選擇同 projectId 的最新成功 Final CONCAT，再退到最近成功 CONCAT，最後才使用人工選取的 MP4／MOV／MKV；取消、失敗、離線與空檔不可自動入選。舊 output history 沒有 projectId 時只可走 recent-render 相容退路。
- 人工選檔與自動選檔只執行 ffprobe／低解析取樣；不得改寫或重新 Encode Final Output。v0.85 release、來源、正式 SRT 與 Resume checkpoint 維持唯讀。
- OpenAI／ChatGPT 視覺分析結果一律為 `DRAFT`；未經人工確認不得進入正式 SRT export 或 burn-in。Provider 失敗與取消必須明示，且不得改寫既有正式字幕。
- OpenAI／Gemini API credential 只由 Main process 的加密 credential store 取得；不得保存於 project、Renderer snapshot、log、SRT 或分析 cache。ChatGPT/Codex 登入不等於 OpenAI API Key 或 API 額度。
- 固定取樣間隔限制 1–60 秒，Provider batch 限制 10–30 張。取樣點只供辨識，不可直接當作每 2 秒一筆字幕的 cadence。
- v0.86 release 與 v0.85 release 分離封裝；任何未通過完整回歸、build、package、packaged smoke 與內容 QC 的項目不得宣稱已完成。

## v0.85 Resume Artifact Relocation Contract

- Resume 相容性分析與實際 `concat:resume` 都會在舊絕對路徑遺失時，遞迴搜尋已登錄的 SceneryWalker TEMP roots；不因磁碟代號或資料夾層級改變而直接重建。
- 候選檔先依大小與完整檔名排序，再以 ffprobe 媒體屬性及 checkpoint SHA-256 驗證；驗證通過才建立 path-remap overlay。原 checkpoint JSON 與來源檔保持不變。
- 實際 Resume 會再次執行相同復原閘門；仍缺檔或驗證失敗時停止，不會把已驗證搬移片段送回 encoder。不同磁碟的絕對路徑可直接進入既有 concat/remux 流程。

## v0.84 Resume／TEMP Manual Recovery Contract

- v0.83 的確認搬移流程停在重新分析，沒有進入 `concat:resume`。v0.84 以最新 Storage Analysis 判斷 `READY_TO_RESUME`，確認容量足夠且相容性通過後才真正啟動續轉；自動續轉選項預設開啟。
- 手動搬移只掃描已登錄的 TEMP 根目錄，限制深度與候選量。可由內容指紋辨認更名／換磁碟的完成片段；正式重用前驗證 size、ffprobe 媒體參數與 SHA-256，再 copy-on-write 更新工作 checkpoint 及 immutable relocation registry。舊 checkpoint、來源與其他成品不可被覆寫。
- 備援槽不足時不能建議搬走全部完成片段；搬移計畫須顯示逐檔、來源、目的地及兩槽搬移後餘量，並依最新空間重新計算。若手動複製後 E/C 均有副本，不可假裝 E: 已釋出空間；原副本不得自動刪除。
- 本機的 67.547 GiB 是 10 個 level-1 4K H.264/AAC 中繼片段，不是 final-ready master。可重用這 10 段而不重編來源，但仍需 Base Master 的轉場／字幕／浮水印畫面處理及後續音訊／mux。
- 本版不宣稱已跑完真實長片。App 自動跨磁碟大型複製的即時 bytes/speed/ETA、copy-only Cancel、已驗證 duplicate 的明確刪原檔工作流及 Recovery Wizard 跨啟動保存仍未完成；不得把一般「處理中」文字冒充逐位元組進度。

## v0.83 TEMP／Resume Storage Contract

- 已設定的 Render TEMP 位置有逐槽可調、持久保存的 Soft Reserve。標準 E:／非系統資料碟預設 1 GiB，C: 系統槽預設 2 GiB；Soft Reserve 僅作排程與提醒，真正停止必須考量預估剩餘寫入、即時 free、磁碟可寫與 last-resort Hard Safety。兩者不能混稱 FFmpeg `ENOSPC -28`。
- Resume 前從現存 checkpoint 與同一份剩餘峰值模型建立 Storage Analysis；先判斷主要槽是否可容納，次選新工作轉到備援槽，必要時再提出完成片段搬移。搬移或清理不能由按「繼續」隱含授權。
- 搬移僅接受已完成、有內容指紋、再次通過 size／ffprobe／SHA 驗證的 Artifact。跨磁碟先複製到唯一 partial、驗證、無覆蓋發布，更新目前 checkpoint 與不可變 relocation registry 並讀回驗證，最後才可刪舊位置。任何早期失敗都保留來源。舊 checkpoint JSON 不覆寫；載入時可依內容指紋定位搬移後的片段。
- 路徑或 reserve 變動不進入 render identity；混合 E/C segment 以各自保存的絕對路徑供後續 concat。不能把兩槽 free 當單一大卷，也不能移動正在寫入的 partial。
- 舊版 TEMP 清理先有界盤點已註冊 SceneryWalker 根目錄。UNKNOWN、partial、仍由 Resume 引用、僅因檔名或版本較舊而懷疑重複的檔案均禁止刪。已命名 cache 仍須依賴證據與使用者確認才可清；此機器目前無已證明可立即清理的舊檔。
- 本機 v0.82 checkpoint 引用 E: 上 10 個已完成 MKV（67.547 GiB）。其內容不因 v0.83 發布而自動搬移、清除或重編；完整長片續轉尚未實測。

## v0.75 Canonical Audio Track Gates

- `AudioTrackGates` 是 Intro occurrence 與 Main clip 的共用四軌 gate：Original、Voice、BGM、SFX，預設全部 `true`。Main ordinary clips 以 `SourceAsset.id` 持久化；Main insertion 與 Intro 仍以各 occurrence 的 stable ID 持久化。
- Voice gate 不代表來源影片中的人聲；來源人聲屬 Original。現階段不存在獨立 narration asset，因此 Voice OFF 是明確的 no-op gate，保留未來 voice overlay 接點。
- `buildInsertionAudioPlan` 同時解析 Intro 與 Main ordinary/insertion occurrences。Preview、Final、轉出摘要不得另建 gate 規則。
- 同曲 BGM range 可跨 `bgm=false` occurrence；播放頭依 Project Timeline 繼續，只在關閉範圍套 25 ms gain ramp。SFX event 仍為獨立 track。
- Main-start cue 是獨立的全域 MAIN SFX event，預設 ON／650 ms，可設 100–3000 ms；不受 clip SFX gate 影響。Preview 與 Final 共同使用 `mainStartCueSpec`。
- picture/base master 不包含 global/insertion BGM、SFX、track gates 或 final DSP；post-audio 以 `-c:v copy` 套 source gate、BGM gate、SFX、cue 與 Audio Processing。只有 final audio signature 改變，Resume 不重編 video。
- schema 21 migration：所有既有 clips 的四軌 gate 補為 ON，保留 schema 20 `InsertionAudioSettings`，Main-start cue 補為 ON／650 ms。

## v0.74 插入素材 Audio Plan

- `MediaInsertion.insertionAudio` 與 `IntroSuggestion.insertionAudio` 使用同一型別／sanitizer／UI，設定屬於 occurrence，不屬於來源資產。
- 照片 instance 預設 SFX ON、影片 OFF；`bgmTrackId` 未指定即不用 BGM。SFX 與 BGM 完全獨立。
- `InsertionAudioPlan` 是 Preview、Final FFmpeg 與轉出摘要的 Single Source of Truth；timeline start 已包含片段真實長度、Main 插入素材與轉場 overlap。
- 相鄰同曲 instance 合併 BGM range，播放位置跨照片／影片延續。範圍超過來源曲長時 Loop，並以 acrossfade 或有界 de-click 處理接點。
- picture/base master 先以成品 video codec＋FLAC 建立，且不含 insertion BGM/SFX。source audio、BGM、SFX 在單一 post pass 做 placement／gain／fade／loop、`amix`、Peak Protection，最後才做 Enhanced Stereo／Virtual Surround 5.1；video 固定 stream copy。
- `pictureBaseSignature` 與 `finalAudioSignature` 分離。每專案只保留最近一份經 size/hash/duration/codec 驗證的可重建 master，App 重開仍可復用；SSD 預估包含其容量，使用者可在轉檔頁確認後單獨清理。
- manifest schema 為 20；舊照片快門明確關閉保留，缺值照片按舊開關補預設，舊資料不自動開啟 BGM。

## v0.73 直式模糊填边与成功后电源动作

- Display Matrix 仍是每支素材方向的唯一事实来源。需要实际旋转且进入 blurred-fill 的 leaf input 不使用 QSV decode；它采用 CPU decode、`-noautorotate` 与唯一明确旋转，再进入 scale/crop/blur。QSV encode 保留。
- 硬解 frame 从 QSV surface 下载后必须先转换成 canonical planar `yuv420p`，再允许 `split`、`boxblur` 与 `overlay`；输出 canvas 必须完整覆盖且 rotation metadata 为0／不存在。
- 方向处理版本必须进入 preview cache 与 render checkpoint signature。修正不得以色彩遮罩、裁掉绿块或对所有9:16素材强制旋转代替。
- 成功后电源动作采用显式 opt-in，旧版或新安装预设关闭。触发事件仅为已验证 render success 或 YouTube 官方 API 完整 success；失败、取消、暂停、浏览器交接、partial完成均不属于成功。
- 动作固定为 Windows shutdown、Hibernate 或 Sleep。Main process 维护60秒倒数与实际执行，Renderer只能选择固定枚举或取消，不可传入 executable／argument／script。
- 转档和上传期间必须持有同一防睡眠 guard。新工作开始、资源仍 busy 或倒数期间出现新工作时，必须取消旧电源动作。关闭 UI 不得让倒数静默消失。

## v0.72 影片方向單一來源規格

- 每支影片的 visual orientation 必須由 coded dimensions 加 Display Matrix／rotation side data 計算，不得依檔名、`width > height` 或「9:16」全域硬轉。
- 所有 decode backend 使用相同 deterministic contract：FFmpeg input `-noautorotate`，原始 leaf frame 在 decode/hwdownload 後、任何 fps/scale/crop/pad 前套零或一次 canonical orientation filter。
- Physical portrait＋rotation 0 不旋轉；coded landscape＋matrix 90/270 交換 visual axes；180 只旋轉一次且不交換 axes。負角度必須與其等價正角度一致。
- Preview、Proxy、Intro、Main、Shorts、Segment Render、Final Render 必須讀同一 orientation resolver。已正規化 intermediate 的方向為 0，不可在 reduction/final stage 再轉。
- Upright proxy/intermediate/final 應 neutralize output rotation metadata。方向演算法版本必須納入 preview cache 及 render checkpoint identity，防止重用舊錯誤衍生檔。

## v0.71.0 字幕單筆行寬與位置微調

- 字幕單筆及批次行寬範圍統一為 6–60 字；中文預設 12、英文或中英混合預設 20 保持不變。
- 每個 `SubtitleCue` 可選擇保存輸出畫布的 X／Y 百分比座標。未設定時保持既有畫面中央 X=50% 與全域高低位置，因此舊專案畫面不改變。
- 單筆位置視窗提供上、下、左、右觸控／滑鼠按鈕；方向鍵每次微調 1%，Shift＋方向鍵移動 5%，範圍限制在安全畫布 5–95%。每次移動或恢復預設都經由 Main process 原子保存。
- 字幕 Preview 與最終 ASS 燒錄共用同一個 normalized position resolver；1080P／1440P、16:9／9:16 都只將相同百分比換算到對應畫布像素。
- SRT 標準不保存畫面位置；SRT 匯出的文字、換行與時間維持標準格式，X／Y metadata 只保存在 SceneryWalker 專案及燒錄流程。

## v0.70.0 LAN Remote Control／即時音效預覽

- Remote Control 默认关闭，只绑定一个私人 LAN IPv4。Windows 显示 IP、port、一次性 QR；iPhone Safari 使用 responsive portrait UI。
- Remote state 必须与 PC 共用 Main-owned command/state source；REST 只送语意 command，SSE 传送带 revision 的最新 snapshot。断线不影响 FFmpeg，重连先恢复 snapshot。
- Start 仅执行 Windows 已 prepared 的完整 request／output token；不得提供远端文件浏览或任意 command。Pause 仅在 checkpoint-safe boundary 生效并显示 PAUSING／PAUSED；Cancel 必须双阶段确认。
- Pairing token 十分钟、单次、fragment-only；session 使用 HttpOnly SameSite=Strict cookie + CSRF，另强制 exact Host/Origin、私人来源地址、rate/body 限制与 expiry。外网不支持 direct port forwarding。
- 音效参数试听复用现有 Proxy Video，不重新 Encode 画面；从当前播放头处理约 20 秒唯读原始高品质音讯。A/B 保持同一 playhead，以 Proxy 为时钟，允许小于 120 ms 漂移后校正。
- Preview cache 与 Final 完全分离；key 必须包含来源 fingerprint、timeline revision、range、DSP 参数和版本，支持取消/debounce/latest wins、atomic finalize、TTL/LRU/size cleanup。Final 仍重读原始高品质音讯。

## v0.69.0 Audio Processing

- 輸出設定提供 Original Stereo 2.0、Enhanced Stereo 2.0、Virtual Surround 5.1；未確認授權前不使用品牌功能名稱。
- Virtual 5.1 標準 layout 為 FL、FR、FC、LFE、SL、SR，UI 必須揭露其為 Stereo 演算法模擬，不等同原生錄製 5.1。
- 5.1 codec 至少 AAC、AC-3、E-AC-3；YouTube 預設 AAC 5.1／48 kHz／384 kbps。
- 音訊空間處理與畫面 Render 分離；影片畫面完成後，以 video stream copy 只重做音軌與 mux。
- 無音軌／聲學靜音影片套用第一首指定 BGM 後，也進入同一 Audio Processing。
- A/B 試聽與 LUFS／Peak／Clipping 結果必須來自實際衍生檔分析；5.1 在雙聲道裝置只提供明確標示的 downmix compatibility monitoring。
- 原生多聲道不可再 Stereo-to-5.1 Upmix。第一版僅在單支原生多聲道時間段可安全 stream-copy 時保持；複雜混合時間線需阻擋並說明限制。

## v0.68.0 actual render elapsed timing

- 實際耗時從第一個 FFmpeg child 已成功建立 PID 才開始；來源檢查、資源警告、使用者確認與字幕前置處理不計入。
- 同一次執行從第一個 FFmpeg 啟動至完成、失敗或人工取消連續計時，包含分段 wave、記憶體等待、階段切換與 final concat；以 monotonic clock 計算，不用固定加五分鐘。
- Renderer 每秒只做本地顯示刷新。Main 在起點、每五分鐘 heartbeat 與 terminal 狀態寫入 checkpoint 及獨立 timing history，不增加 FFmpeg 工作。
- UI 分開顯示 `已耗時` 與 `預估剩餘`。完成顯示 `轉檔完成／總耗時`；失敗或取消顯示 `本次耗時`；Resume 完成另列 `累積總耗時`。
- `render-state.json` schema 2 保存 finalized cumulative time 與 active attempt 的 monotonic elapsed、startedAt、lastHeartbeatAt。Crash／App 關閉後只恢復至最後 heartbeat，最多容許五秒時鐘漂移；關機期間不計入。
- 完成或人工取消沿用既有規則清除可續轉 checkpoint，但 `<renderId>.timing.ndjson` 保留 terminal 記錄，取消耗時不會隨 checkpoint 一起刪除。

## v0.67.0 runtime-probed render pipeline

- 高速輸出優先 H.264，但 encoder 必須以實際 FFmpeg command 通過啟動測試；本機預設 `h264_qsv`，不是不可用的 NVENC。
- H.265 可選 `hevc_nvenc`、`hevc_qsv` 或 `libx265`；硬體失敗時明示原因並由使用者改選 CPU，禁止靜默 fallback。
- Normal 是 2→3→4 adaptive waves；高速模式可由本機 profile 從 3 起步。安全閘包含 Available RAM、6 GiB 系統保留、Commit、CPU、GPU 與 SSD。
- 1080P／1440P 在 leaf stage 正規化；後續 reduction 不重跑 scale/fps/pad。存在 xfade／字幕／浮水印／BGM／limiter 時 final 仍必須 filter＋encode。
- ETA 讀 FFmpeg progress，30 秒後 EMA 校正。checkpoint 每段記錄狀態、路徑、duration、profile、codec、resolution、fps、pixel/audio format、size 與 SHA-256。
- SSD 建議空間為 working estimate 加 `max(20 GiB, capacity×5%)`；建議餘量不足只警告，真正可能留下毀損檔時才阻擋。

## Scope

Windows-first read-only source organizer. The first visible workflow remains source selection, thumbnail/proxy preview, ordering, IN/OUT, Intro and preview MP4 output. Sources, SOP files and previous releases are never overwritten.

## v0.66.0 bottleneck-aware rendering

- Existing QSV modes already emit `hevc_qsv`／`h264_qsv`; CPU software modes remain explicit `libx265`／`libx264` fallback. Encoder selection is shown during execution.
- Source decode remains CPU in Normal mode. High Speed may attempt QSV decode only for declared H.264/AVC or H.265/HEVC inputs and inserts `hwdownload,format=nv12` before the unchanged CPU filter chain. Any QSV device/decoder/download failure retries that segment with CPU decode.
- Selected output resolution is applied at the leaf stage. Already-normalized intermediates do not repeat fps/scale/pad/color/zoom/audio resample at later reduction levels.
- High Speed uses the Normal graph bound with a four-job ceiling, but starts at no more than two. RAM, Commit and SSD gates can pause or lower the next wave; CPU/GPU headroom plus a measured ≥3% throughput gain is required to increase concurrency.
- Runtime UI reports Encoder, Decoder, CPU, GPU Encode, GPU Decode, RAM, FPS, speed, current jobs, SSD read/write, output/TEMP free space and work-file size. ETA is divided by observed FFmpeg speed.
- Final stream copy is intentionally ineligible while transition/filter/subtitle/watermark/BGM/master-dynamics output is required. Timeline, audio, subtitles, transitions, composition and source-read-only guarantees remain unchanged.

## v0.65.0 adaptive Normal Mode

- Normal Mode RAM budget is calculated from Total/Available RAM and live CPU/GPU load, with 10/14/18 GiB safe tiers instead of a fixed 4.3 GiB assumption.
- 24 GiB systems reserve at least 6 GiB; 32 GiB and larger systems reserve at least 8 GiB. The controller never consumes the reserve merely to reach a target number.
- Each FFmpeg filter graph is capped at 10 visual inputs. Independent intermediate batches may run concurrently and finish independently.
- Concurrency increases one job at a time only when a completed wave proves at least 3% throughput improvement and CPU/GPU/RAM retain headroom. Memory/commit pressure or saturation reduces the next wave after current jobs finish.
- Persistent diagnostics include CPU, GPU, total/available RAM, aggregate FFmpeg RAM, current jobs, FPS, speed and disk read/write throughput.

## v0.64.0 commit-safe rendering, resume and resolution profile

- Event Log evidence proves the observed OOM was Windows commit exhaustion: 64-bit FFmpeg reached about 45.86 GiB commit against an approximately 50.44 GiB RAM+Pagefile Commit Limit. Free SSD capacity is measured separately and is never inferred to be RAM.
- Main preflight owns system-resource capture and policy. It reserves `max(4 GiB, total RAM × 18%)`, computes a render RAM budget, selects bounded inputs/threads, and returns both low-memory and normal estimates. Low-memory uses 3–6 inputs; normal uses a larger adaptive batch capped at 16. Both avoid an unbounded all-project filter graph.
- Persistent checkpoint metadata and verified H.264 intermediates survive process/Windows restarts. A segment is reusable only after file existence, size, codec, duration tolerance and SHA-256 pass. Project revision and render-request signature prevent stale reuse. Final-only failure resumes at final concat.
- Runtime monitoring samples available RAM, FFmpeg working/private bytes, App memory, Commit, disk free and retained work files. New stages wait while Available RAM is below 2 GiB; user cancellation deletes the job, while App-close interruption preserves it.
- `render-profile.ts` is the output resolution source of truth. 1080P and 1440P map to 1920×1080 and 2560×1440 landscape, with swapped 1080×1920 and 1440×2560 portrait. Geometry normalization happens inside each source/stage filter before expensive composition; Preview and ASS subtitle layout consume the same profile without requiring full-resolution browser playback.
- Shared UI tokens define Primary／Secondary／Tertiary／Destructive hierarchy and blue／purple／pink／warning／danger states. Core render action remains the only Primary action in its footer; mode/resolution selection has explicit pressed state and keyboard focus indication.

## v0.63.0 dual render strategy and workload-based resource comparison

- Main and Intro output expose two mutually exclusive strategies. `LOW_MEMORY_SEGMENTED` remains the persisted default; `NORMAL` uses one filter graph. The selected Boolean is passed unchanged through preload/IPC to the existing `ConcatRenderService`; no timeline or content setting is derived from it.
- Every preflight returns both mode estimates from one disk/RAM snapshot and one canonical selection workload. The workload is resolved in Main from project `SourceAsset` metadata plus the exact ordered clip selections, insertion IDs, transition duration and generated Main-start-card count; Renderer cannot supply arbitrary source paths.
- Output bytes use duration × resolution/codec bitrate plus AAC and container allowance. Temporary SSD peak simulates the real partial output and recursive six-input H.264 intermediate lifecycle, including the moment a replacement is created before consumed intermediates are deleted. Final remaining disk is based on the finished output, while the existing 1 GiB reserve gate checks peak working footprint.
- RAM peak estimates live source decode queues, codec/FPS-weighted source frames, normalized output/filter buffers and actual maximum concurrent inputs. Normal mode uses every visual input; staged mode uses six, conservatively seven only when the generated Main-start card must stay with both boundary clips.
- Time estimates combine target codec/resolution realtime cost with duration-weighted source resolution, FPS and decode codec complexity, transition/input graph cost, insertion cost and every simulated intermediate stage/job. Values are explicitly approximate and do not claim benchmark precision.
- Orange/red SSD or RAM pressure remains advisory at selection time. Only insufficient disk reserve blocks actual start. Both pipelines preserve the same ordered clips and final render filters; actual FFmpeg integration verifies matching duration, resolution and codec.

## v0.62.0 preview/render parity and canonical inserted duration

- Subtitle Preview and ASS burn-in use one 854×480-authored style contract: identical wrap resolver, font-size/outline/shadow scaling, Microsoft JhengHei primary font, scaled horizontal margins, anchor growth direction and exact vertical percentage. Manual per-cue and global wrap limits are 6–60; automatic defaults remain Chinese 12 and English/mixed 20.
- An Intro segment's persisted IN/OUT is also its render IN/OUT. The 3–22 second range remains AI/balancing guidance and an orange UI warning only; it no longer caps or snaps manual changes. The editor keeps only source bounds and a 0.1-second step. Existing render preflight still reports when an extremely short segment cannot support the selected transition.
- Expanded grid Preview is composed on the output canvas rather than the source aspect. Main is 16:9; the shared policy also defines Shorts as 9:16. Portrait-on-landscape uses the same centered contain foreground plus same-source blurred fill decision as FFmpeg; landscape uses centered contain plus black pad. FFmpeg output composition is unchanged.
- `buildTimelinePlan` remains the sole output-time calculation. `buildMainTimelineGroups` only groups those exact render clips back onto their top-level anchor card, so inserted video/photo duration is included in the displayed source sum, transition-adjusted span, total duration and subsequent start times.

## v0.61.0 low-memory segmented render and guarded full-auto YouTube upload

- Main and Intro output default to a low-memory segmented mode. At most six visual inputs are normalized and joined per FFmpeg filter graph; large timelines are reduced recursively, then subtitles, watermark, BGM and final output codec are applied once at the final stage. Main-start-card boundaries remain adjacent while grouping so the existing transition semantics stay intact.
- Intermediate files use unique per-job folders beside the selected output, are verified as playable MP4, and are removed when consumed or after success, failure or cancellation. Disk preflight includes an explicit temporary-space allowance and the UI warns that the safer mode trades additional disk I/O and time for substantially smaller filter graphs.
- The output page places the Intro + Main option first. It is checked when confirmed Intro segments exist, opens the existing Main-start-card review, and remains user-switchable; no Intro content is invented when none exists.
- Main YouTube full-auto upload is default-on and uses the existing official OAuth/API path, never simulated Chrome clicks. It fixes audience to not made for kids, applies the explicit playback/thumbnail/title/description/chapter/channel/visibility review gate, and invokes the existing final upload action after the 60-second cancellation window.
- Full-auto upload stops before any network upload when the YouTube account/channel is not connected or mismatched, title/description/chapters/thumbnail validation fails, or no completed output exists. Upload remains unlisted by default; Chrome + Explorer handoff is still available after full-auto is disabled.

## v0.60.0 per-cue subtitle width and selected-range silence detection

- Every subtitle cue has an effective line width. With no cue override, Chinese-only text uses 12 characters per line; English or mixed Chinese/English uses 20. A per-row dialog exposes a native 6–60 number input (keyboard Up/Down and typed entry), saves immediately through the canonical subtitle manifest path, and can return the cue to automatic language defaults.
- Per-cue override wins over the optional global bulk override. Subtitle-page overlay, SRT serialization and ASS burn-in call the same shared resolver; translated English text therefore receives the English/mixed default when the cue and global profile are automatic.
- Manifest schema 18 persists the optional per-cue override. Older cues migrate with no synthetic value: their effective default is derived from current text, so later language edits remain correct until the user makes a manual override.
- Every VIDEO card and expanded preview shows a default-on selected-range auto-BGM switch; IMAGE assets never show it and never enter acoustic analysis.
- Before Intro/Main render, VIDEO clips with the switch enabled are measured over their exact source IN/duration using local FFmpeg `volumedetect`, with at most two analyzers running concurrently. No audio track or maximum volume at/below -50 dB is silent; louder content is not auto-dubbed. Results are cached by source preview fingerprint, range, analyzer version and threshold for the App session.
- Auto-dub uses the literal first item on the BGM page when it is a resolved local track, reuses its gain/fades, and is scoped to the silent clip's output range. Per-render BGM disable and per-clip opt-out remain authoritative. Detection and render read sources only; previous releases are unchanged.

## v0.59.0 silent auto-dub, grid output times, subtitle wrap fixes

- Silent VIDEO clips (no audio track) are auto-dubbed at render with the first READY BGM track laid under exactly their output range, reusing that track's volume/fades. The grid card shows a default-on 無聲自動配音 checkbox for silent videos; opting out keeps the clip silent. Applies to 片頭/串聯 renders when BGM is enabled; the result reports autoDubClipCount.
- Grid cards show each rendered clip's output time range (串聯後 mm:ss→mm:ss) computed from the canonical timeline plan with the active transition. Display settings add two switches: show/hide the ranges, and include/exclude the 片頭＋即將開始提示頁 lead time (estimated from current render defaults).
- Subtitle wrap fixes: the 每行字數 field no longer clamps while typing (raw integer committed, Main clamps 6–60 on save), and the preview overlay anchors multi-line blocks the same way as the burned ASS anchor (top-down / centered / bottom-up) so tall subtitles no longer drift off-screen.
- The dub flag is render-only metadata: toggling it never bumps the timeline revision and never triggers subtitle re-review.

## v0.58.0 adjustable subtitle width with true preview, transparent master bus

- Subtitle display format gains 每行字數: 6–60 manual override, blank means automatic width-derived wrap as before. The setting persists with the existing style preset and flows into ASS burn-in.
- The subtitle-page preview overlay wraps with the identical shared helper, so line breaks match the finished MP4 at any output resolution (wrap ratio is resolution-invariant by construction).
- Master bus no longer rides the program: acompressor threshold -6 dB ratio 4 → -1 dB ratio 2, so it only catches true peaks under the ceiling and preserves the contrast created by per-clip ducking. Measured on synthetic material: detector-band bursts still duck ≈4 dB, beds untouched, non-detector loud passages keep ≈1.9 dB more contrast than before, peaks still capped.
- Audio panel documents the most audible combination (6 dB + crowd preservation off) and states EQ/ceiling are subtle by design.

## v0.57.0 background render with concurrent subtitle work

- Concat/Intro render runs as a background job: pressing × closes the render window and returns to the main screen while encoding continues; the main-screen background-jobs banner keeps showing live percent.
- Reopening the render page while a render runs adopts it in monitoring mode (live progress, cancel still available, no second render can start); completion or failure is reported in place and the finished file appears in the output library.
- Subtitle review and SRT export stay fully usable during a render. The running render uses the project snapshot taken at start (store `getProject()` deep-clones), so later subtitle edits never alter the in-flight output; the UI states that the finished file reflects the content at render start.
- Explicit 取消產出 still aborts through the single-flight controller with the existing safe-finalize contract; closing the window never cancels.

## v0.56.0 immediate per-cue subtitle persistence

- Every visible subtitle row owns a native textarea and adjacent per-row actions: confirm, delete, move up and move down. Focusing or clicking the textarea must preserve normal native caret placement, selection, arrow navigation and text entry; row selection remains isolated on the numbered selector.
- Individual confirmation persists the current complete cue snapshot immediately through the canonical Main-process `setSubtitleCues` validation path. The UI reports success only after the manifest write returns successfully; a write failure leaves the edit dirty and visible with an error.
- Forced review does not advance to the next cue until the current confirmation write succeeds. Global confirmation toggles and Shift-selected confirm/unconfirm actions use the same immediate persistence contract. Deletion retains its explicit safety prompt and source-media isolation.
- Up/down is defined as moving subtitle content to the adjacent chronological slot within the same Intro/Main scope. The two cues exchange output time and source anchor fields, are both marked `DRAFT`, and are immediately persisted. This preserves deterministic timeline order while requiring a fresh picture/text review after the content position changes.
- The footer save action is retained only for unconfirmed free-form text/time edits. It is disabled when there is no dirty local edit and is not a prerequisite for any confirmation action.

## v0.55.0 versioned delivery, safe confirmations and subtitle review

- Every newly packaged Windows executable includes the semantic version in its filename: `SceneryWalkerSourceOrganizer-v<version>.exe`. The release folder remains versioned separately, so a user can identify the binary even after copying it elsewhere.
- Compact App confirmation overlays identify a non-destructive safe default. When they open, that button receives keyboard focus and the Windows pointer is moved to its center on a best-effort basis. Renderer coordinates are bounded to the owning window before Main converts them to a physical screen point; the helper runs without shell interpolation. Close confirmation defaults to `繼續剪輯`, never `確定關閉`.
- Per-cue Subtitle review requests only the selected source range as a low-resolution H.264 clip proxy instead of transcoding the complete 4K／HEVC source. Cache keys remain bound to source fingerprint and exact IN／OUT. A verified output fingerprint avoids repeated ffprobe startup on later cache hits; mismatch still triggers codec validation and rebuild.
- `強制重新校對` first re-derives selected cues against the canonical current Intro/Main plan, including order, IN／OUT and the selected 0.3／0.5／0.7-second transition. It then opens a per-cue human review queue with `一致，確認並下一筆`, `不一致，修改文字／時間`, skip and finish actions. This is an explicit visual check and does not falsely claim AI verified picture semantics.
- Timeline remapping refreshes `sourceOutMs` together with output time and `sourceInMs`, so the short review proxy always reflects the remapped cue duration. Images use their cached still preview.
- Manually adding an Intro video/photo or a saved zoom range preserves every existing segment IN／OUT and the configured Intro target duration. It no longer invokes equalized redistribution and no longer auto-increases the target. If the new range does not fit the remaining target capacity, the App stops and asks the user to explicitly shorten/remove a segment or change the target.

## v0.54.0 local audio protection and scoped BGM

- `AudioProtectionOptions` is a per-render, persisted preference contract. Current defaults enable the master switch, smooth voice/sudden-event ducking, distant-crowd preservation, scene-sound preservation, a gentle speech-band EQ, 6 dB maximum ducking, 1.5 dB EQ attenuation and a -1 dB peak ceiling. Accepted ranges are 3–6 dB ducking, 0.5–4 dB EQ and -1／-2 dB ceiling.
- The detector is strictly local and acoustic. Each source-audio stream is split into dry, wet and detector paths; the detector is high-pass/low-pass constrained to 1–4 kHz and drives `sidechaincompress`. A dry-floor plus compressed-wet blend bounds the deepest automatic reduction to the chosen 3–6 dB. Preserve-ambience mode raises the threshold; preserve-scene-sound mode uses 45 ms attack and 500 ms release for smooth recovery.
- Optional 2.5 kHz equalization gently reduces speech intelligibility across the requested 1–4 kHz region. Final program audio passes through a compressor and `alimiter` at the selected -1 or -2 dB ceiling, covering broad-band sudden shouts, impacts and clipping risk as well as speech-band events.
- The App must not label acoustic inference as semantic privacy classification. It cannot understand speech content or reliably distinguish all screams, child cries, laughter, market calls, footsteps and other overlapping spectra. The UI exposes this limitation and requires a post-render listening pass. No audio is uploaded for this feature and no editable detector keyframe list is fabricated.
- `BgmScopeSelection` independently enables Intro and Main music for `CONCAT`. Both selected preserves the continuous existing mix. Intro-only truncates the MP3 plan at the actual start-card boundary and enforces up to a 1.5-second fade ending before the card. Main-only shifts the saved BGM timeline to the actual first-Main start after the card. Boundaries consume the selected 0.3／0.5／0.7-second transition style, including hard-cut behavior.
- All validation runs in Main. Renderer submits numeric settings and scopes only; FFmpeg values are bounded before filter construction. Sources and MP3 files remain read-only, output keeps the existing unique-partial／atomic-finalize contract, and render sleep protection remains active until cleanup completes.
- Main and Intro timing mutations continue through `syncSubtitlesToTimeline`: each cue anchors to a stable Intro segment, media insertion or source asset plus source-relative time, then remaps against the new clip duration, order and selected transition overlap. Unmappable cues retain text/time as `DRAFT`; no cue is silently deleted or reassigned to unrelated footage.
- Subtitle review exposes a confirmed `forceSubtitleReReview(scopes)` Main-process operation. It preserves cue text/times, leaves `REJECTED` cues untouched, marks selected non-rejected cues `DRAFT`, invalidates only the selected scope review revision and records a human-QC warning. Reconfirmation remains per cue or explicit batch, followed by normal save.

## v0.53.0 scoped preview output and subtitle visual parity

- The shared concat-output page has an explicit `CONCAT`／`INTRO` selector. `INTRO` emits only the selected Intro ranges, reuses the same codec, resolution, watermark, BGM, preflight, partial-file and cancellation safety contracts, and never silently includes Main clips.
- A completed Intro preview is an eligible YouTube test artifact. Chrome＋Explorer drag/drop remains the default handoff and the official YouTube API remains the secondary route. Both retain human confirmation and unlisted/private defaults. Intro is still blocked from BiliBili/TikTok Main-post handoff.
- Intro YouTube QA uploads start with an Intro-specific local title/description and do not silently attach the saved Main video's AI title, thumbnail or chapters. This prevents a short test clip from inheriting invalid Main chapter times or misleading publish copy.
- Standalone Intro output and the shared Intro selector expose the same opt-in subtitle burn control. Enabling requires confirmed, current `INTRO` cues; Main cues are excluded. Output history records remain `purpose=INTRO`.
- `SubtitlePreviewStyle.fontSizePx` is defined against the 854×480 subtitle-review canvas. The primary burn-in track consumes this exact profile and scales by output height (`fontSizePx × height ÷ 480`); the UI writes the same preference from either Subtitle review or the render page. Optional translated tracks keep their independent 1080p sizing and position.
- ASS cue placement uses transition-aware logical clip starts for Main and Intro, matching the canonical render plan. Subtitle-page text, render-page settings and output filters therefore no longer use conflicting size or overlap time bases.

## v0.52.0 transition-aware subtitle anchoring, large text and Gemini material vision

- Manifest schema 17 persists one canonical `timelineTransitionSeconds` value limited to 0.3, 0.5 or 0.7 seconds. Renderer preferences synchronize this value before output. Main/Intro timeline plans, AI subtitle placement, visual-material placement, subtitle duration gates, Intro subtitle proxy and publishing chapter duration consume the canonical transition-aware plan.
- Every Main/Intro timeline mutation captures the prior plan, anchors each cue to a stable Intro segment ID, media-insertion ID or source asset plus source-relative time, then maps it into the new plan. Moving or inserting a photo/video therefore moves its cue and shifts following cues. Changing the transition duration itself also remaps cues.
- Confirmed cue collisions introduced by a crossfade shorten the earlier cue when at least 100 ms remains. A cue that cannot be mapped or safely separated is retained as `DRAFT` with a review warning; text is never silently deleted and unrelated footage is never guessed as its source. Successfully mapped scopes advance their subtitle-review revision with the timeline revision.
- Every subtitle-list row exposes a native inline textarea. Focusing it selects that cue without taking over the caret; pointer caret placement, arrows, text selection and typing remain native, while the separate numbered button owns single selection and Shift contiguous multi-selection. Delete shortcuts ignore focused text inputs.
- UI text-size choices are 16, 18, 20, 22, 24 and 26 px. The last two are explicitly labeled 超大 and 特大 and persist through the existing local display preference.
- `GEMINI` replaces `GOOGLE_LENS_ASSISTED` in the material-analysis contract. Photos default to Gemini, while video accepts explicitly selected frames. The service sends only the derived JPEG frame to the configured Gemini model using the encrypted Gemini API key, requests strict JSON, and normalizes a short Traditional-Chinese subtitle, visual/object/location evidence, animal species/common name, species explanation, confidence and warnings.
- Gemini identification must remain evidence-bound: uncertain species use a broader group or `疑似`; no location or species may be inferred from a filename/topic alone. Missing credentials or provider errors are surfaced before any subtitle is inserted. ChatGPT/Codex visual analysis remains selectable as the alternate route.
- Every media render acquires a reference-counted Windows `prevent-app-suspension` blocker before creating output. Failure to activate the blocker prevents render start. The blocker is released only from the render `finally` path after success, failure or cancellation cleanup. While active, normal App close is disabled and the Windows session-end request is prevented; forced shutdown or power loss cannot be guaranteed by an application.

## v0.51.0 overlap review, render preflight and configurable AI density

- A material visual analysis result is never discarded solely because its proposed cue overlaps an existing cue. The result contract includes the editable draft plus the exact overlapping cue IDs, text and time ranges. Non-overlapping drafts may be confirmed immediately; overlapping drafts enter the manifest as `DRAFT` only after the user chooses to open Subtitle review.
- Subtitle review computes overlap pairs live within each Main/Intro scope. Both sides of every active overlap receive a red outline until their ranges no longer intersect. A still-overlapping cue cannot be confirmed individually or by batch; draft overlap is allowed as a temporary editing state, while two confirmed cues remain invalid.
- AI subtitle generation accepts a user-selected target of 1–300 cues, default 100. Sampling density is distributed within retained clips with a minimum readable slot; confirmed existing cues, short clips and unavailable timeline space may reduce the result. Higher values explicitly cost more analysis time and AI usage.
- Every user-facing Main, Intro, Clip and Shorts render requests a preflight estimate for output bytes, render time, current free bytes and estimated free bytes after completion. Main process repeats the disk-space check immediately before launching FFmpeg. A render is denied when its estimated output would leave less than the mandatory 1 GiB reserve.
- Shorts explicitly requests `H265_QSV` and uses the same preflight contract. Estimate numbers are guidance rather than promises because scene complexity, filters, subtitles, BGM, watermarking and system load affect actual output.

## Canonical project state

- `ProjectManifest` is the persisted source of truth; schema 17 migrates older manifests without dropping fields.
- Main and Intro timeline revisions and subtitle review revisions are tracked independently.
- `ProjectStore` emits `project:changed` after every persisted mutation. Renderer state replaces only the canonical snapshot; changing project while a background job is running is blocked with an owning-project message.
- Background jobs carry `projectId`, project name and timeline revision for auditability.

## Subtitle and AI rules

- AI knowledge subtitles use Codex/ChatGPT login fallback when OpenAI API billing is unavailable; speech transcription remains opt-in.
- AI regeneration modes: fill blanks, preserve human edits, or replace AI cues in the selected scope. Manual/imported/user-edited cues are protected.
- Subtitle burn-in is per-output and opt-in. The checkbox can always be cancelled before render; enabling requires confirmed, current cues for the selected Main or Intro scope.
- Burned-in subtitles are video pixels and are never edited in place. Subtitle-only corrections create a new output from a clean no-subtitle video or the read-only sources; old MP4 outputs are not overwritten. SRT or a future soft-subtitle track may be replaced without video re-encoding.
- AI-generated subtitle cues are persisted as `CONFIRMED` immediately. The subtitle review page offers a visible all-scope confirm/unconfirm toggle, selected-cue confirm/unconfirm/delete actions, and a per-cue delete button. Shift selects a contiguous range for batch actions; deleting a cue only removes it from the manifest.

## Timeline and output

`src/shared/timeline-plan.ts` is the deterministic plan layer used for output position, overlap duration, subtitle mapping and BGM clipping. Proxy files remain derived cache and never become formal sources.

## Editing UX

All millisecond fields use the shared minute/second/millisecond editor. The renderer exposes autosave state and protects dirty Subtitle/BGM drafts when a canonical project snapshot arrives from another window or background job.

The main screen exposes eight primary workspaces: sources/order, Intro, BGM, subtitles, project watermark, preview/output library, publishing settings, and AI publishing assets. Per-material edits enter a single Material Editor workspace before opening the detailed safe editor. Output pages use the shared compact OutputLibrary provider for recent files and actions. As of v0.41.0, `useOutputLibrary` and `OutputRecordActions` are the shared query/action layer for Concat, Intro, subtitle and global output views; global registration/removal and platform handoff remain owned by OutputHistoryModal.

On the Subtitle workspace, the shared Intro preview history is collapsible and defaults to collapsed so it cannot consume the synchronized video review area. The Intro workspace keeps the history expanded as before. Expanding the Subtitle history mounts the same shared `OutputLibrary`, so playback, reveal and copy actions remain canonical.

## v0.42.0 incremental fix

The permanent-subtitle checkbox is explicitly reversible before rendering. A saved enabled preference remains visually and functionally actionable even when the current project has no confirmed cues or requires subtitle review; turning it off is always allowed and persists `enabled: false`. Enabling still requires confirmed, current subtitles. The source files and existing output are never modified by this setting change.

## v0.43.0 publishing vertical slice

v0.42.0 contained partial domain/IPC scaffolding only. v0.43 adds the visible seventh `AI 發布素材` workspace, editable topic snapshot, title/description/hashtags/chapter review, external-AI prompt copy/paste validation, traceable thumbnail candidate editing and local 1280×720 render/import path, plus a visible Intro-to-Shorts flow. Shorts explicitly validates selected Intro segments and writes `purpose=SHORTS` output history records. YouTube upload accepts a selected thumbnail only after final user confirmation; `videos.insert` success and `thumbnails.set` failure are reported separately with retry.

Remote publishing-material generation remains honest: the current service uses a traceable local fallback/template after an account diagnostic and does not claim an unimplemented model response as Structured Output. AI image generation is not claimed; only source-frame composition or user-imported JPG/PNG is used.

## v0.44.0 true AI generation contract

OpenAI Responses (`store:false`, active vision model, strict `json_schema`) now receives only the topic/context, canonical transition-aware timeline summary and three low-resolution cached candidate frames. If the active API account fails, the service attempts the Codex/ChatGPT CLI provider with `--ephemeral --ignore-user-config --sandbox read-only --output-schema`; only when both providers fail is the result labeled `LOCAL_FALLBACK`. Provider/model and complete failure reasons are persisted in warnings. External AI paste-back uses the same full schema and validates candidate IDs and chapter rules. AI image generation remains disabled; thumbnail generation is local composition or user JPG/PNG import.

## v0.45.0 YouTube final review gate

The upload payload is composed once from the selected title, Chinese description, English summary, chapter time codes and hashtags. Chapter text and hashtags are reserved ahead of prose when enforcing YouTube's 5,000-character description limit. The upload workflow has a separate final-review step that streams only the selected OutputHistory MP4 and the current manifest's selected thumbnail. It displays the exact text payload, channel, privacy, audience setting and chapter status, and requires an explicit human review checkbox before `youtube:upload` can be invoked. YouTube transcoding, copyright and community checks remain authoritative in YouTube Studio.

## v0.48.0 project watermark and visible AI publishing results

Watermark settings are canonical project state in schema 16. The verified Caota Sand Dunes default is Chinese `漫步\n風光` at lower-left and `SceneryWalker` at lower-right, scaled from a 1080p baseline of 51/41 px and 63 px safe margins. The default cadence starts at 0 seconds, repeats every 360 seconds, stays visible for 15 seconds and fades in/out for 1 second. Text and box opacity default to 82% and 24%. Main-complete output and standalone Intro are enabled by default; Shorts is explicit opt-in. Main-process normalization requires distinct lower corners and validates every timing/opacity/size limit. The final drawtext pass is applied only to new output after optional subtitle composition.

AI publishing visual candidates now prioritize the exact midpoint of selected Intro ranges, then fill from the canonical Main timeline. Candidate extraction creates three traceable, low-resolution analysis frames at their declared source time codes. OpenAI/Codex prompts include the topic, story promise, Intro order, Main timeline and candidate origin, and explicitly ask titles and thumbnail concepts to reflect the opening visuals. After any provider result—including honest local fallback—the App builds three local 1280×720 thumbnail previews from the referenced source frames. The scrolling result summary immediately shows provider, selected title and selected thumbnail; remote AI image fabrication remains out of scope.

## v0.49.0 upload handoff, codec, publishing review and species evidence

- The default YouTube handoff opens the official upload page in Chrome, copies the indexed latest Main MP4 path and asks Windows File Explorer to select that exact file. The human performs the actual cross-application drag and final YouTube publish action. The existing OAuth/API flow remains an explicit secondary choice and retains its final-review gate.
- New render preferences default to H.265/HEVC (`libx265`, `hvc1`) with H.264/AVC as the compatibility option. The chosen codec and the per-render watermark choice are validated in Main, persisted in user preferences/output history, and sent explicitly by the Renderer. Watermark is checked by default; opting out affects only the new output.
- Watermark settings use responsive auto-fit grids, width containment and wrapping footer actions so narrow windows do not overlap or cover controls.
- Codex/ChatGPT is the primary publishing-material generator. OpenAI API is a fallback on the same OpenAI path; optional Gemini 2.5 Flash is a second reviewer that can recommend only an existing generated title ID and thumbnail ID. Gemini failure never discards or relabels the ChatGPT result.
- The publishing workbench presents selected output, titles and visible thumbnails before description/chapters/advanced paste-back. Title prompts require distinct, scene-specific candidates within 100 characters; thumbnail copy is brief and composition-aware while remaining tied to traceable source frames.
- Subtitle story-frame evidence may include `animalSpecies` and `speciesExplanation`. Empty means no animal detected. Uncertain sightings must use a broader class or `疑似`, reduce confidence and add a warning; no species fact may be invented from topic text alone.

## Verification baseline

Run `npm run typecheck`, `npm test`, `npm run build`, `npm audit --audit-level=high`, `npm run package:win`, and `npm run smoke:packaged`. See `docs/VERIFICATION.md` for the release record.

## v0.50.0 GPU render and material visual-subtitle workflow

- New renders default to Intel Quick Sync Video (QSV) H.265/HEVC (`hevc_qsv`, MP4-friendly `hvc1`). GPU H.264 (`h264_qsv`) is also available; CPU H.265/H.264 remain explicit fallbacks. The selected encoder is persisted and recorded in output history. Existing legacy preferences are preserved until the user changes them.
- The render UI labels GPU versus CPU choices clearly. The current Windows machine was verified with one-second synthetic H.265 QSV and H.264 QSV encodes; actual project renders still require normal media, filter, transition, subtitle, BGM and watermark QC.
- Each photo card has a checked-by-default visual-analysis option. The user opens the material analysis panel, chooses Main or Intro, and receives an editable subtitle draft containing visual summary, location, visible objects, animal species when supportable, species explanation and source time evidence.
- Each video card can open the same panel and accept one or more source-relative frame times (`mm:ss`, `hh:mm:ss` or decimal seconds). Exact selected frames are extracted into a derived storyboard and analyzed without modifying the source. The current IN/OUT/Intro range is enforced before analysis.
- ChatGPT/OpenAI is the default analysis route with Codex/ChatGPT login fallback. Google Lens is an explicit manual-assisted route: the App opens Lens, the user performs the external selection and pastes the observation back, and ChatGPT/Codex simplifies it. The App never silently uploads local files to Lens.
- Analysis results remain `DRAFT` until the user edits text/time and presses “確認並加入字幕頁”. Only then are cues saved as `CONFIRMED`; all existing subtitles remain untouched. Overlap, out-of-range times and provider failures are surfaced instead of silently inserting content.
- Visual-analysis cache, frame evidence and provider warnings are stored under App Data. Source media, SOP files and existing MP4/SRT outputs remain read-only and are never overwritten.
