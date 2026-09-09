# ADR-0036：YouTube 發布內容集中確認

## 決策

- YouTube 說明由同一個純函式整合中文說明、English summary、章節時間與 hashtags；5,000 字不足時先縮短散文內容，保留章節與 hashtags。
- 上傳分成「編輯」與「集中確認」兩步。集中確認頁播放 OutputHistory 中目前選定的 MP4，並顯示 manifest 中選定縮圖的實際 JPG／PNG、完整文字、頻道、兒童內容與可見度。
- 使用者必須勾選已檢查聲明，Renderer 才能呼叫既有 `youtube:upload`。Main process 仍重新驗證成品 ID、頻道、標題、說明、可見度與縮圖。
- `preview-media` 只以 OutputHistory job ID 或目前 manifest 的 thumbnail candidate ID 解出檔案；Renderer 不能傳入任意本機路徑。
- YouTube 轉碼、著作權與社群規範檢查仍以 YouTube Studio 為準。自動測試不建立真實影片。

## 理由

影片、縮圖、標題與說明原先分散在不同頁面，章節也只有匯出文字，容易在最後上傳時漏帶或看錯。集中確認能在不移除人工發布決策的前提下，讓實際 payload 與使用者看到的內容一致。
