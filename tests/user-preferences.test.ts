import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserPreferencesStore } from "../src/main/services/user-preferences";

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "source-app-preferences-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("user preferences", () => {
  it("defaults new renders to H.265, watermark on and Chrome drag-and-drop handoff", async () => {
    const store = new UserPreferencesStore(await root());
    await store.initialize();
    expect(store.snapshot().renderDefaults).toMatchObject({
      videoCodec: "H265_QSV",
      includeWatermark: true,
      mainBgmScopes: { intro: true, main: true },
      audioProtection: {
        enabled: true,
        autoDuckVoiceAndSuddenSounds: true,
        preserveDistantCrowdAmbience: true,
        preserveSceneMatchedSounds: true,
        eqEnabled: true,
        maxDuckingDb: 6,
        eqReductionDb: 1.5,
        peakCeilingDb: -1,
      },
      youtubeHandoffMode: "CHROME_DRAG_DROP",
    });
    const changed = await store.update({
      renderDefaults: {
        videoCodec: "H264",
        includeWatermark: false,
        mainBgmScopes: { intro: true, main: false },
        audioProtection: {
          enabled: true,
          autoDuckVoiceAndSuddenSounds: true,
          preserveDistantCrowdAmbience: false,
          preserveSceneMatchedSounds: true,
          eqEnabled: true,
          maxDuckingDb: 4.5,
          eqReductionDb: 2,
          peakCeilingDb: -2,
        },
        youtubeHandoffMode: "OFFICIAL_API",
      },
    });
    expect(changed.renderDefaults).toMatchObject({
      videoCodec: "H264",
      includeWatermark: false,
      mainBgmScopes: { intro: true, main: false },
      audioProtection: { maxDuckingDb: 4.5, eqReductionDb: 2, peakCeilingDb: -2 },
      youtubeHandoffMode: "OFFICIAL_API",
    });
  });
  it("persists last UI, render, upload and voice defaults across reopen", async () => {
    const dataRoot = await root();
    const first = new UserPreferencesStore(dataRoot);
    await first.initialize();
    await first.update({
      viewMode: "LIST",
      renderDefaults: {
        transitionSeconds: 0.7,
        resolution: "4K",
        prependIntro: false,
        autoUpload: false,
        introPreviewIncludeBgm: true,
        mainPreviewIncludeBgm: false,
        mainStartCard: {
          durationSeconds: 7,
          line1: "草漯沙丘",
          line2: "正片開始",
          line1FontSize1080p: 120,
          line2FontSize1080p: 88,
          lineGap1080p: 130,
          overlayOpacityPercent: 70,
          transitionStyle: "FADE_BLACK",
          backgroundIntroSegmentId: "intro-background-2",
        },
      },
      youtubeUploadDefaults: { privacyStatus: "private" },
      voiceInputLanguage: "en-US",
      subtitleBurnInDefaults: {
        enabled: true,
        tracks: [
          { language: "zh-TW", position: "BOTTOM", fontSize1080p: 52 },
          { language: "en", position: "TOP", fontSize1080p: 40 },
        ],
      },
      musicSuggestionDefaults: { includeTikTokTrending: true, royaltyFreeOnly: true },
    });
    const reopened = new UserPreferencesStore(dataRoot);
    await reopened.initialize();
    expect(reopened.snapshot()).toMatchObject({
      viewMode: "LIST",
      renderDefaults: {
        transitionSeconds: 0.7,
        resolution: "4K",
        prependIntro: false,
        autoUpload: false,
        introPreviewIncludeBgm: true,
        mainPreviewIncludeBgm: false,
        mainStartCard: {
          durationSeconds: 7,
          line1: "草漯沙丘",
          line2: "正片開始",
          line1FontSize1080p: 120,
          line2FontSize1080p: 88,
          lineGap1080p: 130,
          overlayOpacityPercent: 70,
          transitionStyle: "FADE_BLACK",
          backgroundIntroSegmentId: "intro-background-2",
        },
      },
      youtubeUploadDefaults: { privacyStatus: "private" },
      voiceInputLanguage: "en-US",
      subtitleBurnInDefaults: {
        enabled: true,
        tracks: [
          { language: "zh-TW", position: "BOTTOM", fontSize1080p: 52 },
          { language: "en", position: "TOP", fontSize1080p: 40 },
        ],
      },
      musicSuggestionDefaults: { includeTikTokTrending: true, royaltyFreeOnly: true },
    });
  });

  it("remembers Chinese and spaced directories without retaining a selected filename", async () => {
    const dataRoot = await root();
    const store = new UserPreferencesStore(dataRoot);
    await store.initialize();
    const filePath = path.join(dataRoot, "使用者 影片", "預覽 成品.mp4");
    await store.rememberDirectory("PREVIEW_OUTPUT", filePath);
    const folderPath = path.join(dataRoot, "另一個 素材夾");
    await store.rememberDirectory("SOURCE_FOLDER", folderPath, true);
    expect(store.getLastDirectory("PREVIEW_OUTPUT", "fallback")).toBe(path.dirname(filePath));
    expect(store.getLastDirectory("SOURCE_FOLDER", "fallback")).toBe(folderPath);
    expect(JSON.parse(await readFile(store.settingsPath, "utf8")).lastDirectories).toMatchObject({
      PREVIEW_OUTPUT: path.dirname(filePath),
      SOURCE_FOLDER: folderPath,
    });
  });

  it("rejects invalid updates and never replaces a good persisted snapshot", async () => {
    const dataRoot = await root();
    const store = new UserPreferencesStore(dataRoot);
    await store.initialize();
    await store.update({ viewMode: "LIST" });
    await expect(store.update({ renderDefaults: { transitionSeconds: 1 as 0.3 } })).rejects.toThrow(/疊化秒數/);
    expect(store.snapshot().viewMode).toBe("LIST");
  });

  it("limits burn-in defaults to two unique supported languages and clamps readable sizes", async () => {
    const store = new UserPreferencesStore(await root());
    await store.initialize();
    const updated = await store.update({
      subtitleBurnInDefaults: {
        enabled: true,
        tracks: [
          { language: "zh-TW", position: "BOTTOM", fontSize1080p: 5 },
          { language: "en", position: "TOP", fontSize1080p: 200 },
          { language: "ja", position: "MIDDLE", fontSize1080p: 44 },
        ],
      },
    });
    expect(updated.subtitleBurnInDefaults).toEqual({
      enabled: true,
      tracks: [
        { language: "zh-TW", position: "BOTTOM", fontSize1080p: 24 },
        { language: "en", position: "TOP", fontSize1080p: 96 },
      ],
    });
  });

  it("persists subtitle scope and clamps the synchronized preview style", async () => {
    const dataRoot = await root();
    const store = new UserPreferencesStore(dataRoot);
    await store.initialize();
    await store.update({
      subtitleGenerationScope: { intro: true, main: false },
      subtitlePreviewStyle: {
        verticalPositionPercent: 99,
        fontSizePx: 5,
        textColor: "#31aBcD",
        shadowEnabled: false,
        outlineWidthPx: 20,
      },
    });
    const reopened = new UserPreferencesStore(dataRoot);
    await reopened.initialize();
    expect(reopened.snapshot()).toMatchObject({
      subtitleGenerationScope: { intro: true, main: false },
      subtitlePreviewStyle: {
        verticalPositionPercent: 92,
        fontSizePx: 16,
        textColor: "#31ABCD",
        shadowEnabled: false,
        outlineWidthPx: 8,
      },
    });
    await expect(store.update({ subtitleGenerationScope: { intro: false, main: false } })).rejects.toThrow(
      /至少需要選擇一項/,
    );
  });

  it("clamps the subtitle per-line character override and keeps auto when absent", async () => {
    const dataRoot = await root();
    const store = new UserPreferencesStore(dataRoot);
    await store.initialize();
    const base = {
      verticalPositionPercent: 82,
      fontSizePx: 28,
      textColor: "#FFFFFF",
      shadowEnabled: true,
      outlineWidthPx: 2,
    };
    await store.update({ subtitlePreviewStyle: { ...base, maxCharactersPerLine: 3 } });
    expect(store.snapshot().subtitlePreviewStyle.maxCharactersPerLine).toBe(6);
    await store.update({ subtitlePreviewStyle: { ...base, maxCharactersPerLine: 100 } });
    expect(store.snapshot().subtitlePreviewStyle.maxCharactersPerLine).toBe(40);
    await store.update({ subtitlePreviewStyle: { ...base, maxCharactersPerLine: 12 } });
    expect(store.snapshot().subtitlePreviewStyle.maxCharactersPerLine).toBe(12);
    await store.update({ subtitlePreviewStyle: { ...base, maxCharactersPerLine: Number.NaN } });
    expect(store.snapshot().subtitlePreviewStyle.maxCharactersPerLine).toBeUndefined();
  });
});
