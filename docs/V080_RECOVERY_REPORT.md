# v0.80 Recovery Report

日期：2026-09-27

## 範圍

本次只對既有 v0.79 checkpoint 做唯讀檢查與 copy-on-write migration 驗證。來源、舊 release、舊 E: 資料與 checkpoint 不作覆寫或搬移。

## 可重用內容

- 10 個 level-1 segments 全部可讀。
- 合計約 67.547 GiB，媒體時間約 8976.718 秒。
- migration 可重用這 10 段，因此不需要重編 10 段；Base Master 仍需重跑。
- 舊版已刪除的 `base.partial.mkv` 沒有可恢復副本，列為不可恢復。

## 為何不能全程 copy

跨 group xfade、ASS 字幕與浮水印仍屬 picture graph，阻止 10 段直接全程 `-c copy`。完成畫面／基礎 master 後，最後的 audio mux 可使用 `-c:v copy`；這不等同於整段影片免重編。

## 磁碟與暫停證據

本次使用 15 秒 runtime monitor 與 EMERGENCY safe pause。v0.79 error classifier 命中 ENOSPC，但舊 raw stderr 沒有保存，不能補寫具體錯誤輸出。E: 曾顯示 144.45 GiB free 的數值是在刪除 partial 後取得的過時快照；UI 曾顯示「建議再清 20 GiB」的錯誤提示，但沒有執行該清理。因此 E: 的實際最低 free 仍未知。

## 品質與效能界線

v0.80 續轉把舊片段視為已占用空間，不再重算成新增寫入；而最後成品對 Base Master 的影片做 stream copy，不能拿較小的交付碼率估算最終檔案。依此案已驗證片段的大小與時長，保守估計新增 Base 約 86.46 GiB、Final mux 分支約 95.9 GiB，峰值新增需求約 182 GiB。E: 當時約 144.45 GiB 可用，尚差約 38 GiB，且未計入建議安全餘量。這是續轉前的估算，不是實際重新轉檔量測；App 會在啟動 Base 前重新讀取即時可用空間，若預估剩餘寫入高於實際可用空間就安全暫停，不清除舊片段。

既有 QSV GQ25 是基準。v0.80 的 30 秒 bounded 方案測試造成 SSIM 下降，最終回退 GQ25。本機 NVENC runtime 不支援；實際路徑是 QSV encode 加 CPU filter，觀測慢速瓶頸約 0.10–0.115x。未完成完整長片 render，故本報告不宣稱加速成功。

## 工程驗證

本次 run 記錄 74 files／459 tests，並通過 typecheck、production build、audit、source smoke 與 packaged smoke。這是當次執行的結果；若日後重跑，測試數、包裝輸出或其他數字可能變動，應以新證據更新本報告及索引文件。

## 公開文件限制

本報告刻意不記錄使用者私有的完整磁碟路徑、checkpoint ID、來源 fingerprint 或其他可識別資訊；公開候選文件只使用泛稱與彙總數字。

## 逐項 Recovery／Root Cause 結果

| # | 項目 | 經證據確認的結果 |
| --- | --- | --- |
| 1 | 實際完成百分比 | 已排程的第一層分段為 10／10（該階段 100%）；Base Master 與最終 MP4 未完成，不能把整體專案宣稱為 100%。舊紀錄不足以換算可信的整體百分比。 |
| 2 | 已完成 Segment | 10 個，總大小 67.547 GiB，媒體時長合計 02:29:36.718。 |
| 3 | partial MKV 可讀性 | 舊版在失敗處理時刪除了 Base `.partial.mkv`，目前檔案不存在，無法再執行 ffprobe。 |
| 4 | partial 可恢復時長 | 0；無檔案可恢復，不虛構最後 keyframe／PTS／DTS。 |
| 5 | 直接重用資料 | 驗證通過的 10 個 H.264 4K／AAC 第一層分段；舊檔原位唯讀引用。 |
| 6 | 必須重做 | Base Master picture pass（跨組疊化、ASS 字幕與浮水印），其後仍須完成音訊處理及最終 mux；舊 10 段不用重編。 |
| 7 | v0.80 讀取 v0.79 Resume | 可透過逐段驗證後的 copy-on-write migration 匯入獨立 v0.80 checkpoint；不是覆寫舊 JSON 或搬移舊片段。 |
| 8 | 從哪個時間點續轉 | 從 Base Master 時間線起點重做 picture pass；因舊 Base partial 已遺失，不能從其未知最後時間戳接續。第一層片段處理則從全部已完成狀態接續。 |
| 9 | 是否保住 23:42:03 | 保住 10 個已完成片段及 checkpoint 所記累積耗時；未能救回舊版刪掉的 Base partial。沒有重新執行完整專案。 |
| 10 | 為何顯示 144.45 GiB 仍報不足 | 舊數字是刪除 partial 後的過時快照；舊 UI 又以 `max(20 GiB, 0)` 錯誤顯示需再清 20 GiB。v0.80 另發現真實 Base＋Final 同時存在的新增峰值估計約 182 GiB，可能確實高於該可用量。 |
| 11 | FFmpeg ENOSPC 還是 Disk Guard | v0.79 classifier 命中 ENOSPC，但原始 stderr／完整命令與最低 free 沒保存；目前無法排他性證明哪一個先觸發。v0.80 保存原始錯誤與 stage 資源快照，以利下次區分。 |
| 12 | 舊磁碟估算問題 | 舊版 final delivery 估值約 42.6 GB，沒有反映 QSV 品質模式 Base 與最後 `-c:v copy` 成品同級大小；v0.80 migration 初稿又會把已占用空間的外部片段重複算為待寫，兩者均已修正。 |
| 13 | 新增寫入空間 | 依舊片段實際 bytes／duration × 1.25 與 FLAC headroom，Base 約 86.46 GiB、Final mux 分支約 95.9 GiB，合計約 182 GiB；相對當時 E: 144.45 GiB free，約差 38 GiB，且尚未保留建議安全餘量。估計非保證值，開始前會即時重算。 |
| 14 | 最慢三個已記錄工作 | 診斷中的 level-1 工作約：第 5 段 529 分、第 4 段 245 分、第 7 段 210 分。這是個別工作耗時，不可相加成完整 wall time。 |
| 15 | Decode pass 前／後 | 舊 pipeline 先解碼來源製作分段，再解碼分段製作 Base；v0.80 恢復時可跳過已完成來源分段 pass，剩下的 Base 仍須解碼 10 段。完整新輸出架構沒有宣稱從兩 pass 變一 pass。 |
| 16 | Encode pass 前／後 | 舊 pipeline 分段 encode 一次、Base picture encode 一次、最終音訊 mux 時 video stream copy；v0.80 恢復時不重編 10 段，只剩 Base video encode。尚未以完整專案驗證總 wall-time 改善。 |
| 17 | Final concat 是否 `-c copy` | 10 個 level-1 不能直接 copy 成最終畫面，否則遺失跨組轉場／字幕／浮水印；Base 完成後的最終音訊 mux 對 video 使用 `-c:v copy`。 |
| 18 | GPU Pipeline | 本機 NVENC runtime probe 失敗；實際為 H.264 QSV encode、CPU software decode／filter。沒有證據支持宣稱 GPU transition／subtitle 已生效；也沒有強行導入可能增加回傳成本的 hwdownload/hwupload。 |
| 19 | Smart Render／Cache | v0.80 實際改善是驗證後重用舊 checkpoint 分段，以及保留 Base master 供後續 audio-only mux；尚無通用逐效果 smart render，不能把 proxy 當 final source。 |
| 20 | v0.80 Benchmark 前／後 | 以同一個已完成分段的前 30 秒做 QSV 參數窄測：原 GQ25 約 20.55 秒、來源相對 SSIM 0.982671；試驗固定碼率約 20.73 秒、SSIM 0.979853，較慢且畫質下降，因此回退。此窄測不包含完整 Base filter graph，不代表整體吞吐改善。 |
| 21 | 完整專案新時間預估 | 尚未可靠量測；已觀測舊 Base 約 0.10–0.115×，若粗略外推 02:29:36.718 媒體時長，單 Base 可能約 21.7–24.9 小時，這不是 v0.80 的承諾 ETA，也未計其他階段。磁碟空間足夠後才可做代表性 Base benchmark 校正。 |
| 22 | 修改檔案 | 核心在 `src/main/services/concat-render.ts`、`render-checkpoint.ts`、`render-disk-space.ts`、`render-estimate.ts`；介面／契約在 `src/shared/domain.ts`、`src/renderer/components/ConcatRenderModal.tsx`；測試、README、CHANGELOG、VERIFICATION 同步更新。 |
| 23 | 未解風險 | 舊 Base partial 永久遺失；舊 raw stderr 缺失；E: 空間按保守峰值仍不足；完整 4K 長片與 A/V Sync 尚未實測；CPU filter／十輸入 Base graph 仍是主要速度瓶頸。後續版本應先以 30–60 秒同專案 Base graph benchmark，再決定是否做跨組畫面圖分段與相容的 Base-level cache。 |

## Model／工具分工與避免重複掃描

- 複雜 recovery、磁碟峰值與畫質取捨由 GPT-5.6 Sol 分析，機械式文件與公開候選檔案檢查由 GPT-5.6 Luna 協助；最終整合與驗證由主代理負責。
- 實際查閱範圍集中於 checkpoint、diagnostics、Render／Disk／Estimate／Codec、續轉 UI 與相關測試；未重新掃描全部 RAW 來源。
- 大型媒體只做必要 ffprobe／短段 benchmark；沒有重新跑完整 23 小時工作，也未把整份 FFmpeg log 交給模型逐行閱讀。
