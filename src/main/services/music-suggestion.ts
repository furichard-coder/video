import { randomUUID } from "node:crypto";
import type { AiStoryContext, MusicSuggestion, MusicSuggestionRequest, MusicSuggestionResult } from "../../shared/domain";
import { AiSettingsStore } from "./ai-settings";
import { CodexCliStoryProvider } from "./codex-cli-provider";
import { OpenAiProvider, type MusicSuggestionCandidate } from "./openai-provider";
import { ProjectStore } from "./project-store";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"]);
const TIKTOK_HOSTS = new Set(["ads.tiktok.com", "www.tiktok.com", "m.tiktok.com"]);

function parsedAllowedUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    if (YOUTUBE_HOSTS.has(host)) {
      const valid = host === "youtu.be" ? url.pathname.length > 1 : url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
      return valid ? url : undefined;
    }
    if (TIKTOK_HOSTS.has(host)) {
      const valid = host === "ads.tiktok.com" ? url.pathname.toLowerCase().includes("creativecenter") : url.pathname.toLowerCase().includes("/music/");
      return valid ? url : undefined;
    }
  } catch { /* invalid URL */ }
  return undefined;
}

export function isAllowedMusicSuggestionUrl(raw: string): boolean {
  return Boolean(parsedAllowedUrl(raw));
}

function topicSummary(context: AiStoryContext): string {
  return [context.topic, context.locations.join("、"), context.storySummary, context.audiencePromise]
    .map((item) => item.trim()).filter(Boolean).join("｜").slice(0, 600);
}

function normalizeCandidates(candidates: MusicSuggestionCandidate[], includeTikTok: boolean, royaltyFreeOnly: boolean): { suggestions: MusicSuggestion[]; discarded: number } {
  const seen = new Set<string>();
  let discarded = 0;
  const suggestions = candidates.flatMap((candidate): MusicSuggestion[] => {
    const rightsEvidence = typeof candidate.rightsEvidence === "string" ? candidate.rightsEvidence.trim() : "";
    if ((!includeTikTok && candidate.platform === "TIKTOK") || (royaltyFreeOnly && !rightsEvidence) || !isAllowedMusicSuggestionUrl(candidate.auditionUrl) || !isAllowedMusicSuggestionUrl(candidate.evidenceUrl)) {
      discarded += 1; return [];
    }
    const auditionUrl = parsedAllowedUrl(candidate.auditionUrl)!.toString();
    const evidenceUrl = parsedAllowedUrl(candidate.evidenceUrl)!.toString();
    if (seen.has(auditionUrl)) { discarded += 1; return []; }
    seen.add(auditionUrl);
    return [{
      id: randomUUID(), platform: candidate.platform, title: candidate.title.trim(), artist: candidate.artist.trim() || undefined,
      reason: candidate.reason.trim(), auditionUrl, evidenceUrl,
      observedAt: candidate.observedAt.trim() || undefined, trendEvidence: candidate.trendEvidence.trim() || undefined, rightsEvidence: rightsEvidence || undefined,
      rightsStatus: "REVIEW_REQUIRED",
    }];
  });
  return { suggestions, discarded };
}

export class MusicSuggestionService {
  private readonly codex: CodexCliStoryProvider;

  constructor(
    private readonly store: ProjectStore,
    private readonly aiSettings: AiSettingsStore,
    private readonly openAi = new OpenAiProvider(),
    codex?: CodexCliStoryProvider,
    private readonly openExternal: (url: string) => Promise<void> = async () => undefined,
    cacheRoot = "",
  ) {
    this.codex = codex ?? new CodexCliStoryProvider(cacheRoot);
  }

  async generate(request: MusicSuggestionRequest, signal?: AbortSignal): Promise<MusicSuggestionResult> {
    if (!request || typeof request.includeTikTokTrending !== "boolean" || typeof request.royaltyFreeOnly !== "boolean") throw new Error("AI 配樂建議設定無效。");
    const context = this.store.getProject().aiStoryContext;
    const summary = topicSummary(context);
    if (!summary) throw new Error("請先在 AI 故事設定填寫影片主題、地點、故事摘要或觀眾承諾，再產生配樂建議。");
    const snapshot = this.aiSettings.getSnapshot();
    const profile = snapshot.accounts.find((account) => account.id === snapshot.activeAccountId);
    if (!profile) throw new Error("找不到作用中的 AI 帳號。");
    let raw: { suggestions: MusicSuggestionCandidate[]; warnings: string[] };
    let provider: MusicSuggestionResult["provider"] = "OPENAI_API";
    let accountName = profile.name;
    let openAiFailure = "";
    try {
      raw = await this.openAi.suggestMusic(context, request.includeTikTokTrending, request.royaltyFreeOnly, this.aiSettings.getRuntimeAccount(), signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      openAiFailure = error instanceof Error ? error.message : String(error);
      await this.codex.testConnection(signal);
      raw = await this.codex.suggestMusic(context, request.includeTikTokTrending, request.royaltyFreeOnly, profile.visionModel, signal);
      provider = "CODEX_CHATGPT";
      accountName = "Codex／ChatGPT 登入";
    }
    const normalized = normalizeCandidates(raw.suggestions, request.includeTikTokTrending, request.royaltyFreeOnly);
    const youtubeCount = normalized.suggestions.filter((item) => item.platform === "YOUTUBE").length;
    if (youtubeCount < 3) throw new Error("AI 沒有找到至少 3 個可核對的 YouTube 試聽連結；本次結果未保存，請稍後再試或補充更明確的影片主題。");
    const warnings = [
      ...(openAiFailure ? [`OpenAI API 未能完成，已改用 Codex／ChatGPT 登入：${openAiFailure}`] : []),
      ...raw.warnings,
      ...(normalized.discarded ? [`已排除 ${normalized.discarded} 筆不安全、重複或無法核對的連結。`] : []),
      ...(request.includeTikTokTrending && !normalized.suggestions.some((item) => item.platform === "TIKTOK") ? ["本次沒有找到可核對的 TikTok／抖音近期熱門項目；未以舊榜單冒充即時結果。"] : []),
      request.royaltyFreeOnly ? "本次已套用『只找有授權線索』條件；這仍不等於法律上的無版權，請逐首查看原始授權條款。" : "所有建議只供試聽與選曲；上傳、商用與影音同步授權須由使用者逐首確認。",
    ];
    return { provider, accountName, generatedAt: new Date().toISOString(), topicSummary: summary, royaltyFreeOnly: request.royaltyFreeOnly, suggestions: normalized.suggestions, warnings: [...new Set(warnings.filter(Boolean))] };
  }

  async open(url: string): Promise<void> {
    const allowed = parsedAllowedUrl(url);
    if (!allowed) throw new Error("試聽連結不是允許的 YouTube 或 TikTok 官方 HTTPS 網址，已阻擋開啟。");
    const error = await this.openExternal(allowed.toString()).then(() => "", (reason) => reason instanceof Error ? reason.message : String(reason));
    if (error) throw new Error(`無法開啟試聽連結：${error}`);
  }
}
