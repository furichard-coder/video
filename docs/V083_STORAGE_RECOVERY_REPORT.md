# v0.83 TEMP／Resume Storage Recovery Report

## 本機唯讀基準（2026-09-29）

本次只盤點已設定／已知的 SceneryWalker TEMP 根目錄，沒有掃描整部電腦、刪除、搬移或重新轉檔。v0.82 視窗仍開啟，但盤點時沒有 FFmpeg 轉檔程序。

| 路徑 | 可見內容 | 大小 | 判定 |
| --- | --- | ---: | --- |
| `E:\temp\.SceneryWalker_preview_20260926_0243.d8d72501-a0c5-46df-af3e-4ba4c01c419f.resume` | 10 個完成的 MKV segments | 72,527,956,978 bytes（67.547 GiB） | **RESUME_REQUIRED**，禁止直接刪除 |
| `E:\temp\SceneryWalkerCache` | 82 個 JPG／JSON | 1,706,787 bytes（1.63 MiB） | 候選可重建 cache；依賴尚未確認，不標為可刪 |
| `E:\temp\SceneryWalker-v080-quickbench-20260927` | 3 個 MKV | 760,778,128 bytes（725.53 MiB） | UNKNOWN；未證明可刪 |
| E: 的 v0.80／v0.82 命名 `.resume` 目錄 | 空 | 0 | 不提供有意義的空間回收 |
| `C:\Users\fgg88\AppData\Local\Temp\SceneryWalker` | 空 | 0 | 可用作未來新工作的備援，仍須做寫入／容量檢查 |

盤點時磁碟可用：E: 176,677,855,232 bytes（約 164.5 GiB），C: 80,984,784,896 bytes（約 75.4 GiB）。這是當下快照，不代表轉檔開始或失敗瞬間的容量。

目前專案 `033e4b53-b4fa-4418-95d2-5f7bc4b6df86` 的 v0.82 checkpoint `2a268cff-ead8-4b6e-bf50-910a95dcac7a` 狀態為 `PAUSED_DISK_SPACE`。v0.82 checkpoint、舊未版本化 checkpoint、v0.80 checkpoint 均引用上述相同 10 個 MKV 路徑／記錄 SHA。檔案大小與 v0.82 checkpoint 宣告值合計相同。此處的「引用」與大小盤點是唯讀證據；完整媒體／SHA 驗證另見 v0.82 recovery report。不能因新版 checkpoint 存在就把來源 `.resume` 目錄視為已被取代。

在這些已知位置中沒有找到 v0.77、v0.78、v0.79 命名的 TEMP 根目錄或 artifact。這**不是**宣稱整台電腦不存在其他歷史檔案；也沒有足夠證據宣稱 quickbench 或 cache 可直接刪除。故目前可證明「立即安全刪除」的空間為 **0**。

## 「可用 164.54 GiB，仍要求多 54.1 GiB」的來源

v0.82 對本案套用的舊估算式中，已完成且仍在 E: 的 67.55 GiB segments **沒有重複算為新增寫入**。依既有片段的實測碼率推估，仍需產生的 base master 約 92,834,598,094 bytes（86.459 GiB）；接著 final mux 所需的完整成品／音訊／容器額外寫入估為 102,788,912,310 bytes（95.730 GiB）。兩者在同一磁碟上會同時存在，因此推估新增同時峰值為 195,623,510,404 bytes（182.189 GiB）。

舊 `safetyReserveBytes` 又把這個估算的 20%——39,124,702,081 bytes（36.438 GiB）——當成強制門檻。因此顯示的需求約為 218.626 GiB，減去當時 E: 可用約 164.54 GiB，得到「再釋放 54.1 GiB」。這是 **App 的預防性空間閘門**；沒有證據證明這次 FFmpeg 或 Windows 實際回報 `ENOSPC -28`。主要判定問題是將大額建議餘量當成了致命條件，不是把已完成 segments 加總兩次。這些數字仍是模型估算，並非實際重新續轉後量測的最終需求。

v0.83 以 E: Soft Reserve 1 GiB 試算，同一個 182.189 GiB 峰值對上述 E: 空間快照的缺口約 18.645 GiB。新的搬移建議另留 `max(512 MiB, 缺口的 5%)` 模型誤差緩衝；在這個**靜態快照**下，最接近的片段組合是第 1、2、4、8、9 段，共約 19.582 GiB。若使用者確認且每一步 copy／驗證／checkpoint 更新／刪來源均成功，E: 理論可用會約為 184.13 GiB，C: 理論可用約 55.84 GiB。這不是已執行的搬移計畫；真正 UI 必須重新讀取當下空間與檔案狀態，舊快照的 plan ID 過期即拒絕執行。由於峰值本身是估算，這些數字不能保證完整長片必定成功。

## 安全原則

- 本版的清理與搬移 UI 必須先分析，再逐筆提出證據與徵求確認；UNKNOWN、partial、active 與 resume-required 一律保留。
- 目前 67.547 GiB 的 10 段可作「經驗證後搬移」候選，不能作清理候選；未經確認不執行實際跨磁碟複製或刪除。
- 目的磁碟要先證明可寫、有足夠空間。搬移需先 copy、比對大小／內容／ffprobe、原子更新獨立 checkpoint 並驗證 Resume，最後才可移除來源副本；任一步失敗都保留來源。
- 改變 TEMP 路徑、磁碟優先順序或每槽 reserve 不得改變 segment 的內容身份或使舊 checkpoint 失效。

## 實作與驗證結果

- 新預設 Soft Reserve：E:／非系統資料碟 1 GiB；C: 2 GiB，逐槽可設定與持久化。舊版預設路徑（包括本案實際使用的 `E:\temp`）上，舊 20／30 GiB 預設會遷移；其他自訂路徑與數值保留。Soft Reserve 不再與真正 Hard Safety 或 FFmpeg `-28` 混為一談。
- Resume 前由同一份 checkpoint 與剩餘峰值模型建立 Storage Analysis，並提供直接續轉、未開始工作改寫備援、提出搬移計畫或安全暫停。搬移須再確認、即時重新驗證計畫；10 個已完成片段不因 TEMP 路徑改變而重編。
- 搬移只接受已完成、有內容指紋並重驗的片段。跨磁碟 copy 到唯一 partial、比對 size／ffprobe／SHA，使用不覆蓋既存檔的方式發佈；保存目前 checkpoint 與不可變 relocation registry 並讀回驗證後才移除來源。舊 checkpoint JSON 不被覆寫，往後可憑內容指紋重新找到已搬移資料。目的地同名、空間不足、發布失敗均須保留原檔。
- 舊版暫存掃描限制在已設定 root 與明確命名的 SceneryWalker 兄弟目錄；目前 v0.82 的 10 個 MKV 是 `RESUME_REQUIRED`。1.63 MiB 快取只標為 `REBUILDABLE_CACHE` 候選，725.53 MiB quickbench 為 UNKNOWN；兩者尚無足夠的依賴／替代證據，因此不能標成可刪。即時可證明可刪容量為 0，沒有執行清理。
- 完整 Vitest 78 files／496 tests PASS；最後 relocation-registry 安全修正的 focused checkpoint 21/21 PASS；TypeScript、production build、Electron source／packaged smoke、`git diff --check` PASS。Production dependencies audit 0 vulnerabilities；開發依賴 audit 有 1 個 moderate `undici`。獨立封裝 EXE SHA-256 `00A6BA6366C533DC56EF29FC92557D02AA458297D90D7A414C995BDD30F51F24`，`app.asar` SHA-256 `2C128B3E2C159CE87A6EC678906AF022EBC79B76B8AF84A4BF61F7304B5B29D9`。

本次沒有實際搬移／刪除任何真實 E/C TEMP、沒有重啟完整長片 Render，也沒有關閉正在使用的 v0.82 視窗。回歸測試中的故障注入與短媒體案例不能代替完整 20 多小時工作的最終驗收。上面的磁碟需求與搬移數量均是動態估算；實際續轉前仍須以 UI 的新快照與使用者確認為準。
