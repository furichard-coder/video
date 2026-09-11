import type { ColorPresetId, ProjectColorSettings } from "./domain";

export interface ColorPreset {
  id: ColorPresetId;
  label: string;
  description: string;
  temperatureLabel: string;
  saturationPercent: number;
  ffmpegFilters: string[];
  cssFilter: string;
}

export const COLOR_PRESETS: readonly ColorPreset[] = [
  {
    id: "NATURAL",
    label: "自然原色",
    description: "不改變色溫與彩度，適合已完成調色的素材。",
    temperatureLabel: "中性",
    saturationPercent: 100,
    ffmpegFilters: [],
    cssFilter: "none",
  },
  {
    id: "WARM_GOLDEN",
    label: "暖陽金色",
    description: "稍微偏暖並輕度增豔，適合夕陽、街景與人物。",
    temperatureLabel: "暖色 +",
    saturationPercent: 110,
    ffmpegFilters: ["colorbalance=rs=.045:gs=.012:bs=-.035", "eq=saturation=1.10"],
    cssFilter: "sepia(.08) saturate(1.10) brightness(1.01)",
  },
  {
    id: "COOL_CLEAR",
    label: "清透冷色",
    description: "稍微降低暖色、提升藍綠清爽感，適合森林、天空與水景。",
    temperatureLabel: "冷色 +",
    saturationPercent: 108,
    ffmpegFilters: ["colorbalance=rs=-.025:gs=.008:bs=.04", "eq=saturation=1.08"],
    cssFilter: "saturate(1.08) hue-rotate(3deg) brightness(1.01)",
  },
  {
    id: "VIVID_TRAVEL",
    label: "旅遊增豔",
    description: "不明顯改變色溫，提升彩度與少量對比。",
    temperatureLabel: "中性",
    saturationPercent: 120,
    ffmpegFilters: ["eq=saturation=1.20:contrast=1.04"],
    cssFilter: "saturate(1.20) contrast(1.04)",
  },
  {
    id: "WARM_VIVID",
    label: "暖色增豔",
    description: "暖色與增豔同時套用，較有活力但仍保留自然膚色。",
    temperatureLabel: "暖色 ++",
    saturationPercent: 118,
    ffmpegFilters: ["colorbalance=rs=.04:gs=.01:bs=-.03", "eq=saturation=1.18:contrast=1.03"],
    cssFilter: "sepia(.07) saturate(1.18) contrast(1.03)",
  },
] as const;

export const DEFAULT_PROJECT_COLOR_SETTINGS: ProjectColorSettings = { introPresetId: "NATURAL", applyToMain: false };

export function isColorPresetId(value: unknown): value is ColorPresetId {
  return COLOR_PRESETS.some((preset) => preset.id === value);
}

export function normalizeProjectColorSettings(value: unknown): ProjectColorSettings {
  const input = value && typeof value === "object" ? (value as Partial<ProjectColorSettings>) : {};
  return {
    introPresetId: isColorPresetId(input.introPresetId)
      ? input.introPresetId
      : DEFAULT_PROJECT_COLOR_SETTINGS.introPresetId,
    applyToMain: input.applyToMain === true,
  };
}

export function colorPreset(id: ColorPresetId): ColorPreset {
  return COLOR_PRESETS.find((preset) => preset.id === id) ?? COLOR_PRESETS[0];
}
