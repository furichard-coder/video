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
