import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConcatRenderResult,
  PreviewOutputHistorySnapshot,
  PreviewOutputImportResult,
  PreviewOutputPurpose,
  PreviewOutputRecord,
  PreviewResolution,
  RenderVideoCodec,
} from "../../shared/domain";
import { MediaProbe } from "./media-probe";

interface StoredOutput extends Omit<PreviewOutputRecord, "exists"> {}
interface StoredHistory { schemaVersion: 1; outputs: StoredOutput[] }

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function validPurpose(value: unknown): value is PreviewOutputPurpose {
  return value === "CONCAT" || value === "INTRO" || value === "CLIP" || value === "SHORTS" || value === "UNKNOWN";
}

function validResolution(value: unknown): value is PreviewResolution {
  return value === "360P" || value === "480P" || value === "720P" || value === "4K";
}

function validVideoCodec(value: unknown): value is RenderVideoCodec {
  return value === "H265_QSV" || value === "H265" || value === "H264_QSV" || value === "H264";
}

function sanitizeRecord(value: unknown): StoredOutput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<StoredOutput>;
  if (typeof item.jobId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(item.jobId)) return undefined;
  if (typeof item.outputPath !== "string" || !path.isAbsolute(item.outputPath) || path.extname(item.outputPath).toLowerCase() !== ".mp4") return undefined;
  if (!validPurpose(item.purpose) || (item.origin !== "APP_RENDERED" && item.origin !== "IMPORTED_EXISTING")) return undefined;
  if (typeof item.createdAt !== "string" || Number.isNaN(new Date(item.createdAt).valueOf())) return undefined;
  if (!Number.isFinite(item.sizeBytes) || Number(item.sizeBytes) < 0) return undefined;
  return {
    jobId: item.jobId,
    outputPath: path.resolve(item.outputPath),
    fileName: path.basename(item.outputPath),
    purpose: item.purpose,
    origin: item.origin,
    createdAt: item.createdAt,
    sizeBytes: Math.round(Number(item.sizeBytes)),
    durationMs: Number.isFinite(item.durationMs) && Number(item.durationMs) >= 0 ? Math.round(Number(item.durationMs)) : undefined,
    resolution: validResolution(item.resolution) ? item.resolution : undefined,
    videoCodec: validVideoCodec(item.videoCodec) ? item.videoCodec : undefined,
    cancelled: item.cancelled === true,
    includedIntroSegmentCount: Number.isInteger(item.includedIntroSegmentCount) && Number(item.includedIntroSegmentCount) >= 0 ? Number(item.includedIntroSegmentCount) : undefined,
    projectName: typeof item.projectName === "string" && item.projectName.trim() ? item.projectName.trim().slice(0, 160) : undefined,
    aspectRatio: item.aspectRatio === "PORTRAIT_9_16" || item.aspectRatio === "LANDSCAPE_16_9" ? item.aspectRatio : undefined,
  };
}

function isHistory(value: unknown): value is StoredHistory {
  return Boolean(value && typeof value === "object" && (value as Partial<StoredHistory>).schemaVersion === 1 && Array.isArray((value as Partial<StoredHistory>).outputs));
}

export class OutputHistoryStore {
  readonly historyPath: string;
  private history: StoredHistory = { schemaVersion: 1, outputs: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dataRoot: string, private readonly probe = new MediaProbe()) {
    this.historyPath = path.join(dataRoot, "settings", "preview-output-history.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.historyPath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.historyPath, "utf8"));
      if (!isHistory(parsed)) throw new Error("預覽成品紀錄格式不相容");
      const seen = new Set<string>();
      this.history.outputs = parsed.outputs.map(sanitizeRecord).filter((item): item is StoredOutput => {
        if (!item) return false;
        const key = canonicalPath(item.outputPath);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        const backupPath = `${this.historyPath}.invalid-${Date.now()}`;
        try { await rename(this.historyPath, backupPath); } catch { /* Preserve startup even when backup is unavailable. */ }
      }
      this.history = { schemaVersion: 1, outputs: [] };
      await this.saveNow();
    }
  }

  async registerRender(result: ConcatRenderResult, projectName?: string): Promise<PreviewOutputRecord> {
    const record: StoredOutput = {
      jobId: result.jobId,
      outputPath: path.resolve(result.outputPath),
      fileName: path.basename(result.outputPath),
      purpose: result.purpose,
      origin: "APP_RENDERED",
      createdAt: new Date().toISOString(),
      sizeBytes: result.sizeBytes,
      durationMs: result.expectedDurationMs,
      resolution: result.resolution,
      videoCodec: result.videoCodec,
      cancelled: result.cancelled,
      includedIntroSegmentCount: result.includedIntroSegmentCount,
      projectName,
      aspectRatio: result.aspectRatio,
    };
    await this.mutate((outputs) => {
      const key = canonicalPath(record.outputPath);
      return [record, ...outputs.filter((item) => item.jobId !== record.jobId && canonicalPath(item.outputPath) !== key)];
    });
    return { ...record, exists: true };
  }

  async importExisting(filePaths: string[]): Promise<PreviewOutputImportResult> {
    let addedCount = 0; let duplicateCount = 0; const errors: string[] = [];
    const additions: StoredOutput[] = [];
    const known = new Set(this.history.outputs.map((item) => canonicalPath(item.outputPath)));
    for (const source of filePaths) {
      const resolved = path.resolve(source);
      const key = canonicalPath(resolved);
      if (known.has(key)) { duplicateCount += 1; continue; }
      try {
        if (path.extname(resolved).toLowerCase() !== ".mp4") throw new Error("只支援 MP4 預覽檔");
        const file = await stat(resolved);
        if (!file.isFile() || file.size < 1) throw new Error("檔案不存在或為空");
        const media = await this.probe.probe(resolved);
        if (!media.videoCodec) throw new Error("檔案沒有可辨識的影片軌");
        const displayWidth = media.displayWidth ?? media.width;
        const displayHeight = media.displayHeight ?? media.height;
        const resolution = displayWidth === 640 && displayHeight === 360 ? "360P" : displayWidth === 854 && displayHeight === 480 ? "480P" : displayWidth === 1280 && displayHeight === 720 ? "720P" : displayWidth === 3840 && displayHeight === 2160 ? "4K" : undefined;
        const videoCodec = media.videoCodec?.toLowerCase() === "hevc" || media.videoCodec?.toLowerCase() === "h265" ? "H265" : media.videoCodec?.toLowerCase() === "h264" ? "H264" : undefined;
        additions.push({ jobId: randomUUID(), outputPath: resolved, fileName: path.basename(resolved), purpose: "UNKNOWN", origin: "IMPORTED_EXISTING", createdAt: file.birthtime.toISOString(), sizeBytes: file.size, durationMs: media.durationMs, resolution, videoCodec, aspectRatio: displayWidth && displayHeight && displayHeight > displayWidth ? "PORTRAIT_9_16" : "LANDSCAPE_16_9" });
        known.add(key); addedCount += 1;
      } catch (error) { errors.push(`${path.basename(resolved)}：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (additions.length) await this.mutate((outputs) => [...additions.reverse(), ...outputs]);
    return { cancelled: false, addedCount, duplicateCount, errors, history: await this.snapshot() };
  }

  async snapshot(): Promise<PreviewOutputHistorySnapshot> {
    const outputs = await Promise.all(this.history.outputs.map(async (item): Promise<PreviewOutputRecord> => {
      const file = await stat(item.outputPath).catch(() => undefined);
      return { ...structuredClone(item), exists: Boolean(file?.isFile() && file.size > 0), sizeBytes: file?.isFile() ? file.size : item.sizeBytes };
    }));
    return { schemaVersion: 1, outputs };
  }

  async get(jobId: string): Promise<PreviewOutputRecord> {
    if (typeof jobId !== "string") throw new Error("預覽成品 ID 無效。");
    const record = this.history.outputs.find((item) => item.jobId === jobId);
    if (!record) throw new Error("找不到這筆預覽成品紀錄。");
    const file = await stat(record.outputPath).catch(() => undefined);
    if (!file?.isFile() || file.size < 1) throw new Error("預覽成品已移動、刪除或離線；可保留紀錄供日後核對。");
    return { ...structuredClone(record), exists: true, sizeBytes: file.size };
  }

  async removeRecord(jobId: string): Promise<PreviewOutputHistorySnapshot> {
    if (!this.history.outputs.some((item) => item.jobId === jobId)) throw new Error("找不到要移除的預覽成品紀錄。");
    await this.mutate((outputs) => outputs.filter((item) => item.jobId !== jobId));
    return this.snapshot();
  }

  private async mutate(mutator: (outputs: StoredOutput[]) => StoredOutput[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      this.history = { schemaVersion: 1, outputs: mutator(structuredClone(this.history.outputs)) };
      await this.saveNow();
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async saveNow(): Promise<void> {
    const partial = `${this.historyPath}.${process.pid}.partial`;
    await writeFile(partial, `${JSON.stringify(this.history, null, 2)}\n`, "utf8");
    await rename(partial, this.historyPath);
  }
}
