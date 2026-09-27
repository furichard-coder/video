# ADR-0055｜低記憶體分段轉檔與 YouTube 全自動上傳

日期：2026-09-12
狀態：Accepted

## 背景

大型正片把數十個 4K 來源、疊化、音訊包絡、字幕、浮水印與配樂放入單一 FFmpeg filter graph 時，曾發生 `Cannot allocate memory (-12)`。同時，使用者要求在串連輸出後可預設完成 YouTube 的觀眾設定、內容確認與上傳動作。

## 決策

1. 預設啟用低記憶體分段模式。每個中繼 filter graph 最多接收六個畫面輸入；超過時遞迴合併，直到 final graph 也不超過六個。
2. 中繼輸出統一為高品質 H.264 MP4，只有 final stage 使用 UI 選定的 H.265／H.264 與 GPU／CPU 路徑。字幕、浮水印、BGM、master limiter 只在 final stage 套一次。
3. 中繼檔位於最終輸出同磁碟的 unique job folder。每檔須通過 ffprobe；上層消費後即可刪除，下游失敗或取消由 `finally` 收斂清理。
4. Main-start-card 輸入和相鄰 Intro／Main 邊界不可被分到錯誤順序；分組 helper 對該邊界做鄰接保護，預期總時長必須和原 canonical plan 一致。
5. YouTube 全自動上傳只走既有官方 OAuth／Data API。不得以滑鼠鍵盤假裝完成 YouTube Studio 的不可見設定或發布。
6. 全自動模式設定 `madeForKids=false`，將完整 review checkbox 視為使用者預先授權的 gate，並在 60 秒取消窗口結束後呼叫既有最終 upload action。任何帳號、頻道、發布資料或輸出驗證失敗都必須停止。

## 影響

- 單一 FFmpeg graph 的記憶體峰值與 filter 數量受界限控制，但多層中繼會增加時間、磁碟 I/O 與一次以上的視訊編碼；UI 與 estimate 必須明示此交換。
- 原始來源、MP3、舊 release 與已完成 MP4 不受清理波及。
- Chrome＋檔案總管拖放與人工 API 上傳仍保留；全自動關閉後即可選擇。
- 全自動不等於自動公開；可見度沿用受驗證偏好，預設仍為 `unlisted`。
