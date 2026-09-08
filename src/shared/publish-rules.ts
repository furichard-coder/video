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
