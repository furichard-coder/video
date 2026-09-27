# ADR-0060｜實際探測驅動的 v0.67 Render Pipeline

日期：2026-09-13

## v0.66 真正瓶頸與原流程

實際 command／runtime log 證明 v0.66 成品不是 NVENC，而是 `h264_qsv`／`hevc_qsv`（CPU 備援為 `libx264`／`libx265`）。原流程為：來源 → CPU 或高速分段 QSV decode → 必要時 `hwdownload,format=nv12` → CPU `fps/scale/pad/crop/boxblur/overlay` 與色彩／zoom → CPU `xfade`／`acrossfade` → CPU ASS subtitle／drawtext watermark／BGM／limiter → QSV intermediate encode → 多層 reduction → final QSV encode。

瓶頸不是 RAM budget 數字，而是 4K decode＋CPU filter、巨大 graph buffer、多層 intermediate 工作與 final 必要重編碼。歷史 OOM 是 Windows Commit 接近上限後 FFmpeg filter allocation `-12`；提高 RAM target 但不增加有效 parallel work 不會提高 throughput。

## 實機 encoder／decoder結果

FFmpeg 8.1.2 列出 `h264_nvenc`、`hevc_nvenc`、`h264_qsv`、`hevc_qsv`，但列出不等於可用。短片 runtime probe 結果：

- `h264_nvenc`：失敗。NVIDIA driver 提供 NVENC API 13.0，FFmpeg 要求 13.1。
- `hevc_nvenc`：同原因失敗。
- `h264_qsv`：成功。
- `hevc_qsv`：成功。

因此不能說 Quadro M2000M「硬體只支援 H.264、不支援 H.265」；在目前 driver／FFmpeg 組合下，兩種 NVENC 都無法啟動，而 Intel QSV 兩種都可用。H.264 QSV 因相容性與本機 throughput 成為建議預設。更新 driver 或 FFmpeg 後 fingerprint 改變，App 會重跑 probe。

## 新流程與 CPU／GPU 分工

1080P／1440P 在第一個 leaf stage 立刻正規化到目標尺寸、30000/1001、SAR 1、yuv420p、48 kHz stereo；後續 reduction level 只重設 timestamp 並做必要 transition，不重跑 scale/fps/pad。高速分段的相容影片由與 encoder 同後端的 QSV 或 CUDA/NVDEC decode；因 `xfade`、ASS、drawtext、複合 overlay 與音訊鏈仍是 CPU filter，硬體 frame 只做一次 `hwdownload`。不強行套用 GPU scale/overlay，避免之後又為 CPU-only filters `hwdownload`／`hwupload`，增加 VRAM copy 反而變慢。

每個 intermediate 只 encode 一次。Final 僅在 codec、resolution、fps、pixel format、audio format 完全一致且沒有 xfade/acrossfade/subtitle/watermark/BGM/limiter 等 filter 時才可考慮 `-c copy`；現行正式內容通常含至少 xfade/audio mix，因此保留一次 final encode，不能以內容差異換速度。

## Adaptive concurrency、OOM 與 SSD

24 GiB 系統保留至少 6 GiB，Normal target 8–10 GiB。Normal 由 2 jobs 起步，高速在系統閒置時可由 profile 的 3 jobs 起步；每個 wave 後以實際 media-duration/wall-time throughput 檢查是否至少改善 3%，有餘裕才升到 3／4。Available RAM、Commit、CPU、GPU Encode／Decode／Compute 或 SSD 壓力上升時不送新工作，下一波降級，不殺在途工作。

SSD 的硬門檻仍是 1 GiB，避免輸出成為毀損檔；建議門檻是 `estimated working + max(20 GiB, capacity×5%)`。建議不足顯示警告並允許確認繼續。

## Resume、ETA 與可觀測性

每個完成 segment 立即 atomic 更新 render state，包含 completed/failed、output path、duration、profile、codec、resolution、fps、pixel/audio format、size 與 SHA-256。segment 9 失敗只從 9 繼續；segments 全完成而 final 失敗只重跑 final。

FFmpeg progress 讀 `out_time`、`fps`、`speed`。前 30 秒保留穩定的媒體時間估計，之後以 `speed` 的 0.25 EMA 更新 `remaining media duration / smoothed speed`。Runtime UI 顯示 Encoder、Decoder、CPU、GPU Decode/Compute/Encode、RAM、VRAM、jobs、segment、FPS、speed、TEMP/SSD 與 Current ETA。

## Benchmark

`scripts/benchmark-render-modes.ps1` 預設代表片段 60 秒，偵測到既有 FFmpeg 即中止，不寫來源或正式輸出；所有檔案位於獨立 TEMP。v0.67 的 3 秒工具驗證結果保存於 `docs/BENCHMARK_V067.json`，High Speed H.264 QSV/QSV decode/3 jobs 最快。短測只驗證方向與工具，不取代長專案的 60 秒 profile 或完整內容 QC。
