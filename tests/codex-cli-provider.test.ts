import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCliStoryProvider } from "../src/main/services/codex-cli-provider";

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(path.join(os.tmpdir(), "source-app-codex-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });

const context = { topic: "大雪山森林", locations: ["大雪山"], people: [], storySummary: "森林步道", audiencePromise: "了解森林養護", subtitleLanguage: "zh" };

describe("Codex ChatGPT login subtitle adapter", () => {
  it("checks that Codex is specifically logged in with ChatGPT", async () => {
    const runner = vi.fn(async () => ({ stdout: "Logged in using ChatGPT\n", stderr: "" }));
    const result = await new CodexCliStoryProvider(await root(), "C:\\Program Files\\Codex\\codex.exe", runner).testConnection();
    expect(result).toMatchObject({ providerLabel: "Codex／ChatGPT 登入", checks: expect.arrayContaining(["ChatGPT 登入可用"]) });
    expect(runner).toHaveBeenCalledWith("C:\\Program Files\\Codex\\codex.exe", ["login", "status"], expect.any(AbortSignal));
  });

  it("passes Chinese and spaced storyboard paths as argument-array items, uses stdin, and removes the temporary schema", async () => {
    const cacheRoot = await root();
    const framePath = path.join(cacheRoot, "大雪山 片段 01.jpg"); await writeFile(framePath, "frame");
    const agentText = JSON.stringify({ results: [{ index: 0, suggestedSubtitle: "林下植被有助涵養水分", visualSummary: "森林步道", eventSummary: "步行觀察", peopleSummary: [], locationSummary: ["大雪山"], animalSpecies: ["疑似山羌"], speciesExplanation: "森林底層常是山羌活動環境。", topicRelevanceScore: 92, transcriptVisualMatchScore: 70, confidence: 84, warnings: ["物種需人工確認"] }] });
    const runner = vi.fn(async (_executable, args: string[], _signal, options) => {
      expect(args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--image", framePath, "--json", "-"]));
      expect(options?.cwd).toBe(cacheRoot);
      expect(options?.input).toContain("大雪山森林");
      expect(options?.input).toContain("animalSpecies");
      expect(options?.input).not.toContain("sk-");
      return { stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: agentText } })}\n`, stderr: "" };
    });
    const provider = new CodexCliStoryProvider(cacheRoot, "C:\\Codex\\codex.exe", runner);
    const result = await provider.analyzeStoryFramesBatch([{ id: "candidate-1", framePath, request: { mode: "SUBTITLE", transcript: "", context, sourceFileName: "森林 01.MOV" } }], "gpt-5.6-sol");
    expect(result.get("candidate-1")).toMatchObject({ suggestedSubtitle: "林下植被有助涵養水分", animalSpecies: ["疑似山羌"], confidence: 84 });
    expect((await readdir(cacheRoot)).filter((name) => name.includes("codex-subtitle-schema"))).toEqual([]);
  });

  it("rejects missing, duplicate or incomplete structured results instead of silently saving them", async () => {
    const cacheRoot = await root(); const framePath = path.join(cacheRoot, "frame.jpg"); await writeFile(framePath, "frame");
    const runner = vi.fn(async () => ({ stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ results: [] }) } })}\n`, stderr: "" }));
    const provider = new CodexCliStoryProvider(cacheRoot, "C:\\Codex\\codex.exe", runner);
    await expect(provider.analyzeStoryFramesBatch([{ id: "candidate-1", framePath, request: { mode: "SUBTITLE", transcript: "", context, sourceFileName: "forest.mov" } }], "gpt-5.6-sol")).rejects.toThrow(/應回傳 1 筆/);
  });

  it("uses the signed-in Codex account in read-only mode for current music research", async () => {
    const cacheRoot = await root();
    const agentText = JSON.stringify({ suggestions: [
      { platform: "YOUTUBE", title: "Walk 1", artist: "A", reason: "城市步行", auditionUrl: "https://www.youtube.com/watch?v=abc123XY1", evidenceUrl: "https://www.youtube.com/watch?v=abc123XY1", rightsEvidence: "YouTube 音樂頁，需確認授權", observedAt: "2026-09-08", trendEvidence: "" },
      { platform: "YOUTUBE", title: "Walk 2", artist: "B", reason: "人物故事", auditionUrl: "https://www.youtube.com/watch?v=abc123XY2", evidenceUrl: "https://www.youtube.com/watch?v=abc123XY2", rightsEvidence: "Creative Commons 線索，需確認條款", observedAt: "2026-09-08", trendEvidence: "" },
      { platform: "YOUTUBE", title: "Walk 3", artist: "C", reason: "旅程節奏", auditionUrl: "https://www.youtube.com/watch?v=abc123XY3", evidenceUrl: "https://www.youtube.com/watch?v=abc123XY3", rightsEvidence: "作者授權說明，需確認條款", observedAt: "2026-09-08", trendEvidence: "" },
    ], warnings: ["逐首確認授權"] });
    const runner = vi.fn(async (_executable, args: string[], _signal, options) => {
      expect(args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--output-schema", expect.stringContaining("codex-music-schema"), "--json", "-"]));
      expect(options?.input).toContain("即時網路搜尋");
      expect(options?.input).toContain("TikTok／抖音近期熱門");
      return { stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: agentText } })}\n`, stderr: "" };
    });
    const provider = new CodexCliStoryProvider(cacheRoot, "C:\\Codex\\codex.exe", runner);
    const result = await provider.suggestMusic(context, true, false, "gpt-5.6-sol");
    expect(result.suggestions).toHaveLength(3);
    expect(result.warnings).toEqual(["逐首確認授權"]);
    expect((await readdir(cacheRoot)).filter((name) => name.includes("codex-music-schema"))).toEqual([]);
  });
});
