# ADR-0002：安全的副檔名外部播放器路由

狀態：Accepted  
日期：2026-08-29

## 決定

保留 HTML5／Electron 內建播放器作為 App proxy 預覽核心；外部播放器只是一個由使用者明確觸發的觀看動作。設定獨立保存於 Electron `userData/settings/external-players.json`，以「副檔名覆寫 → 全域預設 → Windows 系統預設」解析。

內建選項為 Windows 系統預設、VLC、Windows Media Player 與 MPC-HC；安裝位置透過 PATH、Windows App Paths registry 及常見安裝根目錄動態偵測，自訂播放器則由原生檔案選擇器選取 `.exe`。所有位置在開啟前重新驗證。

Renderer 只能傳遞 manifest 中的 `assetId` 與 `PROXY`／`ORIGINAL` enum。Main process 解析實際來源或 cache 路徑；外部 EXE 使用 `spawn(executable, args, { shell: false })`，系統預設使用 Electron `shell.openPath`，不建立 shell 命令字串。

## 理由

- 不讓 Renderer 任意指定執行檔或檔案路徑，可縮小 IPC 攻擊面。
- 參數陣列可正確處理空格、中文及其他 Unicode 路徑，也不會把媒體檔名當成命令。
- proxy 預設值符合來源唯讀原則；原檔只以「觀看意圖」交給外部程式，UI 明確說明 App 無法控制第三方程式行為。
- 獨立設定 schema 不改動既有 source manifest，因此 v0.3 專案、IN／OUT 與 cache 相容。

## 降級規則

指定播放器未安裝、路徑移動或啟動失敗時，嘗試 Windows 系統預設；若系統預設也失敗，回到 App 內建 proxy 播放並顯示原因。失敗不阻塞 Renderer，也不修改來源。

## 不在本決定範圍

不內嵌 libVLC／WMP ActiveX，不加入 Timeline、正式 render、HDR 或上傳。
