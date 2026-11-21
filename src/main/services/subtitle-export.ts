import { randomUUID } from "node:crypto";
import { copyFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtitleCue, SubtitleExportResult } from "../../shared/domain";
import { validateSubtitleCues } from "../../shared/editing-rules";
import { resolveCueSubtitleWrapLimit, wrapSubtitleText } from "../../shared/subtitle-text";
import { finalizePartialOutput } from "./atomic-output";

export function srtTimestamp(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const ms = value % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function serializeSrt(cues: SubtitleCue[]): string {
  return `${validateSubtitleCues(cues)
    .map(
      (cue, index) =>
        `${index + 1}\r\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\r\n${wrapSubtitleText(cue.text, resolveCueSubtitleWrapLimit(cue.lineWidthChars, undefined, cue.text)).join("\r\n")}`,
    )
    .join("\r\n\r\n")}\r\n`;
}

export async function backupExistingSubtitleOutput(outputPath: string): Promise<string | undefined> {
  try {
    const existing = await stat(outputPath);
    if (!existing.isFile()) throw new Error("字幕輸出位置不是一般檔案，無法建立安全備份。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = path.parse(outputPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(parsed.dir, `${parsed.name}.backup_${stamp}_${randomUUID().slice(0, 8)}${parsed.ext}`);
  await copyFile(outputPath, backupPath, 1);
  return backupPath;
}

export async function exportSrt(
  cues: SubtitleCue[],
  outputPath: string,
  signal?: AbortSignal,
): Promise<SubtitleExportResult> {
  if (path.extname(outputPath).toLowerCase() !== ".srt") throw new Error("字幕必須輸出為 .srt。");
  if (signal?.aborted) throw new DOMException("字幕匯出已取消。", "AbortError");
  const parsed = path.parse(outputPath);
  const partialPath = path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.partial.srt`);
  try {
    await rm(partialPath, { force: true });
    await writeFile(partialPath, serializeSrt(cues), { encoding: "utf8", signal });
    if (signal?.aborted) throw new DOMException("字幕匯出已取消。", "AbortError");
    await finalizePartialOutput(partialPath, outputPath);
    return { outputPath, cueCount: cues.length };
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}
