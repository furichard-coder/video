import { useEffect, useState } from "react";
import type { RemoteControlStatus } from "../../shared/domain";
import { formatBytes, formatRenderClock } from "../format";
import { SafeDefaultButton } from "./SafeDefaultButton";

export function RemoteControlModal({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<RemoteControlStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.sourceApp.getRemoteControlStatus?.().then(setStatus).catch((reason) => setError(String(reason)));
    window.sourceApp.onRemoteControlStatus?.(setStatus);
    return () => window.sourceApp.clearRemoteControlStatusListeners?.();
  }, []);

  const run = async (operation: "ENABLE" | "DISABLE" | "ROTATE") => {
    setBusy(true);
    setError(undefined);
    try {
      const next =
        operation === "ENABLE"
          ? await window.sourceApp.enableRemoteControl?.()
          : operation === "DISABLE"
            ? await window.sourceApp.disableRemoteControl?.()
            : await window.sourceApp.rotateRemotePairing?.();
      if (next) setStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const render = status?.render;
  return (
    <div className="modal-backdrop remote-control-backdrop" role="presentation">
      <section className="modal remote-control-modal" role="dialog" aria-modal="true" aria-labelledby="remote-title">
        <header>
          <div><span className="eyebrow">LOCAL NETWORK ONLY</span><h2 id="remote-title">iPhone Remote Control</h2></div>
          <SafeDefaultButton type="button" className="close-button" onClick={onClose} aria-label="关闭远端控制设置">×</SafeDefaultButton>
        </header>
        <div className="remote-security-note">
          <strong>只开放同一 LAN／Wi-Fi</strong>
          <p>只绑定画面列出的单一私人 LAN IP，不开放 Internet，也不提供文件浏览。QR Code 内是十分钟有效、只能使用一次的配对凭证；手机取得的控制会话也会自动过期。第一次启动时 Windows 防火墙可能询问，请只允许私人网络。</p>
        </div>
        {!status?.enabled ? (
          <div className="remote-disabled-state">
            <p>启动后会显示本机 IP、临时 Port 与 QR Code。iPhone Safari 断线不会中断 Windows 转档。</p>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void run("ENABLE")}>{busy ? "正在启动…" : "启动 iPhone 远端控制"}</button>
          </div>
        ) : (
          <>
            <div className="remote-pairing-grid">
              <div className="remote-qr-card">
                {status.qrDataUrl ? <img src={status.qrDataUrl} alt="iPhone Remote Control 配对 QR Code" /> : <div className="remote-paired">此 QR Code 已使用<br />如需连接另一支手机，请重新产生。</div>}
              </div>
              <div className="remote-addresses">
                <strong>iPhone Safari 连结</strong>
                {(status.addresses.length ? status.addresses : ["127.0.0.1"]).map((address) => <code key={address}>http://{address}:{status.port}</code>)}
                {status.pairingExpiresAt && status.qrDataUrl && <small>QR 有效至 {new Date(status.pairingExpiresAt).toLocaleTimeString("zh-TW")}</small>}
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void run("ROTATE")}>重新产生一次性 QR</button>
                <button className="danger-button" type="button" disabled={busy} onClick={() => void run("DISABLE")}>停止远端控制</button>
              </div>
            </div>
            {render && <section className="remote-pc-snapshot">
              <div><strong>{render.projectName}</strong><span>{render.state}</span></div>
              <progress max="100" value={render.progressPercent} />
              <div className="remote-pc-metrics">
                <span>进度 <b>{Math.round(render.progressPercent)}%</b></span>
                <span>已耗时 <b>{render.attemptElapsedMs === undefined ? "—" : formatRenderClock(render.attemptElapsedMs)}</b></span>
                <span>ETA <b>{render.estimatedRemainingMs === undefined ? "—" : formatRenderClock(render.estimatedRemainingMs)}</b></span>
                <span>RAM 可用 <b>{render.ramAvailableBytes === undefined ? "—" : formatBytes(render.ramAvailableBytes)}</b></span>
              </div>
              {render.pauseDetail && <p className="notice warning">{render.pauseDetail}</p>}
            </section>}
          </>
        )}
        {error && <div className="notice error">{error}</div>}
      </section>
    </div>
  );
}
