import type { AiModelCatalog, AiVisionTestResult } from "../../shared/domain";
import type {
  SubtitleDensity,
  SubtitleVisionCache,
  SubtitleVisionFrame,
  SubtitleVisionLanguage,
  SubtitleVisionProvider,
  SubtitleVisionRunProgress,
  SubtitleVisionResumeState,
} from "./subtitle-vision-orchestrator";
import { runSubtitleVisionDrafts } from "./subtitle-vision-orchestrator";
import {
  GeminiSubtitleVisionProvider,
  OpenAiSubtitleVisionProvider,
  SubtitleVisionRequestError,
} from "./subtitle-vision-providers";

type ProviderKind = "OPENAI" | "GEMINI";
type CatalogClient = Pick<import("./ai-model-catalog").AiModelCatalogService, "refresh" | "test">;

export interface SubtitleVisionFallbackOptions {
  catalog: CatalogClient;
  apiKey: string;
  selectionMode: "AUTO" | "MANUAL";
  onFallback?: (previousModel: string, nextModel: string, reason: SubtitleVisionRequestError) => void;
  createProvider?: (kind: ProviderKind, model: string, apiKey: string) => SubtitleVisionProvider;
}

export interface SubtitleVisionBatchOptions {
  batchSize?: number;
  density?: SubtitleDensity;
  language?: SubtitleVisionLanguage;
  signal?: AbortSignal;
  onProgress?: (progress: SubtitleVisionRunProgress) => void;
}

function modelFromVersion(provider: SubtitleVisionProvider): string {
  const separator = provider.version.indexOf(":");
  return separator >= 0 ? provider.version.slice(separator + 1) : "";
}

function modelRank(modelId: string): [number, number, number, string] {
  const match = modelId.toLowerCase().match(/(?:gpt-|gemini-)(\d+)(?:\.(\d+))?/);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2] ?? 0) : 0;
  const smaller = /(?:mini|nano|lite)/i.test(modelId) ? 1 : 0;
  return [100 - major, 10 - minor, smaller, modelId];
}

function compareModels(a: AiModelCatalog["models"][number], b: AiModelCatalog["models"][number]): number {
  if (a.capability === "READY" && b.capability !== "READY") return -1;
  if (b.capability === "READY" && a.capability !== "READY") return 1;
  const left = modelRank(a.id);
  const right = modelRank(b.id);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3].localeCompare(right[3]);
}

function probeStatus(result: AiVisionTestResult): number | undefined {
  const match = result.message.match(/HTTP (\d{3})/);
  return match ? Number(match[1]) : undefined;
}

function defaultProvider(kind: ProviderKind, model: string, apiKey: string): SubtitleVisionProvider {
  return kind === "OPENAI"
    ? new OpenAiSubtitleVisionProvider(model, apiKey)
    : new GeminiSubtitleVisionProvider(model, apiKey);
}

/**
 * Run one orchestrator-sized batch. In Auto mode, only typed model/capability
 * failures can select another model, and the replacement must pass the same
 * minimal image plus structured-output probe before any batch is retried.
 */
export async function runSubtitleVisionBatchWithFallback(
  frames: readonly SubtitleVisionFrame[],
  initialProvider: SubtitleVisionProvider,
  cache: SubtitleVisionCache,
  options: SubtitleVisionBatchOptions,
  fallback: SubtitleVisionFallbackOptions,
): Promise<{ result: SubtitleVisionResumeState; provider: SubtitleVisionProvider }> {
  try {
    const result = await runSubtitleVisionDrafts(frames, initialProvider, cache, options);
    return { result, provider: initialProvider };
  } catch (error) {
    if (
      fallback.selectionMode !== "AUTO" ||
      !(error instanceof SubtitleVisionRequestError) ||
      (error.failure !== "MODEL_UNAVAILABLE" &&
        error.failure !== "CAPABILITY_UNSUPPORTED" &&
        error.failure !== "RATE_LIMITED")
    )
      throw error;

    const kind = initialProvider.kind;
    const failedModel = modelFromVersion(initialProvider);
    const catalog = await fallback.catalog.refresh(kind, fallback.apiKey, "auto");
    const candidates = [...catalog.models]
      .filter((model) => model.candidate && model.capability !== "UNSUPPORTED" && model.id !== failedModel)
      .sort(compareModels)
      .slice(0, 3);
    const createProvider = fallback.createProvider ?? defaultProvider;
    let probeFailures = 0;
    for (const candidate of candidates) {
      const probe = await fallback.catalog.test(kind, fallback.apiKey, candidate.id);
      if (!probe.ok || !probe.modelId) {
        const status = probeStatus(probe);
        if (status === 400 || status === 404 || status === 422) {
          probeFailures += 1;
          continue;
        }
        throw new Error(probe.message || "候選字幕模型圖片測試失敗；未切換模型。");
      }
      const selected = createProvider(kind, probe.modelId, fallback.apiKey);
      fallback.onFallback?.(failedModel, probe.modelId, error);
      const result = await runSubtitleVisionDrafts(frames, selected, cache, options);
      return { result, provider: selected };
    }
    throw new Error(
      probeFailures
        ? `Auto 找不到通過圖片與結構化輸出測試的同一服務模型（已測試 ${probeFailures} 個候選）。`
        : "Auto 沒有其他可測試的同一服務模型；未切換 Provider。",
    );
  }
}
