import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWatermarkFilterChain } from "../src/main/services/concat-render";
import { ProjectStore } from "../src/main/services/project-store";
import { DEFAULT_WATERMARK_SETTINGS, normalizeWatermarkSettings, watermarkAppliesToPurpose, watermarkRenderedText } from "../src/shared/watermark";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project watermark settings", () => {
  it("uses the verified Caota dunes reference as the safe project default", () => {
    const settings = normalizeWatermarkSettings(undefined);
    expect(settings).toEqual(DEFAULT_WATERMARK_SETTINGS);
    expect(watermarkRenderedText(settings.chinese)).toBe("漫步\n風光");
    expect(watermarkRenderedText({ ...settings.chinese, text: "漫步風光" })).toBe("漫步\n風光");
    expect(watermarkRenderedText({ ...settings.chinese, layout: "SINGLE_LINE" })).toBe("漫步 風光");
    expect(watermarkAppliesToPurpose(settings, "CONCAT")).toBe(true);
    expect(watermarkAppliesToPurpose(settings, "INTRO")).toBe(true);
    expect(watermarkAppliesToPurpose(settings, "SHORTS")).toBe(false);
    expect(watermarkAppliesToPurpose(settings, "CLIP")).toBe(false);
  });

  it("builds a resolution-scaled lower-corner periodic drawtext chain", () => {
    const filter = buildWatermarkFilterChain(DEFAULT_WATERMARK_SETTINGS, 3840, 2160, {
      chineseTextFilePath: "C:\\Temp\\watermark-zh.txt",
      englishTextFilePath: "C:\\Temp\\watermark-en.txt",
      chineseFontFilePath: "C:\\Windows\\Fonts\\msjhbd.ttc",
      englishFontFilePath: "C:\\Windows\\Fonts\\arial.ttf",
    });
    expect(filter.match(/drawtext=/g)).toHaveLength(2);
    expect(filter).toContain("fontsize=102");
    expect(filter).toContain("fontsize=82");
    expect(filter).toContain("x=126:y=h-text_h-126");
    expect(filter).toContain("x=w-text_w-126:y=h-text_h-126");
    expect(filter).toContain("boxcolor=black@0.24");
    expect(filter).toContain("gte(t,0)*lt(mod(t-0,360),15)");
    expect(filter).toContain("alpha='0.82*");
  });

  it("rejects overlapping corners and impossible display timing", () => {
    expect(() => normalizeWatermarkSettings({ ...DEFAULT_WATERMARK_SETTINGS, english: { ...DEFAULT_WATERMARK_SETTINGS.english, position: "LOWER_LEFT" } })).toThrow(/避免互相重疊/);
    expect(() => normalizeWatermarkSettings({ ...DEFAULT_WATERMARK_SETTINGS, intervalSeconds: 10, visibleDurationSeconds: 11 })).toThrow(/不可超過顯示週期/);
  });

  it("persists changes and migrates them into manifest schema 16", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "source-app-watermark-"));
    tempRoots.push(root);
    const store = new ProjectStore(root);
    await store.initialize();
    const saved = await store.setWatermarkSettings({
      ...DEFAULT_WATERMARK_SETTINGS,
      startSeconds: 8,
      intervalSeconds: 120,
      visibleDurationSeconds: 12,
      chinese: { ...DEFAULT_WATERMARK_SETTINGS.chinese, text: "山海\n漫步" },
    });
    expect(saved).toMatchObject({ schemaVersion: 17, watermarkSettings: { startSeconds: 8, intervalSeconds: 120, visibleDurationSeconds: 12 } });
    const restored = await new ProjectStore(root).initialize();
    expect(restored.watermarkSettings).toEqual(saved.watermarkSettings);
    const raw = JSON.parse(await readFile(path.join(root, "projects", "default", "project.source-manifest.json"), "utf8"));
    expect(raw.watermarkSettings.chinese.text).toBe("山海\n漫步");
  });
});
