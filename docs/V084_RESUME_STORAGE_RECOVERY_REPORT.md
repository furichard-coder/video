# v0.84 Resume／TEMP 搬移復原報告

## 本次實際專案：唯讀盤點

盤點日期：2026-09-29。v0.83 視窗仍在執行，但盤點時沒有 FFmpeg／ffprobe 轉檔程序；沒有對下列真實片段做搬移、刪除、覆寫或長片續轉。當時 E: 可用約 164.544 GiB，C: 可用約 74.571 GiB，C: 的 SceneryWalker 備援 TEMP 為空。

目前 v0.82 copy-on-write checkpoint：`C:\Users\fgg88\AppData\Roaming\SceneryWalker 素材整理\projects\render-state\033e4b53-b4fa-4418-95d2-5f7bc4b6df86.v082.render-state.json`，checkpoint ID `2a268cff-ead8-4b6e-bf50-910a95dcac7a`，狀態 `PAUSED_DISK_SPACE`。其 10／10 個 level-1 segment 均標為 `COMPLETED`，存在於 `E:\temp\.SceneryWalker_preview_20260926_0243.d8d72501-a0c5-46df-af3e-4ba4c01c419f.resume`。目前檔案大小均符合 checkpoint；逐檔 `ffprobe` 都可讀到 H.264／AAC、3840×2160。checkpoint 已保存 SHA-256，這次唯讀盤點**沒有**重新對 67.547 GiB 全量計算 SHA 或做尾段解碼；正式重用／搬移仍必須重驗。

|  段 | 檔名                                            | 大小（GiB，約） |  片段長度 |
| --: | ----------------------------------------------- | --------------: | --------: |
|   1 | `level-1-part-001-2e026c2a2081bbdb9a3dca90.mkv` |            0.58 |  1:15.742 |
|   2 | `level-1-part-002-1bf7cfb392a6696127026884.mkv` |            0.32 |  0:52.517 |
|   3 | `level-1-part-003-641389e0fc8e6a065a8af08d.mkv` |            2.37 |  5:47.590 |
|   4 | `level-1-part-004-b2cdaaf9e49645e0d2da96d5.mkv` |           11.91 | 25:55.134 |
|   5 | `level-1-part-005-bd68f77c7644d1e239bd3bb5.mkv` |           26.44 | 57:34.890 |
|   6 | `level-1-part-006-1a925452d422c5b2a238e329.mkv` |            2.12 |  5:00.746 |
|   7 | `level-1-part-007-035acf82f07b4774c27b9d0a.mkv` |           16.92 | 37:01.424 |
|   8 | `level-1-part-008-b61bd3635b469e369cafb777.mkv` |            6.73 | 14:57.286 |
|   9 | `level-1-part-009-b7666e70ce8e44620058d1a5.mkv` |            0.04 |  0:43.700 |
|  10 | `level-1-part-010-8cd83335a2a6b49477988a7d.mkv` |            0.11 |  0:27.479 |

合計 **72,527,956,978 bytes（67.547 GiB）**、checkpoint 媒體時間 **8,976,508 ms（2:29:36.508）**。10 段都是仍需保留的 level-1 中繼成果，不是單一 67.5 GiB MKV，也不能因為「完成」就直接當正式成品刪除或跳過所有後續處理。實際 FFmpeg 診斷記錄顯示下一階段為 `BASE_MASTER`：10 段輸入、轉場／字幕／浮水印的 filter graph、`h264_qsv` 輸出 base MKV。原 `.base.partial.mkv` 及最終 MP4 目前不存在；因此可免重編的是上述 10 段，後續 base picture、音訊與 mux 仍要執行，不能不顧畫面效果強行 `-c copy` 到成品。

## v0.83 按確認後沒有續轉的原因

v0.83 的「確認搬移建議項目並重新分析」只走到：UI → `concat:execute-resume-storage-plan` → copy／驗證／checkpoint 變更 → 重新分析 → UI notice。成功後沒有再進入 `concat:resume`，所以按鈕文案中的「重新分析」其實就是流程終點。這是控制流程缺漏，不能只靠改文案解決。現況 C: 備援資料夾仍為空、10 個 E: 片段仍存在，故目前沒有證據顯示這次實際完成過搬移；也不能僅據截圖推斷使用者是否已按過 Windows 確認框後續按鈕。

## 空間試算與搬移安全

在 v0.83 報告的剩餘同時峰值約 182.189 GiB、E: soft reserve 1 GiB，以及本次 E: 164.544 GiB 快照下，E: 約缺 18.645 GiB；再加模型誤差緩衝約 0.932 GiB，靜態最小容量組合可用第 1、2、4、8、9 段，合計約 19.582 GiB。**這只是快照計算，不是已執行的搬移清單**；實際方案必須重新量測兩槽空間、驗證檔案與當前 checkpoint，並由使用者確認。若這些片段成功移到 C: 且 E: 原檔經授權後才移除，理論上 E: 可用約 184.126 GiB、C: 約 54.989 GiB。若把全部 67.547 GiB 搬到 C:，C: 將只剩約 7.024 GiB，故不應預設全搬。

使用者手動複製與手動移動是不同狀態：若 E: 與 C: 同時保有副本，E: **並未釋出空間**。目的地即使經驗證，也不能偷偷刪除來源。來源片段、既有 checkpoint、舊版 release、成品與原始媒體均保持受保護。

## v0.84 續轉契約與驗證

本版流程：分析 → 列出個別 Artifact 與目的路徑 → 手動搬移／受控 App 搬移 → 掃描已登錄 TEMP 根目錄 → size／媒體參數／SHA 驗證 → copy-on-write checkpoint 與位置索引更新 → 重新量測 E/C → 容量足夠時**實際呼叫** `concat:resume`。任何一關失敗都保留原始片段，不能以路徑改變當成影片內容改變。

- UI 由最新分析回傳值判斷 `READY_TO_RESUME`，不依賴尚未更新的 React state；續轉 IPC 在 Main 再次做空間 gate。手動掃描或 App 搬移若產生新的 COW checkpoint ID，會同步刷新 offer／相容性報告並以新 ID 執行。
- 手動掃描只走已登錄 TEMP root，限制深度 6、最多 50,000 個目錄項與 10,000 個 MKV／MP4；超限明確停止並要求縮小根目錄。候選先比對大小，再作媒體屬性與 SHA 驗證，支援改名與跨磁碟移動。
- 新選擇的備援 TEMP 先安全登錄到目前的 COW 工作 checkpoint 才能搬移，不將位置加入 render identity。來源和目的地可在精靈逐檔檢視與複製路徑；資料夾開啟僅允許已登錄 TEMP 內的路徑。
- 以短測試媒體完成「手動複製＋改名 → 移除測試來源 → 掃描與驗證 → checkpoint remap → 新空間分析 READY → 實際 Resume」整合測試。測試確認已完成的第一段沒有再次編碼。這不是本機 67.547 GiB 真實專案的完整續轉驗收。

目前明確限制：App 自動大型搬移尚無即時 bytes／速度／ETA 與只停止複製的 Cancel；若使用者選擇 Copy 而 E: 原檔仍在，App 只會回報 duplicate，不會自動刪原檔，也沒有本版的獨立確認刪除工作流。精靈可依現存 checkpoint 重新分析，但逐階段進度與精靈 UI 狀態尚未跨重啟持久保存。這些項目不能標為完成；大型資料預設建議手動處理，並在續轉前確認 E/C 當下容量。

最終驗證：TypeScript PASS；完整回歸 78 files／498 tests PASS；短媒體「移動／改名→內容驗證→COW remap→READY→真正 Resume，且舊段不重編」整合測試 PASS；production build、source 與獨立封裝後的 Electron smoke PASS；`git diff --check` PASS。Production dependencies audit 0 vulnerabilities，開發依賴有 1 個 moderate `undici`。v0.84 EXE SHA-256 `FFD0B56900E9C569E4C2A99A7E20F1A62CAAE61AA56AF5AFCF5909750350BE7F`，`app.asar` SHA-256 `15A162205FB2335050635B4AFC6AA92DF66A07B4D7E8068016154D3FD03EF096`。

主要程式修改：`src/renderer/components/ConcatRenderModal.tsx`、`src/renderer/styles.css`（精靈、重新掃描後續轉、逐檔資訊）；`src/main/services/render-checkpoint.ts`（有界內容辨認、驗證與 COW remap）；`src/main/services/concat-render.ts`（空間狀態與備援槽銜接）；`src/main/ipc.ts`、`src/main/preload.ts`、`src/shared/domain.ts`（受限 IPC／狀態契約）；`tests/render-checkpoint.test.ts`、`tests/concat-render.integration.test.ts`、`tests/renderer/concat-render-modal.test.tsx`（安全與跨流程回歸）。版本與交付文件：`package.json`、`package-lock.json`、`README.md`、`CURRENT_PRODUCT_SPEC.md`、`docs/CHANGELOG.md`、`docs/VERIFICATION.md` 與本報告。

本報告不是對完整長片 Resume 成功的宣稱；尚須在使用者確認搬移及實際轉檔後，才能記錄真正總耗時與成品 QC。
