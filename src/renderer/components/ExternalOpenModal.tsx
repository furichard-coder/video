import { useEffect, useMemo, useState } from "react";
import type { ExternalMediaTarget, ExternalOpenResult, ExternalPlayerSettingsSnapshot, SourceAsset } from "../../shared/domain";

interface ExternalOpenModalProps {
  asset: SourceAsset;
  onClose(): void;
}

export function ExternalOpenModal({ asset, onClose }: ExternalOpenModalProps) {
  const [snapshot, setSnapshot] = useState<ExternalPlayerSettingsSnapshot>();
  const [target, setTarget] = useState<ExternalMediaTarget>("PROXY");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExternalOpenResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.sourceApp.getExternalPlayerSettings().then(setSnapshot).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const selectedPlayer = useMemo(() => {
    if (!snapshot) return undefined;
    const id = snapshot.settings.extensionOverrides[asset.extension.toLowerCase()] ?? snapshot.settings.defaultPlayerId;
    return snapshot.players.find((player) => player.id === id);
  }, [asset.extension, snapshot]);

  const open = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await window.sourceApp.openExternalMedia(asset.id, target));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop external-open-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="external-open-modal" role="dialog" aria-modal="true" aria-label={`以外部播放器開啟 ${asset.fileName}`}>
        <header className="modal-header">
          <div><span className="eyebrow">EXTERNAL VIEW ONLY</span><h2>以外部播放器開啟</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉">×</button>
        </header>
        <div className="external-open-body">
          <div className="external-file"><strong>{asset.fileName}</strong><span>{asset.extension.toLowerCase()} → {selectedPlayer?.label ?? "正在讀取設定…"}</span></div>
          <fieldset className="external-targets">
            <legend>選擇觀看檔案</legend>
            <label className={target === "PROXY" ? "is-selected" : ""}>
              <input type="radio" name="external-target" value="PROXY" checked={target === "PROXY"} onChange={() => setTarget("PROXY")} />
              <span><strong>App cache proxy（建議）</strong><small>衍生的低解析預覽，不把原始來源交給外部程式。</small></span>
            </label>
            <label className={target === "ORIGINAL" ? "is-selected warning" : "warning"}>
              <input type="radio" name="external-target" value="ORIGINAL" checked={target === "ORIGINAL"} onChange={() => setTarget("ORIGINAL")} />
              <span><strong>唯讀意圖開啟原檔</strong><small>App 不會修改來源；但來源保護仍取決於外部播放器自身行為。</small></span>
            </label>
          </fieldset>
          <p className="external-security-note">播放器與目標檔會在 Main process 重新驗證，並以獨立參數啟動，不執行媒體路徑中的任何命令文字。</p>
          {result?.message && <div className={`notice ${result.status === "USE_INTERNAL" ? "error" : "success"}`} role="status">{result.message}</div>}
          {result && !result.message && <div className="notice success" role="status">已交給 {result.playerLabel} 開啟。</div>}
          {error && <div className="notice error" role="alert">{error}</div>}
        </div>
        <footer className="settings-footer"><span /><div><button className="secondary-button" type="button" onClick={onClose}>關閉</button><button className="primary-button" type="button" disabled={busy || !snapshot} onClick={() => void open()}>{busy ? target === "PROXY" ? "正在準備 proxy…" : "正在開啟…" : "開啟觀看"}</button></div></footer>
      </section>
    </div>
  );
}
