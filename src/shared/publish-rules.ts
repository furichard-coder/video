import type { AiPublishAssets, PublishChapterCue, PublishTitleCandidate } from "./domain";

export const YOUTUBE_TITLE_LIMIT = 100;
export const YOUTUBE_DESCRIPTION_LIMIT = 5_000;
export const YOUTUBE_CHAPTER_MIN_COUNT = 3;
export const YOUTUBE_CHAPTER_MIN_DURATION_MS = 10_000;

export function youtubeTextLength(value: string): number { return Array.from(value).length; }

export function validateYoutubeTitle(value: string): { value: string; charCount: number } {
  const normalized = value.trim();
  const charCount = youtubeTextLength(normalized);
  if (!normalized || charCount > YOUTUBE_TITLE_LIMIT) throw new Error(`YouTube 標題必須介於 1 到 ${YOUTUBE_TITLE_LIMIT} 個字元（目前 ${charCount}）。`);
  return { value: normalized, charCount };
}

export function isValidYoutubeChapterSet(chapters: PublishChapterCue[], durationMs: number): boolean {
  if (chapters.length < YOUTUBE_CHAPTER_MIN_COUNT || !chapters.length || chapters[0].startMs !== 0) return false;
  for (let index = 0; index < chapters.length; index += 1) {
    const current = chapters[index];
    const next = chapters[index + 1];
    if (!Number.isInteger(current.startMs) || current.startMs < 0 || current.startMs >= durationMs || !current.title.trim()) return false;
    if (next && (next.startMs <= current.startMs || next.startMs - current.startMs < YOUTUBE_CHAPTER_MIN_DURATION_MS)) return false;
    if (!next && durationMs - current.startMs < YOUTUBE_CHAPTER_MIN_DURATION_MS) return false;
  }
  return true;
}

export function chapterText(chapters: PublishChapterCue[]): string {
  return chapters.map((chapter) => {
    const totalSeconds = Math.floor(chapter.startMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")} ${chapter.title.trim()}`;
  }).join("\n");
}

export function mergePublishTitles(existing: PublishTitleCandidate[], generated: PublishTitleCandidate[], mode: "FILL_BLANKS" | "PRESERVE_USER_EDITED" | "REPLACE_AI_DRAFTS"): PublishTitleCandidate[] {
  if (mode === "REPLACE_AI_DRAFTS") return generated;
  const protectedTitles = existing.filter((item) => item.userEdited);
  if (mode === "PRESERVE_USER_EDITED") return [...protectedTitles, ...generated.filter((item) => !protectedTitles.some((old) => old.id === item.id))].slice(0, 5);
  return [...existing, ...generated.filter((item) => !existing.some((old) => old.text === item.text))].slice(0, 5);
}

export function publishAssetsNeedReview(assets: AiPublishAssets, currentMainRevision: number): boolean {
  return assets.stale || assets.mainTimelineRevision !== currentMainRevision;
}

export function validateExternalPublishPayload(value: unknown, candidateIds: Set<string>, durationMs = Number.MAX_SAFE_INTEGER): { titles: Array<{ text: string; reason: string }>; description: string; englishSummary: string; hashtags: string[]; thumbnails: Array<{ candidateId: string; overlayText: string; layout: "LEFT_TEXT" | "RIGHT_TEXT" | "CENTER_TEXT"; colorNote: string; reason: string }>; chapters: Array<{ startMs: number; title: string; description: string }>; warnings: string[] } {
  if (!value || typeof value !== "object") throw new Error("外部 AI 結果必須是 JSON 物件。");
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.titles) || item.titles.length < 3 || item.titles.length > 5) throw new Error("titles 必須有 3–5 筆。" );
  const titles = item.titles.map((raw) => { const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}; const text = typeof entry.text === "string" ? entry.text.trim() : ""; if (!text || youtubeTextLength(text) > 100) throw new Error("外部 AI 標題超過 100 字元或為空。" ); return { text, reason: typeof entry.reason === "string" ? entry.reason.trim() : "外部 AI" }; });
  if (typeof item.description !== "string" || typeof item.englishSummary !== "string" || !Array.isArray(item.hashtags)) throw new Error("外部 AI 結果缺少 description／englishSummary／hashtags。" );
  const hashtags = item.hashtags.filter((tag): tag is string => typeof tag === "string" && /^#[^\s#]+/.test(tag.trim())).map((tag) => tag.trim()); if (!hashtags.length) throw new Error("至少需要一個 hashtag。" );
  if (!Array.isArray(item.thumbnails) || item.thumbnails.length !== 3) throw new Error("外部 AI 必須提供 3 個縮圖概念。" );
  const thumbnails = item.thumbnails.map((raw) => { const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}; const candidateId = String(entry.candidateId ?? ""); if (!candidateIds.has(candidateId)) throw new Error("縮圖概念引用不存在的候選影格。" ); const layout: "LEFT_TEXT" | "RIGHT_TEXT" | "CENTER_TEXT" = entry.layout === "RIGHT_TEXT" || entry.layout === "CENTER_TEXT" ? entry.layout : "LEFT_TEXT"; return { candidateId, overlayText: typeof entry.overlayText === "string" ? entry.overlayText.trim() : "", layout, colorNote: typeof entry.colorNote === "string" ? entry.colorNote.trim() : "", reason: typeof entry.reason === "string" ? entry.reason.trim() : "" }; });
  const chapters = Array.isArray(item.chapters) ? item.chapters.map((raw) => { const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}; const startMs = Number(entry.startMs); if (!Number.isInteger(startMs) || startMs < 0 || startMs >= durationMs || typeof entry.title !== "string" || !entry.title.trim()) throw new Error("外部 AI 章節時間或標題無效。" ); return { startMs, title: entry.title.trim(), description: typeof entry.description === "string" ? entry.description.trim() : "" }; }) : [];
  return { titles, description: item.description.slice(0, 5_000), englishSummary: item.englishSummary.slice(0, 5_000), hashtags, thumbnails, chapters, warnings: Array.isArray(item.warnings) ? item.warnings.filter((warning): warning is string => typeof warning === "string") : [] };
}
