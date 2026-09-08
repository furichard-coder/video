# ADR 0026｜MOV 代理驗證與編碼資訊橫排

- 狀態：Accepted
- 日期：2026-09-06

## 決定

網格 metadata 保持兩行資訊密度，但第二欄取得較多水平空間，`dt` 標籤禁止縮小及中文字間折行。因此「編碼」會和 codec 值左右排列；值太長時只截斷值，完整內容仍保留在素材資料中。

來源預覽器升級為 `preview-v3`。來源檔沒有變更時，App 仍會在該素材下次要求預覽時重新計算帶版本的 cache key；不主動掃描或重建整批來源。

Apple QuickTime HEVC 素材採軟體解碼優先。原因是通用 `-hwaccel auto` 在舊 GPU／驅動與 10-bit HEVC／Dolby Vision 組合上，可能花較長時間協商或傳回系統記憶體；本機代表素材的 5 秒測試中，軟體路徑約 8.38 秒，通用硬體路徑約 14.60 秒。其他 codec 仍先嘗試硬體，再回退軟體及無聲代理。

代理 MP4 固定寫入 H.264 `avc1`、AAC（可解碼時）、CFR、正規化時間戳與 `faststart`。FFmpeg 成功結束後仍須通過 ffprobe 的 H.264、有效尺寸及正時長檢查，才可改名並寫入 cache marker；cache hit 同樣驗證。過短、毀損或無法解析的舊檔一律局部重建。

## 安全與限制

- MOV、MP4 與其他來源都只讀；所有衍生檔僅寫入 App cache 或驗證用暫存位置。
- 代理固定轉成 MPEG-4 容器內的 H.264/AAC，並非把 MOV 原檔改名，也不取代正式輸出來源。
- 10-bit HLG／Dolby Vision 代理是操作用低解析顯示版本，不宣稱保留 HDR mastering；正式 HDR／SDR 色彩管理仍屬後續 Master 階段。
- 無聲 fallback 只在來源音訊無法處理時使用，並向既有 UI 回報代理狀態；來源音訊不會被更動。
