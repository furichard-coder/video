import type {
  AiPublishAssets,
  PublishChapterCue,
  PublishTitleCandidate,
  ThumbnailCandidate,
} from "../../shared/domain";
import { isValidYoutubeChapterSet, validateYoutubeTitle, youtubeTextLength } from "../../shared/publish-rules";

export interface PublishCandidateFrame {
  candidateId: string;
  assetId: string;
  sourceTimeMs: number;
  sourceFileName: string;
  framePath: string;
  origin: "INTRO" | "MAIN";
}
export interface PublishGenerationInput {
  topic: { topic: string; locations: string[]; storySummary: string; audiencePromise: string };
  durationMs: number;
  introSummary: Array<{ assetId: string; fileName: string; sourceInMs: number; sourceOutMs: number; order: number }>;
  timelineSummary: Array<{ assetId: string; fileName: string; startMs: number; endMs: number }>;
  candidates: PublishCandidateFrame[];
}

export interface PublishGeneratedDraft {
  titles: PublishTitleCandidate[];
  description: string;
  englishSummary: string;
  hashtags: string[];
  thumbnails: ThumbnailCandidate[];
  chapters: PublishChapterCue[];
  warnings: string[];
}

export const PUBLISH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    titles: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" }, reason: { type: "string" } },
        required: ["text", "reason"],
      },
    },
    description: { type: "string" },
    englishSummary: { type: "string" },
    hashtags: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
    thumbnails: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidateId: { type: "string" },
          overlayText: { type: "string" },
          layout: { type: "string", enum: ["LEFT_TEXT", "RIGHT_TEXT", "CENTER_TEXT"] },
          colorNote: { type: "string" },
          reason: { type: "string" },
        },
        required: ["candidateId", "overlayText", "layout", "colorNote", "reason"],
      },
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          startMs: { type: "integer", minimum: 0 },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["startMs", "title", "description"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["titles", "description", "englishSummary", "hashtags", "thumbnails", "chapters", "warnings"],
} as const;

export function normalizePublishResponse(value: unknown, input: PublishGenerationInput): PublishGeneratedDraft {
  if (!value || typeof value !== "object") throw new Error("AI 發布素材結果不是 JSON 物件。");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.titles) || raw.titles.length < 3 || raw.titles.length > 5)
    throw new Error("AI 標題候選必須為 3–5 筆。");
  const titles = raw.titles.map((item, index) => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const checked = validateYoutubeTitle(typeof entry.text === "string" ? entry.text : "");
    return {
      id: `ai-title-${index + 1}`,
      text: checked.value,
      charCount: checked.charCount,
      reason: typeof entry.reason === "string" ? entry.reason.trim().slice(0, 400) : "AI 建議",
    };
  });
  if (titles.some((item) => youtubeTextLength(item.text) > 100)) throw new Error("AI 標題超過 YouTube 100 字元限制。");
  if (typeof raw.description !== "string" || raw.description.length > 5_000 || typeof raw.englishSummary !== "string")
    throw new Error("AI 說明欄位無效。");
  const hashtags = Array.isArray(raw.hashtags)
    ? raw.hashtags
        .filter((item): item is string => typeof item === "string" && /^#[^\s#]+/.test(item.trim()))
        .map((item) => item.trim())
        .slice(0, 12)
    : [];
  if (!hashtags.length) throw new Error("AI 必須回傳至少一個 hashtag。");
  const frames = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (!Array.isArray(raw.thumbnails) || raw.thumbnails.length !== 3) throw new Error("AI 必須回傳 3 個縮圖概念。");
  const thumbnails = raw.thumbnails.map((item, index) => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const frame = frames.get(String(entry.candidateId ?? ""));
    if (!frame) throw new Error("AI 縮圖概念引用了未提供的候選影格。");
    const layout: ThumbnailCandidate["layout"] =
      entry.layout === "RIGHT_TEXT" || entry.layout === "CENTER_TEXT" ? entry.layout : "LEFT_TEXT";
    return {
      id: `thumbnail-${index + 1}`,
      assetId: frame.assetId,
      sourceTimeMs: frame.sourceTimeMs,
      sourceFileName: frame.sourceFileName,
      reason: typeof entry.reason === "string" ? entry.reason.trim().slice(0, 500) : "AI 構圖建議",
      layout,
      colorNote: typeof entry.colorNote === "string" ? entry.colorNote.trim().slice(0, 200) : "保留來源色彩",
      previewUrl: undefined,
      style: {
        text: typeof entry.overlayText === "string" ? entry.overlayText.trim().slice(0, 40) : "",
        textXPercent: layout === "RIGHT_TEXT" ? 72 : layout === "LEFT_TEXT" ? 28 : 50,
        textYPercent: 78,
        fontSizePx: 64,
        textColor: "#FFFFFF",
        outlineWidthPx: 3,
        overlayOpacityPercent: 24,
      },
    };
  });
  const chapters: PublishChapterCue[] = Array.isArray(raw.chapters)
    ? raw.chapters.flatMap((item, index) => {
        const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const startMs = Number(entry.startMs);
        if (!Number.isInteger(startMs) || startMs < 0 || typeof entry.title !== "string" || !entry.title.trim())
          return [];
        return [
          {
            id: `ai-chapter-${index + 1}`,
            startMs,
            title: entry.title.trim().slice(0, 120),
            description: typeof entry.description === "string" ? entry.description.trim().slice(0, 500) : "",
          },
        ];
      })
    : [];
  if (chapters.length && !isValidYoutubeChapterSet(chapters, input.durationMs))
    throw new Error("AI 章節不符合 YouTube 時間規則。");
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  return {
    titles,
    description: raw.description.trim(),
    englishSummary: raw.englishSummary.trim(),
    hashtags,
    thumbnails,
    chapters,
    warnings,
  };
}

export function applyGeneratedDraft(
  base: AiPublishAssets | undefined,
  draft: PublishGeneratedDraft,
  metadata: Pick<
    AiPublishAssets,
    | "topicSnapshot"
    | "provider"
    | "model"
    | "analyzerVersion"
    | "generatedAt"
    | "mainTimelineRevision"
    | "introTimelineRevision"
  >,
): AiPublishAssets {
  const protectedTitles = new Map(
    (base?.titles ?? []).filter((item) => item.userEdited).map((item) => [item.id, item]),
  );
  const titles = draft.titles.map((item) => protectedTitles.get(item.id) ?? item).slice(0, 5);
  return {
    schemaVersion: 1,
    topicSnapshot: metadata.topicSnapshot,
    titles,
    description: base?.userEdited ? base.description : draft.description,
    englishSummary: base?.userEdited ? base.englishSummary : draft.englishSummary,
    hashtags: base?.userEdited ? base.hashtags : draft.hashtags,
    thumbnails: draft.thumbnails,
    chapters: draft.chapters,
    selectedTitleId: titles[0]?.id,
    selectedThumbnailId: draft.thumbnails[0]?.id,
    provider: metadata.provider,
    model: metadata.model,
    analyzerVersion: metadata.analyzerVersion,
    generatedAt: metadata.generatedAt,
    mainTimelineRevision: metadata.mainTimelineRevision,
    introTimelineRevision: metadata.introTimelineRevision,
    stale: false,
    userEdited: Boolean(base?.userEdited),
    warnings: draft.warnings,
  };
}
