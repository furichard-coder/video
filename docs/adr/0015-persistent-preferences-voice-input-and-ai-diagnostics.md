# ADR-0015：持久偏好、麥克風輸入與可判讀的 OpenAI API 診斷

## 狀態

已採用，v0.16.0。

## 決定

- 新增 App 級 `user-preferences.json`，集中保存上次網格／清單檢視、預覽解析度、疊化秒數、Intro 串接、輸出後上傳準備、YouTube 可見度、麥克風辨識語言及各類原生選檔／儲存視窗的最近資料夾。
- 偏好位於 Electron `userData/settings`，不寫入來源媒體或可攜 `.swproj`。每次修改以唯一 partial 原子完成；無效值回到安全預設。
- API Key、OpenAI 帳號、YouTube OAuth 與外部播放器仍由既有專用設定檔保存；敏感憑證繼續使用 Windows `safeStorage`，不搬入一般偏好檔。
- 故事背景的主題、人物、地點、故事／劇本／特色說明與觀眾承諾加入麥克風按鍵。預設以繁體中文辨識，可切換英文；短錄音只在使用者按下時送給作用中的 OpenAI 語音模型，完成或失敗後即釋放麥克風，不保存到專案或來源。
- OpenAI「測試連線」改成完整測試：先驗證 Key／project，再用極小請求實際呼叫所選故事模型與語音模型。這比只讀模型清單更能代表字幕功能是否可用，但會產生極少量 API 用量。
- 保留 OpenAI 的安全錯誤 code、Request ID 與 rate-limit reset 資訊。429 必須區分 API project 無額度／支出上限與暫時每分鐘限速；不得再統一翻譯成模糊訊息。

## 理由

使用者預期本機桌面 App 重開後延續上次工作習慣與位置。集中偏好能避免各頁自行維護不一致的 local state，也不會污染可攜專案的內容規則。

Codex／ChatGPT 使用量與 OpenAI API Key 所屬 project 的帳務及限速是不同資源。單純成功列出模型只證明 Key 可驗證，不能證明付費 Responses／Transcription 呼叫可執行；分階段 live diagnostic 才能提供可採取行動的結果。

## 安全與相容性

- 不變更 manifest schema；v0.15.0 與更早 `.swproj`、來源清單及 cache 可直接使用。
- 最近路徑只影響 Windows 原生 dialog 的起始位置，不能授權 Renderer 任意讀寫檔案。
- 麥克風權限只對本 App 視窗、純音訊、使用者按下的錄音動作開放；不要求或允許攝影機。
- 錄音限制 120 秒及 25 MB；只接受白名單音訊 MIME，送出後不在本機建立永久錄音檔。
- 診斷訊息不得包含 API Key；只顯示安全錯誤類型、OpenAI Request ID 及使用者可採取的帳務／限速處理方式。
- 不修改根目錄 SOP、來源媒體或既有 release。
