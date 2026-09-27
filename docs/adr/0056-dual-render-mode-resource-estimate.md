# ADR-0056｜雙轉檔模式與工作負載資源預估

日期：2026-09-12
狀態：Accepted

## 背景

既有低記憶體模式已能把超過六個 visual inputs 的工作遞迴分段，但 UI 只有一個勾選，預估也只是片長乘固定倍率：暫存固定視為成品兩倍、時間固定乘 1.9，沒有 RAM、來源解析度／FPS／codec、照片、插入素材或實際 stage 數。因此無法讓使用者在開始前合理比較速度、RAM 與 SSD 取捨。

## 決策

1. 低記憶體分段與一般轉檔為互斥 radio；低記憶體是新安裝及未設定專案的預設。既有 preference Boolean 繼續相容。
2. Main process 由 canonical project assets 與 exact clip selections 建立一次 workload，並在同一時間點讀取輸出磁碟與系統 RAM，回傳兩種模式。Renderer 不估算、不提供任意 path。
3. 成品大小依片長、目標解析度／H.264 或 H.265 bitrate、AAC 192 kbps 與 8% container allowance。
4. SSD 工作空間：一般模式為 growing partial 成品；分段模式另模擬每層 group duration 與 H.264 intermediate 大小，採與實作相同的「新檔完成驗證後才刪 consumed 舊檔」順序求 live peak。
5. RAM 峰值：384 MiB process 基底，加上 concurrent decoders 的來源 YUV frame queues（來源 pixel、FPS、codec factor）、輸出 normalized/filter buffers。一般模式 concurrent count 等於全部輸入；分段通常最多六個，Main-start card 邊界保守抓七個。
6. 時間：20 秒啟動成本，加上目標 resolution/codec realtime factor × 成片長 × duration-weighted source decode complexity × graph/insertion factor；分段模式再加入所有 intermediate duration 的 H.264 realtime cost及每個工作八秒啟動／I/O allowance。
7. RAM 估算達可用量 75% 或 SSD 工作空間達安全可用量 80% 顯示 WARNING；達 100% 顯示 DANGER。這些不禁用模式。只有所選模式在尖峰 SSD 工作期間無法保留 1 GiB 時，沿用既有 start gate 阻擋。

## 一致性

模式欄位只傳給 `ConcatRenderService` 決定是否建立 intermediates。兩者共用同一 ordered inputs、clip selections、transition、subtitle、BGM、watermark、audio protection、canvas 與 final codec request。低記憶體 intermediate 是 normalized 工作檔，不是另一條內容時間軸；final output 的預期 duration、解析度及 codec 必須與一般模式實測一致。

## 邊界

這是預估模型，不是硬體 benchmark。GPU driver、熱降頻、其他程式、素材複雜度與磁碟速度仍會改變實際值，所以 UI 固定顯示「約／預估」。未新增刪除 cache、修改來源或自動選擇模式的行為。
