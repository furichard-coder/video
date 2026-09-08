# ADR 0017：雙語字幕翻譯與 MP4 嵌入

日期：2026-09-05  
狀態：Accepted（v0.17.0）

## 決定

- 正片串連輸出可嵌入一至兩種字幕：繁體中文、英文、簡體中文、日文或韓文。
- 原始字幕基準為專案中人工確認並保存的繁體中文 cue；timeline revision 不一致時阻擋嵌入。
- 翻譯優先使用目前 OpenAI API 帳號發出新的 Responses API 請求，設定 `store: false`，以自然口語、忠實人物／地名／事件為提示原則。
- OpenAI Key 缺失、API project 無額度、速率或端點失敗時，才改用使用者另行設定的 Google Cloud Translation Basic v2 API Key。
- 不宣稱使用 ChatGPT 網頁或 Codex 登入建立「新對話」；兩者登入與 OpenAI API project 的金鑰、帳務及額度不同。
- Google 金鑰用 Windows `safeStorage` 加密，透過 `X-Goog-Api-Key` header 傳送，不寫入 URL、專案、renderer 或翻譯 cache。
- 翻譯結果寫入可重建 App cache；cache key 綁定字幕內容、目標語言與翻譯器版本。
- FFmpeg/libass 使用暫存 UTF-8 ASS 檔真正燒錄；各語言可設定上／中／下位置與 1080p 基準字級，長句自動換行。完成或失敗後刪除暫存 ASS。

## 時間線與安全

- 字幕時間以 Main 尚未扣除疊化的既有基準保存；輸出時逐 Main clip 映射到實際 xfade 後時間，選擇片頭串接時只平移 Main 字幕，不在 Intro 上複製字幕。
- 僅 `CONFIRMED` cue 可輸出；沒有已確認 cue 或字幕需要複核時安全阻擋。
- 輸出仍採唯一 partial MP4，成功或已有足夠有效畫面的取消才完成檔案；來源保持唯讀。

## UI 回歸決定

- 中央影片縮圖左鍵直接依副檔名規則開啟外部播放器；右鍵或 Shift+F10 開啟 proxy／原檔選擇。
- 卡片底部不再重複顯示外部播放器按鈕。
- 「刪除／排除部分片段」以獨立卡片工具按鈕重新露出，沿用原 PreviewModal 的多區段編輯與來源唯讀規則。
