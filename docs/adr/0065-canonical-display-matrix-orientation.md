# ADR-0065：Display Matrix 單次方向正規化

日期：2026-09-14
狀態：Accepted（v0.72.0）

## 問題與實證

同一支 `VID_20260718_090633.mp4` 同時是片頭最後片段與正片最後一支影片。來源 coded frame 是 `3840x2160`，Display Matrix rotation 是 `-90`，所以正確 visual frame 是 `2160x3840`。舊 pipeline 依賴 FFmpeg 預設 autorotate：software decode 會自動插入 `transpose`，但 `-hwaccel qsv -hwaccel_output_format qsv` 成功時只輸出未旋轉的 `3840x2160` hardware frame；既有 `hwdownload,format=nv12` 後沒有方向濾鏡，接著直接 scale/layout，造成側轉。

這不是「所有 9:16 都少轉 90 度」。正常比較素材 `VID_20260718_113747.mp4` 也是 coded `3840x2160`／Display Matrix `-90`，主要差異是 60 fps、Level 5.2 與分段執行上下文；是否碰到 QSV 成功或整批退回 software autorotate，才使舊版結果不一致。

## 決策

所有影片 input 一律使用 deterministic policy：

1. input 加 `-noautorotate`，禁止 decode backend 暗中改變方向。
2. `media-orientation.ts` 將正負角度正規化為 `0/90/180/270`，從 coded dimensions 算 visual dimensions。
3. 原始 leaf input 在 decode（硬解時先 `hwdownload`）之後、fps/scale/crop/pad 之前只套一次顯式方向修正：
   - matrix `0` → 不加方向 filter
   - matrix `90` → `transpose=cclock`
   - matrix `180` → `hflip,vflip`
   - matrix `270`／`-90` → `transpose=clock`
4. 已正規化 intermediate 不再旋轉；stage/final output 清除輸入 metadata，並寫 `rotate=0`，避免播放器再轉一次。
5. Thumbnail、Proxy、Clip Proxy、Intro、Main、Shorts 與 Final 共用同一 resolver；preview cache version 升級，舊方向策略產物不會命中。
6. Orientation normalizer version 進入 render request signature，v0.71 以前的錯誤方向 checkpoint 不可被 v0.72 誤用。

## FFmpeg 關鍵差異

舊 QSV leaf：

```text
-hwaccel qsv -hwaccel_output_format qsv -i source
[0:v]hwdownload,format=nv12,fps=...,scale=...,crop/pad=...
```

v0.72：

```text
-hwaccel qsv -hwaccel_output_format qsv -noautorotate -i source
[0:v]hwdownload,format=nv12,transpose=clock,fps=...,scale=...,crop/pad=...
-map_metadata -1 -metadata:s:v:0 rotate=0
```

Software fallback 使用同一個 `-noautorotate + explicit orientation filter`，因此 QSV 成功與 fallback 不再產生不同方向。

## 安全與相容性

- 來源媒體只讀；方向只物理套用到 proxy/intermediate/output pixels。
- 0 度橫片與物理直式（width < height、無 rotation metadata）不加 transpose。
- 16:9／9:16 canvas、blur fill、crop/scale、字幕、音訊與 timeline 不變；方向先正規化後才進既有 layout。
- Resume signature 隔離舊 intermediate，避免錯誤方向被安全驗證為可重用。
