# ADR-0059｜瓶頸感知高速轉檔與可觀測性

日期：2026-09-13

## 證據與真正瓶頸

v0.65.0 的實際 FFmpeg command 已使用 `hevc_qsv`／`h264_qsv`，因此成品與中繼編碼本來就是 Intel QSV 硬體編碼；不是再次換 encoder 就會解決的問題。來源端沒有 `-hwaccel`，所以 H.264／HEVC／MJPEG 解碼、`fps`、`scale`、模糊背景、overlay、zoompan、xfade、字幕與音訊濾鏡仍主要在 CPU。大量素材還會產生多層中繼；舊 reduction level 重複執行已完成的 fps/scale/pad/audio normalization，最後也因 xfade、字幕、浮水印、BGM 與 master dynamics 必須走 filter graph，不能安全改成 `-c copy`。

本機歷史 Event ID 2004 證明極端失敗是 FFmpeg Commit 約 45.86 GiB 逼近 Windows Commit Limit，不是單純 C 槽不足；本輪畫面所示 10 GiB budget、約 6.07 GiB estimated peak 也只代表估算預留尚有餘裕，不能推出「再多給 RAM 一定更快」。

## 決策

- Normal 保留現有 Intel QSV encoder 選擇，不重複包裝成新的 encoder。
- reduction level 的中繼已是指定輸出解析度、30000/1001 fps、SAR 1、yuv420p 與 48 kHz stereo，因此後續層不再重跑 `fps/scale/pad`、色彩／縮放與音訊 resample；只重設 timestamp 並執行必要 transition。這同時減少 CPU、filter buffer 與 intermediate encode 前處理。
- 1080P／1440P 仍在第一個 leaf stage 立即正規化；不再讓 4K frame 穿越所有 reduction levels。選擇 4K 時則誠實保留 4K，不偷偷降畫質。
- final concat 仍重新編碼。只要存在 xfade／acrossfade、字幕、浮水印、BGM 或 master limiter，`-c copy` 就無法產生相同內容；本輪不以內容差異換速度。
- ETA 改為 `(stage expected duration - out_time) / observed speed`，以 FFmpeg 實際 `speed=x` 校正，不再把剩餘媒體時間當 wall time。

## 高速模式與 hardware decode

新增明確 opt-in 的高速模式。它強制優先 QSV hardware encode，允許最高四個獨立中繼工作；起始仍只有一至兩個，必須由完成 wave 的實際 throughput 證明 3/4 jobs 有至少 3% 改善才上調。

H.264／HEVC 來源可嘗試 QSV decode。硬體 frame 透過 `hwdownload,format=nv12` 回到既有 CPU filter chain，避免假設所有 CPU filters 能直接消費 QSV surface。照片與 MJPEG 不冒險啟用 QSV decode；初始化、driver、decoder 或 download 不相容時，只清理該 partial 並以完全相同 graph/時間線回退 CPU decode。因硬體上傳／下載可能抵銷收益，排程仍以實測 throughput 決定是否增加工作。

## Adaptive concurrency 安全閘

每個 wave 之前同時檢查 Available RAM、Windows Commit headroom、CPU、GPU、輸出磁碟安全保留與每工作預估暫存量：

- 接近門檻：暫停送入新工作並定期重測。
- 壓力過高：已在途工作完成，不強制終止；下一 wave 降低一個 job。
- 有餘裕且完成 wave 證明吞吐改善至少 3%：下一 wave 增加一個 job。
- 3/4 jobs 未改善至少 3%：回到已知較快的 job count。

## 可觀測性

轉檔 UI 顯示實際 Encoder、Decoder、CPU Usage、GPU Encode Usage、GPU Decode Usage、RAM、FFmpeg FPS、`speed=x`、Current Parallel Jobs、SSD read/write、輸出／TEMP 可用空間與工作檔大小。所有值是 Main process 從受控 FFmpeg PID 與 Windows counter 讀取；Renderer 不能提供 PID 或偽造數值。

## 安全與相容性

所有變更只影響資源排程與等價正規化省略；來源唯讀，時間線、片段 IN/OUT、字幕、音訊、轉場、構圖、色彩與輸出 codec 不變。高速模式仍使用既有 atomic partial、checkpoint、segment size/duration/codec/SHA-256 驗證與失敗續轉。
