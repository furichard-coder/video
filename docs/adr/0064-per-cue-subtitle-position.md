# ADR-0064｜單筆字幕輸出畫布位置

日期：2026-09-14
狀態：Accepted（v0.71.0）

## 決策

每筆字幕可選保存 `position: { xPercent, yPercent }`，範圍為輸出畫布的 5–95 整數百分比。欄位省略時保持舊行為：X=50%，Y 使用全域字幕高度。Manifest 由 schema 18 升級為 19。

Preview 與 Final ASS 都必須呼叫 `resolveSubtitleCuePosition`；前者使用百分比定位，後者將同一百分比換算成目標解析度像素並使用相同 TOP／MIDDLE／BOTTOM anchor。方向鍵移動 1%，Shift＋方向鍵移動 5%，每次動作立即走既有 `setSubtitleCues` 原子保存。

## 相容邊界

標準 SRT 無法可靠編碼 App 的絕對畫布位置，因此 SRT 只匯出文字、換行與時間。Primary 燒錄軌使用 cue position；可選的第二翻譯軌繼續使用原本獨立 track position，以免兩個語言軌被壓到同一個位置。Timeline remap 與行次交換以 cue identity 保存 metadata。
