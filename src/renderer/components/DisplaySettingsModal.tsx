import type { UiTextSize, UiZoomPercent } from "../ui-preferences";
import { UI_TEXT_SIZE_OPTIONS, UI_ZOOM_LEVELS } from "../ui-preferences";

interface Props {
  textSize: UiTextSize;
  zoomPercent: UiZoomPercent;
  showGridOutputTimes: boolean;
  gridOutputIncludeIntro: boolean;
  onTextSizeChange(size: UiTextSize): void;
  onZoomChange(percent: UiZoomPercent): void;
  onShowGridOutputTimesChange(visible: boolean): void;
  onGridOutputIncludeIntroChange(include: boolean): void;
  onClose(): void;
}

export function DisplaySettingsModal({
  textSize,
  zoomPercent,
  showGridOutputTimes,
  gridOutputIncludeIntro,
  onTextSizeChange,
  onZoomChange,
  onShowGridOutputTimesChange,
  onGridOutputIncludeIntroChange,
  onClose,
}: Props) {
  const zoomIndex = UI_ZOOM_LEVELS.indexOf(zoomPercent);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="display-settings-modal" role="dialog" aria-modal="true" aria-label="介面顯示設定">
        <header className="modal-header">
          <div>
            <span className="eyebrow">SETTINGS · READABILITY</span>
            <h2>介面顯示設定</h2>
            <p>一次調整整個 App 的文字，包括網格預覽下方的檔名、規格、路徑與操作說明。</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="display-settings-body">
          <fieldset>
            <legend>整體介面縮放</legend>
            <div className="ui-zoom-control">
              <button
                type="button"
                aria-label="縮小介面"
                disabled={zoomIndex <= 0}
                onClick={() => onZoomChange(UI_ZOOM_LEVELS[Math.max(0, zoomIndex - 1)])}
              >
                −
              </button>
              <strong aria-live="polite">{zoomPercent}%</strong>
              <button
                type="button"
                aria-label="放大介面"
                disabled={zoomIndex >= UI_ZOOM_LEVELS.length - 1}
                onClick={() => onZoomChange(UI_ZOOM_LEVELS[Math.min(UI_ZOOM_LEVELS.length - 1, zoomIndex + 1)])}
              >
                ＋
              </button>
              <button type="button" disabled={zoomPercent === 100} onClick={() => onZoomChange(100)}>
                回到 100%
              </button>
            </div>
            <small className="zoom-shortcut-help">
              也可使用 Ctrl＋滑鼠滾輪、Ctrl＋↑／↓、Ctrl＋＋／−；Ctrl＋0 回到 100%。設定會保留到下次開啟。
            </small>
          </fieldset>
          <fieldset>
            <legend>全介面文字大小</legend>
            <div className="text-size-options">
              {UI_TEXT_SIZE_OPTIONS.map((option) => (
                <label key={option.value} className={textSize === option.value ? "is-selected" : ""}>
                  <input
                    type="radio"
                    name="ui-text-size"
                    value={option.value}
                    checked={textSize === option.value}
                    onChange={() => onTextSizeChange(option.value)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                  <em style={{ fontSize: `${option.value}px` }}>Aa 中文</em>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>網格串聯後時間</legend>
            <div className="text-size-options">
              <label className={showGridOutputTimes ? "is-selected" : ""}>
                <input
                  type="checkbox"
                  checked={showGridOutputTimes}
                  onChange={(event) => onShowGridOutputTimesChange(event.target.checked)}
                />
                <span>
                  <strong>顯示串聯後時間段</strong>
                  <small>每個轉出片段在成品中的始末</small>
                </span>
              </label>
              <label className={gridOutputIncludeIntro ? "is-selected" : ""}>
                <input
                  type="checkbox"
                  checked={gridOutputIncludeIntro}
                  disabled={!showGridOutputTimes}
                  onChange={(event) => onGridOutputIncludeIntroChange(event.target.checked)}
                />
                <span>
                  <strong>含片頭＋提示頁時間</strong>
                  <small>關閉則只顯示正片內相對時間</small>
                </span>
              </label>
            </div>
          </fieldset>
          <section className="grid-text-sample" aria-label="網格文字預覽">
            <span>網格文字預覽</span>
            <strong>河內旅行影片_001.MOV</strong>
            <p>2026/08/02 09:30 · 3840 × 2160 · H.264 / AAC</p>
            <small>C:\來源素材\河內旅行影片_001.MOV</small>
          </section>
          <div className="readonly-note">
            <span>✓</span>
            <div>
              <strong>設定已即時保存</strong>
              <small>下次開啟 App 會沿用；不寫入影片、照片或專案內容。</small>
            </div>
          </div>
        </div>
        <footer className="settings-footer">
          <p>整體縮放會一起調整按鈕、圖片與文字；文字大小可再獨立微調。</p>
          <button className="primary-button" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
