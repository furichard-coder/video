import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MusicSuggestionCandidate, StoryFrameAnalysis, StoryFrameRequest } from "./openai-provider";
import type { AiStoryContext } from "../../shared/domain";
import { normalizePublishResponse, PUBLISH_JSON_SCHEMA, type PublishGenerationInput, type PublishGeneratedDraft } from "./publish-generation";
import { ProcessFailure, runProcess } from "./process-runner";

const CODEX_BATCH_SIZE = 12;
const CODEX_TIMEOUT_MS = 180_000;

export interface CodexStoryRequest {
  id: string;
  framePath: string;
  request: Omit<StoryFrameRequest, "frames">;
}

export interface CodexConnectionDiagnostic {
  checks: string[];
  providerLabel: "Codex／ChatGPT 登入";
}

interface CodexBatchItem extends StoryFrameAnalysis { index: number; }

function executableCandidates(): string[] {
  const values = [
    process.env.CODEX_EXECUTABLE?.trim(),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Codex", "bin", "codex.exe") : undefined,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

export function findCodexExecutableSync(): string | undefined {
  return executableCandidates().find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
}

function score(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 12)
    : [];
}

function normalizeResult(value: unknown): CodexBatchItem {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const index = Number(item.index);
  if (!Number.isInteger(index) || index < 0) throw new Error("Codex 字幕結果缺少有效的畫面序號。");
  return {
    index,
    suggestedSubtitle: typeof item.suggestedSubtitle === "string" ? item.suggestedSubtitle.trim() : "",
    visualSummary: typeof item.visualSummary === "string" ? item.visualSummary.trim() : "",
    eventSummary: typeof item.eventSummary === "string" ? item.eventSummary.trim() : "",
    peopleSummary: strings(item.peopleSummary),
    locationSummary: strings(item.locationSummary),
    animalSpecies: strings(item.animalSpecies),
    speciesExplanation: typeof item.speciesExplanation === "string" ? item.speciesExplanation.trim() : "",
    topicRelevanceScore: score(item.topicRelevanceScore),
    transcriptVisualMatchScore: score(item.transcriptVisualMatchScore),
    confidence: score(item.confidence),
    warnings: strings(item.warnings),
  };
}

function finalAgentMessage(stdout: string): string {
  let result = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") result = event.item.text;
    } catch { /* ignore non-JSON diagnostic lines */ }
  }
  if (!result) throw new Error("Codex 沒有傳回可讀的結構化結果。");
  return result.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function batchSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      results: {
        type: "array",
        minItems: 1,
        maxItems: CODEX_BATCH_SIZE,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer", minimum: 0, maximum: CODEX_BATCH_SIZE - 1 },
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
          required: ["index", "suggestedSubtitle", "visualSummary", "eventSummary", "peopleSummary", "locationSummary", "animalSpecies", "speciesExplanation", "topicRelevanceScore", "transcriptVisualMatchScore", "confidence", "warnings"],
        },
      },
    },
    required: ["results"],
  };
}

function promptFor(batch: CodexStoryRequest[]): string {
  const context = batch[0].request.context;
  const items = batch.map((item, index) => ({
    index,
    sourceFileName: item.request.sourceFileName,
    mode: item.request.mode,
    transcript: item.request.transcript || "（未勾選語音分析）",
  }));
  return [
    "你是旅遊影片的繁體中文字幕編輯。依序檢視附加的每張故事板；每張故事板由同一素材時段的起、中、末三格組成。",
    "本次只產生可供人工審核的知識型字幕草稿。不要執行工具、不要讀取其他檔案、不要修改任何檔案。",
    `專案主題：${context.topic || "未提供"}`,
    `故事摘要：${context.storySummary || "未提供"}`,
    `已知地點：${context.locations.join("、") || "未提供"}`,
    `已知人物：${context.people.join("、") || "未提供"}`,
    `觀眾承諾：${context.audiencePromise || "未提供"}`,
    "字幕需與當下畫面直接相關，優先提供地方特色、歷史文化、自然生態、森林養護或環境保護等有助理解的知識。若地點或事實無法由畫面與已知背景支持，請使用一般描述、降低信心並加入警告，不得捏造。不得依臉孔猜測真實身分。",
    "若畫面可見動物，辨識可由外觀支持的物種或較安全類群，animalSpecies 填常用中文名，speciesExplanation 寫一句與畫面相關的棲地、行為或生態說明，並在 suggestedSubtitle 自然帶入。不能可靠辨識時要用『疑似』或較廣類群、降低 confidence 並加入 warnings；沒有動物時兩欄留空。",
    "suggestedSubtitle 請自然精簡，適合在畫面停留約 4 秒；使用繁體中文。每張圖必須恰好回傳一筆，index 必須對應下列清單與附圖順序。",
    JSON.stringify(items),
  ].join("\n\n");
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CODEX_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function musicSchema() {
  return {
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
            title: { type: "string" }, artist: { type: "string" }, reason: { type: "string" },
            auditionUrl: { type: "string" }, evidenceUrl: { type: "string" }, observedAt: { type: "string" }, trendEvidence: { type: "string" },
            rightsEvidence: { type: "string" },
          },
          required: ["platform", "title", "artist", "reason", "auditionUrl", "evidenceUrl", "observedAt", "trendEvidence", "rightsEvidence"],
        },
      },
      warnings: { type: "array", items: { type: "string" } },
    },
    required: ["suggestions", "warnings"],
  };
}

function normalizeMusic(value: unknown): MusicSuggestionCandidate[] {
  if (!Array.isArray(value)) throw new Error("Codex 配樂研究沒有回傳建議清單。");
  return value.flatMap((entry): MusicSuggestionCandidate[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (item.platform !== "YOUTUBE" && item.platform !== "TIKTOK") return [];
    if (["title", "reason", "auditionUrl", "evidenceUrl"].some((field) => typeof item[field] !== "string" || !String(item[field]).trim())) return [];
    return [{
      platform: item.platform,
      title: String(item.title).trim().slice(0, 160), artist: typeof item.artist === "string" ? item.artist.trim().slice(0, 120) : "",
      reason: String(item.reason).trim().slice(0, 500), auditionUrl: String(item.auditionUrl).trim(), evidenceUrl: String(item.evidenceUrl).trim(),
      observedAt: typeof item.observedAt === "string" ? item.observedAt.trim().slice(0, 80) : "",
      trendEvidence: typeof item.trendEvidence === "string" ? item.trendEvidence.trim().slice(0, 300) : "",
      rightsEvidence: typeof item.rightsEvidence === "string" ? item.rightsEvidence.trim().slice(0, 400) : "",
    }];
  });
}

export class CodexCliStoryProvider {
  constructor(
    private readonly cacheRoot: string,
    private readonly configuredExecutable = findCodexExecutableSync(),
    private readonly processRunner = runProcess,
  ) {}

  isInstalled(): boolean { return Boolean(this.configuredExecutable); }

  async testConnection(signal?: AbortSignal): Promise<CodexConnectionDiagnostic> {
    const executable = this.configuredExecutable;
    if (!executable) throw new Error("這台電腦找不到 Codex 執行程式，無法使用 ChatGPT 登入備援。");
    let result;
    try { result = await this.processRunner(executable, ["login", "status"], combinedSignal(signal)); }
    catch (error) { throw new Error(`Codex 登入狀態檢查失敗：${error instanceof Error ? error.message : String(error)}`); }
    const status = `${result.stdout}\n${result.stderr}`;
    if (!/logged in using chatgpt/i.test(status)) throw new Error("Codex 尚未使用 ChatGPT 登入；請先在 Codex 完成登入後重試。");
    return { checks: ["已偵測 Codex", "ChatGPT 登入可用", "唯讀／暫存工作模式"], providerLabel: "Codex／ChatGPT 登入" };
  }

  async generatePublishAssets(input: PublishGenerationInput, model: string, signal?: AbortSignal): Promise<{ draft: PublishGeneratedDraft; model: string }> {
    const executable = this.configuredExecutable;
    if (!executable) throw new Error("這台電腦找不到 Codex 執行程式。" );
    await mkdir(this.cacheRoot, { recursive: true });
    const schemaPath = path.join(this.cacheRoot, `.codex-publish-schema-${process.pid}-${Date.now()}.json`);
    const prompt = ["你是旅遊 YouTube 發布素材編輯。先理解主題、故事與正片內容，再優先判讀已選片頭的實際候選畫面，讓標題與縮圖呈現影片開場承諾。不要執行工具、不要讀寫本機檔案；只依照文字與附加低解析影格回答。不得猜測人物身分或未提供的地點。", JSON.stringify({ topic: input.topic, durationMs: input.durationMs, intro: input.introSummary, timeline: input.timelineSummary, candidates: input.candidates.map(({ framePath: _framePath, ...candidate }) => candidate) }), "標題須延伸影片內容與片頭畫面；嚴格依 output schema 回傳完整 titles、description、englishSummary、hashtags、3 個可追溯縮圖概念與章節。縮圖概念應優先選用 origin=INTRO 的候選，除非該畫面明顯不適合。", "品質要求：標題彼此角度要有明顯差異、避免制式空話，必須具體呼應可見主體或片頭情境，總長不超過 100 字；可自然加入一個英文關鍵片語或 hashtag，但不可堆砌。縮圖顯示文字應精簡、通常不超過 12 個中文字，與標題互補而非重複，並依候選畫面的主體位置選擇左右版面、避免遮住重要景物。說明與章節只能使用有來源依據的資訊。"].join("\n\n");
    try {
      await writeFile(schemaPath, JSON.stringify(PUBLISH_JSON_SCHEMA), { encoding: "utf8", flag: "wx" });
      const args = ["exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check", "--model", model, "-C", this.cacheRoot, "--image", ...input.candidates.map((candidate) => candidate.framePath), "--output-schema", schemaPath, "--json", "-"];
      let output;
      try { output = await this.processRunner(executable, args, combinedSignal(signal), { cwd: this.cacheRoot, input: prompt }); }
      catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; const detail = error instanceof ProcessFailure ? error.stderr.slice(-500) : error instanceof Error ? error.message : String(error); throw new Error(`Codex／ChatGPT 發布素材失敗：${detail}`); }
      let parsed: unknown; try { parsed = JSON.parse(finalAgentMessage(output.stdout)); } catch (error) { throw new Error(`Codex 發布素材 JSON 無法解析：${error instanceof Error ? error.message : String(error)}`); }
      return { draft: normalizePublishResponse(parsed, input), model };
    } finally { await rm(schemaPath, { force: true }); }
  }

  async analyzeStoryFramesBatch(requests: CodexStoryRequest[], model: string, signal?: AbortSignal): Promise<Map<string, StoryFrameAnalysis>> {
    if (!requests.length) return new Map();
    const executable = this.configuredExecutable;
    if (!executable) throw new Error("這台電腦找不到 Codex 執行程式。");
    await mkdir(this.cacheRoot, { recursive: true });
    const resultById = new Map<string, StoryFrameAnalysis>();
    for (let offset = 0; offset < requests.length; offset += CODEX_BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException("AI 字幕分析已取消。", "AbortError");
      const batch = requests.slice(offset, offset + CODEX_BATCH_SIZE);
      const schemaPath = path.join(this.cacheRoot, `.codex-subtitle-schema-${process.pid}-${offset}.json`);
      try {
        await writeFile(schemaPath, JSON.stringify(batchSchema()), { encoding: "utf8", flag: "wx" });
        const args = [
          "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check",
          "--model", model, "-C", this.cacheRoot,
          "--image", ...batch.map((item) => item.framePath),
          "--output-schema", schemaPath, "--json", "-",
        ];
        let output;
        try { output = await this.processRunner(executable, args, combinedSignal(signal), { cwd: this.cacheRoot, input: promptFor(batch) }); }
        catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          const detail = error instanceof ProcessFailure ? error.stderr.replace(/[\r\n]+/g, " ").slice(-500) : error instanceof Error ? error.message : String(error);
          throw new Error(`Codex／ChatGPT 字幕分析失敗：${detail || "執行程序未成功完成。"}`);
        }
        let parsed: { results?: unknown };
        try { parsed = JSON.parse(finalAgentMessage(output.stdout)) as { results?: unknown }; }
        catch (error) { throw new Error(`Codex 字幕結果格式無法解析：${error instanceof Error ? error.message : String(error)}`); }
        if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) throw new Error(`Codex 應回傳 ${batch.length} 筆字幕，但收到 ${Array.isArray(parsed.results) ? parsed.results.length : 0} 筆。`);
        const normalized = parsed.results.map(normalizeResult);
        const indexes = new Set(normalized.map((item) => item.index));
        if (indexes.size !== batch.length || [...indexes].some((index) => index >= batch.length)) throw new Error("Codex 字幕結果序號重複或超出範圍。");
        for (const item of normalized) {
          const { index, ...analysis } = item;
          resultById.set(batch[index].id, analysis);
        }
      } finally { await rm(schemaPath, { force: true }); }
    }
    return resultById;
  }

  async suggestMusic(context: AiStoryContext, includeTikTokTrending: boolean, royaltyFreeOnly: boolean, model: string, signal?: AbortSignal): Promise<{ suggestions: MusicSuggestionCandidate[]; warnings: string[] }> {
    const executable = this.configuredExecutable;
    if (!executable) throw new Error("這台電腦找不到 Codex 執行程式。");
    const topicSummary = [context.topic, context.locations.join("、"), context.storySummary, context.audiencePromise].map((item) => item.trim()).filter(Boolean).join("｜");
    if (!topicSummary) throw new Error("請先在 AI 故事設定填寫影片主題、地點、故事摘要或觀眾承諾，再產生配樂建議。");
    await mkdir(this.cacheRoot, { recursive: true });
    const schemaPath = path.join(this.cacheRoot, `.codex-music-schema-${process.pid}-${Date.now()}.json`);
    const prompt = [
      "你是旅遊影片的配樂研究員。請使用即時網路搜尋，不要使用 shell，不要讀寫本機檔案。",
      `今天是 ${new Date().toISOString().slice(0, 10)}。專案主題資料：${topicSummary}`,
      "找出 5 至 8 個可在 YouTube 點開試聽的音樂建議。每筆必須提供實際核對的 HTTPS YouTube watch、YouTube Music watch 或 youtu.be 連結，不得捏造影片 ID。",
      includeTikTokTrending
        ? "再找 3 至 5 首 TikTok／抖音近期熱門音樂，以 TikTok Creative Center 等官方趨勢頁為主要證據；填入觀察日期與熱門證據。若無法核對，就不要列為熱門並在 warnings 說明。"
        : "本次不要搜尋或回傳 TikTok 項目。",
      royaltyFreeOnly
        ? "本次只列出有明確 royalty-free、Creative Commons、YouTube Audio Library 或明確允許使用線索的音樂；每筆填 rightsEvidence，沒有明確證據就不要列出。不要把沒有標示版權當成無版權。"
        : "本次不限制授權類型，但要在 warnings 提醒逐首確認授權。",
      "建議需說明和人物、事件、故事、情緒或地點的搭配理由。所有連結只供試聽，不能宣稱已取得同步、商用或上傳授權；在 warnings 提醒逐首確認授權。",
      "使用繁體中文，嚴格依輸出 schema 回傳。",
    ].join("\n\n");
    try {
      await writeFile(schemaPath, JSON.stringify(musicSchema()), { encoding: "utf8", flag: "wx" });
      const args = ["exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check", "--model", model, "-C", this.cacheRoot, "--output-schema", schemaPath, "--json", "-"];
      let output;
      try { output = await this.processRunner(executable, args, combinedSignal(signal), { cwd: this.cacheRoot, input: prompt }); }
      catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const detail = error instanceof ProcessFailure ? error.stderr.replace(/[\r\n]+/g, " ").slice(-500) : error instanceof Error ? error.message : String(error);
        throw new Error(`Codex／ChatGPT 配樂研究失敗：${detail || "執行程序未成功完成。"}`);
      }
      let parsed: { suggestions?: unknown; warnings?: unknown };
      try { parsed = JSON.parse(finalAgentMessage(output.stdout)) as { suggestions?: unknown; warnings?: unknown }; }
      catch (error) { throw new Error(`Codex 配樂研究結果格式無法解析：${error instanceof Error ? error.message : String(error)}`); }
      return { suggestions: normalizeMusic(parsed.suggestions), warnings: strings(parsed.warnings) };
    } finally { await rm(schemaPath, { force: true }); }
  }
}
