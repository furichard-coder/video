# v0.82 Resume Recovery Report

## 判定摘要

舊版 Resume 在 `src/main/services/concat-render.ts:2395` 拒絕續轉。當時的條件要求舊 checkpoint 的 picture/base render signature 相符；舊簽章不存在時，則要求整體 request signature 與 `projectUpdatedAt` 同時相符。本案走 picture signature 比對，該比較失敗。

| 欄位 | 舊 checkpoint | 目前狀態 | 判定 |
| --- | --- | --- | --- |
| Picture/base signature | `390D…DF66` | 舊 request 重算 `7D67…E79B`；目前 canonical signature `9066…C0A0` | 舊／新版 hash 不同；缺少舊 Project snapshot，不能把差異歸因到單一 render 欄位 |
| `projectUpdatedAt` | 2026-09-27 12:39:31 | 2026-09-28 15:50:42 | 不同；代表專案記錄更新，不足以證明影像內容改變 |
| Clip selection | 92 筆：Intro 25、Main 67 | 目前 manifest 相符 | 已比對欄位一致，不代表完整 Project snapshot 一致 |
| Transition | 0.7 秒 | 0.7 秒 | 相同 |
| Source continuity | 舊 checkpoint 沒有來源內容雜湊 | 59/59 即時 size／mtime 與目前 manifest 相符，修改時間均不晚於 checkpoint 建立時間 | 有界的來源 stat 連續性證據，非舊內容雜湊比對 |
| Legacy level-one IDs | checkpoint 記錄 10 個 | `legacyLevelOneIdsForProject` 預期 10 個 | 10/10 exact match |
| Segment validation | 10 個已完成 segment | 10 個通過媒體參數、size 與 SHA 驗證 | `VALIDATED_SEGMENT_REUSE` |
| TEMP | 舊 signature/request 含舊版儲存設定；v0.81 使用 E: 主 TEMP、C: 備援槽 | 儲存位置可能不同 | 路徑屬儲存位置；它是舊 hash 的風險來源，但無法證明是本案唯一差異 |
| YouTube 上傳設定 | 不在 render hash | UI 設定可另行變更 | 不影響此次 render signature mismatch |
| Base partial / audio master | 無可找到的檔案 | 未找到 | 沒有可驗證的 base/audio master 可接續 |

## Root cause 與可知範圍

舊 validator 把「render signature 不同」與「專案更新時間不同」當成整份 checkpoint 不相容，錯誤訊息因此把 VIDEO、TIMELINE、BASE_AUDIO 三種可能原因合併。它沒有指出哪一個欄位造成差異。TEMP 路徑確實曾參與舊 picture signature，因此磁碟路徑改變可能造成 false mismatch；但本案重算舊 request 的 picture signature仍不同，且 `projectUpdatedAt` 也不同。由於舊 checkpoint 沒有完整 Project snapshot，無法 Field-by-Field 判定實際內容變更，三種 mismatch 均應記為 UNKNOWN，而非推定為真的媒體變更或純路徑變更。

完整 Project snapshot 缺失，因此整體 render compatibility 仍不能從舊 checkpoint 逐欄還原；但 level-one segments 可獨立驗證。唯讀分析中，`legacyLevelOneIdsForProject` 預期 10 個 ID，checkpoint 記錄 10 個，10/10 完全相符。59/59 個來源檔案的即時 size／mtime 與目前 manifest 相符，且修改時間均不晚於 checkpoint 建立時間；這是 metadata continuity 證據，並非舊來源檔案的完整內容雜湊。10 個 segment 通過 codec、尺寸、fps、pixel format、色彩範圍、音訊／sample／channel、duration、size 及 SHA 驗證，analyzer 回報 `VALIDATED_SEGMENT_REUSE`。可重用首層 segments，checkpoint 宣告 duration 為 8,976,508 ms、72,527,956,978 bytes；ffprobe aggregate duration 約 8,976,718 ms。這可跳過 10 段重編，不等於已有 Base Master。沒有 base partial 或 audio master；`partial.mkv` 的 last-valid timestamp／tail decode 因沒有可檢查檔案而為 NOT FOUND／NOT APPLICABLE。逐欄差異詳見 `RESUME_COMPAT_DIFF.json`。

## 恢復決策

- 本案可重用 segment 數：**10/10 首層 segments**；legacy IDs、來源連續性及媒體／SHA 驗證全部通過。
- 可重用首層 segment 時長與大小：**8,976,508 ms／72,527,956,978 bytes**；不含 Base Master。
- 已恢復的 partial：**無**；沒有可找到的 partial 或 base/audio master。
- 安全恢復範圍：**跳過 10 個已驗證首層 segments 的重編**。沒有 base master，後續 Base picture、audio、mux 階段仍需執行；目前不指定整片續轉的下一個 timestamp。
- 是否避免前二十多小時全數重跑：**可避免重編這 10 個首層 segments；不能避免後續 Base picture pass**。不能宣稱完整長片成果已全部保存或整片可直接接續。
- TEMP E:/C: 是否造成 mismatch：**可能是舊 hash 的 contributing factor，非已證實唯一原因**。此次舊簽章對保存 request 重算也不同。
- YouTube 設定是否誤入此次 hash：**否**；上傳設定與 render hash 分離。
- Base audio 是否改變：**UNKNOWN**；沒有可比對的 Project snapshot/base master，不能說內容變了或相同。
- Timeline 是否改變：**UNKNOWN**；92 筆 clip selection 和 transition 欄位相同，但無完整 snapshot 供逐欄比對。

v0.82 的恢復方式會把遷移／新索引寫入獨立 copy-on-write checkpoint，保留原始 checkpoint 與 artifacts。本案 10 個舊格式首層 segment 已由精確 legacy IDs、來源 stat 連續性及媒體／SHA 驗證共同核准重用；可略過這 10 段的重編。沒有 Base Master，後續 Base picture、audio、mux 仍須執行。此次沒有執行完整長片 render，因此沒有「完整長片已接續成功」的結果可報告。

## 驗證狀態

- TypeScript：PASS。
- `render-checkpoint`：18/18 PASS。
- concat integration：47/47 PASS。
- Full regression：76 files／484 tests PASS；後續介面安全修改 focused 10/10 PASS；production build、Electron source／packaged smoke PASS；npm audit 0 vulnerabilities。v0.82 EXE SHA-256：`200227FC9F4115BBE9A32447479B74DF8E55163C8FBB3194C84513E44D03F6CA`，`app.asar` SHA-256：`69295BCF91D4E2EBC6E5AF292331CDE34038FD1D1AE614D52238B9DD65E1DE49`。
- 本案完整長片：未執行。

## 最終回報欄位

1. 拒絕行：`src/main/services/concat-render.ts:2395`（舊版）。
2. 失敗比較：picture/base signature；舊值 `390D…DF66`，舊 request 重算值 `7D67…E79B`，目前 canonical 值 `9066…C0A0`。hash 方案跨版本不同；附加的 `projectUpdatedAt` 亦不同。
3. 舊／新 project timestamp：2026-09-27 12:39:31 → 2026-09-28 15:50:42。
4. 內容或路徑：無法唯一歸因；TEMP 路徑可能參與，Project snapshot 缺失。
5. TEMP E:/C:：舊 hash 將 storage setting 混入的風險成立；無法證明是本案唯一 mismatch。
6. YouTube 設定：不在 render hash，非此次拒絕原因。
7. Base audio：是否真的變更為 UNKNOWN；未找到 base partial/audio master。
8. Timeline：完整狀態 UNKNOWN；92 筆 clip selection 與 0.7 秒 transition 欄位相同。
9. Segment：10/10 legacy IDs exact match；59/59 來源 stat 連續；10/10 媒體／SHA 驗證通過，`VALIDATED_SEGMENT_REUSE`。
10. 可重用首層 segment：8,976,508 ms／72,527,956,978 bytes；Base picture、audio、mux 仍需執行。
11. `partial.mkv`：NOT FOUND，無法做 ffprobe／tail decode 恢復。
12. 二十多小時成果：可避免重編已驗證的 10 個首層 segments；因未找到 Base Master，不能宣稱剩餘 Base/audio/mux 已保存。
13. 安全恢復起點：復用這 10 個已驗證首層 segments，然後執行 downstream Base picture、audio、mux；不是從單一 timestamp 接續。
14. 修正測試：TypeScript PASS、render-checkpoint 18/18 PASS、concat integration 47/47 PASS；full regression 76 files／484 tests、production build、source／packaged smoke PASS；npm audit 0 vulnerabilities。
15. 完整 render 結果：未執行。逐欄差異：`RESUME_COMPAT_DIFF.json`。
