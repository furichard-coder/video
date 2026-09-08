import { describe, expect, it, vi } from "vitest";
import type { AiAccountProfile, AiStoryContext } from "../src/shared/domain";
import { MusicSuggestionService, isAllowedMusicSuggestionUrl } from "../src/main/services/music-suggestion";
import type { AiSettingsStore } from "../src/main/services/ai-settings";
import type { CodexCliStoryProvider } from "../src/main/services/codex-cli-provider";
import type { OpenAiProvider } from "../src/main/services/openai-provider";
import type { ProjectStore } from "../src/main/services/project-store";

const context: AiStoryContext = { topic: "河內旅行", locations: ["河內"], people: ["主持人"], storySummary: "步行探索城市", audiencePromise: "看見人物與城市故事", subtitleLanguage: "zh" };
const account: AiAccountProfile & { apiKey: string } = { id: "openai-default", name: "OpenAI 測試", provider: "OPENAI", visionModel: "gpt-5.6-terra", transcriptionModel: "gpt-4o-transcribe-diarize", credentialStatus: "SAVED_ENCRYPTED", updatedAt: "2026-09-08T00:00:00.000Z", apiKey: "sk-test" };
const candidates = [1, 2, 3].map((index) => ({ platform: "YOUTUBE" as const, title: `曲目 ${index}`, artist: "作者", reason: "適合城市步行", auditionUrl: `https://www.youtube.com/watch?v=abc123XY${index}`, evidenceUrl: `https://www.youtube.com/watch?v=abc123XY${index}`, rightsEvidence: "YouTube Audio Library／授權頁線索，需確認條款", observedAt: "2026-09-08", trendEvidence: "" }));

function dependencies(openAiResult: "OK" | "FAIL" = "OK") {
  const store = { getProject: () => ({ aiStoryContext: context }) } as unknown as ProjectStore;
  const aiSettings = { getSnapshot: () => ({ activeAccountId: account.id, accounts: [account] }), getRuntimeAccount: () => account } as unknown as AiSettingsStore;
  const openAi = { suggestMusic: vi.fn(async () => {
    if (openAiResult === "FAIL") throw new Error("credit_balance_exhausted");
    return { suggestions: [...candidates, { platform: "TIKTOK" as const, title: "熱門曲", artist: "", reason: "近期旅遊熱門", auditionUrl: "https://ads.tiktok.com/business/creativecenter/song/sample/pc/en", evidenceUrl: "https://ads.tiktok.com/business/creativecenter/song/sample/pc/en", rightsEvidence: "", observedAt: "2026-09-08", trendEvidence: "近 7 日榜單" }], warnings: [] };
  }) } as unknown as OpenAiProvider;
  const codex = { testConnection: vi.fn(async () => undefined), suggestMusic: vi.fn(async () => ({ suggestions: candidates, warnings: [] })) } as unknown as CodexCliStoryProvider;
  const openExternal = vi.fn(async () => undefined);
  return { store, aiSettings, openAi, codex, openExternal };
}

describe("music suggestion service", () => {
  it("keeps only requested official audition links and labels every result for rights review", async () => {
    const d = dependencies(); const service = new MusicSuggestionService(d.store, d.aiSettings, d.openAi, d.codex, d.openExternal, "C:\\cache");
    const result = await service.generate({ includeTikTokTrending: true, royaltyFreeOnly: false });
    expect(result.provider).toBe("OPENAI_API");
    expect(result.suggestions).toHaveLength(4);
    expect(result.suggestions.every((item) => item.rightsStatus === "REVIEW_REQUIRED")).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/只供試聽.*授權/);
  });

  it("falls back to the signed-in Codex account when the API project has no credit", async () => {
    const d = dependencies("FAIL"); const service = new MusicSuggestionService(d.store, d.aiSettings, d.openAi, d.codex, d.openExternal, "C:\\cache");
    const result = await service.generate({ includeTikTokTrending: false, royaltyFreeOnly: false });
    expect(result.provider).toBe("CODEX_CHATGPT");
    expect(result.accountName).toMatch(/Codex／ChatGPT/);
    expect(d.codex.testConnection).toHaveBeenCalledOnce();
    expect(result.warnings.join(" ")).toContain("credit_balance_exhausted");
  });

  it("filters out candidates without rights evidence when royalty-free search is enabled", async () => {
    const d = dependencies();
    vi.mocked(d.openAi.suggestMusic).mockResolvedValue({ suggestions: [...candidates, { ...candidates[0], title: "未標示授權曲", rightsEvidence: "" }], warnings: [] });
    const service = new MusicSuggestionService(d.store, d.aiSettings, d.openAi, d.codex, d.openExternal, "C:\\cache");
    const result = await service.generate({ includeTikTokTrending: false, royaltyFreeOnly: true });
    expect(result.royaltyFreeOnly).toBe(true);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions.some((item) => item.title === "未標示授權曲")).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/授權線索/);
  });

  it("blocks shell-like and non-official URLs before opening", async () => {
    const d = dependencies(); const service = new MusicSuggestionService(d.store, d.aiSettings, d.openAi, d.codex, d.openExternal, "C:\\cache");
    expect(isAllowedMusicSuggestionUrl("https://www.youtube.com/watch?v=abc123XYZ")).toBe(true);
    expect(isAllowedMusicSuggestionUrl("https://ads.tiktok.com/business/creativecenter/song/sample/pc/en")).toBe(true);
    expect(isAllowedMusicSuggestionUrl("file:///C:/Windows/System32/cmd.exe")).toBe(false);
    expect(isAllowedMusicSuggestionUrl("https://evil.example/?next=youtube.com")).toBe(false);
    await expect(service.open("https://evil.example/?next=youtube.com")).rejects.toThrow(/已阻擋/);
    await service.open("https://youtu.be/abc123XYZ");
    expect(d.openExternal).toHaveBeenCalledWith("https://youtu.be/abc123XYZ");
  });
});
