import { useEffect, useMemo, useState } from "react";
import type { ExternalPlayerId, ExternalPlayerSettingsSnapshot } from "../../shared/domain";

interface PlayerSettingsModalProps {
  onClose(): void;
}

const STARTER_EXTENSIONS = [".mp4", ".mov"];

export function PlayerSettingsModal({ onClose }: PlayerSettingsModalProps) {
  const [snapshot, setSnapshot] = useState<ExternalPlayerSettingsSnapshot>();
  const [defaultPlayerId, setDefaultPlayerId] = useState<ExternalPlayerId>("SYSTEM_DEFAULT");
  const [overrides, setOverrides] = useState<Record<string, ExternalPlayerId>>({});
  const [newExtension, setNewExtension] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = async () => {
    const next = await window.sourceApp.getExternalPlayerSettings();
    setSnapshot(next);
    setDefaultPlayerId(next.settings.defaultPlayerId);
    setOverrides(next.settings.extensionOverrides);
  };

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const extensions = useMemo(() => [...new Set([...STARTER_EXTENSIONS, ...Object.keys(overrides)])].sort(), [overrides]);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.sourceApp.updateExternalPlayerSettings({ defaultPlayerId, extensionOverrides: overrides });
      setSnapshot(next);
      setNotice("外部播放器設定已保存，下次開啟 App 會自動恢復。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const browseCustom = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.sourceApp.chooseCustomPlayer();
      if (next) {
        setSnapshot(next);
        setNotice("已加入自訂播放器；請在全域或副檔名列選用並儲存。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async (playerId: ExternalPlayerId) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.sourceApp.removeCustomPlayer(playerId);
      setSnapshot(next);
      setDefaultPlayerId(next.settings.defaultPlayerId);
      setOverrides(next.settings.extensionOverrides);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const addExtension = () => {
    const normalized = `${newExtension.trim().startsWith(".") ? "" : "."}${newExtension.trim().toLowerCase()}`;
    if (!/^\.[a-z0-9]{1,12}$/.test(normalized)) {
      setError("請輸入有效副檔名，例如 .mkv。");
      return;
    }
    setOverrides((current) => ({ ...current, [normalized]: defaultPlayerId }));
    setNewExtension("");
    setError(undefined);
  };

  const playerOptions = snapshot?.players ?? [];
  const selectOptions = (includeInherit = false) => <>
    {includeInherit && <option value="">繼承全域預設</option>}
    {playerOptions.map((player) => (
      <option key={player.id} value={player.id} disabled={!player.available}>
        {player.label}{player.available ? "" : "（未偵測／已遺失）"}
      </option>
    ))}
  </>;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="player-settings-modal" role="dialog" aria-modal="true" aria-label="外部播放器設定">
        <header className="modal-header">
          <div><span className="eyebrow">SETTINGS · EXTERNAL PLAYBACK</span><h2>外部播放器設定</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉">×</button>
        </header>
        {!snapshot ? <div className="settings-loading"><span className="spinner" /><p>正在偵測已安裝的播放器…</p>{error && <p className="inline-error">{error}</p>}</div> : (
          <div className="player-settings-body">
            <section className="settings-section">
              <div><h3>全域預設</h3><p>沒有個別副檔名規則時使用。</p></div>
              <select aria-label="全域預設播放器" value={defaultPlayerId} onChange={(event) => setDefaultPlayerId(event.target.value as ExternalPlayerId)}>{selectOptions()}</select>
            </section>

            <section className="settings-section extension-section">
              <div><h3>依副檔名覆寫</h3><p>副檔名不分大小寫；未設定即繼承全域。</p></div>
              <div className="extension-routes">
                {extensions.map((extension) => (
                  <div className="extension-route" key={extension}>
                    <strong>{extension}</strong>
                    <select aria-label={`${extension} 播放器`} value={overrides[extension] ?? ""} onChange={(event) => {
                      const value = event.target.value as ExternalPlayerId | "";
                      setOverrides((current) => {
                        const next = { ...current };
                        if (value) next[extension] = value;
                        else delete next[extension];
                        return next;
                      });
                    }}>{selectOptions(true)}</select>
                    {!STARTER_EXTENSIONS.includes(extension) && <button type="button" onClick={() => setOverrides((current) => { const next = { ...current }; delete next[extension]; return next; })}>移除規則</button>}
                  </div>
                ))}
                <div className="add-extension-row">
                  <input aria-label="新增副檔名" placeholder="例如 .mkv" value={newExtension} onChange={(event) => setNewExtension(event.target.value)} />
                  <button type="button" onClick={addExtension}>新增副檔名</button>
                </div>
              </div>
            </section>

            <section className="settings-section detected-section">
              <div><h3>播放器偵測</h3><p>安裝路徑每次使用前都會再驗證，不把下列位置視為永久事實。</p></div>
              <div className="player-detection-list">
                {playerOptions.map((player) => (
                  <div className={`player-detection ${player.available ? "is-available" : "is-missing"}`} key={player.id}>
                    <span>{player.available ? "●" : "○"}</span>
                    <div><strong>{player.label}</strong><small title={player.executablePath}>{player.executablePath ?? player.detail}</small></div>
                    {player.kind === "CUSTOM" && <button type="button" disabled={busy} onClick={() => void removeCustom(player.id)}>移除</button>}
                  </div>
                ))}
                <button className="browse-player-button" type="button" disabled={busy} onClick={() => void browseCustom()}>瀏覽選擇自訂 .exe</button>
              </div>
            </section>

            {notice && <div className="notice success" role="status">{notice}</div>}
            {error && <div className="notice error" role="alert">{error}</div>}
          </div>
        )}
        <footer className="settings-footer">
          <p>外部程式只供觀看；App 無法保證播放器本身的寫入行為。建議優先開啟 App cache proxy。</p>
          <div><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={!snapshot || busy} onClick={() => void save()}>儲存設定</button></div>
        </footer>
      </section>
    </div>
  );
}
