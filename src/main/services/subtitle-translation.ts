import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtitleCue, SubtitleRenderLanguage, SubtitleTranslationProvider } from "../../shared/domain";
import { AiSettingsStore } from "./ai-settings";
import { finalizePartialOutput } from "./atomic-output";
import { OpenAiProvider } from "./openai-provider";
import { TranslationSettingsStore } from "./translation-settings";

type TargetLanguage = Exclude<SubtitleRenderLanguage, "zh-TW">;
type FetchLike = typeof fetch;

export interface SubtitleTranslationResult {
  byLanguage: Partial<Record<SubtitleRenderLanguage, string[]>>;
  providers: SubtitleTranslationProvider[];
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity] ?? entity,
  );
}

export class GoogleCloudTranslationProvider {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async translateTexts(
    texts: string[],
    targetLanguage: TargetLanguage,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await this.fetcher("https://translation.googleapis.com/language/translate/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify({ q: texts, source: "zh-TW", target: targetLanguage, format: "text" }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = String(((await response.json()) as { error?: { message?: unknown } }).error?.message ?? "")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 300);
      } catch {
        /* status is enough */
      }
      throw new Error(`Google Cloud Translation 請求失敗（HTTP ${response.status}）${detail ? `：${detail}` : "。"}`);
    }
    const body = (await response.json()) as { data?: { translations?: Array<{ translatedText?: unknown }> } };
    const translations = (body.data?.translations ?? []).map((item) =>
      typeof item.translatedText === "string" ? decodeEntities(item.translatedText).trim() : "",
    );
    if (translations.length !== texts.length || translations.some((item) => !item))
      throw new Error("Google Cloud Translation 沒有逐項傳回完整結果。");
    return translations;
  }
}

export class SubtitleTranslationService {
  private readonly version = "subtitle-translation-v1";
  constructor(
    private readonly cacheRoot: string,
    private readonly aiSettings: AiSettingsStore,
    private readonly translationSettings: TranslationSettingsStore,
    private readonly openAi = new OpenAiProvider(),
    private readonly google = new GoogleCloudTranslationProvider(),
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
  }

  async translate(
    cues: SubtitleCue[],
    languages: SubtitleRenderLanguage[],
    signal?: AbortSignal,
  ): Promise<SubtitleTranslationResult> {
    const texts = cues.map((cue) => cue.text.trim());
    if (!texts.length || texts.some((text) => !text)) throw new Error("字幕內容為空，無法翻譯。");
    const byLanguage: SubtitleTranslationResult["byLanguage"] = {};
    const providers = new Set<SubtitleTranslationProvider>();
    for (const language of languages) {
      if (signal?.aborted) throw new DOMException("字幕翻譯已取消。", "AbortError");
      if (language === "zh-TW") {
        byLanguage[language] = texts;
        providers.add("ORIGINAL");
        continue;
      }
      const cached = await this.readCache(texts, language);
      if (cached) {
        byLanguage[language] = cached.translations;
        providers.add(cached.provider);
        continue;
      }
      let translations: string[] | undefined;
      let openAiError = "";
      try {
        translations = await this.openAi.translateTexts(texts, language, this.aiSettings.getRuntimeAccount(), signal);
        providers.add("OPENAI");
        try {
          await this.writeCache(texts, language, translations, "OPENAI");
        } catch {
          /* derived cache failure must not discard a valid translation */
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        openAiError = error instanceof Error ? error.message : String(error);
      }
      if (!translations) {
        try {
          translations = await this.google.translateTexts(
            texts,
            language,
            this.translationSettings.getGoogleCloudApiKey(),
            signal,
          );
          providers.add("GOOGLE_CLOUD");
          try {
            await this.writeCache(texts, language, translations, "GOOGLE_CLOUD");
          } catch {
            /* derived cache is optional */
          }
        } catch (googleError) {
          if (googleError instanceof Error && googleError.name === "AbortError") throw googleError;
          const googleMessage = googleError instanceof Error ? googleError.message : String(googleError);
          throw new Error(`字幕翻譯失敗。OpenAI：${openAiError || "未設定或不可用"} Google 後援：${googleMessage}`);
        }
      }
      byLanguage[language] = translations;
    }
    return { byLanguage, providers: [...providers] };
  }

  async testGoogle(signal?: AbortSignal): Promise<void> {
    await this.google.translateTexts(["翻譯連線測試"], "en", this.translationSettings.getGoogleCloudApiKey(), signal);
  }

  private cachePath(texts: string[], language: TargetLanguage): string {
    const key = createHash("sha256")
      .update(JSON.stringify({ version: this.version, language, texts }))
      .digest("hex");
    return path.join(this.cacheRoot, `${key}.json`);
  }

  private async readCache(
    texts: string[],
    language: TargetLanguage,
  ): Promise<{ translations: string[]; provider: "OPENAI" | "GOOGLE_CLOUD" } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath(texts, language), "utf8")) as {
        version?: unknown;
        language?: unknown;
        translations?: unknown;
        provider?: unknown;
      };
      if (
        parsed.version !== this.version ||
        parsed.language !== language ||
        !Array.isArray(parsed.translations) ||
        parsed.translations.length !== texts.length ||
        !["OPENAI", "GOOGLE_CLOUD"].includes(String(parsed.provider))
      )
        return undefined;
      if (parsed.translations.some((item) => typeof item !== "string" || !item.trim())) return undefined;
      return { translations: parsed.translations as string[], provider: parsed.provider as "OPENAI" | "GOOGLE_CLOUD" };
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    texts: string[],
    language: TargetLanguage,
    translations: string[],
    provider: "OPENAI" | "GOOGLE_CLOUD",
  ): Promise<void> {
    const outputPath = this.cachePath(texts, language);
    const partial = `${outputPath}.${process.pid}.${randomUUID()}.partial`;
    await mkdir(path.dirname(outputPath), { recursive: true });
    try {
      await writeFile(
        partial,
        JSON.stringify({
          version: this.version,
          language,
          provider,
          translations,
          createdAt: new Date().toISOString(),
        }),
        { encoding: "utf8", flag: "wx" },
      );
      await finalizePartialOutput(partial, outputPath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
}
