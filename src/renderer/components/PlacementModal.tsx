import { useState } from "react";
import type { PlacementAction, PlacementRequest, SourceAsset } from "../../shared/domain";

interface Props { asset: SourceAsset; anchors: SourceAsset[]; onDecide(placement: PlacementRequest): Promise<void>; onClose(): void; }

export function PlacementModal({ asset, anchors, onDecide, onClose }: Props) {
  const [action, setAction] = useState<PlacementAction>("END");
  const [anchorAssetId, setAnchorAssetId] = useState(anchors[0]?.id ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const submit = async () => { setBusy(true); setError(undefined); try { await onDecide({ action, anchorAssetId: action === "BEFORE" || action === "AFTER" ? anchorAssetId : undefined }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); } };
  return <div className="modal-backdrop placement-backdrop" role="presentation"><section className="editor-modal placement-modal" role="dialog" aria-modal="true" aria-label={`安插位置 ${asset.fileName}`}>
    <header className="modal-header"><div><span className="eyebrow">SUPPLEMENTAL MEDIA PLACEMENT</span><h2>決定安插位置</h2></div><button className="icon-button" onClick={onClose} aria-label="關閉">×</button></header>
    <div className="editor-modal-body"><div className="placement-file"><strong>{asset.fileName}</strong><span>{asset.sourcePath}</span></div>
      <div className="placement-options">{(["FRONT","END","BEFORE","AFTER","PENDING"] as PlacementAction[]).map((value) => <label key={value} className={action === value ? "is-selected" : ""}><input type="radio" name="placement" checked={action === value} onChange={() => setAction(value)} /><span>{{ FRONT:"放在最前", END:"放在最後", BEFORE:"放在指定素材之前", AFTER:"放在指定素材之後", PENDING:"先放入待決定區" }[value]}</span></label>)}</div>
      {(action === "BEFORE" || action === "AFTER") && <label className="anchor-select">參考素材<select aria-label="參考素材" value={anchorAssetId} onChange={(event) => setAnchorAssetId(event.target.value)}>{anchors.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}</select></label>}
      <p className="mix-note">每筆決定會寫入 manifest；之後仍可用卡片上的上移／下移調整。待決定素材不會進入串連輸出。</p>{error && <div className="notice error">{error}</div>}
    </div><footer className="settings-footer"><button className="secondary-button" onClick={onClose}>稍後處理</button><button className="primary-button" disabled={busy || ((action === "BEFORE" || action === "AFTER") && !anchorAssetId)} onClick={() => void submit()}>確認位置</button></footer>
  </section></div>;
}
