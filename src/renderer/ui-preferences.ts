export type UiTextSize = 16 | 18 | 20 | 22 | 24 | 26;
export type UiZoomPercent = 75 | 85 | 100 | 110 | 125 | 150;

export const DEFAULT_UI_TEXT_SIZE: UiTextSize = 18;
export const UI_TEXT_SIZE_STORAGE_KEY = "scenerywalker.ui-text-size.v1";
export const UI_ZOOM_STORAGE_KEY = "scenerywalker.ui-zoom.v1";
export const DEFAULT_UI_ZOOM_PERCENT: UiZoomPercent = 100;
export const UI_ZOOM_LEVELS: UiZoomPercent[] = [75, 85, 100, 110, 125, 150];
export const UI_TEXT_SIZE_OPTIONS: Array<{ value: UiTextSize; label: string; detail: string }> = [
  { value: 16, label: "標準", detail: "100%" },
  { value: 18, label: "舒適", detail: "約 113%（預設）" },
  { value: 20, label: "清楚", detail: "125%" },
  { value: 22, label: "最大", detail: "約 138%" },
  { value: 24, label: "超大", detail: "150%" },
  { value: 26, label: "特大", detail: "約 163%" },
];

export function readUiTextSize(storage: Pick<Storage, "getItem"> = window.localStorage): UiTextSize {
  try {
    const parsed = Number(storage.getItem(UI_TEXT_SIZE_STORAGE_KEY));
    return UI_TEXT_SIZE_OPTIONS.some((option) => option.value === parsed)
      ? (parsed as UiTextSize)
      : DEFAULT_UI_TEXT_SIZE;
  } catch {
    return DEFAULT_UI_TEXT_SIZE;
  }
}

export function applyUiTextSize(size: UiTextSize, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  document.documentElement.style.fontSize = `${size}px`;
  document.documentElement.dataset.uiTextSize = String(size);
  try {
    storage.setItem(UI_TEXT_SIZE_STORAGE_KEY, String(size));
  } catch {
    // The visual setting still applies for this session if persistent storage is unavailable.
  }
}

export function readUiZoom(storage: Pick<Storage, "getItem"> = window.localStorage): UiZoomPercent {
  try {
    const parsed = Number(storage.getItem(UI_ZOOM_STORAGE_KEY));
    return UI_ZOOM_LEVELS.includes(parsed as UiZoomPercent) ? (parsed as UiZoomPercent) : DEFAULT_UI_ZOOM_PERCENT;
  } catch {
    return DEFAULT_UI_ZOOM_PERCENT;
  }
}

export function applyUiZoom(percent: UiZoomPercent, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  document.documentElement.style.zoom = String(percent / 100);
  document.documentElement.dataset.uiZoom = String(percent);
  try {
    storage.setItem(UI_ZOOM_STORAGE_KEY, String(percent));
  } catch {
    // The zoom still applies for this session if persistent storage is unavailable.
  }
}

export function stepUiZoom(current: UiZoomPercent, direction: -1 | 1): UiZoomPercent {
  const index = Math.max(0, UI_ZOOM_LEVELS.indexOf(current));
  return UI_ZOOM_LEVELS[Math.max(0, Math.min(UI_ZOOM_LEVELS.length - 1, index + direction))];
}

export const GRID_OUTPUT_TIMES_VISIBLE_KEY = "scenerywalker.grid-output-times-visible.v1";
export const GRID_OUTPUT_INCLUDE_INTRO_KEY = "scenerywalker.grid-output-include-intro.v1";

function readFlag(storage: Pick<Storage, "getItem">, key: string, fallback: boolean): boolean {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function applyFlag(value: boolean, storage: Pick<Storage, "setItem">, key: string): void {
  try {
    storage.setItem(key, value ? "1" : "0");
  } catch {
    // The display setting still applies for this session if persistent storage is unavailable.
  }
}

/** Grid cards show each clip's output time range after concatenation. Defaults on. */
export function readGridOutputTimesVisible(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  return readFlag(storage, GRID_OUTPUT_TIMES_VISIBLE_KEY, true);
}

export function applyGridOutputTimesVisible(
  value: boolean,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  applyFlag(value, storage, GRID_OUTPUT_TIMES_VISIBLE_KEY);
}

/** Output ranges include the intro + main-start card lead time. Defaults on. */
export function readGridOutputIncludeIntro(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  return readFlag(storage, GRID_OUTPUT_INCLUDE_INTRO_KEY, true);
}

export function applyGridOutputIncludeIntro(
  value: boolean,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  applyFlag(value, storage, GRID_OUTPUT_INCLUDE_INTRO_KEY);
}
