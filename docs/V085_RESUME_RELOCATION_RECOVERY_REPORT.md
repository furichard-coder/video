# v0.85 Resume Artifact Relocation Recovery Report

日期：2026-09-30  
範圍：只讀診斷與 v0.85 relocation regression 修復；未啟動正式長片 Resume、未搬移或刪除任何媒體。

## Root cause

v0.84 的 `ConcatRenderService.analyzeResumeCompatibility()` 直接以 checkpoint 內的舊絕對 `outputPath` 呼叫 `validateSegment()`。五個 E:\ 路徑因使用者已用檔案總管搬到 C:\ 而不存在，便直接計入 `invalidSegmentCount`；既有 `discoverAndRemapCompletedArtifacts()` 只有 TEMP 空間精靈的手動按鈕會呼叫，並非相容性分析或真正 `concat:resume` 的前置步驟。因此畫面顯示 5 reusable／5 needs rebuild，雖然 render identity、timeline、video、audio 都沒有改變。

v0.85 在兩個入口都加入相同的 bounded recovery gate：只掃已登錄的 SceneryWalker TEMP roots，優先完整檔名與大小候選，再驗證 ffprobe 媒體屬性及 checkpoint SHA-256。相容性報告只在記憶體預覽 Mapping；使用者明確掃描或 Resume 時才發佈 content-addressed path-remap overlay。原 v0.82 checkpoint JSON 與所有媒體保持不變。

## 真實十片段驗證

Checkpoint：`033e4b53-b4fa-4418-95d2-5f7bc4b6df86.v082.render-state.json`  
Checkpoint SHA-256（驗證前）：`A9B5D8ABAB9F54C159F26539DF3F631ECB8E9D8CA071C0076D9ADFA1765E9A31`  
狀態：10／10 `COMPLETED`，總時長 `02:29:36.508`，總大小 `67.547 GiB`，`concatStatus=PAUSED_DISK_SPACE`。

| Segment | Artifact ID | 目前位置 | Bytes | Duration ms | size | ffprobe | SHA-256 |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| 001 | `2e026c2a2081bbdb9a3dca90` | C:\ TEMP root | 619,893,179 | 75,742 | MATCH | PASS | MATCH |
| 002 | `1bf7cfb392a6696127026884` | C:\ TEMP root | 345,535,452 | 52,517 | MATCH | PASS | MATCH |
| 003 | `641389e0fc8e6a065a8af08d` | E:\ original root | 2,547,753,259 | 347,590 | MATCH | PASS | MATCH |
| 004 | `b2cdaaf9e49645e0d2da96d5` | C:\ TEMP root | 12,792,945,747 | 1,555,134 | MATCH | PASS | MATCH |
| 005 | `bd68f77c7644d1e239bd3bb5` | E:\ original root | 28,388,814,878 | 3,454,890 | MATCH | PASS | MATCH |
| 006 | `1a925452d422c5b2a238e329` | E:\ original root | 2,271,647,642 | 300,746 | MATCH | PASS | MATCH |
| 007 | `035acf82f07b4774c27b9d0a` | E:\ original root | 18,172,428,006 | 2,221,424 | MATCH | PASS | MATCH |
| 008 | `b61bd3635b469e369cafb777` | C:\ TEMP root | 7,224,745,963 | 897,286 | MATCH | PASS | MATCH |
| 009 | `b7666e70ce8e44620058d1a5` | E:\ original root | 42,812,619 | 43,700 | MATCH | PASS | MATCH |
| 010 | `8cd83335a2a6b49477988a7d` | C:\ TEMP root | 121,380,233 | 27,479 | MATCH | PASS | MATCH |

全部十個檔案均為 H.264、3840×2160、30000/1001 fps、AAC 48 kHz stereo。ffprobe container duration 比 checkpoint duration 多 0.02 秒，落在既有 250 ms 容許範圍；十個完整 SHA-256 均與 checkpoint 完全相同。

搬移的 001／002／004／008／010 合計 `19.655 GiB`、`00:43:28.158`。未搬移的 003／005／006／007／009 合計 `01:46:08.350`，即 v0.84 畫面原本顯示的五個 reusable；所以五個 needs rebuild 精確對應搬移，而不是內容或 render key 改變。

## 修正後 Resume 結果

- Path Mapping：001／002／004／008／010 由 checkpoint 的 E:\ 舊路徑對應到 `C:\Users\fgg88\AppData\Local\Temp\SceneryWalker\` 下的同名平移檔案。
- 經真實內容驗證與隔離回歸得到的 recovery plan：Reusable 10／10；Needs Rebuild 0。為避免與仍在執行的 v0.84 共用 userData，本次未另開 v0.85 live UI，因此不把它誤寫成已在正式 UI 觀察到的畫面結果。
- Resume 起點：所有 level-1 segment 都已完成，下一步是下游 final concat／base master 階段；`02:29:36.508` 是十片段合計時長，不是保證的 seek timestamp。沒有新的 level-1 segment encoder 工作。
- 已搬移 MKV 重新 Encode：否。回歸測試確認已復原完成片段不會再次出現在 segment encoder 階段。
- Final concat：直接使用 E:\ 與 C:\ 的絕對路徑；不搬回 E:\，也不因跨 volume 改成 full re-encode。
- partial.mkv：缺少 partial 不會降低任何已完成 segment 的 reuse 狀態；segment recovery 與 project partial recovery 分離。

正式長片 Resume 尚未在本次修復中啟動，因此上述是經真實十檔內容驗證及短媒體端到端回歸證明的 Resume plan，不宣稱已完成最終 master。
