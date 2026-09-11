import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiMaterialAnalysisProvider } from "../src/main/services/gemini-material-analysis";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Gemini material image analysis", () => {
  it("sends one derived image and normalizes species plus a simplified subtitle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gemini-material-")); roots.push(root);
    const frame = path.join(root, "frame.jpg"); await writeFile(frame, Buffer.from([1, 2, 3, 4]));
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ inlineData?: { data: string } }> }> };
      expect(body.contents[0].parts[1].inlineData?.data).toBe((await readFile(frame)).toString("base64"));
      expect(String(init?.headers)).not.toContain("secret-test-key");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ suggestedSubtitle: "林間可見一隻臺灣山羌", visualSummary: "森林中的小型鹿科動物", eventSummary: "山羌站在林下", peopleSummary: [], locationSummary: ["森林"], animalSpecies: ["臺灣山羌"], speciesExplanation: "常活動於森林底層。", topicRelevanceScore: 95, transcriptVisualMatchScore: 80, confidence: 88, warnings: [] }) }] } }] }), { status: 200 });
    });
    const provider = new GeminiMaterialAnalysisProvider(fetcher as typeof fetch);
    const result = await provider.analyze(frame, { sourceFileName: "IMG_001.jpg", context: { topic: "森林步道", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh" } }, { model: "gemini-2.5-flash", apiKey: "secret-test-key-that-is-long-enough" });
    expect(result).toMatchObject({ suggestedSubtitle: "林間可見一隻臺灣山羌", animalSpecies: ["臺灣山羌"], confidence: 88 });
  });
});
