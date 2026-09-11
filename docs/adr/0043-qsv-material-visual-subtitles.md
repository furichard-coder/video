# ADR-0043：QSV 預設與素材影格字幕分析

## 狀態

Accepted — v0.50.0

## 決策

新版輸出預設使用 Intel Quick Sync Video 的 H.265／HEVC（`hevc_qsv`）。同頁提供 QSV H.264 與 CPU H.265／H.264 備援，讓硬體編碼器或舊裝置不適用時由使用者明確切換；不以靜默 fallback 掩蓋實際編碼失敗。

照片與影片影格的視覺分析不直接寫入字幕。照片卡預設勾選分析；影片由使用者輸入一個或多個來源時間點。Main process 只從唯讀來源建立低解析衍生故事板，交給 ChatGPT／OpenAI 或 Codex／ChatGPT 判讀物種、物品、地點、事件與簡化字幕，再回傳 `DRAFT` cue。

使用者可在寫入前修改範圍與文字，確認後才以 `CONFIRMED` 保存到 Main 或 Intro 字幕時間線。Google Lens 只提供外部人工輔助入口與貼回文字，不由 App 自動上傳本機檔案。

## 理由與邊界

- QSV 已在目標 Windows 機以 H.265／H.264 合成測試驗證；實際濾鏡、轉場、BGM、字幕與浮水印仍需每次輸出 QC。
- 分析時間點必須落在目前素材 IN／OUT 或已確認 Intro 範圍，避免字幕證據指向未輸出的畫面。
- AI 回應帶來源 asset、source time、物種說明、信心與警告；未知物種不可從主題文字推測。
- 分析快取與 frame proxy 可重建，來源檔、既有 MP4／SRT 與 SOP 永不覆寫。
