import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderBenchmarkResult, RenderPerformanceProfile, RenderVideoCodec } from "../../shared/domain";
import { runProcess } from "./process-runner";

const MODES = new Set<RenderBenchmarkResult["mode"]>([
  "ORIGINAL_NORMAL_2",
  "NORMAL_2",
  "NORMAL_3",
  "NORMAL_4",
  "HIGH_SPEED_H264",
  "H265",
]);

export class RenderBenchmarkService {
  private readonly profilePath: string;

  constructor(dataRoot: string, private readonly scriptPath: string) {
    this.profilePath = path.join(dataRoot, "performance", "render-performance-profile.json");
  }

  async run(): Promise<RenderPerformanceProfile> {
    const result = await runProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.scriptPath,
      "-ClipSeconds",
      "60",
    ]);
    const raw = JSON.parse(result.stdout) as Record<string, unknown>;
    if (raw.schemaVersion !== 1 || typeof raw.fingerprint !== "string" || !Array.isArray(raw.results))
      throw new Error("效能測試沒有產生有效的本機 Performance Profile。");
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const results = raw.results.flatMap((item): RenderBenchmarkResult[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.mode !== "string" || !MODES.has(row.mode as RenderBenchmarkResult["mode"])) return [];
      return [{
        mode: row.mode as RenderBenchmarkResult["mode"],
        jobs: number(row.jobs) ?? 1,
        encoder: String(row.encoder ?? "unknown"),
        decoder: String(row.decoder ?? "unknown"),
        processingSeconds: number(row.processingSeconds),
        fps: number(row.fps),
        speed: number(row.speed),
        cpuAveragePercent: number(row.cpuPercent),
        gpuEncodeAveragePercent: number(row.gpuEncodePercent),
        gpuDecodeAveragePercent: number(row.gpuDecodePercent),
        gpuComputeAveragePercent: number(row.gpuComputePercent),
        ramPeakBytes: number(row.ramPeakBytes),
        vramPeakBytes: number(row.vramPeakBytes),
        ssdTemporaryPeakBytes: number(row.ssdTemporaryPeakBytes),
        finalFileSizeBytes: number(row.finalFileSizeBytes),
        oom: /cannot allocate memory|error code:\s*-12/i.test(String(row.failure ?? "")),
        status: row.status === "PASS" ? "PASS" : "FAILED_SAFE",
        ...(row.failure ? { failureReason: String(row.failure) } : {}),
      }];
    });
    if (results.length !== 6) throw new Error("效能測試未完成全部六種安全情境。");
    const profile: RenderPerformanceProfile = {
      schemaVersion: 1,
      fingerprint: raw.fingerprint,
      capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : new Date().toISOString(),
      sampleDurationSeconds: number(raw.clipSeconds) ?? 60,
      sourceAssetIds: Array.isArray(raw.sources) ? raw.sources.map(String) : [],
      results,
      recommendedMode: raw.recommendedMode === "HIGH_SPEED" ? "HIGH_SPEED" : "NORMAL",
      recommendedVideoCodec: String(raw.recommendedVideoCodec ?? "H264") as RenderVideoCodec,
      recommendedParallelJobs: number(raw.recommendedParallelJobs) ?? 2,
      recommendationReason: "六種本機實測中選擇處理時間最短且未發生 OOM 的模式。",
    };
    await mkdir(path.dirname(this.profilePath), { recursive: true });
    const temporary = `${this.profilePath}.${process.pid}.partial`;
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", flag: "w" });
    try {
      await copyFile(temporary, this.profilePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return profile;
  }

  async load(): Promise<RenderPerformanceProfile | undefined> {
    try {
      return JSON.parse(await readFile(this.profilePath, "utf8")) as RenderPerformanceProfile;
    } catch {
      return undefined;
    }
  }
}
