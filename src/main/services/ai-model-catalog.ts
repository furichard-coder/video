import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import type { AiAvailableModel, AiModelCatalog, AiVisionTestResult } from "../../shared/domain";

type Provider = "OPENAI" | "GEMINI";
type FetchLike = typeof fetch;

let aiModelCatalogRoot = path.join(os.tmpdir(), "scenerywalker-ai-model-catalog");

export function configureAiModelCatalogRoot(rootDir: string): void {
  const normalized = rootDir.trim();
  if (!normalized) throw new Error("AI 模型目錄位置不可為空。");
  aiModelCatalogRoot = path.resolve(normalized);
}

export function getAiModelCatalogRoot(): string {
  return aiModelCatalogRoot;
}

const OPENAI_MODELS = "https://api.openai.com/v1/models";
const GEMINI_MODELS = "https://generativelanguage.googleapis.com/v1beta/models";
const EXCLUDED_MODEL =
  /(audio|transcri|whisper|embedding|codex|image|moderation|realtime|tts|speech|search|live|^gpt-3|^text-)/i;
const PROBE_IMAGE = `data:image/jpeg;base64,${jpeg.encode({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 255) }, 75).data.toString("base64")}`;
const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const;

interface CatalogFile {
  schemaVersion: 1;
  catalogs: Record<string, AiModelCatalog>;
}

function safeModels(value: unknown): AiAvailableModel[] {
  return Array.isArray(value)
    ? value.flatMap((item): AiAvailableModel[] => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (typeof row.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,150}$/.test(row.id)) return [];
        const candidate = row.candidate === true;
        return [
          {
            id: row.id,
            displayName: row.id,
            ...(Number.isFinite(row.created) ? { created: Number(row.created) } : {}),
            candidate,
            capability: row.capability === "READY" || row.capability === "UNSUPPORTED" ? row.capability : "UNKNOWN",
            ...(typeof row.reason === "string" ? { reason: row.reason.slice(0, 200) } : {}),
          },
        ];
      })
    : [];
}

function compatible(id: string): boolean {
  return !EXCLUDED_MODEL.test(id) && /(gpt|gemini|o[134])[-._\w]*/i.test(id);
}

function autoRank(id: string): number {
  const model = id.toLowerCase();
  const numbered = model.match(/(?:gpt-|gemini-)(\d+)(?:\.(\d+))?/);
  const major = numbered ? Number(numbered[1]) : 0;
  const minor = numbered ? Number(numbered[2] ?? 0) : 0;
  const small = /(?:mini|nano|lite|flash-lite)/.test(model) ? 1 : 0;
  return (100 - major) * 100 + (10 - minor) * 10 + small;
}

async function responseJson(response: Response, provider = "模型服務"): Promise<Record<string, unknown>> {
  if (!response.ok) {
    let code = "";
    try {
      const body = (await response.json()) as { error?: { code?: unknown; param?: unknown } };
      if (typeof body.error?.code === "string" && /^[a-zA-Z0-9_:-]{1,80}$/.test(body.error.code))
        code = body.error.code;
      if (typeof body.error?.param === "string" && /^[a-zA-Z0-9_.\[\]:-]{1,120}$/.test(body.error.param))
        code += ` @ ${body.error.param}`;
    } catch {
      /* safe status fallback */
    }
    throw new Error(`${provider} 模型請求失敗（HTTP ${response.status}${code ? ` / ${code}` : ""}）。`);
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("模型服務回傳格式無效。");
  return value as Record<string, unknown>;
}

function statusFromError(error: unknown): number {
  const match = error instanceof Error ? error.message.match(/HTTP (\d{3})/) : null;
  return match ? Number(match[1]) : 0;
}

export class AiModelCatalogService {
  private readonly filePath: string;
  constructor(
    rootDir: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.filePath = path.join(rootDir, "settings", "ai-model-catalog.json");
  }

  async refresh(provider: Provider, key: string, selectedModel = "auto"): Promise<AiModelCatalog> {
    const apiKey = key.trim();
    if (!apiKey) throw new Error("請先設定該服務的 API 金鑰。");
    const raw: Array<{ id: string; created?: number }> =
      provider === "OPENAI" ? await this.listOpenAi(apiKey) : await this.listGemini(apiKey);
    const models: AiAvailableModel[] = raw
      .filter((model) => compatible(model.id))
      .map((model) => ({
        id: model.id,
        displayName: model.id,
        ...(model.created ? { created: model.created } : {}),
        candidate: true,
        capability: "UNKNOWN" as const,
      }));
    const catalog: AiModelCatalog = {
      provider,
      models: await this.withSavedReadiness(provider, apiKey, models),
      updatedAt: new Date().toISOString(),
      selectionMode: selectedModel.toLowerCase() === "auto" ? "AUTO" : "MANUAL",
      ...(selectedModel.toLowerCase() !== "auto" ? { selectedModelId: selectedModel } : {}),
    };
    await this.saveCatalog(provider, apiKey, catalog);
    return catalog;
  }

  async test(provider: Provider, key: string, model: string): Promise<AiVisionTestResult> {
    const started = Date.now();
    const apiKey = key.trim();
    const result: AiVisionTestResult = {
      ok: false,
      provider,
      modelId: model,
      authentication: false,
      modelAccess: false,
      visionSupported: false,
      structuredOutputSupported: false,
      latencyMs: 0,
      message: "",
    };
    try {
      if (!apiKey) throw new Error("請先設定該服務的 API 金鑰。");
      let targetModel = model;
      if (!targetModel || targetModel.toLowerCase() === "auto") {
        let catalog = await this.readCatalog(provider, apiKey);
        if (!catalog) catalog = await this.refresh(provider, apiKey, "auto");
        const verified = catalog.models.filter((candidate) => candidate.candidate && candidate.capability === "READY");
        if (!verified.length) {
          const candidates = catalog.models
            .filter((candidate) => candidate.candidate && candidate.capability === "UNKNOWN")
            .sort((a, b) => autoRank(a.id) - autoRank(b.id) || a.id.localeCompare(b.id))
            .slice(0, 3);
          for (const candidate of candidates) {
            try {
              if (provider === "OPENAI") await this.testOpenAi(apiKey, candidate.id);
              else await this.testGemini(apiKey, candidate.id);
              await this.markCapability(provider, apiKey, candidate.id, "READY");
              targetModel = candidate.id;
              break;
            } catch (probeError) {
              const status = statusFromError(probeError);
              if (status === 401 || status === 403 || status === 429 || status === 0) throw probeError;
              if (status === 400 || status === 404 || status === 422)
                await this.markCapability(provider, apiKey, candidate.id, "UNSUPPORTED");
            }
          }
          if (!targetModel || targetModel.toLowerCase() === "auto")
            throw new Error("Auto 找不到通過圖片與結構化輸出測試的模型；請手動選擇候選模型再試一次。");
        } else {
          targetModel = verified.sort((a, b) => autoRank(a.id) - autoRank(b.id) || a.id.localeCompare(b.id))[0].id;
          // A connection test must make a current request, not report cached readiness as success.
          if (provider === "OPENAI") await this.testOpenAi(apiKey, targetModel);
          else await this.testGemini(apiKey, targetModel);
        }
      } else {
        if (provider === "OPENAI") await this.testOpenAi(apiKey, targetModel);
        else await this.testGemini(apiKey, targetModel);
      }
      result.modelId = targetModel;
      result.authentication = true;
      result.modelAccess = true;
      result.visionSupported = true;
      result.structuredOutputSupported = true;
      result.ok = true;
      result.message = `模型 ${targetModel} 已通過圖片與結構化輸出實際測試。`;
      await this.markCapability(provider, apiKey, targetModel, "READY");
    } catch (error) {
      result.message = error instanceof Error ? error.message : "模型測試失敗。";
      if (/HTTP 401/.test(result.message)) result.message = "API 金鑰無效或已撤銷（HTTP 401）。";
      if ([400, 404, 422].includes(statusFromError(error)))
        await this.markCapability(provider, apiKey, result.modelId ?? model, "UNSUPPORTED");
    }
    result.latencyMs = Date.now() - started;
    return result;
  }

  async resolve(provider: Provider, key: string, selectedModel: string): Promise<string> {
    if (selectedModel.trim().toLowerCase() !== "auto") return selectedModel.trim();
    const catalog = await this.readCatalog(provider, key);
    const pool = (catalog?.models ?? []).filter((model) => model.candidate && model.capability === "READY");
    pool.sort((a, b) => autoRank(a.id) - autoRank(b.id) || a.id.localeCompare(b.id));
    if (!pool.length) throw new Error("目前沒有已通過圖片與結構化輸出測試的模型；請先重新整理並測試一個模型。");
    return pool[0].id;
  }

  private async listOpenAi(key: string): Promise<Array<{ id: string; created?: number }>> {
    const response = await this.fetcher(OPENAI_MODELS, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await responseJson(response);
    return (Array.isArray(body.data) ? body.data : []).flatMap((item): Array<{ id: string; created?: number }> => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return typeof row.id === "string"
        ? [{ id: row.id, ...(Number.isFinite(row.created) ? { created: Number(row.created) } : {}) }]
        : [];
    });
  }

  private async listGemini(key: string): Promise<Array<{ id: string }>> {
    const models: Array<{ id: string }> = [];
    let pageToken = "";
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(GEMINI_MODELS);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.fetcher(url, {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await responseJson(response);
      if (Array.isArray(body.models))
        for (const item of body.models) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          const id =
            typeof row.baseModelId === "string"
              ? row.baseModelId
              : typeof row.name === "string"
                ? row.name.replace(/^models\//, "")
                : "";
          const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
          if (id && methods.includes("generateContent")) models.push({ id });
        }
      const next = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (!next) break;
      if (seen.has(next)) throw new Error("Gemini 模型清單分頁標記重複，已停止讀取。");
      seen.add(next);
      pageToken = next;
    }
    return models;
  }

  private async testOpenAi(key: string, model: string): Promise<void> {
    const response = await this.fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: 'Look at this tiny test image and return {"ok":true}.' },
              { type: "input_image", image_url: PROBE_IMAGE, detail: "low" },
            ],
          },
        ],
        text: { format: { type: "json_schema", name: "vision_probe", strict: true, schema: PROBE_SCHEMA } },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await responseJson(response, "OpenAI");
    const output = Array.isArray(body.output) ? body.output : [];
    const text =
      (typeof body.output_text === "string" ? body.output_text : "") ||
      output
        .flatMap((item) =>
          item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).content)
            ? ((item as Record<string, unknown>).content as unknown[]).flatMap((part) =>
                part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
                  ? [(part as Record<string, unknown>).text as string]
                  : [],
              )
            : [],
        )
        .join("");
    if (!text) throw new Error("OpenAI 圖片測試沒有傳回結構化結果。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("OpenAI 圖片測試的結構化結果無法解析。");
    }
    if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).ok !== true)
      throw new Error("OpenAI 圖片測試沒有確認預期的 JSON 結果。");
  }

  private async testGemini(key: string, model: string): Promise<void> {
    const response = await this.fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Look at this tiny test image and return whether it is an image." },
                { inlineData: { mimeType: "image/jpeg", data: PROBE_IMAGE.split(",")[1] } },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] },
          },
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    const body = await responseJson(response, "Gemini");
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const content =
      candidates[0] && typeof candidates[0] === "object"
        ? (candidates[0] as Record<string, unknown>).content
        : undefined;
    const parts =
      content && typeof content === "object" && Array.isArray((content as Record<string, unknown>).parts)
        ? ((content as Record<string, unknown>).parts as unknown[])
        : [];
    const text = parts
      .flatMap((part) =>
        part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
          ? [(part as Record<string, unknown>).text as string]
          : [],
      )
      .join("");
    if (!text) throw new Error("Gemini 圖片測試沒有傳回結構化結果。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini 圖片測試的結構化結果無法解析。");
    }
    if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).ok !== true)
      throw new Error("Gemini 圖片測試沒有確認預期的 JSON 結果。");
  }

  private async readFile(): Promise<CatalogFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && (parsed as CatalogFile).schemaVersion === 1)
        return parsed as CatalogFile;
    } catch {
      /* missing or malformed cache is rebuilt */
    }
    return { schemaVersion: 1, catalogs: {} };
  }

  private cacheKey(provider: Provider, key: string): string {
    return `${provider}:${createHash("sha256").update(key).digest("hex")}`;
  }

  private async readCatalog(provider: Provider, key: string): Promise<AiModelCatalog | undefined> {
    const file = await this.readFile();
    const value = file.catalogs[this.cacheKey(provider, key)];
    if (!value || value.provider !== provider || !Array.isArray(value.models)) return undefined;
    return { ...value, models: safeModels(value.models) };
  }

  private async saveCatalog(provider: Provider, key: string, catalog: AiModelCatalog): Promise<void> {
    const file = await this.readFile();
    file.catalogs[this.cacheKey(provider, key)] = { ...catalog, models: safeModels(catalog.models) };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), "utf8");
  }

  private async withSavedReadiness(
    provider: Provider,
    key: string,
    models: AiAvailableModel[],
  ): Promise<AiAvailableModel[]> {
    const prior = await this.readCatalog(provider, key);
    const old = new Map(prior?.models.map((model) => [model.id, model.capability]));
    return models.map((model) => ({ ...model, capability: old.get(model.id) ?? "UNKNOWN" }));
  }

  private async markCapability(
    provider: Provider,
    key: string,
    modelId: string,
    capability: "READY" | "UNSUPPORTED",
  ): Promise<void> {
    const catalog = await this.readCatalog(provider, key);
    if (!catalog) return;
    catalog.models = catalog.models.map((model) => (model.id === modelId ? { ...model, capability } : model));
    await this.saveCatalog(provider, key, catalog);
  }
}
