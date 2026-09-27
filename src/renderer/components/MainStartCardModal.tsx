import { useState } from "react";
import type { IntroSuggestion, MainStartCardOptions, MainStartCardTransition, MainStartCueSettings, SourceAsset } from "../../shared/domain";
import { formatDuration } from "../format";
import {
  MAIN_START_CUE_BASE_GAINS,
  MAIN_START_CUE_FREQUENCIES_HZ,
  mainStartCueSpec,
} from "../../shared/main-start-cue";

interface MainStartCardModalProps {
  value: MainStartCardOptions;
  cue: MainStartCueSettings;
  backgroundFileName?: string;
  introClips: IntroSuggestion[];
  assets: SourceAsset[];
  onCancel: () => void;
  onSave: (value: MainStartCardOptions, cue: MainStartCueSettings) => void;
}

const TRANSITIONS: Array<{ value: MainStartCardTransition; label: string; detail: string }> = [
  { value: "DISSOLVE", label: "柔和疊化", detail: "沿用沙丘前案，推薦" },
  { value: "FADE_BLACK", label: "淡至黑", detail: "較明確的章節分隔" },
  { value: "HARD_CUT", label: "直接切換", detail: "不重疊畫面與聲音" },
];

function clamp(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

export function MainStartCardModal({
  value,
  cue,
  backgroundFileName,
  introClips,
  assets,
  onCancel,
  onSave,
}: MainStartCardModalProps) {
  const [draft, setDraft] = useState<MainStartCardOptions>(() => ({
    ...value,
    backgroundIntroSegmentId: introClips.some((clip) => clip.id === value.backgroundIntroSegmentId)
      ? value.backgroundIntroSegmentId
      : undefined,
  }));
  const [cueDraft, setCueDraft] = useState(cue);
  const ready = Boolean(draft.line1.trim() && draft.line2.trim());
  const patch = (update: Partial<MainStartCardOptions>) => setDraft((current) => ({ ...current, ...update }));
  const selectedIntroIndex = introClips.findIndex((clip) => clip.id === draft.backgroundIntroSegmentId);
  const selectedIntro = selectedIntroIndex >= 0 ? introClips[selectedIntroIndex] : undefined;
  const selectedAsset = selectedIntro ? assets.find((asset) => asset.id === selectedIntro.assetId) : undefined;
  const selectedBackgroundName = selectedIntro?.fileName ?? backgroundFileName ?? "正片第一個素材";
  const previewCue = () => {
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor || !cueDraft.enabled) return;
    const context = new AudioContextCtor();
    const cue = mainStartCueSpec(cueDraft.durationMs);
    MAIN_START_CUE_FREQUENCIES_HZ.forEach((frequency, index) => {
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      tone.connect(gain);
      gain.connect(context.destination);
      const start = context.currentTime + (index === 0 ? 0 : cue.secondDelaySeconds);
      const end = context.currentTime + cue.durationSeconds;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(MAIN_START_CUE_BASE_GAINS[index] * 0.7, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      tone.start(start);
      tone.stop(end);
    });
    window.setTimeout(() => void context.close(), cue.durationSeconds * 1_000 + 120);
  };

  return (
    <div className="modal-backdrop nested-modal" role="presentation">
      <section className="main-start-card-modal" role="dialog" aria-modal="true" aria-label="正片開始提示頁設定">
        <header className="modal-header">
          <div>
            <span className="eyebrow">MAIN START PROMPT</span>
            <h2>設定「正片即將開始」提示頁</h2>
          </div>
        </header>
        <div className="main-start-card-body">
          <div className="main-start-card-preview" aria-label="16 比 9 提示頁預覽">
            <div className="main-start-card-preview-image">
              <span>{selectedBackgroundName}</span>
            </div>
            <div className="main-start-card-preview-shade" style={{ opacity: draft.overlayOpacityPercent / 100 }} />
            <div className="main-start-card-preview-copy" style={{ gap: `${Math.max(12, draft.lineGap1080p / 8)}px` }}>
              <strong style={{ fontSize: `${Math.max(18, draft.line1FontSize1080p / 4.5)}px` }}>
                {draft.line1 || "第一行文字"}
              </strong>
              <span style={{ fontSize: `${Math.max(15, draft.line2FontSize1080p / 4.5)}px` }}>
                {draft.line2 || "第二行文字"}
              </span>
            </div>
          </div>
          <p className="main-start-card-source-note">
            實際輸出會重新讀取所選片段的唯讀原始素材，不使用代理；再依本次 MP4 解析度等比顯示並加上半透明暗色遮罩。
          </p>

          <div className="main-start-card-form">
            <fieldset className="main-start-background-source">
              <legend>背景來源</legend>
              <label>
                <span>從正片或片頭精選片段挑選</span>
                <select
                  aria-label="提示頁背景來源"
                  value={draft.backgroundIntroSegmentId ?? ""}
                  onChange={(event) => patch({ backgroundIntroSegmentId: event.target.value || undefined })}
                >
                  <option value="">正片第一個片段 · {backgroundFileName ?? "正片開場"}</option>
                  {introClips.map((clip, index) => (
                    <option key={clip.id} value={clip.id}>
                      片頭第 {index + 1} 段 · {clip.fileName} · {formatDuration(clip.inMs)}–{formatDuration(clip.outMs)}
                    </option>
                  ))}
                </select>
              </label>
              {selectedIntro && (
                <small>
                  已選片頭第 {selectedIntroIndex + 1} 段 ·{" "}
                  {selectedAsset?.kind === "IMAGE"
                    ? "原始照片"
                    : `原始影片 ${formatDuration(selectedIntro.inMs)}–${formatDuration(selectedIntro.outMs)}`}
                </small>
              )}
            </fieldset>
            <fieldset>
              <legend>顯示時間（3–7 秒）</legend>
              <div className="main-start-duration-options">
                {[3, 4, 5, 6, 7].map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    aria-pressed={draft.durationSeconds === seconds}
                    className={draft.durationSeconds === seconds ? "is-selected" : ""}
                    onClick={() => patch({ durationSeconds: seconds })}
                  >
                    {seconds} 秒
                  </button>
                ))}
              </div>
            </fieldset>
            <label>
              第一行文字
              <input
                autoFocus
                maxLength={80}
                value={draft.line1}
                onChange={(event) => patch({ line1: event.target.value.replace(/[\r\n]+/g, " ") })}
              />
            </label>
            <label>
              第二行文字
              <input
                maxLength={80}
                value={draft.line2}
                onChange={(event) => patch({ line2: event.target.value.replace(/[\r\n]+/g, " ") })}
              />
            </label>
            <div className="main-start-card-numbers">
              <label>
                第一行大小
                <input
                  type="number"
                  min="36"
                  max="180"
                  value={draft.line1FontSize1080p}
                  onChange={(event) =>
                    patch({ line1FontSize1080p: clamp(event.target.value, 36, 180, draft.line1FontSize1080p) })
                  }
                />
                <span>px（1080p）</span>
              </label>
              <label>
                第二行大小
                <input
                  type="number"
                  min="30"
                  max="160"
                  value={draft.line2FontSize1080p}
                  onChange={(event) =>
                    patch({ line2FontSize1080p: clamp(event.target.value, 30, 160, draft.line2FontSize1080p) })
                  }
                />
                <span>px（1080p）</span>
              </label>
              <label>
                兩行間距
                <input
                  type="number"
                  min="50"
                  max="240"
                  value={draft.lineGap1080p}
                  onChange={(event) => patch({ lineGap1080p: clamp(event.target.value, 50, 240, draft.lineGap1080p) })}
                />
                <span>px（1080p）</span>
              </label>
              <label>
                暗色遮罩
                <input
                  type="number"
                  min="30"
                  max="85"
                  value={draft.overlayOpacityPercent}
                  onChange={(event) =>
                    patch({ overlayOpacityPercent: clamp(event.target.value, 30, 85, draft.overlayOpacityPercent) })
                  }
                />
                <span>% 半透明</span>
              </label>
            </div>
            <fieldset>
              <legend>提示頁前後轉場</legend>
              <div className="main-start-transition-options">
                {TRANSITIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={draft.transitionStyle === item.value}
                    className={draft.transitionStyle === item.value ? "is-selected" : ""}
                    onClick={() => patch({ transitionStyle: item.value })}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="main-start-cue-settings">
              <legend>正片 Audio</legend>
              <label>
                <input
                  type="checkbox"
                  checked={cueDraft.enabled}
                  onChange={(event) => setCueDraft((current) => ({ ...current, enabled: event.target.checked }))}
                />
                SFX · 正片開始提示音
              </label>
              <label>
                <span>長度</span>
                <input
                  aria-label="正片開始提示音長度（秒）"
                  type="number"
                  min="0.1"
                  max="3"
                  step="0.05"
                  value={(cueDraft.durationMs / 1000).toFixed(2)}
                  disabled={!cueDraft.enabled}
                  onChange={(event) => setCueDraft((current) => ({
                    ...current,
                    durationMs: Math.max(100, Math.min(3_000, Math.round(Number(event.target.value) * 1000))),
                  }))}
                />
                秒
              </label>
              <small>这是正片 SFX，不归类为片头。以合成双音提示，不使用品牌音效或外部授权素材。</small>
              <button type="button" className="secondary-button" disabled={!cueDraft.enabled} onClick={previewCue}>
                ▶ 試聽 SFX
              </button>
            </fieldset>
          </div>
          {!ready && (
            <p className="inline-error" role="alert">
              兩行文字都要填寫，才可串接提示頁。
            </p>
          )}
        </div>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            取消串接
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!ready}
            onClick={() => onSave({ ...draft, line1: draft.line1.trim(), line2: draft.line2.trim() }, cueDraft)}
          >
            儲存提示頁設定
          </button>
        </footer>
      </section>
    </div>
  );
}
