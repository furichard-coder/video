import { readFile } from "node:fs/promises";
import type { AiStoryContext } from "../../shared/domain";
import type { StoryFrameAnalysis } from "./openai-provider";

type FetchLike = typeof fetch;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => item.trim())
        .slice(0, 20)
    : [];
}

function score(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0;
}

export class GeminiMaterialAnalysisProvider {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async analyze(
    framePath: string,
    input: { sourceFileName: string; context: AiStoryContext; transcript?: string },
    settings: { model: string; apiKey: string },
    signal?: AbortSignal,
  ): Promise<StoryFrameAnalysis> {
    const prompt = [
      "你是旅遊與自然紀錄影片的圖片辨識及繁體中文字幕編輯。請實際查看附圖，辨識畫面中可見的物種、物品、場景與可由證據支持的地點線索，再簡化成一段適合畫面的短字幕。",
      "物種名稱要使用常見繁體中文名；若無法確認到種，改用較安全的科、類群或『疑似』，不得因專案主題或檔名猜測。沒有動物就把 animalSpecies 留空。植物、菇菌或其他自然物可寫入 visualSummary 與 suggestedSubtitle。",
      "suggestedSubtitle 應自然、具體、簡短，通常不超過 36 個中文字；不要只回報分析流程，也不要加入看不見的故事。地點無法由畫面與已知背景共同支持時，使用一般場景描述並放入 warnings。",
      JSON.stringify({
        sourceFileName: input.sourceFileName,
        topic: input.context.topic,
        storySummary: input.context.storySummary,
        knownLocations: input.context.locations,
        knownPeople: input.context.people,
        transcriptOrNote: input.transcript || "無",
      }),
      "請嚴格依指定 JSON schema 回傳。",
    ].join("\n\n");
    const image = (await readFile(framePath)).toString("base64");
    const response = await this.fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: image } }] },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                suggestedSubtitle: { type: "STRING" },
                visualSummary: { type: "STRING" },
                eventSummary: { type: "STRING" },
                peopleSummary: { type: "ARRAY", items: { type: "STRING" } },
                locationSummary: { type: "ARRAY", items: { type: "STRING" } },
                animalSpecies: { type: "ARRAY", items: { type: "STRING" } },
                speciesExplanation: { type: "STRING" },
                topicRelevanceScore: { type: "INTEGER", minimum: 0, maximum: 100 },
                transcriptVisualMatchScore: { type: "INTEGER", minimum: 0, maximum: 100 },
                confidence: { type: "INTEGER", minimum: 0, maximum: 100 },
                warnings: { type: "ARRAY", items: { type: "STRING" } },
              },
              required: [
                "suggestedSubtitle",
                "visualSummary",
                "eventSummary",
                "peopleSummary",
                "locationSummary",
                "animalSpecies",
                "speciesExplanation",
                "topicRelevanceScore",
                "transcriptVisualMatchScore",
                "confidence",
                "warnings",
              ],
            },
          },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      },
    );
    if (!response.ok) throw new Error(`Gemini 圖片／物種分析失敗（HTTP ${response.status}）。`);
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!text) throw new Error("Gemini 圖片／物種分析未傳回可讀結果。");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Gemini 圖片／物種分析格式無法解析。");
    }
    return {
      suggestedSubtitle:
        typeof parsed.suggestedSubtitle === "string" ? parsed.suggestedSubtitle.trim().slice(0, 160) : "",
      visualSummary: typeof parsed.visualSummary === "string" ? parsed.visualSummary.trim().slice(0, 1_000) : "",
      eventSummary: typeof parsed.eventSummary === "string" ? parsed.eventSummary.trim().slice(0, 1_000) : "",
      peopleSummary: strings(parsed.peopleSummary),
      locationSummary: strings(parsed.locationSummary),
      animalSpecies: strings(parsed.animalSpecies),
      speciesExplanation:
        typeof parsed.speciesExplanation === "string" ? parsed.speciesExplanation.trim().slice(0, 1_000) : "",
      topicRelevanceScore: score(parsed.topicRelevanceScore),
      transcriptVisualMatchScore: score(parsed.transcriptVisualMatchScore),
      confidence: score(parsed.confidence),
      warnings: strings(parsed.warnings),
    };
  }
}
