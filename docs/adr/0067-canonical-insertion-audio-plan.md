# ADR-0067：每次插入實例共用 SFX／BGM Audio Plan

日期：2026-09-15
狀態：Accepted（v0.74.0）

## 決策

正片安插與片頭片段都把音訊選擇保存到該次出現的 `insertionAudio`，而不是 `SourceAsset`。照片預設啟用已核准的「相機快門效果音（SFX）」；影片預設不啟用 SFX。SFX 與 BGM 是兩個獨立選擇，可同時開啟或關閉。舊專案載入 schema 20 時，會把既有照片的明確關閉狀態保留下來；沒有 instance 欄位的照片按既有 `photoSoundEnabled` 補值，BGM 不憑空開啟。既有非安插靜音影片的 `dubWithBgm` 仍保留；安插素材只由新欄位控制，避免同一實例受到兩套規則重複配樂。

`buildInsertionAudioPlan` 是 Main、Renderer Preview 與 Final Export Review 的共同單一資料來源。它先用實際素材時長與轉場重疊建立 Project Timeline，再產生每個插入實例、照片開始可見（xfade 起點）的獨立 SFX event，以及連續、相鄰、同 scope 且同 `bgmTrackId` 的合併 BGM range。

同一來源可有多個 Main／Intro occurrence，各自保存 SFX／BGM，不互相覆蓋。若 A/B/C/D 的實際時長為 3/4/6/3 秒且轉場為 0，連續同曲 BGM range 為 16 秒；轉場為 0.3 秒時依三次 overlap 成為 15.1 秒。

## FFmpeg

畫面輸出拆成兩個明確階段。第一階段只建立 timeline-correct 畫面與來源／既有全域 BGM 基礎音軌，寫成 MKV（成品 video codec＋FLAC Stereo）；**不含任何 per-insertion BGM/SFX**。第二階段讀取同一份 canonical plan，把 base audio、連續 insertion BGM ranges 與照片 SFX events 一次 `amix`，再直接進入 Original limiter、Enhanced Stereo 或 Virtual Surround 5.1，最後以 `-c:v copy` 封裝 MP4。這樣只改 SFX、BGM、音量、fade、loop 或 Audio Processing 時，不再解碼／重編影片，也不多做一代 lossy intermediate audio encode。

短 BGM 採有限次數 `asplit + acrossfade` 循環，單一 range 最多 32 份；超過上限改為 `aloop` 加短接點增益平滑並寫入 plan warning，避免產生無界 `filter_complex`。SFX 只使用 `adelay` 放到 canonical timeline，不改變 BGM 播放位置。

`pictureBaseSignature` 排除 occurrence insertion audio 与 final DSP；`finalAudioSignature` 纳入 canonical plan 与 Audio Processing。每專案在 App userData 的 render-state cache 保留最近一份經 size、SHA-256、duration、video stream 驗證的 base master，成功後不跟 `.resume` 目錄一起刪除，App 重開仍可重用；新畫面簽章成功保存後才移除舊 master。轉檔頁把這份可重建 master 納入 SSD 預估，並提供需確認的單獨清理按鈕，不刪除來源或既有成品。

Preview 重用現有 proxy video，以獨立 audio element 播放同一個 plan 的 BGM／SFX，不重新編碼 proxy。同一 asset 有多個 occurrence 時必須先選擇插入實例；沒有 occurrence context 的一般來源預覽明示只播放原素材，不假裝是最終插入混音。

## 音效來源與封裝

沿用草漯沙丘前案已核准的 Pixabay／Freesound Community `camera-shutter-click-14671.mp3`，SHA-256 固定為 `0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93`。封裝前驗證 hash，封裝後放入 `resources/assets` 並附來源／授權說明；不下載或替換成未核准素材。

## 取捨

瀏覽器 proxy 試聽維持與 Final 相同的起點、曲目、連續播放位置、Loop 與獨立 SFX，但不在瀏覽器內重做 Final 的 loudnorm／5.1 DSP；正式成品仍以 FFmpeg 結果為準。極短 BGM 需要超過 32 次循環時使用有界接點平滑，UI 會明確列出該策略。第一版每專案只保留最近一份 base master，不是無上限 LRU；清理後可安全重建，但下一次音訊修改需重新編碼畫面。
