import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

export function safePreviewFileName(suggestedName: unknown): string {
  const rawName = path.basename(typeof suggestedName === "string" ? suggestedName : "");
  const safeStem = rawName.replace(/\.mp4$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return `${safeStem || "SceneryWalker_preview"}.mp4`;
}

export async function nextAvailableOutputPath(directory: string, fileName: string): Promise<string> {
  const parsed = path.parse(safePreviewFileName(fileName));
  for (let index = 1; index <= 999; index += 1) {
    const suffix = index === 1 ? "" : `_${String(index).padStart(2, "0")}`;
    const candidate = path.join(directory, `${parsed.name}${suffix}.mp4`);
    const existing = await stat(candidate).catch(() => undefined);
    if (!existing) return candidate;
  }
  return path.join(directory, `${parsed.name}_${Date.now()}_${randomUUID().slice(0, 8)}.mp4`);
}
