# ADR-0061｜v0.68 實際轉檔耗時與 Resume 累積時間

日期：2026-09-14

## 決策

實際耗時由 Main process 的 `RenderElapsedTracker` 計算。使用者按下開始後，來源檢查、資源提示、人工確認與字幕前置作業仍不計時；只有 FFmpeg child process 已成功 spawn 且取得 PID 的 process-start callback 才啟動本次 attempt。

第一個 FFmpeg process 啟動之後，直到完成、失敗或人工取消為止採連續 wall-duration 語義。分段轉檔的 wave 交替、等待記憶體安全閘、階段間調度、final concat 與完成檔驗證都是使用者實際等待的一部分，因此不暫停計時。計算使用 `performance.now()` monotonic clock，禁止以 UI tick 或固定 `+5 分鐘` 累加。

## 更新與效能界線

Main 在 attempt start、每五分鐘 heartbeat，以及 `COMPLETED`、`FAILED`、`CANCELLED`、`INTERRUPTED` terminal 時保存精確 snapshot。五分鐘 interval 若因 event loop 延遲而晚到，仍由當下 monotonic timestamp 重算真實 elapsed。寫入採既有 project queue 串行化，失敗只影響 telemetry，不中止 FFmpeg。

Renderer 收到 Main snapshot 時記錄本地 `performance.now()`，之後每秒用本地 monotonic delta 更新顯示；`timingCapturedAt` 只作稽核，不用 wall clock 推進畫面。這不每秒 IPC、不每秒寫 checkpoint，也不新增任何 FFmpeg filter、progress polling 或媒體 I/O。

## 儲存 schema

`<userData>/projects/render-state/<projectId>.render-state.json` 升級為 schema 2：

- `timing.cumulativeElapsedMs`：已封存 attempts 的累積值。
- `timing.lastAttemptElapsedMs`：上一個已封存 attempt。
- `timing.activeAttempt.attemptId`：本次唯一識別。
- `timing.activeAttempt.startedAt`／`lastHeartbeatAt`：稽核及 crash boundary 用 UTC timestamp。
- `timing.activeAttempt.persistedElapsedMs`：最後一次以 monotonic clock 計算並保存的本次 elapsed。

schema 1 載入時遷移為 schema 2 並以零 elapsed 起始，不虛構歷史時間。所有 attempt 同時 append 到 `<userData>/projects/render-state/<renderId>.timing.ndjson`。此檔不在 checkpoint discard 清單，確保完成或人工取消沿用既有清理語義時，terminal 本次耗時仍可持久查閱。

## Crash 與 Resume

正常失敗先把本次 monotonic elapsed 加入 `cumulativeElapsedMs`，保留 checkpoint。Resume 的新 attempt 從下一個第一個 FFmpeg PID 重新由零計算，本次顯示新 attempt，累積顯示舊 cumulative 加本次。

若 App／Windows 在 heartbeat 之間中止，process 無法執行 terminal handler。下次 Resume 只承接 active attempt 已保存的 `persistedElapsedMs`。`startedAt` 到 `lastHeartbeatAt` 的 wall delta 僅用作保守核對，最多允許比 monotonic snapshot 多五秒的時鐘／排程漂移；`lastHeartbeatAt` 之後到 Resume 的 App 關閉、睡眠或關機時間永不計入。這會最多少記最後未落盤的五分鐘，避免把數小時 downtime 錯算為轉檔。

## UI 與 terminal 語義

- RUNNING：`已耗時：HH:MM:SS` 與 `預估剩餘：HH:MM:SS` 分開顯示；Resume 時可另列累積轉檔耗時。
- COMPLETED：顯示 `轉檔完成`；單次工作列 `總耗時`，Resume 工作列 `本次耗時` 與 `累積總耗時`。
- FAILED：顯示 `轉檔失敗`、錯誤與 `本次耗時`；若可續轉另保留累積值。
- CANCELLED：顯示 `轉檔已取消` 與 `本次耗時`。若取消後成功封裝短 MP4，結果頁同樣顯示取消狀態與時間。

## 相容與安全

所有新增 domain 欄位皆為 optional，既有 v0.67 progress/result/history 可載入。計時不改變時間線、字幕、轉場、BGM、畫面構圖、encoder 或輸出內容。v0.68 封裝到獨立 `release/v0.68.0`，不覆蓋正在運行的 v0.67 executable、userData、checkpoint、cache、TEMP、resume work root 或 output。
