import { useEffect, useMemo, useRef, useState } from "react";
import type { AiPublishAssets, ProjectManifest, PublishTopicSnapshot } from "../../shared/domain";
import {
  chapterText,
  isValidYoutubeChapterSet,
  publishAssetsNeedReview,
  validateExternalPublishPayload,
  validateYoutubeTitle,
  youtubeTextLength,
} from "../../shared/publish-rules";
import { formatDuration } from "../format";
import { SafeDefaultButton } from "./SafeDefaultButton";

interface Props {
  project: ProjectManifest;
  onProjectUpdated(project: ProjectManifest): void;
  onClose(): void;
}
function topicOf(project: ProjectManifest): PublishTopicSnapshot {
  const c = project.aiStoryContext;
  return {
    topic: c.topic,
    locations: c.locations,
    storySummary: c.storySummary,
    audiencePromise: c.audiencePromise,
    capturedAt: new Date().toISOString(),
  };
}
function exportText(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "youtube-description.txt";
  a.click();
  URL.revokeObjectURL(url);
}

export function AiPublishStudio({ project, onProjectUpdated, onClose }: Props) {
  const [assets, setAssets] = useState<AiPublishAssets | null>(() =>
    project.aiPublishAssets ? structuredClone(project.aiPublishAssets) : null,
  );
  const resultsRef = useRef<HTMLElement>(null);
  const [topic, setTopic] = useState(() => topicOf(project));
  const [progress, setProgress] = useState<{
    percent: number;
    detail: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [closePrompt, setClosePrompt] = useState(false);
  const [externalJson, setExternalJson] = useState("");
  const stale = assets
    ? publishAssetsNeedReview(assets, project.mainTimelineRevision ?? project.timelineRevision)
    : false;
  const selectedTitle = assets?.titles.find((item) => item.id === assets.selectedTitleId);
  const selectedThumbnail = assets?.thumbnails.find((item) => item.id === assets.selectedThumbnailId);
  useEffect(() => {
    void window.sourceApp
      .getAiPublishAssets?.()
      .then((value) => {
        if (value) setAssets(value);
      })
      .catch(() => undefined);
    window.sourceApp.onPublishProgress?.(setProgress);
    return () => window.sourceApp.clearPublishProgressListeners?.();
  }, []);
  const update = (next: AiPublishAssets) => {
    setAssets(next);
    setDirty(true);
  };
  const save = async () => {
    if (!assets || !window.sourceApp.setAiPublishAssets) return;
    try {
      if (window.sourceApp.setAiStoryContext)
        await window.sourceApp.setAiStoryContext({
          ...project.aiStoryContext,
          topic: topic.topic.trim(),
          locations: topic.locations,
          storySummary: topic.storySummary.trim(),
          audiencePromise: topic.audiencePromise.trim(),
        });
      const saved = await window.sourceApp.setAiPublishAssets(assets);
      onProjectUpdated(saved);
      setAssets(saved.aiPublishAssets ?? assets);
      setDirty(false);
      setNotice("AI 發布素材已保存。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const generate = async () => {
    if (!window.sourceApp.generateAiPublishAssets) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.sourceApp.generateAiPublishAssets({
        topic: { ...topic, capturedAt: new Date().toISOString() },
        mode: assets?.userEdited ? "PRESERVE_USER_EDITED" : "FILL_BLANKS",
      });
      setAssets(result.assets);
      onProjectUpdated(result.project);
      setDirty(false);
      setNotice(
        result.provider === "LOCAL_FALLBACK"
          ? "已使用可追溯本機 fallback；帳號診斷不代表遠端 AI 已生成內容。"
          : `已產生 ${result.provider} 候選，請人工確認。`,
      );
      requestAnimationFrame(() =>
        resultsRef.current?.scrollIntoView?.({
          behavior: "smooth",
          block: "start",
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const requestClose = () => (dirty ? setClosePrompt(true) : onClose());
  const prompt = useMemo(
    () =>
      JSON.stringify(
        {
          task: "YouTube publishing assets",
          topic,
          constraints: {
            titleMaxCharacters: 100,
            chapterRules: "00:00 first, >=3, increasing, >=10s",
          },
        },
        null,
        2,
      ),
    [topic],
  );
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="editor-modal publish-assets-modal" role="dialog" aria-modal="true" aria-label="AI 發布素材">
        <header className="modal-header">
          <div>
            <span className="eyebrow">AI PUBLISHING ASSETS · CHATGPT FIRST</span>
            <h2>標題與縮圖工作台</h2>
            <p>
              ChatGPT 先依主題、片頭候選畫面與正片內容產生；Gemini
              若已設定，只做第二次復核。標題、縮圖與說明都可在這裡直接修改。
            </p>
          </div>
          <button className="icon-button" onClick={requestClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="publish-assets-body">
          <section className="setting-block">
            <h3>01 主題與觀眾承諾</h3>
            <div className="publish-topic-grid">
              <label>
                主題
                <input value={topic.topic} onChange={(e) => setTopic({ ...topic, topic: e.target.value })} />
              </label>
              <label>
                地點
                <input
                  value={topic.locations.join(", ")}
                  onChange={(e) =>
                    setTopic({
                      ...topic,
                      locations: e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                故事／特色
                <textarea
                  value={topic.storySummary}
                  onChange={(e) => setTopic({ ...topic, storySummary: e.target.value })}
                />
              </label>
              <label>
                觀眾承諾
                <textarea
                  value={topic.audiencePromise}
                  onChange={(e) => setTopic({ ...topic, audiencePromise: e.target.value })}
                />
              </label>
            </div>
            <div className="concat-footer-actions">
              <button className="ai-intro-button" disabled={busy} onClick={() => void generate()}>
                ✦ 產生／重跑
              </button>
              {busy && (
                <button className="cancel-button" onClick={() => void window.sourceApp.cancelAiPublishAssets?.()}>
                  取消
                </button>
              )}
              {progress && (
                <span>
                  {progress.percent}% · {progress.detail}
                </span>
              )}
            </div>
          </section>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="inline-notice" role="status">
              {notice}
            </p>
          )}
          {assets && (
            <>
              <section className="publish-results-summary" ref={resultsRef} aria-label="AI 標題與縮圖產生結果">
                <div>
                  <span className="eyebrow">CHATGPT PRIMARY RESULT</span>
                  <h3>
                    已產生 {assets.titles.length} 個標題＋
                    {assets.thumbnails.length} 張縮圖
                  </h3>
                  <p>
                    先看已選片頭畫面，再用正片與主題交叉核對。主生成：
                    {assets.provider === "CODEX_CHATGPT"
                      ? "Codex／ChatGPT"
                      : assets.provider === "OPENAI_API"
                        ? "OpenAI API 備援"
                        : "本機備援"}
                    {assets.model ? ` · ${assets.model}` : ""}
                  </p>
                  <div className={`gemini-review-badge status-${assets.geminiReview?.status ?? "NOT_CONFIGURED"}`}>
                    <strong>Gemini 輔助</strong>
                    <span>{assets.geminiReview?.summary ?? "未啟用；沒有執行第二次復核。"}</span>
                    {assets.geminiReview?.warnings.map((warning) => (
                      <small key={warning}>{warning}</small>
                    ))}
                  </div>
                </div>
                {selectedThumbnail?.previewUrl && (
                  <img src={selectedThumbnail.previewUrl} alt="目前選用的 AI 縮圖結果" />
                )}
                <strong>{selectedTitle?.text ?? "請在下方選擇標題"}</strong>
                {assets.warnings.length > 0 && (
                  <details>
                    <summary>產生過程提醒（{assets.warnings.length}）</summary>
                    {assets.warnings.map((warning, index) => (
                      <p key={`${warning}-${index}`}>{warning}</p>
                    ))}
                  </details>
                )}
              </section>
              <section className="setting-block publish-title-section">
                <h3>02 選擇與微調標題</h3>
                <p>先點選要使用的標題，再直接修改文字；每一筆都會即時計算 YouTube 的 100 字限制。</p>
                {assets.titles.map((item) => (
                  <label
                    className={`publish-title-row ${item.id === assets.selectedTitleId ? "is-selected" : ""}`}
                    key={item.id}
                  >
                    <input
                      type="radio"
                      checked={item.id === assets.selectedTitleId}
                      onChange={() =>
                        update({
                          ...assets,
                          selectedTitleId: item.id,
                          userEdited: true,
                        })
                      }
                    />
                    <input
                      value={item.text}
                      maxLength={100}
                      onChange={(e) => {
                        const checked = validateYoutubeTitle(e.target.value);
                        update({
                          ...assets,
                          titles: assets.titles.map((old) =>
                            old.id === item.id
                              ? {
                                  ...old,
                                  text: checked.value,
                                  charCount: checked.charCount,
                                  userEdited: true,
                                }
                              : old,
                          ),
                          userEdited: true,
                        });
                      }}
                    />
                    <small>
                      {youtubeTextLength(item.text)}/100 · {item.reason}
                    </small>
                  </label>
                ))}
              </section>
              <section className="setting-block publish-description-section">
                <h3>03 說明／英文摘要／hashtags</h3>
                <label className="publish-wide-field">
                  說明
                  <textarea
                    value={assets.description}
                    maxLength={5000}
                    onChange={(e) =>
                      update({
                        ...assets,
                        description: e.target.value,
                        userEdited: true,
                      })
                    }
                  />
                </label>
                <label className="publish-wide-field">
                  English summary
                  <textarea
                    value={assets.englishSummary}
                    onChange={(e) =>
                      update({
                        ...assets,
                        englishSummary: e.target.value,
                        userEdited: true,
                      })
                    }
                  />
                </label>
                <label className="publish-wide-field">
                  Hashtags
                  <input
                    value={assets.hashtags.join(" ")}
                    onChange={(e) =>
                      update({
                        ...assets,
                        hashtags: e.target.value.split(/\s+/).filter(Boolean),
                        userEdited: true,
                      })
                    }
                  />
                </label>
                <button
                  className="secondary-button"
                  onClick={() =>
                    exportText(
                      `${assets.description}\n\n${assets.englishSummary}\n\n${assets.hashtags.join(" ")}\n\n${chapterText(assets.chapters)}`,
                    )
                  }
                >
                  匯出 UTF-8 說明／章節
                </button>
              </section>
              <section className="setting-block publish-external-section">
                <h3>04 外部 AI 提示詞／貼回</h3>
                <p>
                  貼回內容必須包含完整標題、說明、英文摘要、hashtags、三個可追溯縮圖概念與章節；通過 schema
                  後仍需人工確認。
                </p>
                <textarea
                  className="publish-prompt-box"
                  value={externalJson || prompt}
                  onChange={(e) => setExternalJson(e.target.value)}
                />
                <div className="concat-footer-actions">
                  <button className="secondary-button" onClick={() => navigator.clipboard?.writeText(prompt)}>
                    複製提示詞
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      try {
                        const parsed = validateExternalPublishPayload(
                          JSON.parse(externalJson),
                          new Set(assets.thumbnails.map((item) => item.id)),
                        );
                        const titles = parsed.titles.map((item, index) => {
                          const checked = validateYoutubeTitle(item.text);
                          return {
                            id: `pasted-title-${index}`,
                            text: checked.value,
                            charCount: checked.charCount,
                            reason: item.reason,
                            userEdited: true,
                          };
                        });
                        const thumbnails = parsed.thumbnails.map((item) => {
                          const current = assets.thumbnails.find((candidate) => candidate.id === item.candidateId)!;
                          return {
                            ...current,
                            layout: item.layout,
                            colorNote: item.colorNote,
                            reason: item.reason || current.reason,
                            style: { ...current.style, text: item.overlayText },
                            userEdited: true,
                          };
                        });
                        const chapters = parsed.chapters.map((item, index) => ({
                          id: `pasted-chapter-${index}`,
                          startMs: item.startMs,
                          title: item.title,
                          description: item.description,
                          userEdited: true,
                        }));
                        update({
                          ...assets,
                          titles,
                          description: parsed.description,
                          englishSummary: parsed.englishSummary,
                          hashtags: parsed.hashtags,
                          thumbnails,
                          chapters,
                          selectedTitleId: titles[0]?.id,
                          selectedThumbnailId: thumbnails[0]?.id,
                          warnings: parsed.warnings,
                          userEdited: true,
                        });
                        setNotice("外部發布素材已通過完整 schema 驗證；請逐項確認後保存。");
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : String(reason));
                      }
                    }}
                  >
                    驗證並貼回
                  </button>
                </div>
              </section>
              <section className="setting-block publish-thumbnail-section">
                <h3>05 縮圖候選（1280×720／≤2MB）</h3>
                <p>已自動合成可見結果；片頭畫面會優先成為候選，檔名與時間碼保留供追溯。</p>
                <div className="publish-thumbnail-grid">
                  {assets.thumbnails.map((item, index) => (
                    <article
                      className={`publish-thumbnail-card ${item.id === assets.selectedThumbnailId ? "is-selected" : ""}`}
                      key={item.id}
                    >
                      <img src={item.previewUrl ?? ""} alt={`AI 縮圖候選 ${index + 1}：${item.reason}`} />
                      <label>
                        <input
                          type="radio"
                          checked={item.id === assets.selectedThumbnailId}
                          onChange={() =>
                            update({
                              ...assets,
                              selectedThumbnailId: item.id,
                              userEdited: true,
                            })
                          }
                        />
                        選用第 {index + 1} 張
                      </label>
                      <small>
                        {item.sourceFileName} · {formatDuration(item.sourceTimeMs)}
                        <br />
                        {item.reason}
                      </small>
                      <input
                        aria-label={`縮圖候選 ${index + 1} 顯示文字`}
                        value={item.style.text}
                        onChange={(e) =>
                          update({
                            ...assets,
                            thumbnails: assets.thumbnails.map((old) =>
                              old.id === item.id
                                ? {
                                    ...old,
                                    style: {
                                      ...old.style,
                                      text: e.target.value,
                                    },
                                    userEdited: true,
                                  }
                                : old,
                            ),
                            userEdited: true,
                          })
                        }
                      />
                      <button
                        className="secondary-button"
                        onClick={async () => {
                          const output = await window.sourceApp.choosePublishThumbnailOutput?.("jpg");
                          if (!output) return;
                          const rendered = await window.sourceApp.renderPublishThumbnail?.({
                            candidateId: item.id,
                            outputToken: output.token,
                            format: "jpg",
                          });
                          if (rendered) {
                            update({
                              ...assets,
                              thumbnails: assets.thumbnails.map((old) =>
                                old.id === item.id ? { ...old, outputPath: rendered.outputPath } : old,
                              ),
                            });
                            setNotice(`縮圖已保存：${rendered.outputPath}`);
                          }
                        }}
                      >
                        本機合成另存 JPG
                      </button>
                      <button
                        className="secondary-button"
                        onClick={async () => {
                          const imported = await window.sourceApp.choosePublishThumbnailImport?.();
                          if (imported) {
                            update({
                              ...assets,
                              thumbnails: assets.thumbnails.map((old) =>
                                old.id === item.id
                                  ? {
                                      ...old,
                                      importedPath: imported.path,
                                      outputPath: imported.path,
                                      userEdited: true,
                                    }
                                  : old,
                              ),
                              userEdited: true,
                            });
                            setNotice("已匯入 JPG／PNG；上傳前仍會檢查大小。");
                          }
                        }}
                      >
                        匯入 JPG／PNG
                      </button>
                    </article>
                  ))}
                </div>
              </section>
              <section className="setting-block publish-chapter-section">
                <h3>06 章節候選 {stale && <span className="stale-badge">需複核</span>}</h3>
                {assets.chapters.map((cue) => (
                  <div className="publish-chapter-row" key={cue.id}>
                    <input
                      type="number"
                      value={Math.round(cue.startMs)}
                      onChange={(e) =>
                        update({
                          ...assets,
                          chapters: assets.chapters.map((old) =>
                            old.id === cue.id
                              ? {
                                  ...old,
                                  startMs: Math.max(0, Number(e.target.value) || 0),
                                  userEdited: true,
                                }
                              : old,
                          ),
                          userEdited: true,
                        })
                      }
                    />
                    <input
                      value={cue.title}
                      onChange={(e) =>
                        update({
                          ...assets,
                          chapters: assets.chapters.map((old) =>
                            old.id === cue.id
                              ? {
                                  ...old,
                                  title: e.target.value,
                                  userEdited: true,
                                }
                              : old,
                          ),
                          userEdited: true,
                        })
                      }
                    />
                    <button
                      className="danger-text"
                      onClick={() =>
                        update({
                          ...assets,
                          chapters: assets.chapters.filter((old) => old.id !== cue.id),
                          userEdited: true,
                        })
                      }
                    >
                      刪除
                    </button>
                  </div>
                ))}
                <p
                  className={isValidYoutubeChapterSet(assets.chapters, 999999999) ? "inline-notice" : "inline-warning"}
                >
                  第一段 00:00、至少 3 段、遞增、每段至少 10 秒；目前 {assets.chapters.length} 段。
                </p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    const last = assets.chapters.at(-1);
                    update({
                      ...assets,
                      chapters: [
                        ...assets.chapters,
                        {
                          id: crypto.randomUUID(),
                          startMs: (last?.startMs ?? 0) + 10_000,
                          title: "新章節",
                          description: "",
                          userEdited: true,
                        },
                      ],
                      userEdited: true,
                    });
                  }}
                >
                  ＋ 新增章節
                </button>
              </section>
              <section className="setting-block publish-save-row">
                <span>{assets.userEdited ? "有未保存編輯" : "已保存"}</span>
                <button className="primary-button" disabled={!dirty} onClick={() => void save()}>
                  保存
                </button>
                <button
                  className="secondary-button"
                  onClick={() => selectedTitle && navigator.clipboard?.writeText(selectedTitle.text)}
                >
                  複製選定標題
                </button>
              </section>
            </>
          )}
        </div>
        <footer className="settings-footer">
          <p>縮圖會自動以片頭優先的可追溯影格合成；本版不捏造來源畫面，也不會改寫原始素材。</p>
          <button className="primary-button" onClick={requestClose}>
            完成
          </button>
        </footer>
        {closePrompt && (
          <div className="inline-close-guard" role="alertdialog">
            <strong>有未保存修改</strong>
            <p>要保存後離開，還是放棄修改？</p>
            <button
              className="primary-button"
              onClick={async () => {
                await save();
                setClosePrompt(false);
                onClose();
              }}
            >
              保存並離開
            </button>
            <button
              className="danger-secondary-button"
              onClick={() => {
                setClosePrompt(false);
                onClose();
              }}
            >
              放棄並離開
            </button>
            <SafeDefaultButton className="secondary-button" onClick={() => setClosePrompt(false)}>
              返回編輯
            </SafeDefaultButton>
          </div>
        )}
      </section>
    </div>
  );
}
