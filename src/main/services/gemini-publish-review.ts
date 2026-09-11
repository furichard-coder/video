import { readFile } from "node:fs/promises";
import type { AiPublishAssets, GeminiPublishReview } from "../../shared/domain";
import type { PublishGenerationInput } from "./publish-generation";

type FetchLike = typeof fetch;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim())
        .slice(0, 12)
    : [];
}

export class GeminiPublishReviewProvider {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async review(
    assets: AiPublishAssets,
    input: PublishGenerationInput,
    settings: { model: string; apiKey: string },
    signal?: AbortSignal,
  ): Promise<GeminiPublishReview> {
    const titleIds = assets.titles.map((item) => item.id);
    const thumbnailIds = assets.thumbnails.map((item) => item.id);
    const prompt = [
      "你是 YouTube 旅遊影片發布素材的第二位審稿者。ChatGPT 已完成主要標題、縮圖與說明草稿；你只能復核、指出風險與選出較好的候選，不可捏造畫面、人物、物種或地點，也不可宣稱已發布。",
      "標題必須在 100 個 YouTube 字元內，可含英文與 hashtag，但不要標題黨。縮圖只可從附圖候選中選擇；片頭畫面優先，但必須符合主題與實際內容。",
      `主題：${JSON.stringify(input.topic)}`,
      `ChatGPT 標題：${JSON.stringify(assets.titles.map(({ id, text, reason }) => ({ id, text, reason })))}`,
      `ChatGPT 縮圖：${JSON.stringify(assets.thumbnails.map(({ id, sourceFileName, sourceTimeMs, reason, style }) => ({ id, sourceFileName, sourceTimeMs, reason, overlayText: style.text })))}`,
      `說明摘要：${assets.description.slice(0, 1800)}`,
      "請用繁體中文回傳 JSON。summary 要說明整體觀感與最重要的一項改善；recommendedTitleId、recommendedThumbnailId 只能使用提供的 ID；warnings 為需人工確認的風險。",
    ].join("\n\n");
    const imageParts = await Promise.all(
      input.candidates
        .slice(0, 3)
        .map(async (candidate) => ({
          inlineData: { mimeType: "image/jpeg", data: (await readFile(candidate.framePath)).toString("base64") },
        })),
    );
    const response = await this.fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                summary: { type: "STRING" },
                recommendedTitleId: { type: "STRING" },
                recommendedThumbnailId: { type: "STRING" },
                warnings: { type: "ARRAY", items: { type: "STRING" } },
              },
              required: ["summary", "recommendedTitleId", "recommendedThumbnailId", "warnings"],
            },
          },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      },
    );
    if (!response.ok) throw new Error(`Gemini 輔助復核失敗（HTTP ${response.status}）。`);
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!text) throw new Error("Gemini 輔助復核未傳回可讀結果。");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Gemini 輔助復核格式無法解析。");
    }
    const recommendedTitleId = titleIds.includes(String(parsed.recommendedTitleId))
      ? String(parsed.recommendedTitleId)
      : undefined;
    const recommendedThumbnailId = thumbnailIds.includes(String(parsed.recommendedThumbnailId))
      ? String(parsed.recommendedThumbnailId)
      : undefined;
    return {
      enabled: true,
      status: "REVIEWED",
      model: settings.model,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 1_000) : "Gemini 已完成第二次復核。",
      recommendedTitleId,
      recommendedThumbnailId,
      warnings: strings(parsed.warnings),
      reviewedAt: new Date().toISOString(),
    };
  }
}
