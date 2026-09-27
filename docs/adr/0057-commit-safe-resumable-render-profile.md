# ADR-0057｜Commit-safe 分段續轉與共用輸出規格

日期：2026-09-13
狀態：Accepted

## 實際根因

Windows System Event Log 的 Resource-Exhaustion-Detector（Event ID 2004）記錄到 `ffmpeg.exe` 在失敗時曾提交 49,243,484,160 bytes（約 45.86 GiB）；另兩次為約 39.91 GiB 與 35.02 GiB。這台電腦實體 RAM 約 23.88 GiB、`C:\pagefile.sys` 約 26.55 GiB，當時可用的 Windows Commit Limit 約 50.44 GiB。FFmpeg 為 64-bit，因此不是 32-bit address-space 限制；C 槽仍有約 74 GiB，也不是單純 SSD 空間不足。

根因是舊一般模式把大量影片／照片同時放入單一 `filter_complex`，多路解碼器、未壓縮 frame queues、scale／blur／overlay／xfade buffers 與 encoder allocation 共同逼近 Windows RAM＋Pagefile 的 Commit Limit，觸發 `-12 Cannot allocate memory`。

## 決策

1. 兩種模式都使用有上限的 staged normalization。低記憶體模式依安全 RAM budget 每批 3–6 個輸入；一般模式使用較大但最高 16 個輸入的動態批次，不再以「全部輸入」作為一般模式的定義。
2. 安全保留為 `max(4 GiB, Total RAM × 18%)`。Main 依 Available RAM、工作負載估算與保留量決定每批輸入、`filter_complex_threads` 與 encoder threads。低於 2 GiB available 時不啟動下一個 stage，等待記憶體回復；正在執行的 FFmpeg 不粗暴強制暫停。
3. 開始前讀取總／可用 RAM、App／其他程式 RAM、Pagefile、System Commit／Limit、TEMP 與輸出磁碟。RAM／Commit 警告需人工確認但不禁止；輸出工作空間無法保留 1 GiB 時才阻擋。
4. 每個完成中繼檔經 `ffprobe`、duration、size 與 SHA-256 驗證，再寫入 App Data 的專案 `render-state.json`。中繼檔保留至成品成功；失敗、App 關閉或 Windows 重啟後可以續轉。人工取消則清除本次 checkpoint。
5. 如果中繼段已完成而 final concat 失敗，下次驗證並重用全部完成段，只重跑 final concat。設定或專案 revision 改變時拒絕錯誤重用。
6. 診斷採 NDJSON 保存每階段與每 15 秒 runtime 資源快照；UI 顯示 current segment、RAM available、FFmpeg／App RAM、SSD free、工作檔大小與剩餘時間。
7. `PreviewResolution` 是共用 Render Profile。1080P／1440P 分別對應 16:9 的 1920×1080／2560×1440，以及 9:16 的 1080×1920／1440×2560。Preview 可低解析播放，但 aspect、contain／blurred-fill、字幕相對尺寸及 FFmpeg 早期 normalization 共用同一規格。

## 兩種 pipeline

`Low Memory`：小批次來源解碼 → 目標尺寸 normalized H.264 checkpoint segments → 逐層縮減 → final subtitle/BGM/watermark/codec。
`Normal`：較大但 bounded 的批次來源解碼 → 同規格 checkpoint segments（需要時）→ final effects/codec。片段少於動態上限時直接 final pipeline。

兩者只允許資源策略與時間不同，ordered clips、轉場、時間線、字幕、音訊、構圖與成品 profile 必須一致。

## 估算邊界

輸出大小依 duration、resolution profile、codec bitrate、AAC 與 container allowance；SSD 模擬所有可續轉中繼檔與 partial；RAM 依來源與目標 pixel buffers、FPS、codec decode factor、frame queues、filter buffers 與 concurrent inputs；時間加總 normalize stages、final encode、解碼複雜度與 I/O/job overhead。顯示值一律是約值，不宣稱保證。
