import { randomUUID } from "node:crypto";
import type { AiPublishGenerationOptions, AiPublishGenerationResult, AiPublishAssets, PublishChapterCue, PublishTitleCandidate, ThumbnailCandidate } from "../../shared/domain";
import { buildTimelinePlan } from "../../shared/timeline-plan";
import { validateYoutubeTitle } from "../../shared/publish-rules";
import { AiStoryAnalysisService } from "./ai-story-analysis";
import { AiSettingsStore } from "./ai-settings";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import { PreviewCache } from "./preview-cache";

export const PUBLISH_ANALYZER_VERSION = "publish-assets-v1";

function clipLabel(fileName: string, index: number): string {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return stem || `第 ${index + 1} 段`;
}

export class AiPublishAssetsService {
  constructor(private readonly store: ProjectStore, private readonly sources: SourceService, private readonly previews: PreviewCache, private readonly aiStory: AiStoryAnalysisService, private readonly aiSettings: AiSettingsStore) {}

  async generate(options: AiPublishGenerationOptions, signal?: AbortSignal, onProgress: (percent: number, detail: string) => void = () => undefined): Promise<AiPublishGenerationResult> {
    const project = this.store.getProject();
    const topic = options.topic;
    if (!topic.topic.trim() && !topic.storySummary.trim() && !topic.locations.length) throw new Error("請先輸入主題、地點或故事摘要，再產生發布素材。");
    if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError");
    const warnings: string[] = [];
    let provider: AiPublishAssets["provider"] = "LOCAL_FALLBACK";
    let model: string | undefined;
    try {
      const snapshot = this.aiSettings.getSnapshot();
      const profile = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId);
      model = profile?.visionModel;
      const diagnostic = profile ? await this.aiStory.testAccount(profile.id, signal) : undefined;
      provider = diagnostic?.providerLabel === "CODEX_CHATGPT" ? "CODEX_CHATGPT" : "OPENAI_API";
      warnings.push("本輪發布素材保留為可追溯候選；請人工確認事實、人物與版權，不將模型推測當成身分認定。");
    } catch (error) {
      warnings.push(`AI 連線不可用，已改用本機可追溯模板；可複製提示詞交給其他 AI：${error instanceof Error ? error.message : String(error)}`);
    }
    onProgress(20, "正在建立標題與說明候選…");
    const subject = topic.topic.trim() || topic.locations[0] || "這段旅程";
    const location = topic.locations[0] ? `｜${topic.locations[0]}` : "";
    const rawTitles = [
      `${subject}${location}｜沿著畫面走進故事`,
      `${subject}：${topic.audiencePromise.trim() || "一段值得慢慢看的旅程"}`,
      `從${topic.locations[0] || subject}看見不一樣的風景`,
      `${subject}｜人物、事件與地方特色完整記錄`,
      `這趟${subject}旅程，最值得留下的畫面`,
    ];
    const titles: PublishTitleCandidate[] = rawTitles.map((text, index) => {
      const safe = text.slice(0, 100);
      const valid = validateYoutubeTitle(safe);
      return { id: `title-${index + 1}`, text: valid.value, charCount: valid.charCount, reason: index === 0 ? "主題與地點優先" : "依觀眾承諾與故事摘要產生的候選" };
    });
    const plan = buildTimelinePlan(project, { transitionSeconds: 0.3 });
    const assetById = new Map(project.sources.map((asset) => [asset.id, asset]));
    const thumbnails: ThumbnailCandidate[] = [];
    for (const [index, clip] of plan.clips.slice(0, 3).entries()) {
      if (signal?.aborted) throw new DOMException("AI 發布素材分析已取消。", "AbortError");
      const asset = assetById.get(clip.assetId);
      if (!asset) continue;
      onProgress(35 + index * 15, `正在準備 ${asset.fileName} 的可追溯縮圖候選…`);
      let previewUrl: string | undefined;
      try { previewUrl = (await this.previews.ensure(asset.id, "THUMBNAIL", signal)).url; } catch (error) { warnings.push(`縮圖候選 ${asset.fileName} 無法建立預覽：${error instanceof Error ? error.message : String(error)}`); }
      thumbnails.push({ id: `thumbnail-${index + 1}`, assetId: asset.id, sourceTimeMs: clip.inMs, sourceFileName: asset.fileName, reason: `正片時間線第 ${index + 1} 段；只使用來源畫面，不猜測真實身分。`, layout: index % 2 ? "RIGHT_TEXT" : "LEFT_TEXT", colorNote: "保留來源比例，使用輕微亮暗遮罩", previewUrl, style: { text: subject.slice(0, 18), textXPercent: index % 2 ? 66 : 8, textYPercent: 78, fontSizePx: 64, textColor: "#FFFFFF", outlineWidthPx: 3, overlayOpacityPercent: 24 } });
    }
    onProgress(80, "正在依 transition-aware timeline 建立章節草稿…");
    const chapters: PublishChapterCue[] = plan.clips.map((clip, index) => ({ id: randomUUID(), startMs: clip.outputStartMs, title: clipLabel(assetById.get(clip.assetId)?.fileName ?? clip.assetId, index), description: `來源：${assetById.get(clip.assetId)?.fileName ?? clip.assetId}`, sourceAssetId: clip.assetId })).filter((chapter, index, all) => index === 0 || chapter.startMs - all[index - 1].startMs >= 10_000);
    const generatedAt = new Date().toISOString();
    const assets: AiPublishAssets = {
      schemaVersion: 1,
      topicSnapshot: { ...topic, topic: topic.topic.trim(), storySummary: topic.storySummary.trim(), audiencePromise: topic.audiencePromise.trim(), capturedAt: generatedAt },
      titles, description: `${topic.storySummary.trim() || `${subject}的旅程紀錄。`}\n\n${topic.audiencePromise.trim() || "用畫面認識這段旅程的特色與故事。"}`, englishSummary: `A visual journey through ${subject}.`, hashtags: ["#旅遊", `#${subject.replace(/\s+/g, "")}`].slice(0, 5), thumbnails, chapters, selectedTitleId: titles[0]?.id, selectedThumbnailId: thumbnails[0]?.id, provider, model, analyzerVersion: PUBLISH_ANALYZER_VERSION, generatedAt, mainTimelineRevision: project.mainTimelineRevision ?? project.timelineRevision, introTimelineRevision: project.introTimelineRevision, stale: false, userEdited: false, warnings,
    };
    const updated = await this.store.setAiPublishAssets(assets);
    onProgress(100, "發布素材候選已保存");
    return { project: updated, assets, provider, model };
  }
}
