import type {
  SubtitleDensity,
  SubtitleVisionBatchResult,
  SubtitleVisionFrame,
  SubtitleVisionProvider,
} from "./subtitle-vision-orchestrator";

type FetchLike = typeof fetch;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 90_000;

const OPENAI_SUBTITLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    drafts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          frameId: { type: "string" },
          startMs: { type: "integer", minimum: 0 },
          endMs: { type: "integer", minimum: 1 },
          text: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          provenance: { type: "array", items: { type: "string", enum: ["VISIBLE", "PROJECT_CONTEXT"] } },
          warning: { type: "string" },
        },
        required: ["frameId", "startMs", "endMs", "text", "confidence", "provenance", "warning"],
      },
    },
  },
  required: ["drafts"],
} as const;

const GEMINI_SUBTITLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    drafts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          frameId: { type: "STRING" },
          startMs: { type: "INTEGER", minimum: 0 },
          endMs: { type: "INTEGER", minimum: 1 },
          text: { type: "STRING" },
          confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
          provenance: { type: "ARRAY", items: { type: "STRING", enum: ["VISIBLE", "PROJECT_CONTEXT"] } },
          warning: { type: "STRING" },
        },
        required: ["frameId", "startMs", "endMs", "text", "confidence", "provenance", "warning"],
      },
    },
  },
  required: ["drafts"],
};

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function imageDataUrl(value: string): { mimeType: string; base64: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/i.exec(value);
  if (!match) throw new Error("字幕影格圖片格式無效。");
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function contextForPrompt(frame: SubtitleVisionFrame): Record<string, unknown> {
  return {
    frameId: frame.id,
    timestampMs: frame.timestampMs,
    videoDurationMs: frame.videoDurationMs,
    segmentType: frame.segmentType,
    projectName: frame.context.projectName,
    title: frame.context.title,
    description: frame.context.description,
    chapter: frame.context.chapter,
    previousSubtitle: frame.context.previousSubtitle,
    neighborTimestampsMs: frame.context.neighborTimestampsMs,
  };
}

function prompt(frames: readonly SubtitleVisionFrame[], density: SubtitleDensity, language: string): string {
  return [
    `Output language: ${language}.`,
    "你是影片字幕編輯。逐張查看提供的影格，僅依畫面可見內容與明確標示的專案背景，提出繁體中文字幕草稿。",
    "每個 frameId 最多回傳一筆。frameId 必須完全照抄。startMs/endMs 是影片中的絕對毫秒時間，應涵蓋該影格所代表的可見事件且不得超過 videoDurationMs。不要把分析影格的 timestampMs 當成必然的字幕起點。",
    "不得猜測不可見的行動、人物身分、地點或聲音。若畫面不足以支持字幕，可以不為該影格回傳草稿。provenance 僅可用 VISIBLE 或 PROJECT_CONTEXT；只要使用專案背景就標記 PROJECT_CONTEXT。warning 無警告時回傳空字串。",
    "標題與說明僅是未核實的背景，不是畫面事實來源；若與畫面衝突，以畫面為準。未明確確認的地名、物種、海拔、年份一律使用中性描述，不得編造。",
    `字幕密度：${density}。控制字幕簡短易讀，不要逐字描述所有物件。`,
    "影格脈絡（JSON）：",
    JSON.stringify(frames.map(contextForPrompt)),
  ].join("\n\n");
}

function safeRequestId(value: string | null, apiKey: string): string | undefined {
  const cleaned = value?.trim().slice(0, 200);
  return cleaned && !cleaned.includes(apiKey) ? cleaned : undefined;
}

function parsedDrafts(value: unknown): SubtitleVisionBatchResult["drafts"] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { drafts?: unknown }).drafts))
    throw new Error("字幕視覺分析回傳格式無法解析。");
  return (value as { drafts: SubtitleVisionBatchResult["drafts"] }).drafts;
}

function assertKeyAbsent(value: unknown, apiKey: string): void {
  if (JSON.stringify(value).includes(apiKey)) throw new Error("字幕視覺分析回傳格式無法解析。");
}

function outputText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const payload = response as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
  };
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output ?? [])
    for (const content of item.content ?? [])
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
  return "";
}

export type SubtitleVisionRequestFailure = "MODEL_UNAVAILABLE" | "CAPABILITY_UNSUPPORTED" | "RATE_LIMITED" | "OTHER";

export class SubtitleVisionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly failure: SubtitleVisionRequestFailure,
    provider: "OpenAI" | "Gemini",
  ) {
    super(`${provider} 字幕視覺分析失敗（HTTP ${status}${code ? `，代碼 ${code}` : ""}）。`);
    this.name = "SubtitleVisionRequestError";
  }
}

async function jsonResponse(response: Response, provider: "OpenAI" | "Gemini"): Promise<unknown> {
  if (!response.ok) {
    let code: string | undefined;
    let detail = "";
    try {
      const body = (await response.clone().json()) as {
        error?: { code?: unknown; status?: unknown; message?: unknown };
      };
      const rawCode = body.error?.code ?? body.error?.status;
      if (typeof rawCode === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawCode)) code = rawCode;
      if (typeof body.error?.message === "string") detail = body.error.message;
    } catch {
      /* only the status is needed when no safe machine code is available */
    }
    const normalizedCode = code?.toLowerCase();
    const failure: SubtitleVisionRequestFailure =
      response.status === 404 || normalizedCode === "model_not_found"
        ? "MODEL_UNAVAILABLE"
        : response.status === 429 && normalizedCode === "rate_limit_exceeded"
          ? "RATE_LIMITED"
          : (response.status === 400 || response.status === 422) &&
              /(image|vision|structured output|json schema|response_format|schema)/i.test(detail)
            ? "CAPABILITY_UNSUPPORTED"
            : "OTHER";
    throw new SubtitleVisionRequestError(response.status, code, failure, provider);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${provider} 字幕視覺分析回傳格式無法解析。`);
  }
}

export class OpenAiSubtitleVisionProvider implements SubtitleVisionProvider {
  readonly kind = "OPENAI" as const;
  get version() {
    return `responses-subtitle-vision-v2:${this.model}`;
  }

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    if (!model.trim() || !apiKey.trim()) throw new Error("OpenAI 字幕視覺 Provider 設定不完整。");
  }

  async analyzeBatch(
    frames: readonly SubtitleVisionFrame[],
    options: { language: import("./subtitle-vision-orchestrator").SubtitleVisionLanguage; density: SubtitleDensity },
    signal?: AbortSignal,
  ): Promise<SubtitleVisionBatchResult> {
    if (!frames.length) return { drafts: [] };
    try {
      const content: Array<Record<string, unknown>> = [
        { type: "input_text", text: prompt(frames, options.density, options.language) },
      ];
      for (const frame of frames) {
        const image = imageDataUrl(frame.imageDataUrl);
        content.push({
          type: "input_image",
          image_url: `data:${image.mimeType};base64,${image.base64}`,
          detail: "low",
        });
      }
      const response = await this.fetcher(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          store: false,
          input: [{ role: "user", content }],
          text: {
            format: {
              type: "json_schema",
              name: "timed_subtitle_drafts",
              strict: true,
              schema: OPENAI_SUBTITLE_SCHEMA,
            },
          },
        }),
        signal: timeoutSignal(signal),
      });
      const payload = await jsonResponse(response, "OpenAI");
      const text = outputText(payload);
      if (!text) throw new Error("OpenAI 字幕視覺分析未傳回可讀結果。");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("OpenAI 字幕視覺分析回傳格式無法解析。");
      }
      assertKeyAbsent(parsed, this.apiKey);
      const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
      return {
        drafts: parsedDrafts(parsed),
        inputTokens: Number(usage?.input_tokens) || 0,
        outputTokens: Number(usage?.output_tokens) || 0,
        requestId: safeRequestId(response.headers.get("x-request-id"), this.apiKey),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw new DOMException("字幕視覺分析已取消。", "AbortError");
      if (error instanceof Error && !error.message.includes(this.apiKey)) throw error;
      throw new Error("OpenAI 字幕視覺分析失敗；請檢查連線與 API 設定。");
    }
  }
}

export class GeminiSubtitleVisionProvider implements SubtitleVisionProvider {
  readonly kind = "GEMINI" as const;
  get version() {
    return `generate-content-subtitle-vision-v2:${this.model}`;
  }

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    if (!model.trim() || !apiKey.trim()) throw new Error("Gemini 字幕視覺 Provider 設定不完整。");
  }

  async analyzeBatch(
    frames: readonly SubtitleVisionFrame[],
    options: { language: import("./subtitle-vision-orchestrator").SubtitleVisionLanguage; density: SubtitleDensity },
    signal?: AbortSignal,
  ): Promise<SubtitleVisionBatchResult> {
    if (!frames.length) return { drafts: [] };
    try {
      const parts: Array<Record<string, unknown>> = [{ text: prompt(frames, options.density, options.language) }];
      for (const frame of frames) {
        const image = imageDataUrl(frame.imageDataUrl);
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
      }
      const response = await this.fetcher(`${GEMINI_BASE_URL}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: GEMINI_SUBTITLE_SCHEMA,
          },
        }),
        signal: timeoutSignal(signal),
      });
      const payload = (await jsonResponse(response, "Gemini")) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
        usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
      };
      const text = payload.candidates?.[0]?.content?.parts
        ?.map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (!text) throw new Error("Gemini 字幕視覺分析未傳回可讀結果。");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Gemini 字幕視覺分析回傳格式無法解析。");
      }
      assertKeyAbsent(parsed, this.apiKey);
      return {
        drafts: parsedDrafts(parsed),
        inputTokens: Number(payload.usageMetadata?.promptTokenCount) || 0,
        outputTokens: Number(payload.usageMetadata?.candidatesTokenCount) || 0,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw new DOMException("字幕視覺分析已取消。", "AbortError");
      if (error instanceof Error && !error.message.includes(this.apiKey)) throw error;
      throw new Error("Gemini 字幕視覺分析失敗；請檢查連線與 API 設定。");
    }
  }
}
