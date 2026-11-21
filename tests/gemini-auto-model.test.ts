import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiPublishAssets, AiStoryContext } from "../src/shared/domain";
import type { PublishGenerationInput } from "../src/main/services/publish-generation";
import { GeminiMaterialAnalysisProvider } from "../src/main/services/gemini-material-analysis";
import { GeminiPublishReviewProvider } from "../src/main/services/gemini-publish-review";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemini-auto-model-"));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const context: AiStoryContext = {
  topic: "Taipei walk",
  locations: [],
  people: [],
  storySummary: "A walk",
  audiencePromise: "City scenery",
  subtitleLanguage: "zh-TW",
};

describe("Gemini Auto model resolution", () => {
  it("probes Auto once, then uses the verified actual model for both Gemini features", async () => {
    const root = await tempRoot();
    const framePath = path.join(root, "frame.jpg");
    await writeFile(framePath, Buffer.from([1, 2, 3]));
    const calls: Array<{ url: string; body?: Record<string, any> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : undefined;
      calls.push({ url, body });
      if (url.includes("/v1beta/models?") || url.endsWith("/v1beta/models"))
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-3.1-pro",
                baseModelId: "gemini-3.1-pro",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
          { status: 200 },
        );
      if (
        body?.contents?.[0]?.parts?.some(
          (part: Record<string, unknown>) => typeof part.text === "string" && part.text.includes("tiny test image"),
        )
      )
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), {
          status: 200,
        });
      if (url.includes(encodeURIComponent("gemini-3.1-pro"))) {
        if (body?.contents?.[0]?.parts?.[0]?.text?.includes("第二位審稿者"))
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          summary: "Looks clear.",
                          recommendedTitleId: "title-1",
                          recommendedThumbnailId: "thumb-1",
                          warnings: [],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestedSubtitle: "街道上散步",
                        visualSummary: "A person walking",
                        eventSummary: "Walking",
                        peopleSummary: [],
                        locationSummary: [],
                        animalSpecies: [],
                        speciesExplanation: "",
                        topicRelevanceScore: 80,
                        transcriptVisualMatchScore: 80,
                        confidence: 80,
                        warnings: [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("unexpected model URL", { status: 400 });
    });

    const material = new GeminiMaterialAnalysisProvider(fetcher as typeof fetch, root);
    const storyResult = await material.analyze(
      framePath,
      { sourceFileName: "frame.jpg", context },
      { model: "auto", apiKey: "gemini-test-key-which-is-secret" },
    );
    expect(storyResult.suggestedSubtitle).toBe("街道上散步");
    const publish = new GeminiPublishReviewProvider(fetcher as typeof fetch, root);
    const assets = {
      titles: [{ id: "title-1", text: "City walk", reason: "Relevant" }],
      thumbnails: [
        { id: "thumb-1", sourceFileName: "frame.jpg", sourceTimeMs: 1000, reason: "Clear", style: { text: "Taipei" } },
      ],
      description: "A city walk.",
    } as AiPublishAssets;
    const input = { topic: "Taipei", candidates: [{ framePath }] } as unknown as PublishGenerationInput;
    const review = await publish.review(assets, input, { model: "auto", apiKey: "gemini-test-key-which-is-secret" });
    expect(review.model).toBe("gemini-3.1-pro");
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toContain("/models?");
    expect(calls[1].url).toContain("gemini-3.1-pro:generateContent");
    expect(calls[1].body?.generationConfig.responseSchema.properties.ok).toBeDefined();
    expect(calls[1].body?.contents[0].parts.some((part: Record<string, unknown>) => part.inlineData)).toBe(true);
    expect(calls[2].url).toContain("gemini-3.1-pro:generateContent");
    expect(calls[3].url).toContain("gemini-3.1-pro:generateContent");
  });

  it("keeps a manually selected Gemini model unchanged without refreshing the catalog", async () => {
    const root = await tempRoot();
    const framePath = path.join(root, "frame.jpg");
    await writeFile(framePath, Buffer.from([1, 2, 3]));
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        suggestedSubtitle: "Manual model",
                        visualSummary: "",
                        eventSummary: "",
                        peopleSummary: [],
                        locationSummary: [],
                        animalSpecies: [],
                        speciesExplanation: "",
                        topicRelevanceScore: 1,
                        transcriptVisualMatchScore: 1,
                        confidence: 1,
                        warnings: [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiMaterialAnalysisProvider(fetcher as typeof fetch, root);
    const result = await provider.analyze(
      framePath,
      { sourceFileName: "frame.jpg", context },
      { model: "gemini-2.5-flash", apiKey: "gemini-manual-key" },
    );
    expect(result.suggestedSubtitle).toBe("Manual model");
    expect(String(fetcher.mock.calls[0][0])).toContain("gemini-2.5-flash:generateContent");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
