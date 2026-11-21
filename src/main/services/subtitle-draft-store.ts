import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtitleCue } from "../../shared/domain";
import { validateSubtitleCues } from "../../shared/editing-rules";
import { parseSrt } from "./subtitle-import";
import { serializeSrt } from "./subtitle-export";

export const MAX_SUBTITLE_DRAFT_CUE_DURATION_MS = 10 * 60 * 1000;

export type SubtitleDraftConflictChoice = "BACKUP" | "SAVE_AS" | "OVERWRITE" | "CANCEL";

export interface SubtitleDraftPreflight {
  officialPath: string;
  draftPath: string;
  officialExists: boolean;
  choices: SubtitleDraftConflictChoice[];
  defaultChoice: "BACKUP";
}

export interface SubtitleDraftPromotionResult {
  cancelled: boolean;
  outputPath?: string;
  backupPath?: string;
}

function assertSrtPath(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== ".srt") throw new Error("字幕必須使用 .srt 檔名。");
}

export function subtitleAiDraftPath(officialPath: string): string {
  assertSrtPath(officialPath);
  const parsed = path.parse(officialPath);
  return path.join(parsed.dir, `${parsed.name}.ai-draft${parsed.ext}`);
}

function validateDraftCueSequence(cues: SubtitleCue[]): SubtitleCue[] {
  if (!Array.isArray(cues) || cues.length === 0) throw new Error("AI 字幕草稿至少需要一筆字幕。");

  const timelineRank = (cue: SubtitleCue) => (cue.timelineScope === "INTRO" ? 0 : 1);
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (!cue || typeof cue.text !== "string" || !cue.text.trim())
      throw new Error(`第 ${index + 1} 筆字幕文字不可空白。`);
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs))
      throw new Error(`第 ${index + 1} 筆字幕時間無效。`);
    const durationMs = Math.round(cue.endMs) - Math.round(cue.startMs);
    if (durationMs > MAX_SUBTITLE_DRAFT_CUE_DURATION_MS) {
      throw new Error(`第 ${index + 1} 筆字幕不可超過 10 分鐘。`);
    }
    if (index === 0) continue;

    const previous = cues[index - 1];
    const currentRank = timelineRank(cue);
    const previousRank = timelineRank(previous);
    if (currentRank < previousRank || (currentRank === previousRank && cue.startMs < previous.startMs)) {
      throw new Error("AI 字幕草稿必須依時間線與開始時間排序。");
    }
    if (currentRank === previousRank && Math.round(cue.startMs) < Math.round(previous.endMs)) {
      throw new Error("AI 字幕草稿不可重疊。");
    }
  }

  return validateSubtitleCues(cues);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) throw new Error(`字幕路徑不是一般檔案：${filePath}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function partialPathFor(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.partial${parsed.ext}`);
}

/** Writes an AI draft beside its official SRT, leaving any previous draft intact on failure. */
export async function writeSubtitleAiDraft(
  officialPath: string,
  cues: SubtitleCue[],
  signal?: AbortSignal,
): Promise<{ draftPath: string; cueCount: number }> {
  const draftPath = subtitleAiDraftPath(officialPath);
  const validated = validateDraftCueSequence(cues);
  if (signal?.aborted) throw new DOMException("字幕草稿寫入已取消。", "AbortError");

  const partialPath = partialPathFor(draftPath);
  try {
    await writeFile(partialPath, serializeSrt(validated), { encoding: "utf8", flag: "wx", signal });
    if (signal?.aborted) throw new DOMException("字幕草稿寫入已取消。", "AbortError");
    await rename(partialPath, draftPath);
    return { draftPath, cueCount: validated.length };
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}

/** Reports the official-file conflict options; BACKUP is the suggested choice. */
export async function preflightSubtitleAiDraft(officialPath: string): Promise<SubtitleDraftPreflight> {
  assertSrtPath(officialPath);
  return {
    officialPath,
    draftPath: subtitleAiDraftPath(officialPath),
    officialExists: await pathExists(officialPath),
    choices: ["BACKUP", "SAVE_AS", "OVERWRITE", "CANCEL"],
    defaultChoice: "BACKUP",
  };
}

function timestampForFilename(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}-${three(date.getMilliseconds())}`;
}

async function backupOfficialWithoutClobber(officialPath: string): Promise<string> {
  const parsed = path.parse(officialPath);
  const stamp = timestampForFilename(new Date());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const backupPath = path.join(parsed.dir, `${parsed.name}.backup-${stamp}${suffix}${parsed.ext}`);
    try {
      await copyFile(officialPath, backupPath, constants.COPYFILE_EXCL);
      return backupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("找不到可用的字幕備份檔名。");
}

/** Promotes a previously written draft only after an explicit conflict choice. The draft is retained. */
export async function promoteSubtitleAiDraft(
  officialPath: string,
  choice: SubtitleDraftConflictChoice,
  options: { saveAsPath?: string; signal?: AbortSignal } = {},
): Promise<SubtitleDraftPromotionResult> {
  assertSrtPath(officialPath);
  if (!["BACKUP", "SAVE_AS", "OVERWRITE", "CANCEL"].includes(choice)) throw new Error("字幕衝突處理選項無效。");
  if (choice === "CANCEL") return { cancelled: true };

  const draftPath = subtitleAiDraftPath(officialPath);
  if (!(await pathExists(draftPath))) throw new Error("找不到 AI 字幕草稿。");
  if (options.signal?.aborted) throw new DOMException("字幕草稿發佈已取消。", "AbortError");

  let outputPath = officialPath;
  if (choice === "SAVE_AS") {
    if (!options.saveAsPath) throw new Error("另存字幕需要指定新的 .srt 路徑。");
    assertSrtPath(options.saveAsPath);
    outputPath = options.saveAsPath;
    if (await pathExists(outputPath)) throw new Error("另存路徑已存在，請選擇新的檔名。");
  }

  const officialExists = choice === "SAVE_AS" ? false : await pathExists(officialPath);
  const partialPath = partialPathFor(outputPath);
  let backupPath: string | undefined;
  try {
    // Validate the stored bytes too, so a damaged or manually changed draft cannot be promoted.
    const draftContents = await readFile(draftPath, "utf8");
    validateDraftCueSequence(parseSrt(draftContents));
    await copyFile(draftPath, partialPath, constants.COPYFILE_EXCL);
    if (options.signal?.aborted) throw new DOMException("字幕草稿發佈已取消。", "AbortError");

    if (choice === "SAVE_AS") {
      // Linking is atomic and fails if another file appears at the selected destination.
      await link(partialPath, outputPath);
      await rm(partialPath, { force: true });
    } else {
      if (choice === "BACKUP" && officialExists) backupPath = await backupOfficialWithoutClobber(officialPath);
      if (options.signal?.aborted) throw new DOMException("字幕草稿發佈已取消。", "AbortError");
      await rename(partialPath, officialPath);
    }
    return { cancelled: false, outputPath, backupPath };
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}
