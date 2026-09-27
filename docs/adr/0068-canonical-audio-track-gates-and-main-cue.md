# ADR-0068：Canonical Audio Track Gates 與正片提示音

日期：2026-09-17
狀態：Accepted（v0.75.0）

## 背景

v0.74 已有 per-occurrence SFX/BGM，但 Main ordinary clips 沒有獨立軌道 gate；正片開始提示頁也沒有音訊模型。若 Renderer、Preview 與 FFmpeg 各自推導，會出現 UI 已關閉而 Final 仍播放、BGM 在 clip 邊界重播，或 audio-only 修改誤觸 video encode。

## 決策

新增共用 `AudioTrackGates { original, voice, bgm, sfx }`。Main ordinary clip 保存於 `SourceAsset.mainAudioGates`；Main insertion 與 Intro occurrence 保存於 `InsertionAudioSettings.trackGates`。四項舊資料缺值都 migration 為 ON。來源影片內的人聲屬 Original；Voice 只保留給獨立 narration overlay，沒有 Voice track 時其 gate 不改任何來源聲音。

`buildInsertionAudioPlan` 解析全部 Intro/Main occurrence、track gates、source range、BGM range 與 SFX events。Final Review、Main/Intro/Proxy/放大 Preview 與 FFmpeg 都使用該 plan／相同 persisted state。關閉 Original 只對 base/source audio 的該 timeline range 套 gain envelope；關閉 BGM 不刪除同曲 range，而在 post-mix 套 25 ms down/up ramp，因此 playhead 在靜音期間繼續。SFX events 可個別省略。

正片提示音保存為 `ProjectManifest.mainStartCue`，預設 ON／650 ms，範圍 100–3000 ms。它是 global MAIN SFX，不繼承任一 clip 的 SFX gate。提示音以 deterministic dual sine 合成，不需第三方素材；WebAudio 與 FFmpeg 共同讀 `mainStartCueSpec` 的頻率、增益、第二音延遲與 fade。

## Render／Resume

Global BGM、silent-clip auto-BGM、insertion BGM/SFX、track gates、cue 與 Final DSP 全部位於 post-audio pass。picture/base master signature 排除這些資料；final audio signature 納入 canonical plan、post BGM tracks 與 DSP。音訊設定變更只產生新的 audio/mux 結果，video 固定 `-c:v copy`。Checkpoint 可重用相同畫面 master，audio hash 必須改變但 video packet hash 必須相同。

## 取捨

目前沒有獨立 Voice/Narration 音檔，因此 Voice gate 僅保存並顯示「無可用配音」，不製造假配音，也不把來源人物談話誤當 Voice。瀏覽器個別素材預覽只能即時反映可安全套用的 mute/gate；完整 BGM/SFX/DSP parity 以 canonical proxy/audio preview 與 Final plan 為準。
