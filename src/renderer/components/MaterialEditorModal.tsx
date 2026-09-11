import { useEffect } from "react";
import type { SourceAsset } from "../../shared/domain";

export type MaterialEditorSection = "CLIP" | "VOLUME" | "INSERT" | "PREVIEW";

interface Props {
  asset: SourceAsset;
  initialSection: MaterialEditorSection;
  onClose(): void;
  onOpenSection(section: MaterialEditorSection): void;
}

/** Single entry point for per-material edits; existing safe editors remain reusable behind tabs. */
export function MaterialEditorModal({ asset, initialSection, onClose, onOpenSection }: Props) {
  useEffect(() => {
    // Grid shortcuts keep the legacy detailed editor reachable immediately;
    // the dedicated workspace itself remains the single navigation entry point.
    if (initialSection === "VOLUME" || initialSection === "INSERT") onOpenSection(initialSection);
  }, []);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="editor-modal material-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`素材編輯工作區 ${asset.fileName}`}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">MATERIAL EDITOR WORKSPACE</span>
            <h2>{asset.fileName}</h2>
            <p>同一個素材工作區集中管理 IN／OUT、排除／局部放大、音量與安插；來源檔保持唯讀。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="material-editor-tabs" role="tablist" aria-label="素材編輯區段">
          {(
            [
              ["CLIP", "片段／IN OUT／排除／放大"],
              ["VOLUME", "音量區段"],
              ["INSERT", "安插素材"],
              ["PREVIEW", "預覽"],
            ] as const
          ).map(([section, label]) => (
            <button
              key={section}
              role="tab"
              aria-selected={initialSection === section}
              className={initialSection === section ? "active" : ""}
              onClick={() => onOpenSection(section)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="material-editor-summary">
          <strong>
            目前區段：
            {initialSection === "VOLUME"
              ? "音量區段"
              : initialSection === "INSERT"
                ? "安插素材"
                : initialSection === "PREVIEW"
                  ? "預覽"
                  : "片段與 IN／OUT"}
          </strong>
          <p>點選上方分頁開啟詳細設定；每個子編輯器沿用既有驗證、整數毫秒與唯讀來源保護。</p>
        </div>
        <footer className="settings-footer">
          <span />
          <button className="primary-button" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
