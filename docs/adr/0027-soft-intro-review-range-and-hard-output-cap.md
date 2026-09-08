# ADR 0027｜片頭檢看範圍與輸出上限分離

日期：2026-09-06  
狀態：Accepted

## 背景

使用者需要把片頭拉桿拉到目前「每段最高秒數」之外，完整比較人物、事件、故事的起訖點；原本 ProjectStore 與 UI 都把此上限當成儲存限制，導致拉桿保存失敗或被截短。

## 決定

- `IntroSuggestion.inMs/outMs` 保存人工檢看的完整來源範圍。影片只受來源邊界與至少 3 秒限制；照片仍為 3–7 秒。
- `introSegmentMaxDurationMs` 保持 3–22 秒可持久化設定，但語意改為實際輸出上限。
- 超時是 soft warning：片段卡及拉桿顯示橘紅色，回到上限內立即復原；原始素材預覽仍循環完整範圍。
- 使用者啟動片頭輸出時先看二次確認；安全預設焦點為「返回調整」。確認後每段保持 IN，令 `outputOutMs = min(reviewOutMs, reviewInMs + configuredMaximumMs)`。
- Renderer 先顯示實際截取清單；Main service 以專案狀態重算相同 canonical ranges 並精確比對 request。此規則同時用於片頭、片頭＋正片與字幕 480P 片頭代理。
- 只有明確按下「套用上限並均衡」時，才會重排／縮短已保存檢看範圍；單純拖拉不會觸發均衡。

## 安全與相容性

- 不改 manifest schema，舊專案直接相容；新版本可保存較長影片檢看範圍。
- 不改寫來源、proxy 或 metadata。正式輸出仍從來源建立，App cache 只供檢看。
- 設定上限仍不得高於 22 秒；這是產品輸出限制，不再妨礙人工檢看較長範圍。
