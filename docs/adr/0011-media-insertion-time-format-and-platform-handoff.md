# ADR-0011：通用素材安插、分鐘秒數與平台投稿交接

日期：2026-09-03  
狀態：Accepted

## 背景

使用者希望影片卡除了可安插照片，也能安插另一支影片；插入影片需有獨立 IN／OUT，可在同一主片位置串接多個照片／影片。安插與音量時間不再以純秒數輸入，而要使用容易閱讀的分鐘:秒數。完成正片預覽後，除 YouTube 外也要能前往 BiliBili 與 TikTok 投稿。

## 決定

- Manifest 升級為 schema 8，將 `photoInsertions` 一般化為 `mediaInsertions`。每筆保存主片 asset ID、插入 asset ID、主片安插時間、插入來源 IN／OUT、同點次序與原正片索引。
- 照片仍使用每張 3–7 秒設定；影片使用獨立來源範圍。規劃器依安插時間與次序展開成主片前段、插入素材鏈、主片後段。素材安插後離開頂層正片清單，避免重複播放。
- 同一時間可接續多個素材；UI 提供「接前／接後」。巢狀安插暫不允許，避免第一階段形成難以預測的遞迴時間線。
- 安插點、音量區段開始／結束使用 `M:SS`、`M:SS.xx`，也接受 `H:MM:SS.xx`。Renderer 解析後只傳整數毫秒，Main process 再做邊界驗證；manifest 與 FFmpeg 全程維持毫秒。
- YouTube 保留官方 OAuth／resumable upload。BiliBili 與 TikTok 在沒有平台開放應用、使用者授權及核准 scope 時，採官方頁面交接：只允許本工作階段完成的非空 Main MP4，複製完整路徑、在 Explorer 選取並開啟固定官方投稿頁。
- BiliBili／TikTok 交接不保存平台帳密、不自動點擊發布，也不宣稱已上傳成功。真正 API adapter 留待開放平台身分、應用與 scope 就緒後再實作。

## 安全與相容性

- schema 1–7 自動遷移；舊 `photoAssetId` 轉為 `insertedAssetId`，照片來源範圍由已保存的顯示時長補齊。
- 插入、取消、排序及輸出只改 manifest／App 輸出，不改寫、搬移或刪除來源。取消多個安插素材時，依保存的虛擬原順位恢復，與取消順序無關。
- 平台 URL 在 Main process 固定，Renderer 只提供 job ID 與 platform enum；路徑含中文或空格不經 shell 字串組合。
- Preview 仍是衍生 cache，不成為正式輸出來源。

## 已知界線

- 本版不支援安插素材內再巢狀安插。
- BiliBili／TikTok 是可操作的官方投稿頁交接，不是背景自動上傳。平台頁面、登入狀態、metadata 與發布結果由平台控制。
