# ADR 0033：主題式 AI 配樂建議與近期趨勢

## 狀態

Accepted — v0.35.0

## 決策

配樂頁提供使用者主動觸發的 AI 選曲研究。輸入只取 Project manifest 已有的影片主題、地點、故事摘要與觀眾承諾，不為此功能掃描 RAW、建立新代理或傳送完整來源影片。成功搜尋結果會保存回同一 Project manifest 的 `musicSuggestionResult`，因此關閉工作台、重開 App 或重新開啟同一專案仍可恢復；取消／失敗不覆蓋上一份成功結果。

第一順位以作用中的 OpenAI API 帳號呼叫 Responses API，設定 `store: false` 並啟用內建 `web_search`。若 API Key 未設定、project 無額度或請求不可用，才改用電腦上既有的 Codex／ChatGPT 登入，以 `--ephemeral`、`--ignore-user-config`、`--sandbox read-only` 及結構化輸出執行同一研究。兩條路徑都必須回傳可核對的試聽網址與來源；TikTok／抖音趨勢另要求觀察日期及趨勢證據。無法核對時寧可不列出，不得以模型記憶或舊榜單冒充近期熱門。

Main process 對 AI 回傳再做 URL allowlist：YouTube 只接受 HTTPS watch／YouTube Music watch／youtu.be；TikTok 只接受官方音樂頁或 Creative Center。Renderer 不能直接任意開啟外部網址。搜尋可取消，Renderer 關閉時中止；同一時間只允許一個研究工作。

結果只供試聽與選曲。AI、YouTube 或 TikTok 的可見連結不構成同步、重製、公開傳輸或商用授權；一鍵「加入參考」只沿用既有待指定授權 MP3 流程，不下載音訊、不自動納入輸出。

「同時搜尋 TikTok／抖音近期熱門音樂」與「只搜尋有 royalty-free／授權線索的音樂」是使用者偏好，保存到 App 自己的 user preferences，不改來源檔，也不影響舊專案／cache 相容性。啟用授權線索篩選時，搜尋提示要求只列出 YouTube Audio Library、Creative Commons、明示商用／同步許可或其他可核對條款的候選；Main process 仍會丟棄沒有 `rightsEvidence` 的結果，並將 `royaltyFreeOnly` 寫入已保存的 `musicSuggestionResult`。

## 理由

- 使用者需要的是依影片故事挑選並能立即試聽的候選，不是未經授權的下載自動化。
- 即時趨勢屬於會變動的資料，必須使用 Web Search 與來源證據，而非只靠模型既有知識。
- OpenAI API project 額度與 ChatGPT／Codex 使用量分離；保留登入備援可讓既有流程在 API 額度不足時仍有安全的可用路徑。
- URL allowlist、外部開啟集中於 Main process，可避免模型回傳內容直接變成任意協定或命令入口。

## 刻意未做

- 不下載 YouTube／TikTok 音訊，不繞過平台或權利人的限制。
- 不宣稱「熱門」等於可在影片使用，也不自動將建議曲混入 MP4。
- 不背景定時追蹤榜單；每次結果只代表當次手動搜尋與其觀察日期。
- 不把「royalty-free」字樣當成法律結論；每筆結果仍標示需人工核對授權，沒有可核對線索的候選不會在篩選模式下顯示。
