# ADR-0004：非破壞性移除與正片排除區段

狀態：Accepted  
日期：2026-08-30

## 決定

Manifest 升級為 schema 3。`sources` 是唯讀來源資產庫，不再因 UI 的「刪除／移除」而刪除項目。正片使用 `timelineOrder`、`pendingAssetIds` 與 `excludedMainAssetIds` 表示；移除時保存原索引、原排序模式與待決定狀態，來源的 IN／OUT、音量區段、安插紀錄、cache key 及 metadata 都保留。`recentMainRemovals` 提供重開後仍可使用的一鍵恢復。

Intro 使用獨立的 `introSegments`。移除一段時只按 segment ID 操作，並以 `introExcludedSegmentIds` 阻止後續分析自動加入同一建議；`recentIntroRemovals` 保存完整片段與原索引，只有使用者主動恢復才重新加入。Main 移除或 Main 排除時間都不改動 Intro。

## 正片排除區段

每個影片來源可有 `mainExclusionRanges`，時間採來源絕對毫秒並限制在目前 IN／OUT。保存時依開始時間排序，重疊或相鄰區段合併；IN／OUT 縮短時裁切或移除超界區段並回報。這些資料只存在 App manifest，不改寫來源、proxy 或 metadata。

輸出前以同一個共享函式把每個素材的有效 IN／OUT 扣除 exclusion ranges，得到零個或多個保留子片段。Renderer 顯示的正片總時間、字幕上限與 Main process 輸出白名單均使用此結果。Main process 要求 Renderer 提交的 asset ID、IN、OUT 與 manifest 展開结果完全一致，防止待決定或已排除時間繞過 UI 進入輸出。

每個保留子片段直接以原檔對應時間解碼，不建立靜音或黑畫面占位。音量 automation 仍以來源絕對時間表示，進入每個保留子片段時再換算成局部時間；BGM 依扣除後並套用 xfade 的實際輸出長度裁切。直式版式對每個子片段沿用同源 split／blur／overlay。

## 安全與復原

- 本版沒有磁碟來源刪除 API。
- 正片移除確認視窗的預設焦點是取消；危險按鈕具有明確 accessible name。
- 所有移除／恢復、IN／OUT 與正片排除變更都增加 `timelineRevision`，使既有字幕進入待複核狀態。
- 正片沒有任何保留影片片段時，UI 與 Main process 都阻擋輸出並提供可理解原因。
- schema 1／2 自動補空的 schema 3 欄位；未知或損壞 manifest 直接報錯，不覆寫成空專案。
