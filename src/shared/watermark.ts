import type { PreviewRenderPurpose, WatermarkSettings, WatermarkTextSettings } from "./domain";

export const DEFAULT_WATERMARK_SETTINGS: WatermarkSettings = {
  enabled: true,
  chinese: { text: "漫步\n風光", position: "LOWER_LEFT", layout: "STACKED_TWO_LINES", fontSize1080p: 51 },
  english: { text: "SceneryWalker", position: "LOWER_RIGHT", layout: "SINGLE_LINE", fontSize1080p: 41 },
  startSeconds: 0,
  intervalSeconds: 360,
  visibleDurationSeconds: 15,
  fadeInSeconds: 1,
  fadeOutSeconds: 1,
  textOpacityPercent: 82,
  boxOpacityPercent: 24,
  safeMargin1080p: 63,
  applyToMain: true,
  applyToIntro: true,
  applyToShorts: false,
};

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(raw: unknown, fallback: WatermarkTextSettings, field: string): WatermarkTextSettings {
  const input = raw && typeof raw === "object" ? (raw as Partial<WatermarkTextSettings>) : {};
  const text = (typeof input.text === "string" ? input.text : fallback.text).replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 80 || text.split("\n").length > 2 || text.includes("\0"))
    throw new Error(`${field}須為 1–80 個字，最多兩行。`);
  const position =
    input.position === "LOWER_RIGHT"
      ? "LOWER_RIGHT"
      : input.position === "LOWER_LEFT"
        ? "LOWER_LEFT"
        : fallback.position;
  const layout =
    input.layout === "SINGLE_LINE"
      ? "SINGLE_LINE"
      : input.layout === "STACKED_TWO_LINES"
        ? "STACKED_TWO_LINES"
        : fallback.layout;
  const fontSize1080p = Math.round(finiteNumber(input.fontSize1080p, fallback.fontSize1080p));
  if (fontSize1080p < 12 || fontSize1080p > 180) throw new Error(`${field}字級須介於 12–180 px（1080p 基準）。`);
  return { text, position, layout, fontSize1080p };
}

export function normalizeWatermarkSettings(raw: unknown): WatermarkSettings {
  const input = raw && typeof raw === "object" ? (raw as Partial<WatermarkSettings>) : {};
  const settings: WatermarkSettings = {
    enabled: input.enabled !== false,
    chinese: normalizeText(input.chinese, DEFAULT_WATERMARK_SETTINGS.chinese, "中文浮水印"),
    english: normalizeText(input.english, DEFAULT_WATERMARK_SETTINGS.english, "英文浮水印"),
    startSeconds: finiteNumber(input.startSeconds, DEFAULT_WATERMARK_SETTINGS.startSeconds),
    intervalSeconds: finiteNumber(input.intervalSeconds, DEFAULT_WATERMARK_SETTINGS.intervalSeconds),
    visibleDurationSeconds: finiteNumber(
      input.visibleDurationSeconds,
      DEFAULT_WATERMARK_SETTINGS.visibleDurationSeconds,
    ),
    fadeInSeconds: finiteNumber(input.fadeInSeconds, DEFAULT_WATERMARK_SETTINGS.fadeInSeconds),
    fadeOutSeconds: finiteNumber(input.fadeOutSeconds, DEFAULT_WATERMARK_SETTINGS.fadeOutSeconds),
    textOpacityPercent: Math.round(
      finiteNumber(input.textOpacityPercent, DEFAULT_WATERMARK_SETTINGS.textOpacityPercent),
    ),
    boxOpacityPercent: Math.round(finiteNumber(input.boxOpacityPercent, DEFAULT_WATERMARK_SETTINGS.boxOpacityPercent)),
    safeMargin1080p: Math.round(finiteNumber(input.safeMargin1080p, DEFAULT_WATERMARK_SETTINGS.safeMargin1080p)),
    applyToMain: input.applyToMain !== false,
    applyToIntro: input.applyToIntro !== false,
    applyToShorts: input.applyToShorts === true,
  };
  if (settings.startSeconds < 0 || settings.startSeconds > 86_400) throw new Error("首次顯示時間須介於 0–86,400 秒。");
  if (settings.intervalSeconds < 5 || settings.intervalSeconds > 86_400)
    throw new Error("每次顯示週期須介於 5–86,400 秒。");
  if (settings.visibleDurationSeconds < 1 || settings.visibleDurationSeconds > settings.intervalSeconds)
    throw new Error("顯示時間須至少 1 秒，且不可超過顯示週期。");
  if (
    settings.fadeInSeconds < 0 ||
    settings.fadeOutSeconds < 0 ||
    settings.fadeInSeconds + settings.fadeOutSeconds > settings.visibleDurationSeconds
  )
    throw new Error("淡入加淡出時間不可超過浮水印顯示時間。");
  if (
    settings.textOpacityPercent < 0 ||
    settings.textOpacityPercent > 100 ||
    settings.boxOpacityPercent < 0 ||
    settings.boxOpacityPercent > 100
  )
    throw new Error("文字與底框透明度須介於 0–100%。");
  if (settings.safeMargin1080p < 12 || settings.safeMargin1080p > 300)
    throw new Error("安全邊距須介於 12–300 px（1080p 基準）。");
  if (settings.chinese.position === settings.english.position)
    throw new Error("中文與英文浮水印需分置左下與右下，避免互相重疊。");
  return settings;
}

export function watermarkAppliesToPurpose(settings: WatermarkSettings, purpose: PreviewRenderPurpose): boolean {
  if (!settings.enabled || purpose === "CLIP") return false;
  if (purpose === "INTRO") return settings.applyToIntro;
  if (purpose === "SHORTS") return settings.applyToShorts;
  return settings.applyToMain;
}

export function watermarkRenderedText(settings: WatermarkTextSettings): string {
  if (settings.layout === "SINGLE_LINE") return settings.text.replace(/\n+/g, " ");
  if (settings.text.includes("\n")) return settings.text;
  const characters = [...settings.text];
  const split = Math.ceil(characters.length / 2);
  return `${characters.slice(0, split).join("")}\n${characters.slice(split).join("")}`;
}
