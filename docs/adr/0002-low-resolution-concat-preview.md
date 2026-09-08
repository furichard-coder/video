# ADR-0002：以 FFmpeg 建立低解析串連預覽

日期：2026-08-29  
狀態：Accepted

## 情境

使用者需要在完成素材排序後，選擇固定交接疊化秒數與預覽解析度，確認後直接產生一支可觀看的串連影片。此功能的目的是快速檢查順序與交接，不是正式影片 Master。

## 決定

- 只串連目前排序中的影片；照片保留於 manifest，但不放進此版輸出。
- 交接選項固定為 0.3、0.5、0.7 秒，使用 FFmpeg `xfade=fade`；音訊同步使用 `acrossfade`。
- 無音軌影片在自己的片長範圍補 48 kHz stereo 靜音，避免中斷整體音訊鏈。
- 預覽可選 360p（640×360）或 480p（854×480），固定 16:9。來源等比縮放並加黑邊，不裁切。
- 輸出為 H.264 High、yuv420p、30000/1001、AAC 48 kHz stereo、Fast Start MP4。
- Renderer 只提交排序後的 asset ID、選項與一次性 output token。實際來源路徑與輸出路徑只存在 Main process。
- 原生 save dialog 建立的 output token 30 分鐘失效且只可使用一次；輸出不得等於任一來源路徑。
- 先寫入同一輸出資料夾內的唯一 `.partial.mp4`，成功後才 rename；取消或失敗只刪除該 partial。
- App 關閉或 Renderer 消失時中止目前工作。

## 後果

- 使用者可以快速驗證排序與轉場，不必先建立完整 Timeline。
- 所有來源保持唯讀，低解析串連檔也被明確標記為 Preview、不得作正式 Master 或正式輸出的來源。
- 目前依賴 PATH 內可執行的 FFmpeg／ffprobe。要交付到沒有媒體工具的 Windows 電腦前，仍需決定固定版本與授權相容的隨附方式。
