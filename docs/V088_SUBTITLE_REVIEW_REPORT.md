# SceneryWalker v0.88 — 字幕播放與 AI Review 報告

日期：2026-10-03。播放核心已完成驗收；live AI 內容品質與下列限制不得解讀為已通過。

## 1–10：播放與字幕同步

1. **原本停止原因**：`SubtitleStudio.handleTimeUpdate` 把正片預覽限制在選取字幕／來源範圍；到結尾直接 pause 並倒回起點。原字幕 overlay 跟著選取列，而不是 SRT 播放時間。獨立字幕工作區原本也沒有跨段時鐘與接續流程。
2. **Auto Advance**：用已存在的片段代理，依 canonical Timeline 找下一段；保留續播意圖，等待下一個 video 元素與資料可用再播放。實測曾發現舊元素 pause 後的最後 timeupdate 把續播旗標改成 false，加入每段只執行一次的 handoff guard，不能只依 native ended 的 paused 值判斷使用者意圖。
3. **Playback Clock**：目前播放範圍的 Project start + source local offset。轉場重疊從下一段 outputStart 起交給下一段，避免時鐘倒退。照片使用同一時鐘，不因沒有 video element 而失去時間。播放 scope 與編輯選取分離；選取另一範圍字幕不改 clock/proxy，只有明確跳到才切換。片頭／正片仍是兩個範圍時鐘，不宣稱已建立含片頭的單一全片時鐘。
4. **Active Subtitle**：`startMs <= projectTimeMs < endMs`，文字直接取目前草稿。選取、修改和播放中的 Active Row 分開；只有明確跳到／雙擊／seek 會改播放位置。
5. **Auto Scroll**：左側獨立捲動容器；只在 Active ID 改變／明確回到目前字幕時定位。手動捲動暫停跟隨約 4 秒。真實 Electron 的第 50/100 筆定位於 44.96% 高度，scrollTop=6,384；原本 offsetTop 混用不同容器座標，改為相對捲動容器的矩形座標。
6. **Focus Line**：目標為左側可見容器高度 45%，依 row center 定位。邊界第一／最後列受可捲範圍限制。
7. **右側 Preview**：45/55 雙欄；右側影片 stage sticky，左側獨立捲動。窄視窗退回單欄。真實第 50 筆定位前後 Preview Y 均為 137.125 CSS px；已檢視截圖。未在實體 4K 螢幕完整驗收。
8. **Space**：真實 Electron Play→Space Pause→Space Resume 通過，從原暫停時間續播。
9. **文字框 Space**：真實文字輸入通過，空白進入 textarea，沒有觸發播放器。主工作區與獨立工作區鍵盤 handler 避免重複執行。
10. **Segment Boundary**：真實三段代理測試中，19–24 秒字幕跨段仍顯示；Start/End 的精確端點另有純函式測試。

## 11–17：AI 與正式字幕保護

11. **Old Logic → Root Cause → New Logic**：確認原局部重生只接受 PROJECT_AWARE 成品，外部／舊輸出會先被 compatibility gate 拒絕；單筆 live 請求又確認 API billing/quota 是另一個實際阻礙，不能混稱 UI 或 parser 故障。新版新增獨立 KEEP/EDIT 提案、分類錯誤、持久工作位置，以及內容版本衝突檢查。最終 code-review 另發現帳號／模型 preflight 在錯誤保存之前執行，已改為分類、保存 FAILED 並發送進度後才回報；不能把不相容舊影片上的字幕直接寫回目前 Project。
12. **實際 Provider/Model**：2026-10-03 單筆真實測試使用目前帳號設定 OpenAI `gpt-6-luna`。不是把 ChatGPT 網站登入當成 API 憑證，也沒有硬改成其他模型。
13. **真實 AI Review 結果**：送出一次真實 image + strict JSON review 請求；服務回覆 billing/quota 429，分類 RATE_LIMIT、retryable=false。沒有重試或偷偷換 Provider；不能宣稱真實 AI Review 成功。
14. **第一筆結果**：未產生 KEEP/EDIT。測試原文「眼前的景色隨鏡頭移動。」、時間 600,000–605,000 ms；僅為隔離測試，不是正式字幕。
15. **Evidence**：單筆服務提供字幕、起訖、前後字幕、標題／說明、START/MIDDLE/END 及必要相鄰影格。真實測試只用一張 171,473-byte JPEG，唯讀擷取於已完成影片 600 秒，沒有重新 Encode 影片。
16. **User Confirm**：AI 預設 OFF，互動確認預設 ON；一筆提案保存後暫停，KEEP／APPLY／EDIT／SKIP 決定後才能續下一筆。非互動模式仍只收集提案，不批次覆蓋正式 SRT。手動新版本優先，過期建議不能直接套用。
17. **Draft Safety**：AI review 與接受建議寫入草稿／工作狀態。正式 SRT 只有使用者最後明確輸出時才允許保存，既有檔案走備份／另存流程。原專案、正式影片與 v0.87 EXE 已再次核對未變。

## 18–21：驗收

| 測試                                   | 結果                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 三段各 10 秒，從 5 秒播放至結束        | PASS；實際 ProjectStore 將 transition normalize 為 300 ms，因此 timeline 結束 29,400 ms                                       |
| Project clock 不倒退                   | PASS；scope 隔離後最後一輪 244 筆真實播放器樣本                                                                               |
| 19–24 秒字幕跨段                       | PASS                                                                                                                          |
| Space Pause/Resume                     | PASS                                                                                                                          |
| Textarea Space 不控制播放              | PASS                                                                                                                          |
| 影片→照片→影片接續                     | PASS；實際三種 Preview source，從 5 秒至 24,400 ms 最後暫停；照片採現有 normalized 5 秒長度                                   |
| 100 字幕固定 45% 焦點                  | PASS；第 50 筆 row center=44.96%，Preview 位置不變                                                                            |
| 完整回歸                               | PASS；scope 隔離後第二輪 96 files／585 tests，241.47 秒；首輪 242.66 秒；最後 standalone handoff 10/10、AUTH/MODEL 9/9 另通過 |
| AI parser／草稿安全 focused tests      | Sol 最終 5 files／27 tests PASS；含較新人工修改優先、正式 SRT 不被草稿改寫及永久備份                                          |
| 真實付費 AI 產生建議                   | BLOCKED：API billing/quota，不是 mock 成功                                                                                    |
| Windows v0.88 package / packaged smoke | 最終重封裝及 packaged smoke PASS；scope 選取／標籤回歸另 1/1 PASS                                                             |

測試腳本：`scripts/verify-subtitle-review-v088.mjs`（隔離合成影片與專案副本）；`scripts/verify-subtitle-ai-review-live-v088.cjs`（單筆實測，禁止無限重試）。真實結果在 `artifacts/v088-review-qa` 與 `artifacts/v088-ai-review-live`。

本次修改檔案範圍：`SubtitleStudio.tsx`、`StandaloneSubtitleReview.tsx`、`styles.css`、`renderer/subtitle-playback.ts`、`main/services/subtitle-ai-check.ts`、`standalone-subtitle-store.ts`、`main/ipc.ts`、`preload.ts`、`shared/domain.ts`、相關 tests；Root 另新增 Review QA service/scripts、main.ts 測試入口、version／文件。Git worktree 已含多版先前變更，不可把所有 git diff 都算成本版。

最終可攜版：`release/v0.88.0/SceneryWalkerSourceOrganizer-win32-x64/SceneryWalkerSourceOrganizer-v0.88.0.exe`。EXE SHA-256：`72BB67C0F9DFB3C38E3849CDC505629B67BDB08EF21BAD5A475E80858602D7B9`；`resources/app.asar`：`690B3EB92F26658E525A64E6DC7C580446CF355778AA39EE0B4CD83F15E433EA`。首輪測試封裝保留於 `release/v0.88.0-pre-scope-fix-20261003`，不是最新版本。

本次 fixture 暫存僅在隔離、可重建的測試資料夾內產生，測完釋放。沒有刪除任何使用者影片、SRT、來源、checkpoint 或既有 render cache。原專案 SHA-256：`A06D45FA7AD4E939DE1FF73724AFF4458D9B5733CD6317955FFB65AA71371BBC`；v0.87 EXE SHA-256：`2028E1D127431D42C002BF45D4A239C08217BFDD37FDA0216752F4947181507A`；master 74,888,192,283 bytes、UTC mtime `2026-09-30T02:20:02.3566450Z` 均保留。

## 22：尚未完成／限制

- 真實 AI 內容品質／首筆提案需帳號恢復 API 額度後才能驗收；目前没有成功生成 AI 建議，不做長片付費測試。
- 代理 Review 的轉場以 canonical overlap ownership 作 cut 接續，不是正式 xfade 合成畫面；不能宣稱 transition pixels／音訊接縫與 Final 完全相同。代理冷快取載入也可能有短暫等待，尚未量測保證零黑屏／零音訊空白。
- 既有 74,888,192,283-byte master 缺少 projectId，不能以時長接近作為目前專案時間線安全對應的證明；直接套回 Project 仍需真正輸出 provenance。
- Standalone 跨段是 renderer 模擬測試；真正 Electron 三段／混合播放為主字幕工作區。AI pause/retry、人工衝突與備份測試不是 live-provider IPC 端到端成功。
- 有片頭的專案，其片頭／正片字幕使用不同相對時間軸；目前不直接建立 Project-linked AI Review，避免把正片字幕錯套到含片頭成品。可用「既有 SRT」獨立匯入影片與字幕檢查；這不是完整的跨 scope 自動時間映射。
- 主字幕工作區可在正片內或片頭內連續跨段，但片頭結束不會自動銜接正片；含片頭全片的絕對時鐘／字幕映射仍未完成。独立成品＋正確全片 SRT 可沿整個影片播放，但不能冒充專案跨 scope 代理驗收。
- 本版有逐筆提案／確認與 draft export，但完整七種 Review 狀態篩選、整批修改比較及跨字幕的語義 Scene Summary 共用快取尚未全部實作。已有影格與相同輸入提案快取不能當作以上功能完成。

## Model / Token

- GPT-5.6 Sol：時鐘／handoff、AI review 架構、IPC、parser、持久恢復與安全整合。
- GPT-6 Luna：獨立 Review UI、CSS、快捷鍵與局部 renderer tests；Sol / Root 審查。
- 一般工具：精準搜尋、TS/build/tests、合成短片與 Electron 真實播放、唯讀 hash/stat；不重掃 RAW、不重轉 master、不重新分析整個 Repository。
- OpenAI 錯誤與 structured-output 邊界參考官方文件：[Error codes](https://developers.openai.com/api/docs/guides/error-codes)、[Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 使用入口

1. 先儲存舊版正在編輯的內容，再開啟 v0.88；本次沒有關閉或覆寫仍在使用的 v0.87。
2. 在字幕頁明確「跳到」要檢查的字幕，按播放或 Space；目前範圍內的片段會接續，選取別筆編輯不會自動 seek。
3. 編輯器內 Space 仍輸入空白；保存未確認修改／Ctrl+Enter 後從暫停位置繼續。
4. 如要檢查已有成品與全片 SRT，用「既有 SRT」匯入影片＋字幕形成獨立草稿。片頭／正片合併的時間映射未完成前，不直接把舊成品建議寫回專案。
5. AI 需自行勾選；OpenAI API 額度與 Codex／ChatGPT 訂閱額度是不同服務。正式字幕只在明確輸出時更新，舊檔先備份。
