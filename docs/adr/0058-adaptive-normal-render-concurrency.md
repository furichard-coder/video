# ADR-0058｜一般轉檔自適應 RAM 預算與平行工作

日期：2026-09-13

## 決策

一般模式不再把 RAM 峰值固定在約 4.3 GB，也不把整個專案塞入單一大型 `filter_complex`。每個 FFmpeg process 最多處理 10 個視覺輸入；各批先正規化成固定規格的可續轉中繼片段，再進行最後串連。

## RAM 預算

安全保留量為 `max(總 RAM × 18%, 最低保留量)`；最低保留量在 20–31.9 GiB 系統為 6 GiB，在 32 GiB 以上為 8 GiB，較小系統為 4 GiB。可用轉檔預算取 `Total-reserve`、`Available-reserve` 與模式上限三者最低值。一般模式上限依條件為 8／10／14／18 GiB；低記憶體模式維持最多 6 GiB。

10／14／18 GiB 是上限階段，不是必須消耗量。若 Windows Commit、Available RAM 或 CPU/GPU 沒有餘裕，實際工作數會維持或降低。

## 自適應 concurrency

- Low Memory 固定 1 個中繼工作。
- Normal 起始 1–2 個，最高 4 個；預算不足時最高值會先降到 1–3。
- 每個 wave 全部完成後，計算 `完成片段總時長 / wave wall time`。
- 吞吐量比上一基準至少改善 3%，且 CPU < 78%、GPU < 82%、RAM/Commit 足夠容納下一個工作，才增加 1 個工作。
- RAM／Commit 接近安全門檻，或 CPU ≥ 92%、GPU ≥ 94%，目前 wave 仍安全完成；下一 wave 降低 1 個工作。
- 增加後沒有實際速度改善時停止上調，避免只提高 RAM 而沒有縮短時間。

## Telemetry

每 15 秒與每個 wave 邊界記錄 Total/Available RAM、App RAM、所有受控 FFmpeg process 的 Working Set／Private Bytes、System Commit、Pagefile、CPU、GPU、current jobs、FFmpeg FPS、`speed=x`、SSD read/write bytes/sec 與工作檔大小。記錄只用於當次本機排程及問題診斷，不上傳。

## 一致性與續轉

此變更只改中繼工作排程；每一批仍使用同一個 resolution profile、crop/scale、字幕、轉場、音訊與 checkpoint signature。中繼檔逐一驗證並保存，final concat 失敗時不重編已完成片段。平行 checkpoint 寫入採序列化原子更新，避免多工作同時完成造成 JSON 損壞。
