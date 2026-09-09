import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { ProjectManifest, WatermarkCorner, WatermarkSettings, WatermarkTextLayout } from "../../shared/domain";
import { DEFAULT_WATERMARK_SETTINGS, normalizeWatermarkSettings, watermarkRenderedText } from "../../shared/watermark";

interface Props {
  project: ProjectManifest;
  onProjectUpdated(project: ProjectManifest): void;
  onClose(): void;
}

function cornerLabel(position: WatermarkCorner): string {
  return position === "LOWER_LEFT" ? "左下角" : "右下角";
}

function WatermarkPreview({ settings }: { settings: WatermarkSettings }) {
  const style = (item: WatermarkSettings["chinese"]): CSSProperties => ({
    [item.position === "LOWER_LEFT" ? "left" : "right"]: `${Math.max(12, settings.safeMargin1080p * 0.25)}px`,
    bottom: `${Math.max(12, settings.safeMargin1080p * 0.25)}px`,
    fontSize: `${Math.max(12, item.fontSize1080p * 0.25)}px`,
    opacity: settings.textOpacityPercent / 100,
    background: `rgba(0,0,0,${settings.boxOpacityPercent / 100})`,
    whiteSpace: item.layout === "STACKED_TWO_LINES" ? "pre-line" : "nowrap",
    lineHeight: item.layout === "STACKED_TWO_LINES" ? 0.72 : 1.1,
  });
  return <div className="watermark-preview" aria-label="16:9 浮水印位置預覽">
    <div className="watermark-preview-sky" /><div className="watermark-preview-dune" />
    {settings.enabled ? <><span style={style(settings.chinese)}>{watermarkRenderedText(settings.chinese)}</span><span style={style(settings.english)}>{watermarkRenderedText(settings.english)}</span></> : <strong>浮水印目前關閉</strong>}
    <small>16:9 位置示意 · 實際輸出依解析度等比換算</small>
  </div>;
}

export function WatermarkSettingsModal({ project, onProjectUpdated, onClose }: Props) {
  const [draft, setDraft] = useState<WatermarkSettings>(() => normalizeWatermarkSettings(project.watermarkSettings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const hiddenSeconds = useMemo(() => Math.max(0, draft.intervalSeconds - draft.visibleDurationSeconds), [draft.intervalSeconds, draft.visibleDurationSeconds]);
  const patch = <K extends keyof WatermarkSettings>(key: K, value: WatermarkSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const patchText = (key: "chinese" | "english", update: Partial<WatermarkSettings["chinese"]>) => setDraft((current) => ({ ...current, [key]: { ...current[key], ...update } }));

  const save = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const normalized = normalizeWatermarkSettings(draft);
      const updated = await window.sourceApp.setWatermarkSettings(normalized);
      setDraft(normalizeWatermarkSettings(updated.watermarkSettings));
      onProjectUpdated(updated);
      setNotice("浮水印設定已保存；下一次正片／片頭預覽輸出會依此排程套用，不改寫來源檔。" );
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" role="presentation">
    <section className="watermark-settings-modal" role="dialog" aria-modal="true" aria-label="浮水印設定">
      <header className="modal-header"><div><span className="eyebrow">BRANDING WATERMARK · PROJECT SETTINGS</span><h2>浮水印設定</h2><p>參照「草漯沙丘地質公園」已驗證版式；設定只保存到目前專案，輸出時才寫入新 MP4。</p></div><button className="icon-button" type="button" aria-label="關閉" onClick={onClose}>×</button></header>
      <div className="watermark-settings-body">
        <WatermarkPreview settings={draft} />
        <section className="watermark-reference-card"><div><strong>草漯沙丘預設</strong><span>中文左下兩行、英文右下；每 360 秒顯示 15 秒，淡入／淡出各 1 秒。</span></div><button className="secondary-button" type="button" disabled={busy} onClick={() => { setDraft(structuredClone(DEFAULT_WATERMARK_SETTINGS)); setNotice("已載入草漯沙丘預設；按保存後才會寫入專案。" ); }}>套用草漯沙丘預設</button></section>
        <fieldset className="watermark-enable"><legend>使用範圍</legend><label><input type="checkbox" checked={draft.enabled} onChange={(event) => patch("enabled", event.target.checked)} /> 啟用週期浮水印</label><label><input type="checkbox" checked={draft.applyToMain} disabled={!draft.enabled} onChange={(event) => patch("applyToMain", event.target.checked)} /> 正片完成輸出（含已串接片頭）</label><label><input type="checkbox" checked={draft.applyToIntro} disabled={!draft.enabled} onChange={(event) => patch("applyToIntro", event.target.checked)} /> 獨立片頭輸出</label><label><input type="checkbox" checked={draft.applyToShorts} disabled={!draft.enabled} onChange={(event) => patch("applyToShorts", event.target.checked)} /> Shorts 9:16</label></fieldset>
        <div className="watermark-text-grid">
          {(["chinese", "english"] as const).map((key) => { const item = draft[key]; const label = key === "chinese" ? "中文浮水印" : "英文浮水印"; return <fieldset key={key}><legend>{label}</legend><label>顯示文字<textarea aria-label={`${label}文字`} rows={2} maxLength={80} value={item.text} onChange={(event) => patchText(key, { text: event.target.value })} /></label><div><label>優先位置<select aria-label={`${label}位置`} value={item.position} onChange={(event) => patchText(key, { position: event.target.value as WatermarkCorner })}><option value="LOWER_LEFT">左下角</option><option value="LOWER_RIGHT">右下角</option></select></label><label>排列方式<select aria-label={`${label}排列方式`} value={item.layout} onChange={(event) => patchText(key, { layout: event.target.value as WatermarkTextLayout })}><option value="STACKED_TWO_LINES">上下兩行</option><option value="SINGLE_LINE">單行橫排</option></select></label><label>文字大小（1080p）<span className="number-with-unit"><input aria-label={`${label}文字大小`} type="number" min="12" max="180" value={item.fontSize1080p} onChange={(event) => patchText(key, { fontSize1080p: Number(event.target.value) })} /><em>px</em></span></label></div><small>目前：{cornerLabel(item.position)} · {item.layout === "STACKED_TWO_LINES" ? "上下兩行" : "單行橫排"}</small></fieldset>; })}
        </div>
        <fieldset className="watermark-schedule"><legend>顯示排程</legend><label>首次顯示<input aria-label="浮水印首次顯示秒數" type="number" min="0" max="86400" step="1" value={draft.startSeconds} onChange={(event) => patch("startSeconds", Number(event.target.value))} /><span>秒</span></label><label>每次開始間隔<input aria-label="浮水印顯示週期秒數" type="number" min="5" max="86400" step="1" value={draft.intervalSeconds} onChange={(event) => patch("intervalSeconds", Number(event.target.value))} /><span>秒</span></label><label>每次顯示多久<input aria-label="浮水印顯示時間秒數" type="number" min="1" max={Math.max(1, draft.intervalSeconds)} step="1" value={draft.visibleDurationSeconds} onChange={(event) => patch("visibleDurationSeconds", Number(event.target.value))} /><span>秒</span></label><label>淡入<input aria-label="浮水印淡入秒數" type="number" min="0" max="60" step="0.1" value={draft.fadeInSeconds} onChange={(event) => patch("fadeInSeconds", Number(event.target.value))} /><span>秒</span></label><label>淡出<input aria-label="浮水印淡出秒數" type="number" min="0" max="60" step="0.1" value={draft.fadeOutSeconds} onChange={(event) => patch("fadeOutSeconds", Number(event.target.value))} /><span>秒</span></label><p>以目前設定：每 {draft.intervalSeconds || 0} 秒開始顯示一次，顯示 {draft.visibleDurationSeconds || 0} 秒，兩次之間約空白 {hiddenSeconds} 秒。</p></fieldset>
        <fieldset className="watermark-appearance"><legend>外觀與安全邊距</legend><label>文字不透明度<input aria-label="浮水印文字不透明度" type="range" min="0" max="100" value={draft.textOpacityPercent} onChange={(event) => patch("textOpacityPercent", Number(event.target.value))} /><strong>{draft.textOpacityPercent}%</strong></label><label>黑色底框不透明度<input aria-label="浮水印底框不透明度" type="range" min="0" max="100" value={draft.boxOpacityPercent} onChange={(event) => patch("boxOpacityPercent", Number(event.target.value))} /><strong>{draft.boxOpacityPercent}%</strong></label><label>安全邊距（1080p）<input aria-label="浮水印安全邊距" type="number" min="12" max="300" value={draft.safeMargin1080p} onChange={(event) => patch("safeMargin1080p", Number(event.target.value))} /><span>px</span></label></fieldset>
        {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="watermark-notice" role="status">{notice}</p>}
      </div>
      <footer className="settings-footer"><p>輸出採來源唯讀、唯一 partial 成功後才完成 MP4；浮水印變更只影響之後的新輸出。</p><div><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>完成</button><button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存浮水印設定"}</button></div></footer>
    </section>
  </div>;
}
