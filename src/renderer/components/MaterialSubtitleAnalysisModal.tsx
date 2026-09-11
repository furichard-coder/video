import { useMemo, useState } from "react";
import type {
  MaterialAnalysisProvider,
  MaterialSubtitleAnalysisResult,
  ProjectManifest,
  SourceAsset,
  SubtitleCue,
  SubtitleTimelineScope,
} from "../../shared/domain";
import { formatDuration } from "../format";

interface MaterialSubtitleAnalysisModalProps {
  asset: SourceAsset;
  project: ProjectManifest;
  onClose(): void;
  onProjectUpdated(project: ProjectManifest): void;
  onOpenSubtitleReview?(project: ProjectManifest): void;
  onNotice?(message: string): void;
  initialScope?: SubtitleTimelineScope;
}

function parseTime(value: string): number | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw) * 1000));
  const parts = raw.split(":").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length > 3) return undefined;
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return undefined;
}

function formatProvider(result?: MaterialSubtitleAnalysisResult): string {
  if (!result) return "尚未分析";
  if (result.providerLabel === "GEMINI") return "Gemini 圖片／物種分析";
  return result.providerLabel === "CODEX_CHATGPT" ? "Codex／ChatGPT 登入" : "ChatGPT／OpenAI API";
}

export function MaterialSubtitleAnalysisModal({
  asset,
  project,
  onClose,
  onProjectUpdated,
  onOpenSubtitleReview,
  onNotice,
  initialScope = "MAIN",
}: MaterialSubtitleAnalysisModalProps) {
  const [scope, setScope] = useState<SubtitleTimelineScope>(initialScope);
  const [provider, setProvider] = useState<MaterialAnalysisProvider>(asset.kind === "IMAGE" ? "GEMINI" : "CHATGPT");
  const [frameText, setFrameText] = useState(asset.kind === "VIDEO" ? "00:00" : "");
  const [drafts, setDrafts] = useState<SubtitleCue[]>([]);
  const [result, setResult] = useState<MaterialSubtitleAnalysisResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const durationMs = asset.mediaInfo?.durationMs ?? 0;
  const frameHint = useMemo(
    () =>
      asset.kind === "IMAGE"
        ? "照片會以單張原圖分析。"
        : `可輸入多個時間點，例如 00:12、01:05.500；目前素材長度 ${formatDuration(durationMs)}。`,
    [asset.kind, durationMs],
  );
  const overlapByDraft = useMemo(() => {
    const entries = new Map<string, Array<Pick<SubtitleCue, "id" | "startMs" | "endMs" | "text" | "reviewStatus">>>();
    for (const draft of drafts) {
      const related = [...project.subtitleCues, ...drafts.filter((item) => item.id !== draft.id)].filter(
        (item) =>
          item.reviewStatus !== "REJECTED" &&
          (item.timelineScope ?? "MAIN") === (draft.timelineScope ?? "MAIN") &&
          Math.max(item.startMs, draft.startMs) < Math.min(item.endMs, draft.endMs),
      );
      if (related.length) entries.set(draft.id, related);
    }
    return entries;
  }, [drafts, project.subtitleCues]);
  const overlapCueCount = useMemo(
    () =>
      new Set([...overlapByDraft.entries()].flatMap(([draftId, related]) => [draftId, ...related.map((cue) => cue.id)]))
        .size,
    [overlapByDraft],
  );

  const analyze = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const frameTimesMs =
        asset.kind === "IMAGE"
          ? []
          : frameText
              .split(/[\s,，;；\n]+/)
              .map(parseTime)
              .filter((value): value is number => value !== undefined);
      if (asset.kind === "VIDEO" && !frameTimesMs.length)
        throw new Error("請至少輸入一個有效影格時間（例如 00:12 或 75.5）。");
      if (!window.sourceApp.analyzeMaterialForSubtitles)
        throw new Error("目前執行中的 App 尚未載入素材影像分析功能，請關閉舊版視窗後開啟新版。");
      const analyzed = await window.sourceApp.analyzeMaterialForSubtitles({
        assetId: asset.id,
        timelineScope: scope,
        provider,
        frameTimesMs,
      });
      setResult(analyzed);
      setDrafts(analyzed.drafts);
      setNotice(
        analyzed.drafts.length
          ? `已產生 ${analyzed.drafts.length} 筆可修改字幕建議；即使時間重疊，分析文字也會完整保留。`
          : "分析完成，但沒有產生可用字幕草稿。請調整時間或補充辨識文字。 ",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = (id: string, patch: Partial<Pick<SubtitleCue, "startMs" | "endMs" | "text">>) => {
    setDrafts((current) => current.map((cue) => (cue.id === id ? { ...cue, ...patch, userEdited: true } : cue)));
  };

  const insertConfirmed = async () => {
    if (!drafts.length) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const hasOverlap = overlapByDraft.size > 0;
      const reviewed = drafts.map((cue) => ({
        ...cue,
        reviewStatus: overlapByDraft.has(cue.id) ? ("DRAFT" as const) : ("CONFIRMED" as const),
        userEdited: true,
      }));
      const updated = await window.sourceApp.setSubtitleCues([...project.subtitleCues, ...reviewed]);
      onProjectUpdated(updated);
      onNotice?.(
        hasOverlap
          ? `已保留 ${reviewed.length} 筆影像分析字幕並開啟字幕頁；${overlapCueCount} 筆新舊字幕會以紅框標示，調整到不重疊後即可確認。`
          : `已將 ${reviewed.length} 筆影像分析字幕加入${scope === "INTRO" ? "片頭" : "正片"}字幕頁，狀態預設為已確認；仍可再修改。`,
      );
      if (hasOverlap && onOpenSubtitleReview) onOpenSubtitleReview(updated);
      else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop nested-modal"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="material-analysis-modal" role="dialog" aria-modal="true" aria-label="影像分析字幕">
        <header className="modal-header">
          <div>
            <span className="eyebrow">VISUAL TO SUBTITLE</span>
            <h2>{asset.fileName}</h2>
            <p>先分析物種、物品、地點與事件，再讓你修改文字與時間，確認後才加入字幕頁。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="material-analysis-body">
          <section className="material-analysis-controls">
            <label>
              <span>加入哪一條時間線</span>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as SubtitleTimelineScope)}
                disabled={busy}
              >
                <option value="MAIN">正片</option>
                <option value="INTRO">片頭</option>
              </select>
            </label>
            <label>
              <span>分析方式</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as MaterialAnalysisProvider)}
                disabled={busy}
              >
                <option value="GEMINI">Gemini 圖片／物種分析{asset.kind === "IMAGE" ? "（照片預設）" : ""}</option>
                <option value="CHATGPT">ChatGPT／Codex 視覺分析</option>
              </select>
              <small>
                Gemini 會逐張查看照片或指定影格，先辨識物種、名稱與場景，再產生簡短字幕；使用 AI 設定頁中加密保存的
                Gemini API Key。
              </small>
            </label>
            {asset.kind === "VIDEO" && (
              <label className="material-analysis-wide">
                <span>來源影格時間（可多個）</span>
                <input
                  value={frameText}
                  onChange={(event) => setFrameText(event.target.value)}
                  placeholder="00:12, 01:05.500"
                  disabled={busy}
                />
                <small>{frameHint}</small>
              </label>
            )}
            {asset.kind === "IMAGE" && (
              <p className="material-analysis-photo-default">
                <input type="checkbox" checked readOnly /> 預設勾選：分析照片中的物種、物品、地點與可見事件
              </p>
            )}
            {asset.kind === "IMAGE" && <small className="material-analysis-hint">{frameHint}</small>}
            <div className="material-analysis-actions">
              <button className="primary-button" type="button" onClick={() => void analyze()} disabled={busy}>
                {busy ? "分析中…" : "✦ 分析並產生字幕草稿"}
              </button>
              {busy && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void window.sourceApp.cancelMaterialSubtitleAnalysis?.()}
                >
                  取消
                </button>
              )}
            </div>
          </section>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="notice success" role="status">
              {notice}
            </p>
          )}
          {result && (
            <div className="material-analysis-result-note">
              <p>
                分析來源：{formatProvider(result)} ·{" "}
                {asset.kind === "IMAGE"
                  ? "照片原圖"
                  : `影格 ${result.analyzedFrameTimesMs.map((time) => formatDuration(time)).join("、")}`}
              </p>
              {result.warnings.length ? (
                <ul>
                  {result.warnings.map((warning, index) => (
                    <li key={`${index}:${warning}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {drafts.length > 0 && (
            <section className="material-analysis-drafts">
              <div className="material-analysis-drafts-heading">
                <div>
                  <span className="eyebrow">EDIT BEFORE INSERT</span>
                  <h3>字幕建議 · {drafts.length} 筆</h3>
                  {overlapByDraft.size > 0 && (
                    <p className="material-overlap-summary">
                      偵測到時間重疊，但建議文字已保留。可先在此調整，或加入字幕頁同時檢視新舊紅框。
                    </p>
                  )}
                </div>
                <button className="primary-button" type="button" onClick={() => void insertConfirmed()} disabled={busy}>
                  {overlapByDraft.size > 0 ? "加入字幕頁調整重疊" : "確認並加入字幕頁"}
                </button>
              </div>
              {drafts.map((cue, index) => {
                const related = overlapByDraft.get(cue.id) ?? [];
                return (
                  <article
                    key={cue.id}
                    className={`material-analysis-draft ${related.length ? "has-time-overlap" : ""}`}
                  >
                    <strong>影格 {index + 1}</strong>
                    <label>
                      開始
                      <input
                        type="number"
                        min={0}
                        value={cue.startMs}
                        onChange={(event) => updateDraft(cue.id, { startMs: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      結束
                      <input
                        type="number"
                        min={1}
                        value={cue.endMs}
                        onChange={(event) => updateDraft(cue.id, { endMs: Number(event.target.value) })}
                      />
                    </label>
                    <label className="material-analysis-text">
                      簡化後字幕建議
                      <textarea
                        value={cue.text}
                        onChange={(event) => updateDraft(cue.id, { text: event.target.value })}
                      />
                    </label>
                    <div className="material-analysis-evidence">
                      <span>{cue.visualSummary || "影像摘要未提供"}</span>
                      {cue.animalSpecies?.length ? (
                        <span>
                          物種：{cue.animalSpecies.join("、")}
                          {cue.speciesExplanation ? `（${cue.speciesExplanation}）` : ""}
                        </span>
                      ) : null}
                      {cue.locationSummary?.length ? <span>地點：{cue.locationSummary.join("、")}</span> : null}
                    </div>
                    {related.length > 0 && (
                      <div className="material-overlap-details" role="alert">
                        <strong>目前重疊字幕</strong>
                        {related.map((existing) => (
                          <p key={existing.id}>
                            <span>
                              {formatDuration(existing.startMs)} → {formatDuration(existing.endMs)}
                            </span>
                            「{existing.text}」
                          </p>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          )}
        </div>
        <footer className="modal-footer">
          <small>來源影像、照片與外部素材均維持唯讀；分析快取只寫入 App Data。</small>
          <button className="secondary-button" type="button" onClick={onClose}>
            稍後處理
          </button>
        </footer>
      </section>
    </div>
  );
}
