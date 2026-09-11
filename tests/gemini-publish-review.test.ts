import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiPublishReviewProvider } from "../src/main/services/gemini-publish-review";
import type { AiPublishAssets } from "../src/shared/domain";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gemini publish review", () => {
  it("reviews ChatGPT output as an auxiliary pass and only selects supplied candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gemini-review-"));
    roots.push(root);
    const framePath = path.join(root, "frame.jpg");
    await writeFile(framePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const assets = {
      titles: [{ id: "ai-title-1", text: "森林散步", charCount: 4, reason: "主題" }],
      thumbnails: [
        {
          id: "thumbnail-1",
          assetId: "asset",
          sourceTimeMs: 1_000,
          sourceFileName: "forest.mp4",
          reason: "片頭",
          layout: "LEFT_TEXT",
          colorNote: "自然",
          style: {
            text: "森林",
            textXPercent: 28,
            textYPercent: 78,
            fontSizePx: 64,
            textColor: "#fff",
            outlineWidthPx: 3,
            overlayOpacityPercent: 24,
          },
        },
      ],
      description: "森林旅程",
      warnings: [],
    } as unknown as AiPublishAssets;
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
                        summary: "片頭畫面與標題一致。",
                        recommendedTitleId: "ai-title-1",
                        recommendedThumbnailId: "thumbnail-1",
                        warnings: [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await new GeminiPublishReviewProvider(fetcher as typeof fetch).review(
      assets,
      {
        topic: { topic: "森林", locations: [], storySummary: "", audiencePromise: "" },
        durationMs: 10_000,
        introSummary: [],
        timelineSummary: [],
        candidates: [
          {
            candidateId: "thumbnail-1",
            assetId: "asset",
            sourceTimeMs: 1_000,
            sourceFileName: "forest.mp4",
            framePath,
            origin: "INTRO",
          },
        ],
      },
      { model: "gemini-2.5-flash", apiKey: "test-key" },
    );
    expect(result).toMatchObject({
      status: "REVIEWED",
      recommendedTitleId: "ai-title-1",
      recommendedThumbnailId: "thumbnail-1",
    });
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(request.contents[0].parts[1].inlineData.mimeType).toBe("image/jpeg");
    expect(request.generationConfig.responseMimeType).toBe("application/json");
  });
});
