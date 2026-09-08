# ADR-0006：照片時間與可攜式專案檔

日期：2026-08-31  
狀態：Accepted

## 決策

- Manifest 升級為 schema 4。每個 `IMAGE` asset 保存 `imageDurationMs`，預設 5000 ms，只接受 3000–7000 ms；網格提供 3、4、5、6、7 秒選項。
- 照片時長納入總體預覽、正片時間基準、字幕複核及串連 MP4。FFmpeg 將照片循環成固定幀率片段，交接沿用既有 xfade／acrossfade；照片本身不產生假音訊，只使用等長靜音軌參與混合。
- 放大照片優先使用 ffprobe display dimensions／rotation，以 `object-fit: contain` 顯示完整構圖。直式照片輸出沿用中央等比前景及同來源放大模糊背景。
- 左上角「檔案」選單提供儲存、另存 `.swproj` 及開啟舊專案。Renderer 不傳入任意路徑；路徑只由 Electron 原生對話框產生。
- `.swproj` 保存完整 `ProjectManifest`，包括來源引用、順序、裁切、照片時長、排除、Intro、音量、BGM 與字幕；不內嵌來源媒體、proxy、縮圖或分析 cache。
- 專案寫入使用同資料夾唯一 partial，完成後可恢復替換。開啟前先完整解析及 migration；未知或損壞 schema 不取代目前專案。

## 相容性與安全

- schema 1／2／3 自動遷移到 schema 4；舊照片補 5 秒，其餘既有欄位保留。
- 命名儲存後，後續 manifest 變更同步到 App Data recovery 與目前 `.swproj`。重新啟動會嘗試恢復最近使用的有效專案檔；檔案遺失或損壞時回退 App Data recovery。
- 所有來源與來源 metadata 仍為唯讀；專案檔只引用來源絕對路徑。移動專案到其他電腦時，缺少的媒體會顯示離線／預覽失敗，不會以 cache 假冒正式來源。
