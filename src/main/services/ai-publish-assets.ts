import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AiPublishGenerationOptions, AiPublishGenerationResult, AiPublishAssets, PublishChapterCue, PublishTitleCandidate, ThumbnailCandidate } from "../../shared/domain";
import { buildTimelinePlan } from "../../shared/timeline-plan";
import { isValidYoutubeChapterSet, validateYoutubeTitle } from "../../shared/publish-rules";
import { applyGeneratedDraft, type PublishGenerationInput } from "./publish-generation";
import { OpenAiProvider } from "./openai-provider";
import { CodexCliStoryProvider } from "./codex-cli-provider";
import path from "node:path";
import { AiStoryAnalysisService } from "./ai-story-analysis";
import { AiSettingsStore } from "./ai-settings";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import { PreviewCache } from "./preview-cache";
import { renderThumbnail } from "./thumbnail-render";
import { GeminiPublishReviewProvider } from "./gemini-publish-review";

export const PUBLISH_ANALYZER_VERSION = "publish-assets-v3-chatgpt-primary-gemini-review";

function clipLabel(fileName: string, index: number): string {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return stem || `第 ${index + 1} 段`;
}

export interface PublishVisualSelection {
  candidateId: string;
  assetId: string;
  sourceTimeMs: number;
  sourceFileName: string;
  origin: "INTRO" | "MAIN";
}

export function selectPublishVisualCandidates(project: ReturnType<ProjectStore["getProject"]>): PublishVisualSelection[] {
  const plan = buildTimelinePlan(project);
  const assetById = new Map(project.sources.map((asset) => [asset.id, asset]));
  const selected: Array<Omit<PublishVisualSelection, "candidateId">> = [];
  const add = (assetId: string, sourceTimeMs: number, origin: "INTRO" | "MAIN") => {
    const asset = assetById.get(assetId);
    if (!asset) return;
    const normalizedTimeMs = asset.kind === "IMAGE" ? 0 : Math.max(0, Math.round(sourceTimeMs));
    if (selected.some((item) => item.assetId === assetId && Math.abs(item.sourceTimeMs - normalizedTimeMs) < 500)) return;
    selected.push({ assetId, sourceTimeMs: normalizedTimeMs, sourceFileName: asset.fileName, origin });
  };
  for (const segment of project.introSegments) {
    add(segment.assetId, segment.inMs + (segment.outMs - segment.inMs) * 0.5, "INTRO");
    if (selected.length >= 3) break;
  }
  for (const clip of plan.clips) {
    if (selected.length >= 3) break;
    add(clip.assetId, clip.inMs + (clip.outMs - clip.inMs) * 0.5, "MAIN");
  }
  const ranges = project.introSegments.length
    ? project.introSegments.map((item) => ({ assetId: item.assetId, inMs: item.inMs, outMs: item.outMs, origin: "INTRO" as const }))
    : plan.clips.map((item) => ({ assetId: item.assetId, inMs: item.inMs, outMs: item.outMs, origin: "MAIN" as const }));
  for (const fraction of [0.25, 0.75, 0.1, 0.9]) {
    for (const range of ranges) {
      if (selected.length >= 3) break;
      add(range.assetId, range.inMs + (range.outMs - range.inMs) * fraction, range.origin);
    }
  }
  const uniqueCount = selected.length;
  for (let index = 0; selected.length > 0 && selected.length < 3; index += 1) selected.push({ ...selected[index % uniqueCount] });
  return selected.slice(0, 3).map((item, index) => ({ ...item, candidateId: `thumbnail-${index + 1}` }));
}

export class AiPublishAssetsService {
  constructor(private readonly store: ProjectStore, private readonly sources: SourceService, private readonly previews: PreviewCache, private readonly aiStory: AiStoryAnalysisService, private readonly aiSettings: AiSettingsStore, private readonly openAi = new OpenAiProvider(), private readonly codex = new CodexCliStoryProvider(path.join(previews.cacheRoot, "codex-publish")), private readonly gemini = new GeminiPublishReviewProvider()) {}

  private async applyGeminiReview(assets: AiPublishAssets, input: PublishGenerationInput, signal?: AbortSignal): Promise<void> {
    const settings = this.aiSettings.getRuntimeGeminiReview();
    if (!settings.enabled) {
      assets.geminiReview = { enabled: false, status: "NOT_CONFIGURED", model: settings.model, summary: "Gemini 輔助復核未啟用；本次由 ChatGPT 主生成。", warnings: [] };
      return;
    }
    if (!settings.apiKey) {
      assets.geminiReview = { enabled: true, status: "NOT_CONFIGURED", model: settings.model, summary: "已啟用 Gemini 輔助，但尚未設定可用的 Gemini API Key。", warnings: ["本次沒有執行 Gemini 復核。"] };
      return;
    }
    try {
      assets.geminiReview = await this.gemini.review(assets, input, { model: settings.model, apiKey: settings.apiKey }, signal);
      if (assets.geminiReview.recommendedTitleId) assets.selectedTitleId = assets.geminiReview.recommendedTitleId;
      if (assets.geminiReview.recommendedThumbnailId) assets.selectedThumbnailId = assets.geminiReview.recommendedThumbnailId;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      assets.geminiReview = { enabled: true, status: "FAILED", model: settings.model, summary: "ChatGPT 主生成已保留；Gemini 第二次復核未完成。", warnings: [message] };
      assets.warnings.push(`Gemini 輔助復核失敗：${message}`);
    }
  }

  private async materializeThumbnailPreviews(assets: AiPublishAssets, signal: AbortSignal | undefined, onProgress: (percent: number, detail: string) => void): Promise<void> {
    const directory = path.join(this.previews.cacheRoot, "publish-thumbnails");
    await mkdir(directory, { recursive: true });
    for (const [index, candidate] of assets.thumbnails.entries()) {
      if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError");
      const asset = this.store.getAsset(candidate.assetId);
      if (!asset) { assets.warnings.push(`縮圖候選來源已不存在：${candidate.sourceFileName}`); continue; }
      const cacheKey = createHash("sha256").update(JSON.stringify({ analyzer: PUBLISH_ANALYZER_VERSION, source: asset.previewCacheKey, candidate })).digest("hex");
      const outputPath = path.join(directory, `${cacheKey}.jpg`);
      onProgress(86 + index * 4, `正在合成縮圖候選 ${index + 1}／${assets.thumbnails.length}…`);
      try {
        await renderThumbnail(asset, candidate, outputPath, "jpg");
        candidate.outputPath = outputPath;
        candidate.previewUrl = `preview-media://publish-thumbnail/${encodeURIComponent(candidate.id)}?key=${cacheKey}`;
      } catch (error) {
        assets.warnings.push(`縮圖候選 ${index + 1} 無法合成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async generate(options: AiPublishGenerationOptions, signal?: AbortSignal, onProgress: (percent: number, detail: string) => void = () => undefined): Promise<AiPublishGenerationResult> {
    const project = this.store.getProject();
    const topic = options.topic;
    if (!topic.topic.trim() && !topic.storySummary.trim() && !topic.locations.length) throw new Error("請先輸入主題、地點或故事摘要，再產生發布素材。");
    if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError");
    const warnings: string[] = [];
    let provider: AiPublishAssets["provider"] = "LOCAL_FALLBACK";
    let model: string | undefined;
    const snapshot = this.aiSettings.getSnapshot();
    model = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId)?.visionModel;
    onProgress(20, "正在建立標題與說明候選…");
    const subject = topic.topic.trim() || topic.locations[0] || "這段旅程";
    const location = topic.locations[0] ? `｜${topic.locations[0]}` : "";
    const promise = topic.audiencePromise.trim() || "一段值得慢慢看的旅程";
    const locationName = topic.locations[0] || subject;
    const rawTitles = [
      `${subject}${location}｜${promise}`,
      `${locationName}深度漫步：${subject}的自然與地方故事`,
      `${subject}完整紀錄｜Scenery Walk #旅遊`,
      `第一次這樣看${locationName}：風景、細節與沿途發現`,
      `${subject}值得停下來看的畫面｜Travel Highlights`,
    ];
    const titles: PublishTitleCandidate[] = rawTitles.map((text, index) => {
      const safe = text.slice(0, 100);
      const valid = validateYoutubeTitle(safe);
      return { id: `title-${index + 1}`, text: valid.value, charCount: valid.charCount, reason: index === 0 ? "主題與地點優先" : "依觀眾承諾與故事摘要產生的候選" };
    });
    const plan = buildTimelinePlan(project);
    const assetById = new Map(project.sources.map((asset) => [asset.id, asset]));
    const visualSelections = selectPublishVisualCandidates(project);
    if (!visualSelections.length) throw new Error("目前沒有可追溯的片頭或正片畫面，無法產生標題與縮圖建議。");
    const thumbnails: ThumbnailCandidate[] = [];
    for (const [index, selection] of visualSelections.entries()) {
      if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError");
      const asset = assetById.get(selection.assetId);
      if (!asset) continue;
      onProgress(35 + index * 12, `正在擷取${selection.origin === "INTRO" ? "片頭" : "正片"}畫面：${asset.fileName}…`);
      let previewUrl: string | undefined;
      try { previewUrl = (await this.previews.ensure(asset.id, "THUMBNAIL", signal)).url; } catch (error) { warnings.push(`縮圖候選 ${asset.fileName} 無法建立預覽：${error instanceof Error ? error.message : String(error)}`); }
      thumbnails.push({ id: selection.candidateId, assetId: asset.id, sourceTimeMs: selection.sourceTimeMs, sourceFileName: asset.fileName, reason: `${selection.origin === "INTRO" ? "已選片頭" : "正片時間線"}畫面；只使用來源內容，不猜測真實身分。`, layout: index % 2 ? "RIGHT_TEXT" : "LEFT_TEXT", colorNote: "保留來源比例，使用輕微亮暗遮罩", previewUrl, style: { text: subject.slice(0, 18), textXPercent: index % 2 ? 66 : 28, textYPercent: 78, fontSizePx: 64, textColor: "#FFFFFF", outlineWidthPx: 3, overlayOpacityPercent: 24 } });
    }
    const candidates: PublishGenerationInput["candidates"] = [];
    const analysisFrameDirectory = path.join(this.previews.cacheRoot, "publish-analysis-frames");
    await mkdir(analysisFrameDirectory, { recursive: true });
    for (const selection of visualSelections) {
      const asset = assetById.get(selection.assetId); if (!asset) continue;
      const candidate = thumbnails.find((item) => item.id === selection.candidateId);
      if (!candidate) continue;
      const frameKey = createHash("sha256").update(`${PUBLISH_ANALYZER_VERSION}\0${asset.previewCacheKey}\0${selection.sourceTimeMs}`).digest("hex");
      const framePath = path.join(analysisFrameDirectory, `${frameKey}.jpg`);
      try {
        await renderThumbnail(asset, { ...candidate, style: { ...candidate.style, text: "", overlayOpacityPercent: 0 } }, framePath, "jpg");
        candidates.push({ ...selection, framePath });
      }
      catch (error) { warnings.push(`AI 候選影格無法建立：${asset.fileName}；${error instanceof Error ? error.message : String(error)}`); }
    }
    const timelineDurationMs = plan.durationMs;
    const generationInput: PublishGenerationInput = { topic: { topic: topic.topic.trim(), locations: topic.locations, storySummary: topic.storySummary.trim(), audiencePromise: topic.audiencePromise.trim() }, durationMs: timelineDurationMs, introSummary: project.introSegments.map((segment, order) => ({ assetId: segment.assetId, fileName: assetById.get(segment.assetId)?.fileName ?? segment.fileName, sourceInMs: segment.inMs, sourceOutMs: segment.outMs, order: order + 1 })), timelineSummary: plan.clips.map((clip) => ({ assetId: clip.assetId, fileName: assetById.get(clip.assetId)?.fileName ?? clip.assetId, startMs: clip.outputStartMs, endMs: clip.outputStartMs + clip.outMs - clip.inMs })), candidates };
    try {
      const model = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId)?.visionModel ?? "gpt-5.6-terra"; onProgress(55, "正在由 Codex／ChatGPT 分析片頭畫面並主生成標題、縮圖與說明…");
      const generated = await this.codex.generatePublishAssets(generationInput, model, signal); const generatedAt = new Date().toISOString();
      const generatedAssets = applyGeneratedDraft(project.aiPublishAssets, generated.draft, { topicSnapshot: { ...topic, capturedAt: generatedAt }, provider: "CODEX_CHATGPT", model: generated.model, analyzerVersion: PUBLISH_ANALYZER_VERSION, generatedAt, mainTimelineRevision: project.mainTimelineRevision ?? project.timelineRevision, introTimelineRevision: project.introTimelineRevision });
      for (const thumbnail of generatedAssets.thumbnails) thumbnail.previewUrl = thumbnails.find((item) => item.assetId === thumbnail.assetId && item.sourceTimeMs === thumbnail.sourceTimeMs)?.previewUrl;
      await this.materializeThumbnailPreviews(generatedAssets, signal, onProgress);
      onProgress(97, "正在執行可選的 Gemini 第二次復核…"); await this.applyGeminiReview(generatedAssets, generationInput, signal);
      const latest = this.store.getProject(); if (latest.id !== project.id || (latest.mainTimelineRevision ?? latest.timelineRevision) !== (project.mainTimelineRevision ?? project.timelineRevision)) throw new Error("專案或正片時間線在 AI 生成期間已變更，結果未套用，請重新產生。" );
      const updated = await this.store.setAiPublishAssets(generatedAssets); onProgress(100, "ChatGPT 主生成發布素材已保存"); return { project: updated, assets: generatedAssets, provider: "CODEX_CHATGPT" as const, model: generated.model };
    } catch (codexError) {
      if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError"); warnings.push(`Codex／ChatGPT 主生成失敗：${codexError instanceof Error ? codexError.message : String(codexError)}`);
      try {
        const account = this.aiSettings.getRuntimeAccount(); onProgress(65, "ChatGPT 登入模式不可用，改用 OpenAI API 主生成…");
        const generated = await this.openAi.generatePublishAssets(generationInput, account, signal); const generatedAt = new Date().toISOString();
        const generatedAssets = applyGeneratedDraft(project.aiPublishAssets, generated.draft, { topicSnapshot: { ...topic, capturedAt: generatedAt }, provider: "OPENAI_API", model: generated.model, analyzerVersion: PUBLISH_ANALYZER_VERSION, generatedAt, mainTimelineRevision: project.mainTimelineRevision ?? project.timelineRevision, introTimelineRevision: project.introTimelineRevision });
        generatedAssets.warnings.unshift(...warnings);
        for (const thumbnail of generatedAssets.thumbnails) thumbnail.previewUrl = thumbnails.find((item) => item.assetId === thumbnail.assetId && item.sourceTimeMs === thumbnail.sourceTimeMs)?.previewUrl;
        await this.materializeThumbnailPreviews(generatedAssets, signal, onProgress);
        onProgress(97, "正在執行可選的 Gemini 第二次復核…"); await this.applyGeminiReview(generatedAssets, generationInput, signal);
        const latest = this.store.getProject(); if (latest.id !== project.id || (latest.mainTimelineRevision ?? latest.timelineRevision) !== (project.mainTimelineRevision ?? project.timelineRevision)) throw new Error("專案或正片時間線在 AI 生成期間已變更，結果未套用，請重新產生。" );
        const updated = await this.store.setAiPublishAssets(generatedAssets); onProgress(100, "OpenAI API 備援發布素材已保存"); return { project: updated, assets: generatedAssets, provider: "OPENAI_API" as const, model: generated.model };
      } catch (openAiError) {
        if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError"); warnings.push(`OpenAI API 備援生成失敗：${openAiError instanceof Error ? openAiError.message : String(openAiError)}`);
      }
    }
    onProgress(80, "正在依 transition-aware timeline 建立離線 fallback 草稿…");
    const draftChapters: PublishChapterCue[] = plan.clips.map((clip, index) => ({ id: randomUUID(), startMs: clip.outputStartMs, title: clipLabel(assetById.get(clip.assetId)?.fileName ?? clip.assetId, index), description: `來源：${assetById.get(clip.assetId)?.fileName ?? clip.assetId}`, sourceAssetId: clip.assetId })).filter((chapter, index, all) => index === 0 || chapter.startMs - all[index - 1].startMs >= 10_000);
    const chapters = isValidYoutubeChapterSet(draftChapters, timelineDurationMs) ? draftChapters : [];
    if (!chapters.length) warnings.push("目前正片太短或章節數不足 3 段；章節草稿暫不啟用，請調整時間後再重跑或手動新增。" );
    const generatedAt = new Date().toISOString();
    const assets: AiPublishAssets = {
      schemaVersion: 1,
      topicSnapshot: { ...topic, topic: topic.topic.trim(), storySummary: topic.storySummary.trim(), audiencePromise: topic.audiencePromise.trim(), capturedAt: generatedAt },
      titles, description: `${topic.storySummary.trim() || `${subject}的旅程紀錄。`}\n\n${topic.audiencePromise.trim() || "用畫面認識這段旅程的特色與故事。"}`, englishSummary: `A visual journey through ${subject}.`, hashtags: ["#旅遊", `#${subject.replace(/\s+/g, "")}`].slice(0, 5), thumbnails, chapters, selectedTitleId: titles[0]?.id, selectedThumbnailId: thumbnails[0]?.id, provider, model, analyzerVersion: PUBLISH_ANALYZER_VERSION, generatedAt, mainTimelineRevision: project.mainTimelineRevision ?? project.timelineRevision, introTimelineRevision: project.introTimelineRevision, stale: false, userEdited: false, warnings,
    };
    await this.materializeThumbnailPreviews(assets, signal, onProgress);
    await this.applyGeminiReview(assets, generationInput, signal);
    const updated = await this.store.setAiPublishAssets(assets);
    onProgress(100, "發布素材候選已保存");
    return { project: updated, assets, provider, model };
  }
}
