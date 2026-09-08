import { useState } from "react";
import { MAX_MIX_VOLUME_PERCENT, type SourceAsset, type VolumeSegment } from "../../shared/domain";
import { formatDuration } from "../format";
import { TimeRangeFields } from "./MinuteSecondFields";

interface Props { asset: SourceAsset; defaultVolumePercent: number; onClose(): void; onAssetUpdated(asset: SourceAsset): void; }

export function VolumeSegmentsModal({ asset, defaultVolumePercent, onClose, onAssetUpdated }: Props) {
  const durationMs = asset.mediaInfo?.durationMs ?? 0;
  const range = asset.previewRange ?? { inMs: 0, outMs: durationMs };
  const [segments, setSegments] = useState<VolumeSegment[]>(() => structuredClone(asset.volumeSegments ?? []));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);

  const updateVolume = (id: string, value: number) => setSegments((current) => current.map((item) => item.id === id ? { ...item, volumePercent: value } : item));
  const add = () => {
    const startMs = range.inMs;
    const endMs = Math.min(range.outMs, startMs + Math.max(100, Math.min(5000, range.outMs - range.inMs)));
    const id = crypto.randomUUID();
    setSegments((current) => [...current, { id, startMs, endMs, volumePercent: defaultVolumePercent }]);
  };
  const save = async () => {
    setSaving(true); setError(undefined); setNotice(undefined);
    try {
      const updated = await window.sourceApp.setVolumeSegments(asset.id, segments); onAssetUpdated(updated); setSegments(updated.volumeSegments ?? []);
      setNotice("音量區段已保存並會套用至串連／Intro 輸出。");
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop volume-backdrop" role="presentation"><section className="editor-modal volume-modal" role="dialog" aria-modal="true" aria-label={`音量區段 ${asset.fileName}`}>
    <header className="modal-header"><div><span className="eyebrow">CLIP AUDIO AUTOMATION</span><h2>音量區段</h2><small>{asset.fileName}</small></div><button className="icon-button" onClick={onClose} aria-label="關閉">×</button></header>
    <div className="editor-modal-body">
      <div className="range-summary"><span>目前可用 IN／OUT</span><strong>{formatDuration(range.inMs)} → {formatDuration(range.outMs)}</strong><small>未被任何區段覆蓋的部分使用素材原音預設 {defaultVolumePercent}%。區段不可重疊。</small></div>
      <div className="table-head volume-grid"><span>開始（分鐘:秒數）</span><span>結束（分鐘:秒數）</span><span>音量</span><span /></div>
      <div className="editable-rows">{segments.map((segment) => <div className="editable-row volume-grid" key={segment.id}>
        <TimeRangeFields className="inline-time-range" startLabel="開始時間" endLabel="結束時間" startMs={segment.startMs} endMs={segment.endMs} maxMs={durationMs} onStartChange={(value) => setSegments((current) => current.map((item) => item.id === segment.id ? { ...item, startMs: value } : item))} onEndChange={(value) => setSegments((current) => current.map((item) => item.id === segment.id ? { ...item, endMs: value } : item))} />
        <label className="percent-input"><input aria-label="音量百分比" type="number" min="0" max={MAX_MIX_VOLUME_PERCENT} step="1" value={segment.volumePercent} onChange={(event) => updateVolume(segment.id, Number(event.target.value))} /><span>%</span></label>
        <button type="button" onClick={() => setSegments((current) => current.filter((item) => item.id !== segment.id))}>刪除</button>
      </div>)}</div>
      <button className="add-row-button" type="button" onClick={add}>＋ 新增音量區段</button>
      <p className="mix-note">200% 是數位增益上限，不代表聽感兩倍；最終輸出另套用 peak limiter 防止超過安全峰值。</p>
      {notice && <div className="notice success">{notice}</div>}{error && <div className="notice error" role="alert">{error}</div>}
    </div>
    <footer className="settings-footer"><span /><div><button className="secondary-button" onClick={onClose}>關閉</button><button className="primary-button" disabled={saving} onClick={() => void save()}>儲存音量設定</button></div></footer>
  </section></div>;
}
