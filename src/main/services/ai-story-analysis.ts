import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiAnalysisProgress, AiSubtitleGenerationOptions, AiSubtitleGenerationResult, IntroSuggestion, ProjectManifest, RenderClipSelection, SourceAsset, SubtitleCue, SubtitleTimelineScope, VoiceInputLanguage, VoiceInputRequest, VoiceInputResult } from "../../shared/domain";
import { mainRenderSelections } from "../../shared/editing-rules";
import { AiSettingsStore } from "./ai-settings";
import { CodexCliStoryProvider, type CodexStoryRequest } from "./codex-cli-provider";
import { OpenAiProvider, type OpenAiConnectionDiagnostic, type StoryFrameAnalysis, type TranscriptionSegment } from "./openai-provider";
import { assertSafeHexId, assertWithinRoot } from "./path-safety";
import { ProjectStore } from "./project-store";
import { runProcess } from "./process-runner";
import { SourceService } from "./source-service";
import { finalizePartialOutput } from "./atomic-output";

export const AI_STORY_ANALYZER_VERSION = "story-match-v2-codex-fallback";
const MAX_AUDIO_CHUNK_MS = 240_000;
const MAX_GENERATED_CUES = 100;
const MAX_VOICE_INPUT_BYTES = 25 * 1024 * 1024;
const VOICE_MIME_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);

interface Candidate {
  origin: "AI_SPEECH" | "AI_VISUAL";
  timelineScope: SubtitleTimelineScope;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceAsset: SourceAsset;
  sourceStartMs: number;
  sourceEndMs: number;
  transcript: string;
  speaker?: string;
}

interface VisualCache {
  analyzerVersion: string;
  result: StoryFrameAnalysis;
}

function contextReady(project: ProjectManifest, mode: "SUBTITLE" | "INTRO" = "SUBTITLE"): boolean {
  const context = project.aiStoryContext;
  return Boolean(context?.topic.trim() || context?.storySummary.trim() || context?.locations.length || context?.people.length || (mode === "INTRO" && context?.introPrompt?.trim()));
}

function overlaps(cue: Pick<SubtitleCue, "startMs" | "endMs">, occupied: Array<Pick<SubtitleCue, "startMs" | "endMs">>): boolean {
  return occupied.some((item) => Math.max(cue.startMs, item.startMs) < Math.min(cue.endMs, item.endMs));
}

function clipDuration(clip: RenderClipSelection): number { return Math.max(0, clip.outMs - clip.inMs); }

function stableKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AiStoryAnalysisService {
  private storyReadinessKey = "";
  private storyReadinessExpiresAt = 0;
  private codexFallbackReadinessKey = "";
  private codexFallbackReadinessExpiresAt = 0;

  constructor(
    readonly cacheRoot: string,
    private readonly store: ProjectStore,
    private readonly sources: SourceService,
    private readonly settings: AiSettingsStore,
    private readonly provider = new OpenAiProvider(),
    private readonly codexProvider = new CodexCliStoryProvider(cacheRoot),
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.cacheRoot, "audio"), { recursive: true }),
      mkdir(path.join(this.cacheRoot, "frames"), { recursive: true }),
      mkdir(path.join(this.cacheRoot, "results"), { recursive: true }),
    ]);
  }

  async testAccount(accountId: string, signal?: AbortSignal): Promise<OpenAiConnectionDiagnostic> {
    try { return await this.provider.testConnection(this.settings.getRuntimeAccount(accountId), signal); }
    catch (openAiError) {
      try {
        const codex = await this.codexProvider.testConnection(signal);
        return { checks: [...codex.checks, `OpenAI API 不可用，已確認可改用 ${codex.providerLabel}`], requestIds: [], providerLabel: "CODEX_CHATGPT" };
      } catch (codexError) {
        throw new Error(`OpenAI API 測試未通過：${openAiError instanceof Error ? openAiError.message : String(openAiError)}；Codex／ChatGPT 備援也不可用：${codexError instanceof Error ? codexError.message : String(codexError)}`);
      }
    }
  }

  async transcribeVoiceInput(request: VoiceInputRequest, signal?: AbortSignal): Promise<VoiceInputResult> {
    if (!request || !VOICE_MIME_TYPES.has(request.mimeType.split(";")[0].trim().toLowerCase())) {
      throw new Error("麥克風錄音格式不支援，請改用 WebM、Ogg、M4A、MP3 或 WAV。");
    }
    if (request.language !== "zh-TW" && request.language !== "en-US") throw new Error("語音輸入語言無效。");
    const unknownBytes = request.audioBytes as unknown;
    const bytes = unknownBytes instanceof Uint8Array
      ? unknownBytes
      : ArrayBuffer.isView(unknownBytes)
        ? new Uint8Array(unknownBytes.buffer, unknownBytes.byteOffset, unknownBytes.byteLength)
        : undefined;
    if (!bytes?.byteLength) throw new Error("沒有收到麥克風錄音內容。");
    if (bytes.byteLength > MAX_VOICE_INPUT_BYTES) throw new Error("單次語音輸入不可超過 25 MB，請縮短錄音後重試。");
    const mimeType = request.mimeType.split(";")[0].trim().toLowerCase();
    const extension = mimeType.includes("webm") ? "webm" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "m4a" : "mp3";
    const account = this.settings.getRuntimeAccount();
    const result = await this.provider.transcribeBytes(bytes, `voice-input.${extension}`, mimeType, account, request.language === "zh-TW" ? "zh" : "en", signal);
    const text = result.segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("沒有辨識到語音。請靠近麥克風、縮短停頓後再試一次。");
    return { text, language: request.language, segmentCount: result.segments.length };
  }

  async generateSubtitles(
    options: AiSubtitleGenerationOptions = { includeSpeechTranscription: false },
    signal?: AbortSignal,
    onProgress: (progress: AiAnalysisProgress) => void = () => undefined,
  ): Promise<AiSubtitleGenerationResult> {
    const project = this.store.getProject();
    if (!contextReady(project, "SUBTITLE")) throw new Error("請先在 AI 帳號設定填寫專案主題、故事、人物或地點，再產生字幕草稿。");
    const snapshot = this.settings.getSnapshot();
    const profile = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId);
    if (!profile) throw new Error("找不到作用中的 AI 帳號設定。");
    if (signal?.aborted) throw new DOMException("AI 字幕分析已取消。", "AbortError");
    onProgress({ phase: "PREPARING", processed: 0, total: 1, currentName: `正在確認 ${profile.name}；API 不可用時會安全改用 Codex／ChatGPT 登入…` });
    const readinessKey = stableKey({ accountId: profile.id, accountUpdatedAt: profile.updatedAt, model: profile.visionModel });
    let account: ReturnType<AiSettingsStore["getRuntimeAccount"]> | undefined;
    let storyBackend: "OPENAI_API" | "CODEX_CHATGPT" = "OPENAI_API";
    let openAiFailure = "";
    if (this.codexFallbackReadinessKey === readinessKey && Date.now() < this.codexFallbackReadinessExpiresAt) {
      storyBackend = "CODEX_CHATGPT";
    } else {
      try {
        account = this.settings.getRuntimeAccount();
        if (this.storyReadinessKey !== readinessKey || Date.now() >= this.storyReadinessExpiresAt) {
          await this.provider.testStoryConnection(account, signal);
          this.storyReadinessKey = readinessKey;
          this.storyReadinessExpiresAt = Date.now() + 10 * 60_000;
        }
      } catch (error) {
        openAiFailure = error instanceof Error ? error.message : String(error);
        try {
          await this.codexProvider.testConnection(signal);
          storyBackend = "CODEX_CHATGPT";
          this.codexFallbackReadinessKey = readinessKey;
          this.codexFallbackReadinessExpiresAt = Date.now() + 10 * 60_000;
        } catch (codexError) {
          throw new Error(`AI 字幕尚未開始分析。OpenAI API 不可用：${openAiFailure}；Codex／ChatGPT 登入備援也不可用：${codexError instanceof Error ? codexError.message : String(codexError)}`);
        }
      }
    }
    if (storyBackend === "CODEX_CHATGPT" && options.includeSpeechTranscription) {
      throw new Error(`目前已改用 Codex／ChatGPT 登入產生知識型字幕，但它不接收本機音訊。請取消勾選「同時分析素材語音」後重試；若需要語音辨識，OpenAI API 仍需可用。原 API 原因：${openAiFailure}`);
    }
    const scopes = [...new Set(options.scopes?.length ? options.scopes : ["MAIN"])] as SubtitleTimelineScope[];
    if (scopes.some((scope) => scope !== "INTRO" && scope !== "MAIN")) throw new Error("字幕分析範圍無效。");
    const plans = scopes.map((timelineScope) => ({
      timelineScope,
      clips: timelineScope === "INTRO"
        ? project.introSegments.map((clip) => ({ assetId: clip.assetId, inMs: clip.inMs, outMs: clip.outMs }))
        : mainRenderSelections(project),
    }));
    const totalClips = plans.reduce((sum, plan) => sum + plan.clips.length, 0);
    if (!totalClips) throw new Error(scopes.length === 1 && scopes[0] === "INTRO" ? "片頭沒有可分析的片段。" : "所選片頭／正片沒有可分析的保留片段。");
    onProgress({ phase: "PREPARING", processed: 0, total: totalClips });
    const assetById = new Map(project.sources.map((asset) => [asset.id, asset]));
    const confirmed = project.subtitleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED");
    const candidates: Candidate[] = [];
    let processedClips = 0;

    for (const plan of plans) {
      let timelineOffsetMs = 0;
      const confirmedInScope = confirmed.filter((cue) => (cue.timelineScope ?? "MAIN") === plan.timelineScope);
      for (const clip of plan.clips) {
        if (signal?.aborted) throw new DOMException("AI 字幕分析已取消。", "AbortError");
        const asset = assetById.get(clip.assetId);
        const durationMs = clipDuration(clip);
        if (!asset) { timelineOffsetMs += durationMs; processedClips += 1; continue; }
        const ready = await this.sources.ensureMetadata(asset.id, signal);
        if (durationMs >= 800) {
          const visualDuration = Math.min(4_000, durationMs);
          const localStart = Math.max(0, Math.round((durationMs - visualDuration) / 2));
          const candidate: Candidate = {
            origin: "AI_VISUAL",
            timelineScope: plan.timelineScope,
            timelineStartMs: timelineOffsetMs + localStart,
            timelineEndMs: timelineOffsetMs + localStart + visualDuration,
            sourceAsset: asset,
            sourceStartMs: clip.inMs + localStart,
            sourceEndMs: clip.inMs + localStart + visualDuration,
            transcript: "",
          };
          if (!overlaps({ startMs: candidate.timelineStartMs, endMs: candidate.timelineEndMs }, confirmedInScope)) candidates.push(candidate);
        }
        if (asset.kind === "VIDEO" && options.includeSpeechTranscription && ready.mediaInfo?.audioCodec) {
          for (let chunkOffsetMs = 0; chunkOffsetMs < durationMs; chunkOffsetMs += MAX_AUDIO_CHUNK_MS) {
            const chunkDurationMs = Math.min(MAX_AUDIO_CHUNK_MS, durationMs - chunkOffsetMs);
            onProgress({ phase: "EXTRACTING_AUDIO", processed: processedClips, total: totalClips, currentName: asset.fileName });
            const audioPath = await this.extractAudio(asset, clip.inMs + chunkOffsetMs, chunkDurationMs, signal);
            try {
              onProgress({ phase: "TRANSCRIBING", processed: processedClips, total: totalClips, currentName: asset.fileName });
              const segments = await this.provider.transcribe(audioPath, account!, project.aiStoryContext.subtitleLanguage, signal);
              for (const segment of segments) {
                const candidate = this.speechCandidate(asset, clip, timelineOffsetMs, chunkOffsetMs, chunkDurationMs, segment, plan.timelineScope);
                if (candidate && !overlaps({ startMs: candidate.timelineStartMs, endMs: candidate.timelineEndMs }, confirmedInScope)) candidates.push(candidate);
              }
            } finally { await rm(audioPath, { force: true }); }
          }
        }
        timelineOffsetMs += durationMs;
        processedClips += 1;
        if (candidates.length >= MAX_GENERATED_CUES) break;
      }
      if (candidates.length >= MAX_GENERATED_CUES) break;
    }

    const drafts: SubtitleCue[] = [];
    const limited = candidates.slice(0, MAX_GENERATED_CUES);
    const codexAnalyses = storyBackend === "CODEX_CHATGPT"
      ? await this.analyzeCandidatesWithCodex(limited, project, profile.visionModel, signal, onProgress)
      : undefined;
    for (let index = 0; index < limited.length; index += 1) {
      if (signal?.aborted) throw new DOMException("AI 字幕分析已取消。", "AbortError");
      const candidate = limited[index];
      onProgress({ phase: "SAMPLING_FRAMES", processed: index, total: limited.length, currentName: candidate.sourceAsset.fileName });
      onProgress({ phase: "MATCHING_STORY", processed: index, total: limited.length, currentName: candidate.sourceAsset.fileName });
      const analysis = codexAnalyses?.get(index) ?? await this.analyzeCandidate(candidate, project, account!, "SUBTITLE", signal);
      const text = (analysis.suggestedSubtitle || candidate.transcript || analysis.visualSummary).trim();
      if (!text) continue;
      const cue: SubtitleCue = {
        id: randomUUID(),
        startMs: candidate.timelineStartMs,
        endMs: candidate.timelineEndMs,
        text,
        timelineScope: candidate.timelineScope,
        origin: candidate.origin,
        // AI suggestions are immediately usable for preview/export. The user can
        // still move any cue back to DRAFT or reject it in SubtitleStudio.
        reviewStatus: "CONFIRMED",
        speaker: candidate.speaker,
        sourceAssetId: candidate.sourceAsset.id,
        sourceInMs: candidate.sourceStartMs,
        sourceOutMs: candidate.sourceEndMs,
        visualSummary: analysis.visualSummary,
        eventSummary: analysis.eventSummary,
        peopleSummary: analysis.peopleSummary,
        locationSummary: analysis.locationSummary,
        topicRelevanceScore: analysis.topicRelevanceScore,
        transcriptVisualMatchScore: analysis.transcriptVisualMatchScore,
        aiConfidence: analysis.confidence,
        aiWarnings: analysis.warnings,
        aiAnalysisVersion: AI_STORY_ANALYZER_VERSION,
      };
      const occupied = [...confirmed, ...drafts].filter((item) => (item.timelineScope ?? "MAIN") === candidate.timelineScope);
      if (!overlaps(cue, occupied)) drafts.push(cue);
    }
    onProgress({ phase: "SAVING_DRAFTS", processed: limited.length, total: limited.length });
    const updated = await this.store.replaceAiSubtitleDrafts(drafts, scopes, options.mode ?? "FILL_BLANKS");
    return {
      project: updated,
      generatedCount: drafts.length,
      transcribedCount: drafts.filter((cue) => cue.origin === "AI_SPEECH").length,
      visualOnlyCount: drafts.filter((cue) => cue.origin === "AI_VISUAL").length,
      skippedConfirmedCount: candidates.length - limited.length + candidates.filter((candidate) => overlaps({ startMs: candidate.timelineStartMs, endMs: candidate.timelineEndMs }, confirmed)).length,
      accountName: storyBackend === "CODEX_CHATGPT" ? "Codex／ChatGPT 登入（API 額度備援）" : profile.name,
      analysisVersion: AI_STORY_ANALYZER_VERSION,
      providerLabel: storyBackend === "CODEX_CHATGPT" ? "CODEX_CHATGPT" : "OPENAI_API",
    };
  }

  async enrichIntroSuggestions(suggestions: IntroSuggestion[], signal?: AbortSignal): Promise<{ suggestions: IntroSuggestion[]; analyzedCount: number; fallbackReason?: string }> {
    if (!suggestions.length) return { suggestions, analyzedCount: 0 };
    const project = this.store.getProject();
    if (!contextReady(project, "INTRO")) return { suggestions, analyzedCount: 0, fallbackReason: "尚未設定片頭文字指示或故事主題／人物／地點，使用本機畫面統計。" };
    let account;
    try { account = this.settings.getRuntimeAccount(); }
    catch (error) { return { suggestions, analyzedCount: 0, fallbackReason: error instanceof Error ? error.message : String(error) }; }
    const enriched: IntroSuggestion[] = [];
    const failures: string[] = [];
    let terminalFailure: string | undefined;
    for (const suggestion of suggestions) {
      if (signal?.aborted) throw new DOMException("片頭分析已取消。", "AbortError");
      if (terminalFailure) {
        enriched.push({ ...suggestion, analysisMode: "LOCAL_SIGNAL_ONLY", aiWarnings: [`雲端語意分析未執行：${terminalFailure}`] });
        continue;
      }
      const asset = this.store.getAsset(suggestion.assetId);
      if (!asset || asset.kind !== "VIDEO") { enriched.push(suggestion); continue; }
      try {
        let spokenSummary = "";
        if (asset.mediaInfo?.audioCodec) {
          const audioPath = await this.extractAudio(asset, suggestion.inMs, suggestion.outMs - suggestion.inMs, signal);
          try { spokenSummary = (await this.provider.transcribe(audioPath, account, project.aiStoryContext.subtitleLanguage, signal)).map((segment) => segment.text).join(" ").trim(); }
          finally { await rm(audioPath, { force: true }); }
        }
        const candidate: Candidate = { origin: "AI_SPEECH", timelineScope: "INTRO", timelineStartMs: 0, timelineEndMs: suggestion.outMs - suggestion.inMs, sourceAsset: asset, sourceStartMs: suggestion.inMs, sourceEndMs: suggestion.outMs, transcript: spokenSummary };
        const analysis = await this.analyzeCandidate(candidate, project, account, "INTRO", signal);
        const storyMatchScore = Math.min(100, analysis.topicRelevanceScore + (analysis.eventSummary ? 8 : 0) + (analysis.peopleSummary.length ? 8 : 0) + (analysis.locationSummary.length ? 4 : 0));
        const combinedScore = Math.round(suggestion.score * 0.2 + storyMatchScore * 0.55 + analysis.transcriptVisualMatchScore * 0.15 + analysis.confidence * 0.1);
        enriched.push({
          ...suggestion,
          score: combinedScore,
          analysisMode: "OPENAI_STORY_MATCH",
          storyRelevanceScore: analysis.topicRelevanceScore,
          eventSummary: analysis.eventSummary,
          peopleSummary: analysis.peopleSummary,
          locationSummary: analysis.locationSummary,
          spokenSummary,
          aiConfidence: analysis.confidence,
          aiWarnings: analysis.warnings,
          reasons: [analysis.eventSummary || analysis.visualSummary, analysis.peopleSummary.length ? `人物 ${analysis.peopleSummary.join("、")}` : "", `人物／事件／故事 ${storyMatchScore}`, `聲畫符合 ${analysis.transcriptVisualMatchScore}`].filter(Boolean),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        if (/(credit_balance_exhausted|沒有可用 API 額度|API Key 無效|無法解密|尚未設定 OpenAI API Key)/i.test(message)) terminalFailure = message;
        enriched.push({ ...suggestion, analysisMode: "LOCAL_SIGNAL_ONLY", aiWarnings: [`雲端語意分析失敗：${message}`] });
      }
    }
    const analyzedCount = enriched.filter((item) => item.analysisMode === "OPENAI_STORY_MATCH").length;
    const fallbackReason = failures.length
      ? analyzedCount === 0
        ? `OpenAI 人物／事件／故事比對未完成；本次全部是本機畫面統計。${failures[0]}`
        : `${failures.length} 段 OpenAI 比對失敗並改用本機畫面統計；請逐段查看警告。`
      : undefined;
    return { suggestions: enriched.sort((left, right) => right.score - left.score), analyzedCount, fallbackReason };
  }

  private speechCandidate(asset: SourceAsset, clip: RenderClipSelection, timelineOffsetMs: number, chunkOffsetMs: number, chunkDurationMs: number, segment: TranscriptionSegment, timelineScope: SubtitleTimelineScope): Candidate | undefined {
    const localStart = Math.max(0, Math.min(chunkDurationMs, segment.startMs));
    const localEnd = Math.max(localStart + 100, Math.min(chunkDurationMs, segment.endMs));
    if (localEnd <= localStart || !segment.text.trim()) return undefined;
    return {
      origin: "AI_SPEECH",
      timelineScope,
      timelineStartMs: timelineOffsetMs + chunkOffsetMs + localStart,
      timelineEndMs: timelineOffsetMs + chunkOffsetMs + localEnd,
      sourceAsset: asset,
      sourceStartMs: clip.inMs + chunkOffsetMs + localStart,
      sourceEndMs: clip.inMs + chunkOffsetMs + localEnd,
      transcript: segment.text.trim(),
      speaker: segment.speaker,
    };
  }

  private async extractAudio(asset: SourceAsset, startMs: number, durationMs: number, signal?: AbortSignal): Promise<string> {
    assertSafeHexId(asset.id, "Asset ID");
    const output = assertWithinRoot(path.join(this.cacheRoot, "audio"), path.join(this.cacheRoot, "audio", `${asset.id}-${Math.round(startMs)}-${Math.round(durationMs)}-${randomUUID()}.mp3`));
    try {
      await runProcess(this.ffmpegExecutable, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(startMs / 1000), "-t", String(durationMs / 1000), "-i", asset.sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", "-y", output], signal);
      return output;
    } catch (error) { await rm(output, { force: true }); throw error; }
  }

  private async analyzeCandidatesWithCodex(
    candidates: Candidate[],
    project: ProjectManifest,
    model: string,
    signal: AbortSignal | undefined,
    onProgress: (progress: AiAnalysisProgress) => void,
  ): Promise<Map<number, StoryFrameAnalysis>> {
    const resultByIndex = new Map<number, StoryFrameAnalysis>();
    const missing: Array<{ index: number; key: string; resultPath: string; request: CodexStoryRequest }> = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if (signal?.aborted) throw new DOMException("AI 字幕分析已取消。", "AbortError");
      const candidate = candidates[index];
      const key = stableKey({ version: AI_STORY_ANALYZER_VERSION, backend: "CODEX_CHATGPT", mode: "SUBTITLE", source: candidate.sourceAsset.previewCacheKey, start: candidate.sourceStartMs, end: candidate.sourceEndMs, transcript: candidate.transcript, context: project.aiStoryContext, model });
      const resultPath = assertWithinRoot(path.join(this.cacheRoot, "results"), path.join(this.cacheRoot, "results", `${key}.json`));
      try {
        const cached = JSON.parse(await readFile(resultPath, "utf8")) as VisualCache;
        if (cached.analyzerVersion === AI_STORY_ANALYZER_VERSION && cached.result) { resultByIndex.set(index, cached.result); continue; }
      } catch { /* cache miss */ }
      onProgress({ phase: "SAMPLING_FRAMES", processed: index, total: candidates.length, currentName: candidate.sourceAsset.fileName });
      const framePath = await this.extractStoryboard(candidate.sourceAsset, candidate.sourceStartMs, candidate.sourceEndMs, key, signal);
      missing.push({
        index,
        key,
        resultPath,
        request: {
          id: key,
          framePath,
          request: { mode: "SUBTITLE", transcript: candidate.transcript, context: project.aiStoryContext, sourceFileName: candidate.sourceAsset.fileName },
        },
      });
    }
    if (missing.length) {
      onProgress({ phase: "MATCHING_STORY", processed: resultByIndex.size, total: candidates.length, currentName: `Codex／ChatGPT 正在批次判斷 ${missing.length} 個畫面時段…` });
      const analyzed = await this.codexProvider.analyzeStoryFramesBatch(missing.map((item) => item.request), model, signal);
      for (const item of missing) {
        const result = analyzed.get(item.key);
        if (!result) throw new Error(`Codex 沒有傳回第 ${item.index + 1} 個時段的字幕判斷。`);
        await this.writeAnalysisCache(item.resultPath, result);
        resultByIndex.set(item.index, result);
      }
    }
    return resultByIndex;
  }

  private async writeAnalysisCache(resultPath: string, result: StoryFrameAnalysis): Promise<void> {
    const partial = `${resultPath}.${process.pid}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify({ analyzerVersion: AI_STORY_ANALYZER_VERSION, result }, null, 2)}\n`, "utf8");
      await finalizePartialOutput(partial, resultPath);
    } catch (error) { await rm(partial, { force: true }); throw error; }
  }

  private async analyzeCandidate(candidate: Candidate, project: ProjectManifest, account: ReturnType<AiSettingsStore["getRuntimeAccount"]>, mode: "SUBTITLE" | "INTRO", signal?: AbortSignal): Promise<StoryFrameAnalysis> {
    const key = stableKey({ version: AI_STORY_ANALYZER_VERSION, backend: "OPENAI_API", mode, source: candidate.sourceAsset.previewCacheKey, start: candidate.sourceStartMs, end: candidate.sourceEndMs, transcript: candidate.transcript, context: project.aiStoryContext, model: account.visionModel });
    const resultPath = assertWithinRoot(path.join(this.cacheRoot, "results"), path.join(this.cacheRoot, "results", `${key}.json`));
    try {
      const cached = JSON.parse(await readFile(resultPath, "utf8")) as VisualCache;
      if (cached.analyzerVersion === AI_STORY_ANALYZER_VERSION && cached.result) return cached.result;
    } catch { /* cache miss */ }
    const framePath = await this.extractStoryboard(candidate.sourceAsset, candidate.sourceStartMs, candidate.sourceEndMs, key, signal);
    const frame = `data:image/jpeg;base64,${(await readFile(framePath)).toString("base64")}`;
    const result = await this.provider.analyzeStoryFrames({ mode, transcript: candidate.transcript, frames: [frame], context: project.aiStoryContext, sourceFileName: candidate.sourceAsset.fileName }, account, signal);
    await this.writeAnalysisCache(resultPath, result);
    return result;
  }

  private async extractStoryboard(asset: SourceAsset, startMs: number, endMs: number, key: string, signal?: AbortSignal): Promise<string> {
    const output = assertWithinRoot(path.join(this.cacheRoot, "frames"), path.join(this.cacheRoot, "frames", `${key}.jpg`));
    try { await readFile(output); return output; } catch { /* create */ }
    const duration = Math.max(100, endMs - startMs);
    const times = [startMs + duration * 0.1, startMs + duration * 0.5, startMs + duration * 0.9].map((value) => Math.max(0, value / 1000));
    const partial = `${output}.${process.pid}.jpg`;
    try {
      if (asset.kind === "IMAGE") {
        await runProcess(this.ffmpegExecutable, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", asset.sourcePath, "-vf", "scale=1080:720:force_original_aspect_ratio=decrease,pad=1080:720:(ow-iw)/2:(oh-ih)/2:black", "-frames:v", "1", "-q:v", "4", "-y", partial], signal);
        await rename(partial, output);
        return output;
      }
      await runProcess(this.ffmpegExecutable, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        ...times.flatMap((time) => ["-ss", String(time), "-i", asset.sourcePath]),
        "-filter_complex", "[0:v]scale=360:240:force_original_aspect_ratio=decrease,pad=360:240:(ow-iw)/2:(oh-ih)/2:black[a];[1:v]scale=360:240:force_original_aspect_ratio=decrease,pad=360:240:(ow-iw)/2:(oh-ih)/2:black[b];[2:v]scale=360:240:force_original_aspect_ratio=decrease,pad=360:240:(ow-iw)/2:(oh-ih)/2:black[c];[a][b][c]hstack=inputs=3[out]",
        "-map", "[out]", "-frames:v", "1", "-q:v", "4", "-y", partial,
      ], signal);
      await rename(partial, output);
      return output;
    } catch (error) { await rm(partial, { force: true }); throw error; }
  }
}
