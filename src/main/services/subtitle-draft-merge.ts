import type { SubtitleVisionDraft } from "./subtitle-vision-orchestrator";

export function mergeSubtitleVisionDrafts(
  drafts: readonly SubtitleVisionDraft[],
  options: { durationMs: number; maxCharsPerLine?: number; mergeGapMs?: number },
): SubtitleVisionDraft[] {
  const maxChars = Math.max(6, Math.min(60, Math.round(options.maxCharsPerLine ?? 60)));
  const gap = Math.max(0, Math.min(5_000, Math.round(options.mergeGapMs ?? 1_200)));
  const ordered = [...drafts]
    .filter((d) => d.text.trim() && d.startMs >= 0 && d.endMs > d.startMs && d.startMs < options.durationMs)
    .map((d) => ({ ...d, endMs: Math.min(options.durationMs, d.endMs), text: d.text.trim() }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: SubtitleVisionDraft[] = [];
  for (const draft of ordered) {
    const previous = merged.at(-1);
    const sameText = previous && previous.text === draft.text;
    const sameEvidence = previous && previous.provenance.join("|") === draft.provenance.join("|");
    if (previous && sameText && sameEvidence && draft.startMs - previous.endMs <= gap) {
      previous.endMs = Math.max(previous.endMs, draft.endMs);
      previous.confidence = Math.min(previous.confidence, draft.confidence);
      continue;
    }
    const lines = draft.text.split(/\r?\n/);
    if (lines.some((line) => [...line].length > maxChars)) {
      draft.warning = [draft.warning, `字幕單行超過 ${maxChars} 字，需人工縮短。`].filter(Boolean).join(" ");
    }
    const last = merged.at(-1);
    if (last && draft.startMs < last.endMs) draft.startMs = last.endMs;
    if (draft.endMs > draft.startMs) merged.push(draft);
  }
  return merged;
}
