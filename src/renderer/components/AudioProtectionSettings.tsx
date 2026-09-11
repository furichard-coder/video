import type { AudioProtectionOptions } from "../../shared/domain";

interface Props {
  value: AudioProtectionOptions;
  disabled?: boolean;
  stepLabel?: string;
  compact?: boolean;
  onChange(next: AudioProtectionOptions): void;
}

export function AudioProtectionSettings({ value, disabled = false, stepLabel, compact = false, onChange }: Props) {
  const update = (patch: Partial<AudioProtectionOptions>) => onChange({ ...value, ...patch });
  return (
    <section className={`setting-block audio-protection-setting ${compact ? "is-compact" : ""}`}>
      <div>
        {stepLabel && <span className="setting-step">{stepLabel}</span>}
        <div>
          <h3>人聲／突發聲音保護</h3>
          <p>
            在本機即時偵測 1–4 kHz 的近距離清晰人聲能量與突然大聲事件，使用平滑包絡線壓低，再以 Compressor／Limiter
            防止爆音。
          </p>
        </div>
      </div>
      <label className="subtitle-burn-toggle">
        <input
          aria-label="這次 MP4 啟用人聲與突發聲音保護"
          type="checkbox"
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>
          <strong>自動壓低近身人聲、尖叫、哭鬧與刺耳笑聲（預設勾選）</strong>
          <small>只改新輸出檔的混音；來源音軌與手動音量區段完全不改寫。</small>
        </span>
      </label>
      <fieldset className="audio-protection-controls" disabled={disabled || !value.enabled}>
        <legend>自動化與保留策略</legend>
        <label>
          <input
            aria-label="自動建立人聲壓低包絡線"
            type="checkbox"
            checked={value.autoDuckVoiceAndSuddenSounds}
            onChange={(event) => update({ autoDuckVoiceAndSuddenSounds: event.target.checked })}
          />
          自動建立平滑音量包絡線
        </label>
        <label>
          <input
            aria-label="保留遠處人群與市集氛圍"
            type="checkbox"
            checked={value.preserveDistantCrowdAmbience}
            onChange={(event) => update({ preserveDistantCrowdAmbience: event.target.checked })}
          />
          保留遠處人群嗡嗡聲／市集叫賣氛圍（較高觸發門檻）
        </label>
        <label>
          <input
            aria-label="保留與畫面相符的自然聲"
            type="checkbox"
            checked={value.preserveSceneMatchedSounds}
            onChange={(event) => update({ preserveSceneMatchedSounds: event.target.checked })}
          />
          保留腳步、微弱招呼等與畫面相符的自然聲（較柔和起落）
        </label>
        <label>
          <input
            aria-label="啟用一到四千赫茲等化器"
            type="checkbox"
            checked={value.eqEnabled}
            onChange={(event) => update({ eqEnabled: event.target.checked })}
          />
          EQ 輕微衰減 1–4 kHz，降低背景話語清晰度
        </label>
        <div className="audio-protection-values">
          <label>
            最大自動壓低
            <input
              aria-label="人聲最大壓低分貝"
              type="number"
              min="3"
              max="6"
              step="0.5"
              value={value.maxDuckingDb}
              onChange={(event) =>
                update({
                  maxDuckingDb: Math.max(3, Math.min(6, Math.round((Number(event.target.value) || 3) * 2) / 2)),
                })
              }
            />
            <span>dB</span>
          </label>
          <label>
            EQ 衰減
            <input
              aria-label="人聲頻段等化器衰減分貝"
              type="number"
              min="0.5"
              max="4"
              step="0.5"
              value={value.eqReductionDb}
              disabled={!value.eqEnabled}
              onChange={(event) =>
                update({
                  eqReductionDb: Math.max(0.5, Math.min(4, Math.round((Number(event.target.value) || 0.5) * 2) / 2)),
                })
              }
            />
            <span>dB</span>
          </label>
          <label>
            Peak Ceiling
            <select
              aria-label="最大峰值上限"
              value={value.peakCeilingDb}
              onChange={(event) => update({ peakCeilingDb: Number(event.target.value) === -2 ? -2 : -1 })}
            >
              <option value={-1}>-1 dB</option>
              <option value={-2}>-2 dB</option>
            </select>
          </label>
        </div>
        <small>
          這是純本機聲學偵測，不會把音訊送到
          AI；它能判斷清晰／強烈的人聲頻段與音量突變，但無法理解談話內容是否真的私密，也無法百分之百分辨笑聲、叫賣與其他同頻聲音。完成後仍請播放人工複核。
        </small>
      </fieldset>
    </section>
  );
}
