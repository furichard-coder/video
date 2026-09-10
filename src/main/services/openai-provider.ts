import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AiAccountProfile, AiStoryContext, SubtitleRenderLanguage } from "../../shared/domain";
import { PUBLISH_JSON_SCHEMA, normalizePublishResponse, type PublishGenerationInput, type PublishGeneratedDraft } from "./publish-generation";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface TranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
}

export interface StoryFrameAnalysis {
  suggestedSubtitle: string;
  visualSummary: string;
  eventSummary: string;
  peopleSummary: string[];
  locationSummary: string[];
  animalSpecies?: string[];
  speciesExplanation?: string;
  topicRelevanceScore: number;
  transcriptVisualMatchScore: number;
  confidence: number;
  warnings: string[];
}

export interface StoryFrameRequest {
  mode: "SUBTITLE" | "INTRO";
  transcript: string;
  frames: string[];
  context: AiStoryContext;
  sourceFileName: string;
}

export interface OpenAiConnectionDiagnostic {
  checks: string[];
  requestIds: string[];
  providerLabel?: "OPENAI_API" | "CODEX_CHATGPT";
}

export interface MusicSuggestionCandidate {
  platform: "YOUTUBE" | "TIKTOK";
  title: string;
  artist: string;
  reason: string;
  auditionUrl: string;
  evidenceUrl: string;
  observedAt: string;
  trendEvidence: string;
  rightsEvidence: string;
}

type FetchLike = typeof fetch;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(90_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseError(response: Response): Promise<Error> {
  let detail = "";
  let code = "";
  let type = "";
  try {
    const body = await response.json() as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    if (typeof body.error?.message === "string") detail = body.error.message;
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.type === "string") type = body.error.type;
  } catch { /* keep status fallback */ }
  const requestId = response.headers.get("x-request-id")?.trim();
  const retryAfter = response.headers.get("retry-after")?.trim();
  const requestReset = response.headers.get("x-ratelimit-reset-requests")?.trim();
  const tokenReset = response.headers.get("x-ratelimit-reset-tokens")?.trim();
  const reference = [code || type ? `代碼 ${code || type}` : "", requestId ? `Request ID ${requestId}` : ""].filter(Boolean).join("；");
  const suffix = reference ? `（${reference}）` : "";
  if (response.status === 401) return new Error(`OpenAI API Key 無效、已撤銷，或不屬於可用的 API 專案，請到 AI 帳號設定重新輸入。${suffix}`);
  if (response.status === 403) return new Error(`這把 OpenAI API Key 沒有執行所選模型／端點的權限，請檢查 API project 權限。${suffix}`);
  if (response.status === 404) return new Error(`OpenAI API 找不到所選模型，或這個 API project 無法使用它。請檢查模型名稱與專案權限。${suffix}`);
  if (response.status === 429) {
    const quotaText = `${code} ${type} ${detail}`.toLowerCase();
    const quotaFailure = /(insufficient_quota|credit_balance|billing|spend_limit|usage_limit|quota)/.test(quotaText);
    if (quotaFailure) {
      return new Error(`這把 Key 所屬的 OpenAI API project 沒有可用 API 額度，或已達用量／支出上限。Codex／ChatGPT 顯示的 token 與 API 帳務是分開的，不會自動供這個 App 使用。請到 OpenAI API 平台檢查 Billing、Limits 與 Key 所屬 project。${suffix}`);
    }
    const retry = [retryAfter ? `建議 ${retryAfter} 秒後重試` : "", requestReset ? `requests 重設 ${requestReset}` : "", tokenReset ? `tokens 重設 ${tokenReset}` : ""].filter(Boolean).join("；");
    return new Error(`OpenAI API 暫時超過每分鐘的請求或 token 速率限制，請稍後重試。${retry ? ` ${retry}。` : ""}${suffix}`);
  }
  const safeDetail = detail.replace(/[\r\n]+/g, " ").slice(0, 360);
  return new Error(`OpenAI API 請求失敗（HTTP ${response.status}）${safeDetail ? `：${safeDetail}` : "。"}${suffix}`);
}

function audioMimeType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".wav": return "audio/wav";
    case ".webm": return "audio/webm";
    case ".ogg": return "audio/ogg";
    case ".m4a": return "audio/mp4";
    case ".mp4": return "audio/mp4";
    default: return "audio/mpeg";
  }
}

function diagnosticWav(): Uint8Array {
  const sampleRate = 16_000;
  const seconds = 2;
  const sampleCount = sampleRate * seconds;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 120), 44 + index * 2);
  }
  return buffer;
}

function score(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 12) : [];
}

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const response = value as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }> };
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) if (content.type === "output_text" && typeof content.text === "string") return content.text;
  }
  return "";
}

export class OpenAiProvider {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async generatePublishAssets(input: PublishGenerationInput, account: AiAccountProfile & { apiKey: string }, signal?: AbortSignal): Promise<{ draft: PublishGeneratedDraft; model: string; requestId?: string }> {
    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: ["為旅遊 YouTube 影片產生發布素材。先理解主題、故事與正片內容，再優先判讀已選片頭的實際候選畫面，讓標題與縮圖呈現影片開場承諾。只能依提供的資料與低解析影格；不得猜測人物身分或未提供的地點。", JSON.stringify({ topic: input.topic, durationMs: input.durationMs, intro: input.introSummary, timeline: input.timelineSummary, candidates: input.candidates.map(({ framePath: _framePath, ...candidate }) => candidate) }), "標題須延伸影片內容與片頭畫面，嚴格依 JSON schema 回傳 3–5 個標題、說明、hashtags、3 個可追溯縮圖概念與合法章節。縮圖概念應優先選用 origin=INTRO 的候選，除非該畫面明顯不適合。", "品質要求：標題彼此角度要有明顯差異、避免制式空話，必須具體呼應可見主體或片頭情境，總長不超過 100 字；可自然加入一個英文關鍵片語或 hashtag，但不可堆砌。縮圖顯示文字應精簡、通常不超過 12 個中文字，與標題互補而非重複，並依候選畫面的主體位置選擇左右版面、避免遮住重要景物。說明與章節只能使用有來源依據的資訊。"].join("\n\n") }];
    for (const candidate of input.candidates) {
      const bytes = await readFile(candidate.framePath);
      content.push({ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" });
    }
    const response = await this.fetcher(`${OPENAI_BASE_URL}/responses`, { method: "POST", headers: { Authorization: `Bearer ${account.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: account.visionModel, store: false, input: [{ role: "user", content }], text: { format: { type: "json_schema", name: "youtube_publish_assets", strict: true, schema: PUBLISH_JSON_SCHEMA } } }), signal: requestSignal(signal) });
    if (!response.ok) throw await responseError(response);
    const body = await response.json(); const resultText = outputText(body); let parsed: unknown;
    try { parsed = JSON.parse(resultText); } catch { throw new Error("OpenAI 發布素材回傳不是有效 JSON。" ); }
    return { draft: normalizePublishResponse(parsed, input), model: account.visionModel, requestId: response.headers.get("x-request-id") ?? undefined };
  }

  async testStoryConnection(account: AiAccountProfile & { apiKey: string }, signal?: AbortSignal): Promise<OpenAiConnectionDiagnostic> {
    const requestIds: string[] = [];
    const response = await this.fetcher(`${OPENAI_BASE_URL}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${account.apiKey}` },
      signal: requestSignal(signal),
    });
    if (!response.ok) throw new Error(`API Key／project 驗證失敗：${(await responseError(response)).message}`);
    const modelsBody = await response.json() as { data?: Array<{ id?: unknown }> };
    const modelIds = new Set((modelsBody.data ?? []).map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean));
    const authenticationRequestId = response.headers.get("x-request-id");
    if (authenticationRequestId) requestIds.push(authenticationRequestId);
    if (modelIds.size && !modelIds.has(account.visionModel)) throw new Error(`目前 API project 的模型清單中沒有「${account.visionModel}」，請改選可用的畫面／故事模型。`);

    const storyResponse = await this.fetcher(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: account.visionModel, store: false, max_output_tokens: 16, input: "Reply exactly OK." }),
      signal: requestSignal(signal),
    });
    if (!storyResponse.ok) throw new Error(`故事模型實際測試失敗：${(await responseError(storyResponse)).message}`);
    const storyRequestId = storyResponse.headers.get("x-request-id");
    if (storyRequestId) requestIds.push(storyRequestId);
    await storyResponse.arrayBuffer();
    return { checks: ["API Key 驗證", `故事模型 ${account.visionModel}`], requestIds };
  }

  async translateTexts(
    texts: string[],
    targetLanguage: Exclude<SubtitleRenderLanguage, "zh-TW">,
    account: AiAccountProfile & { apiKey: string },
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 500 || texts.some((text) => typeof text !== "string" || !text.trim())) {
      throw new Error("待翻譯字幕格式無效或數量超過單次上限。");
    }
    const languageNames: Record<Exclude<SubtitleRenderLanguage, "zh-TW">, string> = {
      "zh-CN": "簡體中文", en: "English", ja: "日本語", ko: "한국어",
    };
    const response = await this.fetcher(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: account.visionModel,
        store: false,
        input: [{
          role: "user",
          content: [{ type: "input_text", text: [
            `將下列繁體中文字幕翻譯成${languageNames[targetLanguage]}。`,
            "譯文要像真人為旅遊 YouTube 影片撰寫的自然口語字幕，保留人物、地名、事件與語氣，不增添或刪減事實，不加註解。",
            "必須逐項對應並保持完全相同的數量與順序。",
            JSON.stringify(texts),
          ].join("\n\n") }],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "subtitle_translations",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { translations: { type: "array", minItems: texts.length, maxItems: texts.length, items: { type: "string" } } },
              required: ["translations"],
            },
          },
        },
      }),
      signal: requestSignal(signal),
    });
    if (!response.ok) throw await responseError(response);
    const resultText = outputText(await response.json());
    let parsed: { translations?: unknown };
    try { parsed = JSON.parse(resultText) as { translations?: unknown }; }
    catch { throw new Error("OpenAI 字幕翻譯回傳格式無法解析。"); }
    if (!Array.isArray(parsed.translations) || parsed.translations.length !== texts.length || parsed.translations.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("OpenAI 字幕翻譯沒有逐項傳回完整結果。");
    }
    return parsed.translations.map((item) => String(item).trim());
  }

  async testConnection(account: AiAccountProfile & { apiKey: string }, signal?: AbortSignal): Promise<OpenAiConnectionDiagnostic> {
    const story = await this.testStoryConnection(account, signal);
    const requestIds = [...story.requestIds];

    let transcription;
    try { transcription = await this.transcribeBytes(diagnosticWav(), "scenerywalker-api-test.wav", "audio/wav", account, "zh", signal); }
    catch (error) { throw new Error(`語音模型實際測試失敗：${error instanceof Error ? error.message : String(error)}`); }
    if (transcription.requestId) requestIds.push(transcription.requestId);
    return { checks: [...story.checks, `語音模型 ${account.transcriptionModel}`], requestIds };
  }

  async transcribe(
    audioPath: string,
    account: AiAccountProfile & { apiKey: string },
    language: string,
    signal?: AbortSignal,
  ): Promise<TranscriptionSegment[]> {
    const bytes = await readFile(audioPath);
    return (await this.transcribeBytes(bytes, path.basename(audioPath), audioMimeType(audioPath), account, language, signal)).segments;
  }

  async transcribeBytes(
    bytes: Uint8Array,
    fileName: string,
    mimeType: string,
    account: AiAccountProfile & { apiKey: string },
    language: string,
    signal?: AbortSignal,
  ): Promise<{ segments: TranscriptionSegment[]; requestId?: string }> {
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(bytes).buffer], { type: mimeType || audioMimeType(fileName) }), path.basename(fileName));
    form.append("model", account.transcriptionModel);
    if (language.trim()) form.append("language", language.trim());
    if (account.transcriptionModel.includes("diarize")) {
      form.append("response_format", "diarized_json");
      form.append("chunking_strategy", "auto");
    } else {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
    }
    const response = await this.fetcher(`${OPENAI_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.apiKey}` },
      body: form,
      signal: requestSignal(signal),
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { text?: unknown; duration?: unknown; segments?: Array<{ start?: unknown; end?: unknown; text?: unknown; speaker?: unknown }> };
    const segments: TranscriptionSegment[] = (body.segments ?? []).map((segment) => ({
      startMs: Math.max(0, Math.round(Number(segment.start) * 1000)),
      endMs: Math.max(0, Math.round(Number(segment.end) * 1000)),
      text: typeof segment.text === "string" ? segment.text.trim() : "",
      speaker: typeof segment.speaker === "string" ? segment.speaker.trim() : undefined,
    })).filter((segment) => segment.text && Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs);
    if (!segments.length && typeof body.text === "string" && body.text.trim()) {
      const durationMs = Number.isFinite(Number(body.duration)) ? Math.max(100, Math.round(Number(body.duration) * 1000)) : 1_000;
      segments.push({ startMs: 0, endMs: durationMs, text: body.text.trim() });
    }
    return { segments, requestId: response.headers.get("x-request-id") ?? undefined };
  }

  async analyzeStoryFrames(
    request: StoryFrameRequest,
    account: AiAccountProfile & { apiKey: string },
    signal?: AbortSignal,
  ): Promise<StoryFrameAnalysis> {
    if (!request.frames.length) throw new Error("沒有可供 AI 判斷的畫面取樣。");
    const contextText = [
      `專案主題：${request.context.topic || "未提供"}`,
      `故事摘要：${request.context.storySummary || "未提供"}`,
      `已知地點：${request.context.locations.join("、") || "未提供"}`,
      `已知人物：${request.context.people.join("、") || "未提供"}`,
      `觀眾承諾：${request.context.audiencePromise || "未提供"}`,
      ...(request.mode === "INTRO" ? [`本次片頭文字指示：${request.context.introPrompt || "未提供（依人物／事件／故事優先原則）"}`] : []),
      `來源檔名：${request.sourceFileName}`,
      `語音轉錄：${request.transcript || "（無語音，請只提出畫面情境草稿）"}`,
    ].join("\n");
    const instruction = request.mode === "INTRO"
      ? "評估這段畫面是否適合作為片頭。人物行動、故事事件、前後故事脈絡與已知地點的符合度是第一優先；觀眾承諾是第二優先；單純動態、色彩或漂亮畫面不能凌駕故事一致性。"
      : request.transcript
        ? "建立可供人工審核的繁體中文字幕草稿。忠實修整語音，並用畫面核對人物、事件與地點；不得用想像取代說話內容。"
        : "建立可供人工審核的繁體中文知識型介紹字幕。以畫面與專案主題／地點為依據，說明地方特色、歷史文化、自然生態、森林養護或環境保護等真正有助觀看理解的知識；只選與當下畫面直接相關的一項，不要旁白式空話。";
    const prompt = [
      instruction,
      contextText,
      "只能根據提供的畫面、語音與專案背景作答。不得因臉孔外觀辨識真實身分；人物姓名只有在語音或專案背景足以支持時才能使用。",
      "地點不確定時使用一般描述並加入警告，不得猜測地標；知識無法由畫面與已知背景合理支持時，寧可留空並提出警告，不可捏造。繁體中文自然、簡潔，避免劇透與誇大。",
      "若畫面可見動物，請辨識可由外觀支持的物種或較安全的類群，animalSpecies 填常用中文名，speciesExplanation 提供一句與當下畫面相關的棲地、行為或生態說明，並讓 suggestedSubtitle 自然帶入。無法可靠辨識到物種時必須寫『疑似』或只寫較廣類群、降低 confidence 並加入 warnings；畫面沒有動物時兩欄留空。",
    ].join("\n\n");
    const body = {
      model: account.visionModel,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...request.frames.map((imageUrl) => ({ type: "input_image", image_url: imageUrl, detail: "low" })),
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "video_story_match",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              suggestedSubtitle: { type: "string" },
              visualSummary: { type: "string" },
              eventSummary: { type: "string" },
              peopleSummary: { type: "array", items: { type: "string" } },
              locationSummary: { type: "array", items: { type: "string" } },
              animalSpecies: { type: "array", items: { type: "string" } },
              speciesExplanation: { type: "string" },
              topicRelevanceScore: { type: "integer", minimum: 0, maximum: 100 },
              transcriptVisualMatchScore: { type: "integer", minimum: 0, maximum: 100 },
              confidence: { type: "integer", minimum: 0, maximum: 100 },
              warnings: { type: "array", items: { type: "string" } },
            },
            required: ["suggestedSubtitle", "visualSummary", "eventSummary", "peopleSummary", "locationSummary", "animalSpecies", "speciesExplanation", "topicRelevanceScore", "transcriptVisualMatchScore", "confidence", "warnings"],
          },
        },
      },
    };
    const response = await this.fetcher(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(signal),
    });
    if (!response.ok) throw await responseError(response);
    const text = outputText(await response.json());
    if (!text) throw new Error("OpenAI 視覺分析未傳回可讀結果。");
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error("OpenAI 視覺分析回傳格式無法解析。"); }
    return {
      suggestedSubtitle: typeof parsed.suggestedSubtitle === "string" ? parsed.suggestedSubtitle.trim() : "",
      visualSummary: typeof parsed.visualSummary === "string" ? parsed.visualSummary.trim() : "",
      eventSummary: typeof parsed.eventSummary === "string" ? parsed.eventSummary.trim() : "",
      peopleSummary: stringArray(parsed.peopleSummary),
      locationSummary: stringArray(parsed.locationSummary),
      animalSpecies: stringArray(parsed.animalSpecies),
      speciesExplanation: typeof parsed.speciesExplanation === "string" ? parsed.speciesExplanation.trim() : "",
      topicRelevanceScore: score(parsed.topicRelevanceScore),
      transcriptVisualMatchScore: score(parsed.transcriptVisualMatchScore),
      confidence: score(parsed.confidence),
      warnings: stringArray(parsed.warnings),
    };
  }

  async suggestMusic(
    context: AiStoryContext,
    includeTikTokTrending: boolean,
    royaltyFreeOnly: boolean,
    account: AiAccountProfile & { apiKey: string },
    signal?: AbortSignal,
  ): Promise<{ suggestions: MusicSuggestionCandidate[]; warnings: string[] }> {
    const topicSummary = [
      context.topic,
      context.locations.join("、"),
      context.storySummary,
      context.audiencePromise,
    ].map((item) => item.trim()).filter(Boolean).join("｜");
    if (!topicSummary) throw new Error("請先在 AI 故事設定填寫影片主題、地點、故事摘要或觀眾承諾，再產生配樂建議。");
    const currentDate = new Date().toISOString().slice(0, 10);
    const prompt = [
      "你是旅遊影片的配樂研究員。請使用網路搜尋，依專案主題提出 5 至 8 個可在 YouTube 點開試聽的音樂建議。",
      `今天是 ${currentDate}。專案主題資料：${topicSummary}`,
      "每筆 YouTube 建議必須提供實際找到的 HTTPS YouTube watch、YouTube Music watch 或 youtu.be 連結；不要捏造影片 ID，也不要把一般首頁當試聽連結。",
      includeTikTokTrending
        ? "另搜尋 3 至 5 首 TikTok／抖音近期熱門音樂；以 TikTok Creative Center 等可核對的近期來源為優先，說明觀察日期與熱門證據。auditionUrl 與 evidenceUrl 必須是實際找到的 TikTok 官方或 YouTube 試聽頁。若無法核對近期證據，不要把該曲列為熱門，只在 warnings 說明。"
        : "本次不要搜尋或回傳 TikTok 項目。",
      royaltyFreeOnly
        ? "本次只列出有明確授權線索的音樂，例如 YouTube Audio Library、官方 royalty-free／Creative Commons 授權頁或明確允許商用的音樂庫。每筆必須填寫 rightsEvidence，指出授權名稱與可核對線索；找不到明確授權證據就不要列出。不要把『沒有標示版權』當成無版權。"
        : "本次不限制授權類型，但仍需在 warnings 提醒使用者逐首核對授權。",
      "建議要分散節奏與情緒，並簡短解釋與人物、事件、故事或地點的搭配理由。",
      "所有連結只供試聽與選曲；不要宣稱已取得同步、商用或上傳授權。rights 與授權疑慮寫入 warnings。",
      "只回傳繁體中文的結構化結果。",
    ].join("\n\n");
    const response = await this.fetcher(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: account.visionModel,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        text: {
          format: {
            type: "json_schema",
            name: "music_suggestions",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                suggestions: {
                  type: "array",
                  minItems: 3,
                  maxItems: 13,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      platform: { type: "string", enum: ["YOUTUBE", "TIKTOK"] },
                      title: { type: "string" },
                      artist: { type: "string" },
                      reason: { type: "string" },
                      auditionUrl: { type: "string" },
                      evidenceUrl: { type: "string" },
                      observedAt: { type: "string" },
                      trendEvidence: { type: "string" },
                      rightsEvidence: { type: "string" },
                    },
                    required: ["platform", "title", "artist", "reason", "auditionUrl", "evidenceUrl", "observedAt", "trendEvidence", "rightsEvidence"],
                  },
                },
                warnings: { type: "array", items: { type: "string" } },
              },
              required: ["suggestions", "warnings"],
            },
          },
        },
      }),
      signal: requestSignal(signal),
    });
    if (!response.ok) throw await responseError(response);
    const resultText = outputText(await response.json());
    let parsed: { suggestions?: unknown; warnings?: unknown };
    try { parsed = JSON.parse(resultText) as { suggestions?: unknown; warnings?: unknown }; }
    catch { throw new Error("OpenAI 配樂建議回傳格式無法解析。"); }
    if (!Array.isArray(parsed.suggestions)) throw new Error("OpenAI 配樂建議沒有回傳可用清單。");
    const suggestions = parsed.suggestions.flatMap((value): MusicSuggestionCandidate[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (item.platform !== "YOUTUBE" && item.platform !== "TIKTOK") return [];
      const fields = ["title", "reason", "auditionUrl", "evidenceUrl"] as const;
      if (fields.some((field) => typeof item[field] !== "string" || !String(item[field]).trim())) return [];
      return [{
        platform: item.platform,
        title: String(item.title).trim().slice(0, 160),
        artist: typeof item.artist === "string" ? item.artist.trim().slice(0, 120) : "",
        reason: String(item.reason).trim().slice(0, 500),
        auditionUrl: String(item.auditionUrl).trim(),
        evidenceUrl: String(item.evidenceUrl).trim(),
        observedAt: typeof item.observedAt === "string" ? item.observedAt.trim().slice(0, 80) : "",
        trendEvidence: typeof item.trendEvidence === "string" ? item.trendEvidence.trim().slice(0, 300) : "",
        rightsEvidence: typeof item.rightsEvidence === "string" ? item.rightsEvidence.trim().slice(0, 400) : "",
      }];
    });
    return { suggestions, warnings: stringArray(parsed.warnings) };
  }
}
