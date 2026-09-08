# ADR 0028｜Codex／ChatGPT 知識型字幕備援

日期：2026-09-07  
狀態：Accepted

## 問題

v0.27.0 保存的 OpenAI API Key 可以完成身分驗證與列出模型，但實際 Responses 請求回覆 `credit_balance_exhausted`。片頭分析會在雲端失敗後使用本機畫面統計，因此表面上像是「AI 片頭可用」；知識型字幕不應捏造知識，沒有本機假性字幕備援，所以沒有產出。片頭 480P 代理完成也只代表本機 FFmpeg 工作成功，不能證明 AI 帳務可用。

## 決定

- 產生字幕前先送出極小、`store: false` 的 OpenAI 故事模型實際請求。只有成功才開始來源 metadata／故事板工作。
- OpenAI API Key 缺少、project 額度不足或故事模型不可用時，知識型字幕自動嘗試本機 Codex 執行程式所管理的 ChatGPT 登入。
- 不讀取、複製、記錄或自行更新 Codex auth token。登入檢查與模型執行都交由 Codex 官方執行程式處理。
- Codex 工作採暫存 session、忽略使用者執行設定、唯讀 sandbox、非 Git 模式；工作目錄限制在 App 的可重建 AI cache。模型明確禁止使用工具、讀取其他檔案或修改檔案。
- 每個字幕候選只附加 App cache 內一張 1080×720 低解析三格故事板、來源顯示名稱與專案故事背景；不附加整支影片，也不把來源媒體當輸出來源。
- 每批最多 12 張故事板，以 JSON Schema 約束回覆；Main process 仍驗證筆數、唯一 index、欄位與 0–100 分數後才原子寫入 cache。
- OpenAI 與 Codex 結果使用不同 cache key，並包含來源 preview key、時間、故事背景、模型及 analyzer version。
- Codex 備援只負責知識型畫面字幕。它不接收此 App 的音訊；使用者勾選語音分析時仍需可用 OpenAI API，否則在讀取媒體前明確阻擋。

## 影響

- 目前 ChatGPT/Codex 有可用額度、但 OpenAI API project 無 credit 時，知識型字幕仍能真正產生。
- 首次執行需要 Codex 已安裝且已用 ChatGPT 登入；未安裝、未登入、Codex 使用量受限、模型不可用或回覆不完整時安全失敗並保留現有字幕。
- Codex CLI 是這台 Windows 電腦上的執行相依，不隨 App 封裝；未來若要讓其他電腦使用，需在設定頁提供正式登入流程或安裝引導。
- AI 草稿仍可能錯誤，必須逐項確認時間、影像、人物、地點與文字後才能匯出或燒錄。
- 片頭 AI 的人物／事件／故事重排、語音轉錄與字幕翻譯尚未切換至 Codex，避免在同一小改版擴大範圍。
