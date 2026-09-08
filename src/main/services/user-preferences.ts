import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MainStartCardOptions,
  MainStartCardTransition,
  PreferenceDirectoryKey,
  PreviewResolution,
  SubtitleBurnInOptions,
  SubtitleGenerationScope,
  SubtitlePreviewStyle,
  SubtitleRenderLanguage,
  SubtitleRenderPosition,
  TransitionDurationSec,
  UserPreferences,
  UserPreferencesUpdate,
  ViewMode,
  VoiceInputLanguage,
  YoutubePrivacyStatus,
} from "../../shared/domain";
import { DEFAULT_MAIN_START_CARD_OPTIONS } from "../../shared/domain";
import { finalizePartialOutput } from "./atomic-output";

const DIRECTORY_KEYS = new Set<PreferenceDirectoryKey>([
  "SOURCE_MEDIA", "SOURCE_FOLDER", "INTRO_MEDIA", "PROJECT", "PREVIEW_OUTPUT", "OUTPUT_HISTORY",
  "SUBTITLE_OUTPUT", "BGM", "CUSTOM_PLAYER", "OAUTH_CLIENT",
]);
const VIEW_MODES = new Set<ViewMode>(["GRID", "LIST"]);
const TRANSITIONS = new Set<TransitionDurationSec>([0.3, 0.5, 0.7]);
const RESOLUTIONS = new Set<PreviewResolution>(["360P", "480P", "720P", "4K"]);
const PRIVACY = new Set<YoutubePrivacyStatus>(["unlisted", "private"]);
const VOICE_LANGUAGES = new Set<VoiceInputLanguage>(["zh-TW", "en-US"]);
const SUBTITLE_LANGUAGES = new Set<SubtitleRenderLanguage>(["zh-TW", "en", "zh-CN", "ja", "ko"]);
const SUBTITLE_POSITIONS = new Set<SubtitleRenderPosition>(["TOP", "MIDDLE", "BOTTOM"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAIN_START_TRANSITIONS = new Set<MainStartCardTransition>(["DISSOLVE", "FADE_BLACK", "HARD_CUT"]);

export function sanitizeMainStartCardOptions(value: unknown): MainStartCardOptions {
  const fallback = DEFAULT_MAIN_START_CARD_OPTIONS;
  if (!value || typeof value !== "object") return { ...fallback };
  const candidate = value as Partial<MainStartCardOptions>;
  const number = (input: unknown, minimum: number, maximum: number, defaultValue: number) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : defaultValue;
  };
  const text = (input: unknown, defaultValue: string) => typeof input === "string" && input.trim()
    ? input.replace(/[\r\n]+/g, " ").trim().slice(0, 80)
    : defaultValue;
  return {
    durationSeconds: number(candidate.durationSeconds, 3, 7, fallback.durationSeconds),
    line1: text(candidate.line1, fallback.line1),
    line2: text(candidate.line2, fallback.line2),
    line1FontSize1080p: number(candidate.line1FontSize1080p, 36, 180, fallback.line1FontSize1080p),
    line2FontSize1080p: number(candidate.line2FontSize1080p, 30, 160, fallback.line2FontSize1080p),
    lineGap1080p: number(candidate.lineGap1080p, 50, 240, fallback.lineGap1080p),
    overlayOpacityPercent: number(candidate.overlayOpacityPercent, 30, 85, fallback.overlayOpacityPercent),
    transitionStyle: MAIN_START_TRANSITIONS.has(candidate.transitionStyle as MainStartCardTransition) ? candidate.transitionStyle as MainStartCardTransition : fallback.transitionStyle,
    backgroundIntroSegmentId: typeof candidate.backgroundIntroSegmentId === "string" && candidate.backgroundIntroSegmentId.trim() && candidate.backgroundIntroSegmentId.length <= 200 && !/[\r\n\0]/.test(candidate.backgroundIntroSegmentId)
      ? candidate.backgroundIntroSegmentId.trim()
      : undefined,
  };
}

export function sanitizeSubtitleGenerationScope(value: unknown): SubtitleGenerationScope {
  if (!value || typeof value !== "object") return { intro: false, main: true };
  const candidate = value as Partial<SubtitleGenerationScope>;
  const scope = { intro: candidate.intro === true, main: candidate.main !== false };
  return scope.intro || scope.main ? scope : { intro: false, main: true };
}

export function sanitizeSubtitlePreviewStyle(value: unknown): SubtitlePreviewStyle {
  const fallback: SubtitlePreviewStyle = { verticalPositionPercent: 82, fontSizePx: 28, textColor: "#FFFFFF", shadowEnabled: true, outlineWidthPx: 2 };
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<SubtitlePreviewStyle>;
  const number = (input: unknown, minimum: number, maximum: number, defaultValue: number) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : defaultValue;
  };
  return {
    verticalPositionPercent: number(candidate.verticalPositionPercent, 10, 92, fallback.verticalPositionPercent),
    fontSizePx: number(candidate.fontSizePx, 16, 72, fallback.fontSizePx),
    textColor: typeof candidate.textColor === "string" && HEX_COLOR.test(candidate.textColor) ? candidate.textColor.toUpperCase() : fallback.textColor,
    shadowEnabled: candidate.shadowEnabled !== false,
    outlineWidthPx: number(candidate.outlineWidthPx, 0, 8, fallback.outlineWidthPx),
  };
}

export function sanitizeSubtitleBurnInOptions(value: unknown): SubtitleBurnInOptions {
  const fallback: SubtitleBurnInOptions = {
    enabled: false,
    tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
  };
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<SubtitleBurnInOptions>;
  if (!Array.isArray(candidate.tracks)) return { ...fallback, enabled: Boolean(candidate.enabled) };
  const languages = new Set<SubtitleRenderLanguage>();
  const tracks = candidate.tracks.slice(0, 2).flatMap((track) => {
    if (!track || typeof track !== "object") return [];
    const language = track.language as SubtitleRenderLanguage;
    const position = track.position as SubtitleRenderPosition;
    const fontSize = Math.round(Number(track.fontSize1080p));
    if (!SUBTITLE_LANGUAGES.has(language) || languages.has(language) || !SUBTITLE_POSITIONS.has(position) || !Number.isFinite(fontSize)) return [];
    languages.add(language);
    return [{ language, position, fontSize1080p: Math.max(24, Math.min(96, fontSize)) }];
  });
  return { enabled: Boolean(candidate.enabled), tracks: tracks.length ? tracks : fallback.tracks };
}

function defaults(): UserPreferences {
  return {
    schemaVersion: 1,
    viewMode: "GRID",
    renderDefaults: { transitionSeconds: 0.3, resolution: "480P", prependIntro: true, autoUpload: true, introPreviewIncludeBgm: false, mainPreviewIncludeBgm: true, mainStartCard: sanitizeMainStartCardOptions(undefined) },
    youtubeUploadDefaults: { privacyStatus: "unlisted" },
    voiceInputLanguage: "zh-TW",
    subtitleBurnInDefaults: sanitizeSubtitleBurnInOptions(undefined),
    subtitleGenerationScope: sanitizeSubtitleGenerationScope(undefined),
    subtitlePreviewStyle: sanitizeSubtitlePreviewStyle(undefined),
    musicSuggestionDefaults: { includeTikTokTrending: false, royaltyFreeOnly: false },
    lastDirectories: {},
    updatedAt: new Date().toISOString(),
  };
}

function sanitize(value: unknown): UserPreferences {
  const fallback = defaults();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<UserPreferences>;
  const render = candidate.renderDefaults;
  const upload = candidate.youtubeUploadDefaults;
  const directories: UserPreferences["lastDirectories"] = {};
  if (candidate.lastDirectories && typeof candidate.lastDirectories === "object") {
    for (const [rawKey, rawValue] of Object.entries(candidate.lastDirectories)) {
      const key = rawKey as PreferenceDirectoryKey;
      if (DIRECTORY_KEYS.has(key) && typeof rawValue === "string" && path.isAbsolute(rawValue)) {
        directories[key] = path.resolve(rawValue);
      }
    }
  }
  return {
    schemaVersion: 1,
    viewMode: VIEW_MODES.has(candidate.viewMode as ViewMode) ? candidate.viewMode as ViewMode : fallback.viewMode,
    renderDefaults: {
      transitionSeconds: TRANSITIONS.has(render?.transitionSeconds as TransitionDurationSec) ? render?.transitionSeconds as TransitionDurationSec : fallback.renderDefaults.transitionSeconds,
      resolution: RESOLUTIONS.has(render?.resolution as PreviewResolution) ? render?.resolution as PreviewResolution : fallback.renderDefaults.resolution,
      prependIntro: typeof render?.prependIntro === "boolean" ? render.prependIntro : fallback.renderDefaults.prependIntro,
      autoUpload: typeof render?.autoUpload === "boolean" ? render.autoUpload : fallback.renderDefaults.autoUpload,
      introPreviewIncludeBgm: typeof render?.introPreviewIncludeBgm === "boolean" ? render.introPreviewIncludeBgm : fallback.renderDefaults.introPreviewIncludeBgm,
      mainPreviewIncludeBgm: typeof render?.mainPreviewIncludeBgm === "boolean" ? render.mainPreviewIncludeBgm : fallback.renderDefaults.mainPreviewIncludeBgm,
      mainStartCard: sanitizeMainStartCardOptions(render?.mainStartCard),
    },
    youtubeUploadDefaults: {
      privacyStatus: PRIVACY.has(upload?.privacyStatus as YoutubePrivacyStatus) ? upload?.privacyStatus as YoutubePrivacyStatus : fallback.youtubeUploadDefaults.privacyStatus,
    },
    voiceInputLanguage: VOICE_LANGUAGES.has(candidate.voiceInputLanguage as VoiceInputLanguage) ? candidate.voiceInputLanguage as VoiceInputLanguage : fallback.voiceInputLanguage,
    subtitleBurnInDefaults: sanitizeSubtitleBurnInOptions(candidate.subtitleBurnInDefaults),
    subtitleGenerationScope: sanitizeSubtitleGenerationScope(candidate.subtitleGenerationScope),
    subtitlePreviewStyle: sanitizeSubtitlePreviewStyle(candidate.subtitlePreviewStyle),
    musicSuggestionDefaults: { includeTikTokTrending: candidate.musicSuggestionDefaults?.includeTikTokTrending === true, royaltyFreeOnly: candidate.musicSuggestionDefaults?.royaltyFreeOnly === true },
    lastDirectories: directories,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : fallback.updatedAt,
  };
}

export class UserPreferencesStore {
  readonly settingsPath: string;
  private current = defaults();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.settingsPath = path.join(dataRoot, "settings", "user-preferences.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    try {
      this.current = sanitize(JSON.parse(await readFile(this.settingsPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      this.current = defaults();
      await this.writeNow();
    }
  }

  snapshot(): UserPreferences {
    return structuredClone(this.current);
  }

  getLastDirectory(key: PreferenceDirectoryKey, fallback: string): string {
    if (!DIRECTORY_KEYS.has(key)) throw new Error("偏好路徑類型無效。");
    return this.current.lastDirectories[key] ?? fallback;
  }

  async rememberDirectory(key: PreferenceDirectoryKey, selectedPath: string, selectedIsDirectory = false): Promise<void> {
    if (!DIRECTORY_KEYS.has(key)) throw new Error("偏好路徑類型無效。");
    if (typeof selectedPath !== "string" || !path.isAbsolute(selectedPath)) throw new Error("只能記住絕對路徑。");
    const directory = path.resolve(selectedIsDirectory ? selectedPath : path.dirname(selectedPath));
    await this.mutate((next) => { next.lastDirectories[key] = directory; });
  }

  async update(update: UserPreferencesUpdate): Promise<UserPreferences> {
    if (!update || typeof update !== "object") throw new Error("使用偏好設定格式無效。");
    await this.mutate((next) => {
      if (update.viewMode !== undefined) {
        if (!VIEW_MODES.has(update.viewMode)) throw new Error("檢視方式無效。");
        next.viewMode = update.viewMode;
      }
      if (update.renderDefaults) {
        const render = update.renderDefaults;
        if (render.transitionSeconds !== undefined) {
          if (!TRANSITIONS.has(render.transitionSeconds)) throw new Error("疊化秒數無效。");
          next.renderDefaults.transitionSeconds = render.transitionSeconds;
        }
        if (render.resolution !== undefined) {
          if (!RESOLUTIONS.has(render.resolution)) throw new Error("預覽解析度無效。");
          next.renderDefaults.resolution = render.resolution;
        }
        if (render.prependIntro !== undefined) next.renderDefaults.prependIntro = Boolean(render.prependIntro);
        if (render.autoUpload !== undefined) next.renderDefaults.autoUpload = Boolean(render.autoUpload);
        if (render.introPreviewIncludeBgm !== undefined) next.renderDefaults.introPreviewIncludeBgm = Boolean(render.introPreviewIncludeBgm);
        if (render.mainPreviewIncludeBgm !== undefined) next.renderDefaults.mainPreviewIncludeBgm = Boolean(render.mainPreviewIncludeBgm);
        if (render.mainStartCard !== undefined) next.renderDefaults.mainStartCard = sanitizeMainStartCardOptions(render.mainStartCard);
      }
      if (update.youtubeUploadDefaults?.privacyStatus !== undefined) {
        if (!PRIVACY.has(update.youtubeUploadDefaults.privacyStatus)) throw new Error("YouTube 可見度設定無效。");
        next.youtubeUploadDefaults.privacyStatus = update.youtubeUploadDefaults.privacyStatus;
      }
      if (update.voiceInputLanguage !== undefined) {
        if (!VOICE_LANGUAGES.has(update.voiceInputLanguage)) throw new Error("語音輸入語言無效。");
        next.voiceInputLanguage = update.voiceInputLanguage;
      }
      if (update.subtitleBurnInDefaults !== undefined) {
        const sanitized = sanitizeSubtitleBurnInOptions(update.subtitleBurnInDefaults);
        if (sanitized.enabled && sanitized.tracks.length < 1) throw new Error("啟用字幕嵌入時至少需要選擇一種語言。");
        next.subtitleBurnInDefaults = sanitized;
      }
      if (update.subtitleGenerationScope !== undefined) {
        const sanitized = sanitizeSubtitleGenerationScope(update.subtitleGenerationScope);
        if (!update.subtitleGenerationScope.intro && !update.subtitleGenerationScope.main) throw new Error("片頭與正片至少需要選擇一項字幕範圍。");
        next.subtitleGenerationScope = sanitized;
      }
      if (update.subtitlePreviewStyle !== undefined) {
        next.subtitlePreviewStyle = sanitizeSubtitlePreviewStyle(update.subtitlePreviewStyle);
      }
      if (update.musicSuggestionDefaults?.includeTikTokTrending !== undefined) {
        next.musicSuggestionDefaults.includeTikTokTrending = Boolean(update.musicSuggestionDefaults.includeTikTokTrending);
      }
      if (update.musicSuggestionDefaults?.royaltyFreeOnly !== undefined) {
        next.musicSuggestionDefaults.royaltyFreeOnly = Boolean(update.musicSuggestionDefaults.royaltyFreeOnly);
      }
    });
    return this.snapshot();
  }

  private async mutate(mutator: (next: UserPreferences) => void): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const next = structuredClone(this.current);
      mutator(next);
      next.updatedAt = new Date().toISOString();
      this.current = next;
      await this.writeNow();
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async writeNow(): Promise<void> {
    const partial = `${this.settingsPath}.${process.pid}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(this.current, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await finalizePartialOutput(partial, this.settingsPath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
}
