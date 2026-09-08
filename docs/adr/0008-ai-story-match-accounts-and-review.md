# ADR-0008｜AI 故事比對、帳號與人工審核

## 決定

片頭維持「本機候選先行」：先以短區段亮度、色彩與動態分數縮小候選，再在使用者已設定專案背景與 OpenAI API 憑證時，將每個候選的短音訊與低解析三格故事板送至 OpenAI Responses／Transcription API，比對人物、故事事件、地點、主題、觀眾承諾與聲畫一致性。未設定、連線失敗或單一候選分析失敗時，保留本機結果並明確顯示 fallback，不讓雲端可用性阻斷既有片頭工作流。

字幕採兩階段：語音片段先由 transcription model 取得文字、來源時間與說話者，再由 vision model 用對應故事板與專案背景產生可追溯證據；無語音片段才允許純畫面情境字幕。所有新 AI cue 初始為 `DRAFT`，必須在同步 proxy 畫面中逐項修改並改成 `CONFIRMED` 才能匯出 SRT；`REJECTED` 不輸出。AI 不會從臉孔外觀猜測真實身分，不確定的地點或事件必須產生警告。

## 帳號邊界

Codex 是本 App 的開發代理，但獨立 Electron App 無權讀取或重用 Codex／ChatGPT 登入 session。執行時預設 provider 為 OpenAI API，使用者需提供 API Key 或在環境設定 `OPENAI_API_KEY`。帳號資料模型支援多個 profile 與作用中帳號；provider adapter 預留日後新增其他 AI，v0.10.0 只啟用 OpenAI。

API Key 不進 project manifest、renderer、log 或分析 cache。保存時使用 Electron `safeStorage` 經 Windows OS 加密，憑證檔與一般 provider 設定分離；OS 加密不可用時拒絕明文保存。設定與憑證均以唯一 partial 和可恢復替換完成。

## 資料最小化與可取消性

雲端請求不傳完整來源影片，只傳當前候選的壓縮單聲道短音訊、低解析故事板與使用者填寫的專案背景，Responses 請求設定 `store:false`。App 自有 cache key 包含來源 preview fingerprint、來源時間範圍、故事背景、模型、模式與 analyzer version；來源或判斷條件改變即失效。取消或 API 失敗不寫入半成品字幕，短音訊用畢即刪；來源檔始終唯讀。

## 已知限制

- API 使用量、速率限制、可用模型與資料治理受使用者的 OpenAI API 帳號影響，並不包含在 Codex 訂閱中。
- 本版不做臉部身分辨識、地標搜尋、網路事實查核、字幕燒錄或正式 Master render。
- AI 證據是審核輔助，不是事實證明；片頭 IN／OUT、事件先後和字幕文字仍由使用者確認。
