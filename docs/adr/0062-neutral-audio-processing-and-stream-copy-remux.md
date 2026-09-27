# ADR-0062｜中性 Audio Processing 與影像 stream-copy 重新封裝

## 決策

不使用需要授權確認的品牌名稱。輸出設定使用 Original Stereo 2.0、Enhanced Stereo 2.0、Virtual Surround 5.1，以及「保持原始多聲道」。

既有 FFmpeg 串聯圖仍負責畫面、片段原音、無聲片段指定 BGM、配樂、轉場、保護性動態與時間軸。Enhanced／Virtual 只讀取該 timeline-correct stereo master 的音軌；第二個 FFmpeg 工作以 `-c:v copy` 保留畫面 bitstream，只重新編碼音軌並原子替換 partial。這樣切換音訊模式不會重做影片 frames，也不移動字幕或時間軸。

## Channel mapping

- FL／FR：以原始 L／R 為基礎並保守降低增益。
- FC：L／R 共同成分，穩定中央人聲與旁白。
- SL／SR：L-R／R-L 差異成分，經過高／低通與 11–18 ms 不同延遲。
- LFE：L+R 低頻成分，80／100／120 Hz 二階 low-pass。
- 輸出 join layout：`5.1(side)`，固定 `FL FR FC LFE SL SR`。
- Master：LUFS normalization + true-peak limiter；預設 Natural、-16 LUFS、-1.5 dBTP。

5.1 雙聲道試聽是保守的 downmix compatibility monitoring，不宣稱 HRTF 或 binaural。原生多聲道 bitstream preserve 第一版限單支影片時間段；多片段與轉場必須重新混音，因此拒絕假裝保持原始音軌。

## 安全與相容性

所有 preview/intermediate 位於 App cache 或唯一 partial。失敗／取消清除 partial，來源永遠唯讀。Audio processing 參數進入 render request signature，因此 Resume 不會誤用不同音訊 profile 的 segment。
