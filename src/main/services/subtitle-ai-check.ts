import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SubtitleAiCheckAction,
  SubtitleAiCheckErrorCode,
  SubtitleAiCheckJobSnapshot,
  SubtitleAiCheckProgress,
  SubtitleAiCheckProposal,
  SubtitleCue,
} from "../../shared/domain";

export interface SubtitleAiCheckEvidence {
  role: "START" | "MIDDLE" | "END" | "PREVIOUS" | "NEXT";
  timestampMs: number;
  imageDataUrl: string;
}

export interface SubtitleAiCheckProviderInput {
  cue: SubtitleCue;
  cueIndex: number;
  cueCount: number;
  videoDurationMs: number;
  previousCue?: Pick<SubtitleCue, "startMs" | "endMs" | "text">;
  nextCue?: Pick<SubtitleCue, "startMs" | "endMs" | "text">;
  title: string;
  description: string;
  displayLanguage: string;
  evidence: SubtitleAiCheckEvidence[];
}

export interface SubtitleAiCheckProviderResult {
  decision: "KEEP" | "EDIT";
  suggestedText?: string;
  suggestedStartMs?: number;
  suggestedEndMs?: number;
  reason: string;
  confidence: number;
  timingConfidence: number;
}

export interface SubtitleAiCheckProvider {
  readonly kind: "OPENAI" | "GEMINI";
  readonly modelId: string;
  checkCue(input: SubtitleAiCheckProviderInput, signal?: AbortSignal): Promise<SubtitleAiCheckProviderResult>;
}

export class SubtitleAiCheckError extends Error {
  constructor(
    readonly code: SubtitleAiCheckErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SubtitleAiCheckError";
  }
}

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["KEEP", "EDIT"] },
    suggestedText: { type: "string" },
    suggestedStartMs: { type: "integer", minimum: 0 },
    suggestedEndMs: { type: "integer", minimum: 1 },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    timingConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["decision", "suggestedText", "suggestedStartMs", "suggestedEndMs", "reason", "confidence", "timingConfidence"],
} as const;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseSubtitleAiCheckResult(text: string, videoDurationMs: number): SubtitleAiCheckProviderResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new SubtitleAiCheckError("JSON_PARSE", "AI 字幕檢查回傳的 JSON 無法解析。"); }
  if (!value || typeof value !== "object") throw new SubtitleAiCheckError("BAD_RESPONSE", "AI 字幕檢查回傳格式不完整。");
  const item = value as Record<string, unknown>;
  const allowedKeys = new Set(["decision", "suggestedText", "suggestedStartMs", "suggestedEndMs", "reason", "confidence", "timingConfidence"]);
  if (Object.keys(item).some((key) => !allowedKeys.has(key)) || [...allowedKeys].some((key) => !(key in item)))
    throw new SubtitleAiCheckError("BAD_RESPONSE", "AI 字幕檢查回傳包含未知欄位或缺少必要欄位。");
  if (item.decision !== "KEEP" && item.decision !== "EDIT")
    throw new SubtitleAiCheckError("BAD_RESPONSE", "AI 字幕檢查缺少 KEEP／EDIT 決定。");
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  const confidence = finiteNumber(item.confidence);
  const timingConfidence = finiteNumber(item.timingConfidence);
  if (!reason || confidence === undefined || timingConfidence === undefined || confidence < 0 || confidence > 1 || timingConfidence < 0 || timingConfidence > 1)
    throw new SubtitleAiCheckError("BAD_RESPONSE", "AI 字幕檢查缺少有效原因或信心值。");
  if (typeof item.suggestedText !== "string" || !Number.isInteger(item.suggestedStartMs) || !Number.isInteger(item.suggestedEndMs))
    throw new SubtitleAiCheckError("BAD_RESPONSE", "AI 字幕檢查文字與時間欄位型別無效。");
  if (item.decision === "KEEP")
    return { decision: "KEEP", reason, confidence, timingConfidence };
  const suggestedText = typeof item.suggestedText === "string" ? item.suggestedText.replace(/\s+/g, " ").trim() : "";
  const suggestedStartMs = finiteNumber(item.suggestedStartMs);
  const suggestedEndMs = finiteNumber(item.suggestedEndMs);
  if (!suggestedText || suggestedText.length > 120 || suggestedStartMs === undefined || suggestedEndMs === undefined
    || !Number.isInteger(suggestedStartMs) || !Number.isInteger(suggestedEndMs))
    throw new SubtitleAiCheckError("BAD_RESPONSE", "AI EDIT 建議缺少有效文字或時間。");
  if (suggestedStartMs < 0 || suggestedEndMs <= suggestedStartMs || suggestedEndMs > videoDurationMs)
    throw new SubtitleAiCheckError("SUBTITLE_TIMELINE", "AI EDIT 建議超出影片時間或起訖無效。");
  return {
    decision: "EDIT",
    suggestedText,
    suggestedStartMs: Math.round(suggestedStartMs),
    suggestedEndMs: Math.round(suggestedEndMs),
    reason,
    confidence,
    timingConfidence,
  };
}

function image(value: string): { mimeType: string; data: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/i.exec(value);
  if (!match) throw new SubtitleAiCheckError("FRAME_EXTRACTION", "字幕檢查影格格式無效。");
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}

function prompt(input: SubtitleAiCheckProviderInput): string {
  return [
    `Output language: ${input.displayLanguage}.`,
    "你是逐筆字幕校對員。根據字幕原文、前後字幕、字幕開始／中間／結束及相鄰畫面，只回傳 KEEP 或 EDIT 建議。",
    "KEEP 表示文字與時間可保留。EDIT 只提出建議，不能宣稱已修改字幕。畫面看不清時應 KEEP 並在 reason 說明，不得猜測。",
    "標題與說明只是背景，不能凌駕畫面。時間必須位於影片內且不與前後字幕衝突。",
    JSON.stringify({
      cueIndex: input.cueIndex,
      cueCount: input.cueCount,
      videoDurationMs: input.videoDurationMs,
      cue: { startMs: input.cue.startMs, endMs: input.cue.endMs, text: input.cue.text },
      previousCue: input.previousCue,
      nextCue: input.nextCue,
      title: input.title,
      description: input.description,
      frames: input.evidence.map(({ role, timestampMs }) => ({ role, timestampMs })),
    }),
  ].join("\n\n");
}

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const response = value as { output_text?: unknown; output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }> };
  if (typeof response.output_text === "string") return response.output_text;
  for (const output of response.output ?? [])
    for (const content of output.content ?? [])
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
  return "";
}

function assertOpenAiCompleted(value: unknown): void {
  if (!value || typeof value !== "object") throw new SubtitleAiCheckError("BAD_RESPONSE", "OpenAI 回傳格式不完整。");
  const response = value as { status?: unknown; incomplete_details?: unknown; output?: Array<{ content?: Array<{ type?: string }> }> };
  if (response.status === "incomplete" || response.incomplete_details)
    throw new SubtitleAiCheckError("BAD_RESPONSE", "OpenAI 字幕檢查回傳不完整；不會建立建議。");
  if (response.output?.some((item) => item.content?.some((content) => content.type === "refusal")))
    throw new SubtitleAiCheckError("BAD_RESPONSE", "OpenAI 拒絕這筆字幕檢查；不會建立或套用建議。");
}

export function classifySubtitleAiCheckError(error: unknown): SubtitleAiCheckError {
  if (error instanceof SubtitleAiCheckError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new SubtitleAiCheckError("PROVIDER", "AI 字幕檢查已停止。", true);
  if (error instanceof DOMException && error.name === "TimeoutError") return new SubtitleAiCheckError("TIMEOUT", "AI 字幕檢查逾時。", true);
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return new SubtitleAiCheckError("TIMEOUT", "AI 字幕檢查逾時。", true);
  if (/api\s*key|credential|unauthorized|forbidden|驗證|未設定.*key/i.test(message)) return new SubtitleAiCheckError("AUTH", "AI 字幕檢查驗證失敗，請檢查 Provider 帳號與 API Key。");
  if (/model|模型/i.test(message)) return new SubtitleAiCheckError("MODEL", "AI 字幕檢查模型不可用，請檢查目前模型設定。");
  if (/明確啟用.*gemini/i.test(message)) return new SubtitleAiCheckError("PROVIDER", "Gemini 尚未明確啟用。");
  if (/ENOENT|not found|找不到.*影片/i.test(message)) return new SubtitleAiCheckError("VIDEO_NOT_FOUND", "找不到字幕檢查影片。");
  return new SubtitleAiCheckError("UNKNOWN", message || "AI 字幕檢查發生未知錯誤。");
}

async function responseJson(response: Response, provider: "OpenAI" | "Gemini"): Promise<unknown> {
  if (!response.ok) {
    let code = "";
    let detail = "";
    try {
      const body = await response.clone().json() as { error?: { code?: unknown; status?: unknown; message?: unknown } };
      code = String(body.error?.code ?? body.error?.status ?? "").slice(0, 80);
      detail = String(body.error?.message ?? "").slice(0, 240);
    } catch { /* safe category below */ }
    const joined = `${code} ${detail}`;
    if (response.status === 401 || response.status === 403) throw new SubtitleAiCheckError("AUTH", `${provider} 驗證失敗。`);
    if (response.status === 404 || /model_not_found|model.*unavailable/i.test(joined)) throw new SubtitleAiCheckError("MODEL", `${provider} 模型不可用。`);
    if (/image|vision/i.test(joined)) throw new SubtitleAiCheckError("VISION", `${provider} 模型未接受畫面輸入。`);
    if (/model/i.test(joined)) throw new SubtitleAiCheckError("MODEL", `${provider} 模型不可用。`);
    if (response.status === 429) {
      const exhausted = /credit_balance_exhausted|insufficient_quota|billing/i.test(joined);
      throw new SubtitleAiCheckError("RATE_LIMIT", exhausted ? `${provider} 額度不足；這不是可自動重試的短暫限速。` : `${provider} 請求受到限速。`, !exhausted);
    }
    throw new SubtitleAiCheckError("PROVIDER", `${provider} 字幕檢查失敗（HTTP ${response.status}）。`, response.status >= 500);
  }
  try { return await response.json(); }
  catch { throw new SubtitleAiCheckError("JSON_PARSE", `${provider} 回傳不是有效 JSON。`); }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(90_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class OpenAiSubtitleAiCheckProvider implements SubtitleAiCheckProvider {
  readonly kind = "OPENAI" as const;
  constructor(readonly modelId: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}
  async checkCue(input: SubtitleAiCheckProviderInput, signal?: AbortSignal): Promise<SubtitleAiCheckProviderResult> {
    try {
      const content: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt(input) }];
      for (const evidence of input.evidence) {
        const frame = image(evidence.imageDataUrl);
        content.push({ type: "input_image", image_url: `data:${frame.mimeType};base64,${frame.data}`, detail: "low" });
      }
      const response = await this.fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.modelId, store: false, input: [{ role: "user", content }], text: { format: { type: "json_schema", name: "subtitle_cue_check", strict: true, schema: responseSchema } } }),
        signal: requestSignal(signal),
      });
      const payload = await responseJson(response, "OpenAI");
      assertOpenAiCompleted(payload);
      const text = outputText(payload);
      if (!text) throw new SubtitleAiCheckError("BAD_RESPONSE", "OpenAI 未回傳可讀的字幕檢查結果。");
      return parseSubtitleAiCheckResult(text, input.videoDurationMs);
    } catch (error) { throw classifySubtitleAiCheckError(error); }
  }
}

export class GeminiSubtitleAiCheckProvider implements SubtitleAiCheckProvider {
  readonly kind = "GEMINI" as const;
  constructor(readonly modelId: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}
  async checkCue(input: SubtitleAiCheckProviderInput, signal?: AbortSignal): Promise<SubtitleAiCheckProviderResult> {
    try {
      const parts: Array<Record<string, unknown>> = [{ text: prompt(input) }];
      for (const evidence of input.evidence) {
        const frame = image(evidence.imageDataUrl);
        parts.push({ inlineData: { mimeType: frame.mimeType, data: frame.data } });
      }
      const response = await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelId)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema } }),
        signal: requestSignal(signal),
      });
      const payload = await responseJson(response, "Gemini") as { candidates?: Array<{ finishReason?: unknown; content?: { parts?: Array<{ text?: unknown }> } }> };
      const finishReason = payload.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== "STOP") throw new SubtitleAiCheckError("BAD_RESPONSE", `Gemini 字幕檢查未正常完成（${String(finishReason).slice(0, 40)}）。`);
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("").trim() ?? "";
      if (!text) throw new SubtitleAiCheckError("BAD_RESPONSE", "Gemini 未回傳可讀的字幕檢查結果。");
      return parseSubtitleAiCheckResult(text, input.videoDurationMs);
    } catch (error) { throw classifySubtitleAiCheckError(error); }
  }
}

export function subtitleCueRevision(cue: SubtitleCue): string {
  return createHash("sha256").update(JSON.stringify({ id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text, userEdited: cue.userEdited === true })).digest("hex");
}

export function subtitleAiCheckContextRevision(
  cue: SubtitleCue,
  previousCue: SubtitleCue | undefined,
  nextCue: SubtitleCue | undefined,
  title: string,
  description: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    cue: subtitleCueRevision(cue),
    previous: previousCue ? subtitleCueRevision(previousCue) : null,
    next: nextCue ? subtitleCueRevision(nextCue) : null,
    title,
    description,
  })).digest("hex");
}

export function buildSubtitleAiCheckProposal(
  cue: SubtitleCue,
  cueIndex: number,
  evidenceTimesMs: number[],
  provider: SubtitleAiCheckProvider,
  result: SubtitleAiCheckProviderResult,
  baseContextRevision = subtitleCueRevision(cue),
): SubtitleAiCheckProposal {
  return {
    id: randomUUID(), cueId: cue.id, cueIndex, ...result,
    provider: provider.kind, modelId: provider.modelId, baseCueRevision: subtitleCueRevision(cue), baseContextRevision,
    evidenceTimesMs, status: "PENDING", createdAt: new Date().toISOString(),
  };
}

export function resolveSubtitleAiCheckAction(
  cues: readonly SubtitleCue[],
  proposal: SubtitleAiCheckProposal,
  action: SubtitleAiCheckAction,
  videoDurationMs = Number.POSITIVE_INFINITY,
): { cues: SubtitleCue[]; proposal: SubtitleAiCheckProposal; conflict: boolean } {
  const index = cues.findIndex((cue) => cue.id === proposal.cueId);
  if (index < 0) return { cues: [...cues], proposal: { ...proposal, status: "CONFLICT" }, conflict: true };
  const current = cues[index];
  if (action.action === "KEEP") return { cues: [...cues], proposal: { ...proposal, status: "KEPT" }, conflict: false };
  if (action.action === "SKIP") return { cues: [...cues], proposal: { ...proposal, status: "SKIPPED" }, conflict: false };
  if (action.action === "APPLY" && subtitleCueRevision(current) !== proposal.baseCueRevision)
    return { cues: [...cues], proposal: { ...proposal, status: "CONFLICT" }, conflict: true };
  const text = action.action === "EDIT" ? action.editedText?.trim() : proposal.suggestedText;
  const startMs = action.action === "EDIT" ? action.editedStartMs : proposal.suggestedStartMs;
  const endMs = action.action === "EDIT" ? action.editedEndMs : proposal.suggestedEndMs;
  if (!text || !Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs! < 0 || endMs! <= startMs! || endMs! > videoDurationMs)
    throw new SubtitleAiCheckError("SUBTITLE_TIMELINE", "套用字幕建議前需要有效文字與起訖時間。");
  const updated = [...cues];
  updated[index] = { ...current, text, startMs: Math.round(startMs!), endMs: Math.round(endMs!), userEdited: true, reviewStatus: "DRAFT" };
  return { cues: updated, proposal: { ...proposal, status: "APPLIED" }, conflict: false };
}

export function createSubtitleAiCheckSnapshot(
  workspaceId: string,
  videoFingerprint: string,
  options: SubtitleAiCheckJobSnapshot["options"],
  total: number,
): SubtitleAiCheckJobSnapshot {
  return {
    schemaVersion: 1, workspaceId, videoFingerprint, options, proposals: [],
    progress: { status: "IDLE", processed: 0, total, nextCueIndex: 0, requests: 0, cacheHits: 0, elapsedMs: 0 },
    updatedAt: new Date().toISOString(),
  };
}

export function advanceSubtitleAiCheckProgress(
  progress: SubtitleAiCheckProgress,
  cueIndex: number,
  cueId: string,
  interactiveConfirmation: boolean,
  elapsedMs: number,
): SubtitleAiCheckProgress {
  return {
    ...progress,
    status: interactiveConfirmation ? "PAUSED" : "RUNNING",
    processed: cueIndex + 1,
    nextCueIndex: cueIndex + 1,
    requests: progress.requests + 1,
    currentCueId: cueId,
    elapsedMs,
  };
}

export class SubtitleAiCheckJobStore {
  constructor(private readonly filePath: string) {}
  async load(): Promise<SubtitleAiCheckJobSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as SubtitleAiCheckJobSnapshot;
      if (value.schemaVersion !== 1 || !value.workspaceId || !Array.isArray(value.proposals)) return undefined;
      return value;
    } catch { return undefined; }
  }
  async save(snapshot: SubtitleAiCheckJobSnapshot): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const partial = `${this.filePath}.${process.pid}.${randomUUID()}.partial`;
    await writeFile(partial, JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(partial, this.filePath);
  }
}
