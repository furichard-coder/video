import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtitleVisionCache, SubtitleVisionDraft } from "./subtitle-vision-orchestrator";

export class DiskSubtitleVisionCache implements SubtitleVisionCache {
  constructor(private readonly root: string) {}
  private file(key: string): string {
    return path.join(this.root, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  async get(key: string): Promise<SubtitleVisionDraft[] | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.file(key), "utf8"));
      return Array.isArray(parsed?.drafts) ? parsed.drafts : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }
  async set(key: string, drafts: readonly SubtitleVisionDraft[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.file(key);
    const partial = `${target}.${process.pid}.partial`;
    await writeFile(partial, JSON.stringify({ schemaVersion: 1, drafts }), { encoding: "utf8", flag: "wx" });
    await rename(partial, target);
  }
}
