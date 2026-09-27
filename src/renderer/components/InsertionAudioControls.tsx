import { useMemo, useState } from "react";
import {
  PHOTO_SOUND_PREVIEW_URL,
  type InsertionAudioScope,
  type InsertionAudioSettings,
  type ProjectManifest,
  type SourceAsset,
} from "../../shared/domain";
import { normalizeInsertionAudioSettings } from "../../shared/insertion-audio-plan";

interface Props {
  project: ProjectManifest;
  scope: InsertionAudioScope;
  instanceId: string;
  asset: SourceAsset;
  value?: InsertionAudioSettings;
  onProjectUpdated(project: ProjectManifest): void;
  compact?: boolean;
}

export function InsertionAudioControls({ project, scope, instanceId, asset, value, onProjectUpdated, compact = false }: Props) {
  const trackIds = useMemo(() => new Set(project.bgmTracks.map((track) => track.id)), [project.bgmTracks]);
  const settings = normalizeInsertionAudioSettings(value, asset.kind, trackIds, asset.photoSoundEnabled !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (next: InsertionAudioSettings) => {
    setBusy(true);
    setError(undefined);
    try {
      onProjectUpdated(await window.sourceApp.setInsertionAudio(scope, instanceId, next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const firstReadyTrack = project.bgmTracks.find(
    (track) => track.resolutionStatus !== "NEEDS_LOCAL_FILE" && Boolean(track.sourcePath),
  );
  const bgmEnabled = Boolean(settings.bgmTrackId);

  return (
    <fieldset className={`insertion-audio-controls ${compact ? "is-compact" : ""}`} disabled={busy}>
      <legend>{scope === "INTRO" ? "片頭 Audio" : "正片 Audio"}</legend>
      <div className="audio-track-gates" aria-label={`${asset.fileName} 音訊軌開關`}>
        {(["original", "voice", "bgm", "sfx"] as const).map((key) => {
          const labels = { original: "原音", voice: "配音", bgm: "BGM", sfx: "SFX" } as const;
          const unavailableVoice = key === "voice";
          return (
            <label key={key} title={unavailableVoice ? "目前專案沒有獨立配音軌；开关已保存供未来配音使用，不会影响素材原音。" : undefined}>
              <input
                type="checkbox"
                checked={settings.trackGates?.[key] !== false}
                onChange={(event) => void save({
                  ...settings,
                  trackGates: { ...settings.trackGates!, [key]: event.target.checked },
                })}
              />
              {labels[key]}
            </label>
          );
        })}
      </div>
      <small className="audio-track-status">
        原音 {settings.trackGates?.original !== false ? "✓" : "–"}　配音 {settings.trackGates?.voice !== false ? "✓" : "–"}　BGM {settings.trackGates?.bgm !== false ? "✓" : "–"}　SFX {settings.trackGates?.sfx !== false ? "✓" : "–"}
      </small>
      {asset.kind === "IMAGE" && (
        <label>
          <input
            type="checkbox"
            checked={settings.sfxEnabled}
            disabled={settings.trackGates?.sfx === false}
            onChange={(event) => void save({ ...settings, sfxEnabled: event.target.checked })}
          />
          相機拍照效果音（SFX）
        </label>
      )}
      <label>
        <input
          type="checkbox"
          checked={bgmEnabled}
          disabled={!firstReadyTrack || settings.trackGates?.bgm === false}
          onChange={(event) =>
            void save({ ...settings, bgmTrackId: event.target.checked ? firstReadyTrack?.id : undefined })
          }
        />
        使用背景音樂（BGM）
      </label>
      <label>
        背景音樂曲目
        <select
          aria-label={`${asset.fileName} 背景音樂曲目`}
          value={settings.bgmTrackId ?? ""}
          disabled={settings.trackGates?.bgm === false}
          onChange={(event) => void save({ ...settings, bgmTrackId: event.target.value || undefined })}
        >
          <option value="">不使用背景音樂</option>
          {project.bgmTracks.map((track, index) => (
            <option key={track.id} value={track.id} disabled={track.resolutionStatus === "NEEDS_LOCAL_FILE"}>
              第 {index + 1} 首 · {track.fileName}{track.resolutionStatus === "NEEDS_LOCAL_FILE" ? "（尚未指定本機檔）" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="insertion-audio-levels">
        {asset.kind === "IMAGE" && (
          <label>
          SFX
            <input
              type="number"
              min="0"
              max="300"
              value={settings.sfxVolumePercent}
              onChange={(event) => void save({ ...settings, sfxVolumePercent: Number(event.target.value) })}
            />
            %
          </label>
        )}
        <label>
          BGM
          <input
            type="number"
            min="0"
            max="300"
            value={settings.bgmVolumePercent}
            onChange={(event) => void save({ ...settings, bgmVolumePercent: Number(event.target.value) })}
          />
          %
        </label>
      </div>
      <small>SFX 与 BGM 可同时启用；SFX 不会停止、重启或静音 BGM。</small>
      {asset.kind === "IMAGE" && settings.sfxEnabled && (
        <audio className="insertion-sfx-audition" controls preload="metadata" src={PHOTO_SOUND_PREVIEW_URL}>
          <track kind="captions" />
        </audio>
      )}
      {error && <small className="inline-error">{error}</small>}
    </fieldset>
  );
}
