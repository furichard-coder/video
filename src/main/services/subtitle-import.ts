import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SubtitleCue, SubtitleImportResult } from "../../shared/domain";
import { validateSubtitleCues } from "../../shared/editing-rules";

const MAX_SRT_BYTES = 10 * 1024 * 1024;
const MAX_SRT_CUES = 10_000;

function parseTimestamp(value: string): number {
  const match = value.trim().match(/^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/);
  if (!match) throw new Error(`SRT 時間格式無效：${value.trim()}`);
  const milliseconds = Number(match[4].padEnd(3, "0"));
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + milliseconds;
}

export function parseSrt(contents: string, idFactory: () => string = randomUUID): SubtitleCue[] {
  const normalized = contents
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) throw new Error("SRT 檔案沒有字幕內容。");
  const blocks = normalized.split(/\n{2,}/);
  if (blocks.length > MAX_SRT_CUES) throw new Error(`SRT 最多支援 ${MAX_SRT_CUES} 筆字幕。`);
  const cues = blocks.map((block, index): SubtitleCue => {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) throw new Error(`SRT 第 ${index + 1} 段缺少時間範圍。`);
    const timing = lines[timingIndex].split(/\s*-->\s*/);
    if (timing.length !== 2) throw new Error(`SRT 第 ${index + 1} 段時間範圍無效。`);
    const startToken = timing[0].trim().split(/\s+/)[0];
    const endToken = timing[1].trim().split(/\s+/)[0];
    const text = lines
      .slice(timingIndex + 1)
      .join("\n")
      .trim();
    if (!text) throw new Error(`SRT 第 ${index + 1} 段字幕文字不可空白。`);
    return {
      id: idFactory(),
      startMs: parseTimestamp(startToken),
      endMs: parseTimestamp(endToken),
      text,
      origin: "IMPORTED_SRT",
      reviewStatus: "CONFIRMED",
    };
  });
  return validateSubtitleCues(cues);
}

export async function importSrtFile(filePath: string): Promise<SubtitleImportResult> {
  if (path.extname(filePath).toLowerCase() !== ".srt") throw new Error("請選擇 .srt 字幕檔。");
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error("選取的 SRT 路徑不是檔案。");
  if (file.size > MAX_SRT_BYTES) throw new Error("SRT 檔案超過 10 MB，請先確認檔案內容。");
  const contents = await readFile(filePath, "utf8");
  return { filePath, fileName: path.basename(filePath), cues: parseSrt(contents) };
}
