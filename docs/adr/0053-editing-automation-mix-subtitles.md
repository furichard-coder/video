# ADR-0003：Timeline 順序、音量 automation、BGM 與 SRT

狀態：Accepted  
日期：2026-08-29

## Manifest 與遷移

Manifest schema 升級為 2。讀取 schema 1 時，保留既有來源與 IN／OUT，補上 `timelineOrder`、`pendingAssetIds`、`placementDecisions`、片段 `volumeSegments`、`bgmTracks`、`subtitleCues` 及 revision 欄位，再原子保存。格式不相容或 JSON 損壞時停止，不以空專案覆寫。

## 素材順序

第一次匯入依原本排序規則建立 timeline。已有素材後的新增項目進入待決定區，由使用者逐筆指定 FRONT／END／BEFORE／AFTER／PENDING。手動移動後切換為 `MANUAL_ORDER`。Main process 在串連前核對 Renderer 提交的 ID 與 manifest 已排定影片順序，待決定素材不能繞過 UI 進入輸出。

## 畫面版式

ffprobe 同時讀 coded dimensions 與 display-matrix rotation，計算實際顯示方向。直式素材使用同一解碼來源分流：背景分支等比放大、裁切與模糊，前景分支等比縮放，最後置中 overlay；不使用非等比橫向拉伸。

## 音訊

片段音量區段為來源絕對時間，限制 0%–300%、位於目前 IN／OUT 且不得重疊；輸出時換算成片段局部時間，未覆蓋處為 100%。IN／OUT 改變會裁切或移除超界區段並回報筆數。

MP3 只能由原生檔案選擇器加入，來源欄位之後不可由 Renderer 改寫。BGM 提供 timeline、source IN／OUT、淡入淡出與 0%–300% 增益；source span 與 timeline span 相同，本版不做音樂變速。片段原音先完成 acrossfade，再與 BGM 以 `amix normalize=0` 混合，最終套用 `alimiter=limit=0.95`。300% 是增益上限，不代表主觀響度三倍。

## 字幕

字幕 cue 禁止重疊，使用素材順序與 IN／OUT 所形成的總時間基準。每次順序或裁切改變會增加 `timelineRevision`；字幕只有重新保存後才把 `subtitleTimelineRevision` 對齊。SRT 使用 UTF-8、連續序號與 `HH:MM:SS,mmm`，先寫唯一 partial 再完成目標檔。

本版刻意不燒錄字幕：跨 Windows 環境的 FFmpeg subtitles filter、libass 與字型解析需要獨立依賴與字型驗收，不能以只有 SRT 匯出冒充燒錄完成。
