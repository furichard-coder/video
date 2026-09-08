# ADR-0001｜Electron 本機優先桌面架構

- 狀態：Accepted
- 日期：2026-08-29

## 決定

第一階段使用 Electron 44 + React 19 + TypeScript + Vite。媒體資訊與衍生 preview 由本機 FFmpeg／ffprobe adapter 處理；資料先以版本化 JSON manifest 保存，避免在垂直切片過早導入 SQLite。

## 理由

- 目標是 Windows 桌面 App，原生多檔／資料夾 dialog 與本機檔案權限是必要能力。
- 本機已有 Node 與 FFmpeg，但沒有 Rust；Tauri 會先增加工具鏈安裝與維護成本。
- Electron 的 main/preload/renderer 隔離可讓 renderer 只取得白名單 API。
- Chromium 原生媒體控制可提供播放、暫停與 seek；不支援的來源先由 ffmpeg 轉成 App cache 中的低解析 H.264 proxy。
- 連續總體預覽採播放清單；後續新增的低解析串連輸出另由 ADR-0002 約束，仍不屬於正式 Master 渲染。

## 安全設定

- `contextIsolation=true`、`nodeIntegration=false`、sandbox preload。
- IPC 固定白名單且以 asset ID 定址。
- 自訂 `preview-media` protocol 只解析 App cache 內的既有檔案。
- 外部工具一律 `spawn(executable, args[])`，不經 shell。

## 暫緩項目

SQLite migration、ExifTool、Timeline/EDL、正式 render orchestrator、HDR 與 YouTube adapter 延後。若未來 App 進入大型專案與多版本資料，屆時以新 ADR 評估 SQLite。
