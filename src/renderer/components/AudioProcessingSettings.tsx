import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioPreviewResult, AudioProcessingMode, AudioProcessingOptions, SourceAsset } from "../../shared/domain";

interface Props {
  value: AudioProcessingOptions;
  assets: SourceAsset[];
  disabled?: boolean;
  stepLabel: string;
  timelineRevision?: number;
  allowPreserveMultichannel?: boolean;
  onChange(value: AudioProcessingOptions): void;
}

const MODES: Array<{ value: AudioProcessingMode; title: string; detail: string }> = [
  { value: "ORIGINAL_STEREO", title: "Original Stereo 2.0", detail: "保留目前立體聲混音，不增加空間效果。" },
  { value: "ENHANCED_STEREO", title: "Enhanced Stereo 2.0", detail: "保守增加寬度與空間感，仍輸出雙聲道。" },
  { value: "VIRTUAL_SURROUND_5_1", title: "Virtual Surround 5.1", detail: "由雙聲道演算法建立 FL／FR／FC／LFE／SL／SR。" },
  { value: "PRESERVE_MULTICHANNEL", title: "保持原始多聲道", detail: "只在來源與目前時間線可安全保留時使用；不重複 Upmix。" },
];

function Meter({ result, label }: { result: AudioPreviewResult; label: string }) {
  const peaks = result.meter.channelPeaksDb.length ? result.meter.channelPeaksDb : [-60, -60];
  const names = peaks.length === 6 ? ["FL", "FR", "FC", "LFE", "SL", "SR"] : ["L", "R"];
  return <article className="audio-preview-result"><div className="audio-preview-heading"><strong>{label}</strong><span>{result.monitoring === "DOWNMIXED_5_1" ? "5.1 → Stereo 相容性監聽" : "Stereo 監聽"}</span></div><div className="audio-meter-grid">{peaks.map((peak, index) => <div className="audio-meter" key={index}><span>{names[index] ?? `CH${index + 1}`}</span><i><b style={{ width: `${Math.max(2, Math.min(100, ((peak + 60) / 60) * 100))}%` }} /></i><em>{Number.isFinite(peak) ? `${peak.toFixed(1)} dB` : "—"}</em></div>)}</div><div className="audio-meter-summary"><span>LUFS：{result.meter.integratedLufs?.toFixed(1) ?? "—"}</span><span>Peak：{result.meter.truePeakDb?.toFixed(1) ?? "—"} dBFS</span><span className={result.meter.clipping ? "is-clipping" : "is-safe"}>{result.meter.clipping ? "Clipping Warning" : "Peak 安全"}</span></div>{result.meter.warnings.map((warning) => <p className="inline-warning" key={warning}>{warning}</p>)}</article>;
}

export function AudioProcessingSettings({ value, assets, disabled = false, stepLabel, timelineRevision, allowPreserveMultichannel = false, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [before, setBefore] = useState<AudioPreviewResult>();
  const [after, setAfter] = useState<AudioPreviewResult>();
  const [proxyUrl, setProxyUrl] = useState<string>();
  const [active, setActive] = useState<"BEFORE" | "AFTER">("BEFORE");
  const previewableAssets = useMemo(() => assets.filter((asset) => asset.kind === "VIDEO" && asset.mediaInfo?.audioCodec), [assets]);
  const [previewAssetId, setPreviewAssetId] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const beforeAudioRef = useRef<HTMLAudioElement>(null);
  const afterAudioRef = useRef<HTMLAudioElement>(null);
  const requestSequence = useRef(0);
  const previewAsset = useMemo(() => previewableAssets.find((asset) => asset.id === previewAssetId) ?? previewableAssets[0], [previewAssetId, previewableAssets]);
  const optionsFingerprint = JSON.stringify(value);
  const update = (patch: Partial<AudioProcessingOptions>) => onChange({ ...value, ...patch });
  const activeAudio = () => active === "AFTER" && after ? afterAudioRef.current : beforeAudioRef.current;
  const activeResult = () => active === "AFTER" && after ? after : before;

  useEffect(() => () => { requestSequence.current += 1; void window.sourceApp.cancelAudioPreview?.(); }, []);

  const synchronize = (force = false) => {
    const video = videoRef.current;
    const audio = activeAudio();
    const result = activeResult();
    if (!video || !audio || !result) return;
    const offset = Math.max(0, video.currentTime - (result.startMs ?? 0) / 1000);
    if (force || Math.abs(audio.currentTime - offset) > 0.12)
      audio.currentTime = Math.min(offset, Math.max(0, result.durationMs / 1000 - 0.03));
  };

  const chooseActive = (next: "BEFORE" | "AFTER") => {
    const video = videoRef.current;
    beforeAudioRef.current?.pause();
    afterAudioRef.current?.pause();
    const targetAudio = next === "AFTER" ? afterAudioRef.current : beforeAudioRef.current;
    const targetResult = next === "AFTER" ? after : before;
    if (video && targetAudio && targetResult) {
      const offset = Math.max(0, video.currentTime - (targetResult.startMs ?? 0) / 1000);
      targetAudio.currentTime = Math.min(offset, Math.max(0, targetResult.durationMs / 1000 - 0.03));
    }
    setActive(next);
    requestAnimationFrame(() => {
      if (video && !video.paused) void targetAudio?.play().catch(() => undefined);
    });
  };

  const createPreview = async (processedOnly = false) => {
    if (!previewAsset || !window.sourceApp.createAudioPreview) return;
    const sequence = ++requestSequence.current;
    setBusy(true); setError(undefined);
    try {
      if (!proxyUrl) {
        const proxy = await window.sourceApp.ensurePreview(previewAsset.id, "VIDEO_PROXY");
        if (sequence !== requestSequence.current) return;
        setProxyUrl(proxy.url);
      }
      const playheadMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
      const requestBase = { assetId: previewAsset.id, startMs: Math.max(0, playheadMs - 5_000), durationMs: 20_000, timelineRevision };
      if (!processedOnly || !before) {
        const original = await window.sourceApp.createAudioPreview({ ...requestBase, options: { ...value, mode: "ORIGINAL_STEREO" } });
        if (sequence !== requestSequence.current) return;
        setBefore(original);
      }
      if (value.mode !== "ORIGINAL_STEREO") {
        const processed = await window.sourceApp.createAudioPreview({ ...requestBase, options: value });
        if (sequence !== requestSequence.current) return;
        setAfter(processed); setActive("AFTER");
      } else {
        setAfter(undefined); setActive("BEFORE");
      }
      requestAnimationFrame(() => synchronize(true));
    } catch (reason) {
      if (sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!before) return;
    if (value.mode === "ORIGINAL_STEREO") {
      afterAudioRef.current?.pause();
      setAfter(undefined);
      setActive("BEFORE");
      requestAnimationFrame(() => synchronize(true));
      return;
    }
    const timer = window.setTimeout(() => { void window.sourceApp.cancelAudioPreview?.(); void createPreview(true); }, 550);
    return () => window.clearTimeout(timer);
  }, [optionsFingerprint]);

  return <section className="setting-block audio-processing-setting">
    <div><span className="setting-step">{stepLabel}</span><div><h3>Audio Processing 音訊處理</h3><p>复用 Proxy Video，并仅处理当前位置前后约 20 秒音讯；正式输出仍重读高品质来源。</p></div></div>
    <fieldset disabled={disabled || busy} className="audio-mode-options"><legend>Audio Mode</legend>{MODES.map((mode) => { const unavailable = mode.value === "PRESERVE_MULTICHANNEL" && !allowPreserveMultichannel; return <label className={`${value.mode === mode.value ? "is-selected" : ""} ${unavailable ? "is-disabled" : ""}`} key={mode.value}><input type="radio" name="audio-processing-mode" checked={value.mode === mode.value} disabled={unavailable} onChange={() => update({ mode: mode.value })} /><span><strong>{mode.title}</strong><small>{unavailable ? `${mode.detail}（目前選取不符合安全條件）` : mode.detail}</small></span></label>; })}</fieldset>
    {value.mode === "VIRTUAL_SURROUND_5_1" && <div className="notice warning">Virtual 5.1 是由原始 Stereo 雙聲道演算法模擬產生，不等同原生錄製的真正 5.1 多聲道音訊。</div>}
    {(value.mode === "ENHANCED_STEREO" || value.mode === "VIRTUAL_SURROUND_5_1") && <div className="audio-advanced-grid">
      <label>Preset<select value={value.preset} disabled={disabled} onChange={(event) => update({ preset: event.target.value as AudioProcessingOptions["preset"] })}><option value="NATURAL">Natural（预设）</option><option value="CINEMA">Cinema</option><option value="WIDE">Wide</option></select></label>
      <label>Stereo Width<input type="range" min={50} max={160} step={5} value={value.stereoWidthPercent ?? 100} disabled={disabled} onChange={(event) => update({ stereoWidthPercent: Number(event.target.value) })} /><output>{value.stereoWidthPercent ?? 100}%</output></label>
      <label>低频 EQ<input type="range" min={-6} max={6} step={0.5} value={value.eqLowDb ?? 0} disabled={disabled} onChange={(event) => update({ eqLowDb: Number(event.target.value) })} /><output>{value.eqLowDb ?? 0} dB</output></label>
      <label>人声清晰度 EQ<input type="range" min={-6} max={6} step={0.5} value={value.eqPresenceDb ?? 0} disabled={disabled} onChange={(event) => update({ eqPresenceDb: Number(event.target.value) })} /><output>{value.eqPresenceDb ?? 0} dB</output></label>
      {value.mode === "VIRTUAL_SURROUND_5_1" && <><label>Audio Codec<select value={value.codec} disabled={disabled} onChange={(event) => update({ codec: event.target.value as AudioProcessingOptions["codec"], bitrateKbps: event.target.value === "AAC" ? 384 : event.target.value === "AC3" ? 448 : 640 })}><option value="AAC">AAC 5.1（YouTube 建议）</option><option value="AC3">AC-3 5.1</option><option value="EAC3">E-AC-3 5.1</option></select></label><label>Bitrate<input type="number" min={128} max={1024} step={8} value={value.bitrateKbps} disabled={disabled} onChange={(event) => update({ bitrateKbps: Number(event.target.value) })} /><small>kbps · 48 kHz</small></label><label>Surround Strength<input type="range" min={0} max={120} step={5} value={value.surroundStrengthPercent} disabled={disabled} onChange={(event) => update({ surroundStrengthPercent: Number(event.target.value) })} /><output>{value.surroundStrengthPercent}%</output></label><label>LFE Strength<input type="range" min={0} max={100} step={5} value={value.lfeStrengthPercent} disabled={disabled} onChange={(event) => update({ lfeStrengthPercent: Number(event.target.value) })} /><output>{value.lfeStrengthPercent}%</output></label><label>LFE Low-pass<select value={value.lfeCutoffHz} disabled={disabled} onChange={(event) => update({ lfeCutoffHz: Number(event.target.value) })}><option value={80}>80 Hz</option><option value={100}>100 Hz</option><option value={120}>120 Hz</option></select></label></>}
    </div>}
    <div className="audio-preview-actions"><label>试听素材<select value={previewAsset?.id ?? ""} disabled={disabled || busy || !previewableAssets.length} onChange={(event) => { requestSequence.current += 1; void window.sourceApp.cancelAudioPreview?.(); setPreviewAssetId(event.target.value); setProxyUrl(undefined); setBefore(undefined); setAfter(undefined); }}><option value="">请选择</option>{previewableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.fileName}</option>)}</select></label><button type="button" className="secondary" disabled={disabled || busy || !previewAsset} onClick={() => void createPreview()}>{busy ? "正在快速建立试听区段…" : before ? "依目前播放位置重建 20 秒试听" : "启动 Proxy 即时音效试听"}</button><small>{previewAsset ? `画面复用 ${previewAsset.fileName} 的 H.264 Proxy，不重新 Encode；参数改变后自动 debounce 重建。` : "目前清单中没有已识别音轨的影片。"}</small></div>
    {error && <div className="notice error">{error}</div>}
    {proxyUrl && <div className="audio-live-preview"><video ref={videoRef} controls muted preload="metadata" src={proxyUrl} onPlay={() => { synchronize(true); void activeAudio()?.play().catch(() => undefined); }} onPause={() => activeAudio()?.pause()} onSeeking={() => synchronize(true)} onTimeUpdate={() => synchronize()} /><audio ref={beforeAudioRef} preload="auto" src={before?.url} /><audio ref={afterAudioRef} preload="auto" src={after?.url} /><div className="audio-ab-switch"><button type="button" className={active === "BEFORE" ? "is-selected" : ""} disabled={!before} onClick={() => chooseActive("BEFORE")}>A · Original</button><button type="button" className={active === "AFTER" ? "is-selected" : ""} disabled={!after} onClick={() => chooseActive("AFTER")}>B · {value.mode === "VIRTUAL_SURROUND_5_1" ? "Virtual 5.1→Stereo" : "Enhanced"}</button></div><small>A/B 切换保留 Proxy 播放头；移动超出快取区段后，请按上方按钮重建。</small></div>}
    {(before || after) && <div className="audio-preview-comparison">{before && <Meter result={before} label="A · Original" />}{after && <Meter result={after} label="B · Processing" />}</div>}
  </section>;
}
