import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  RenderDecoderCapability,
  RenderEncoderCapability,
  RenderHardwareCapabilities,
  RenderVideoCodec,
} from "../../shared/domain";
import { ProcessFailure, runProcess } from "./process-runner";

type ProcessRunner = typeof runProcess;

const ENCODERS: Array<
  Pick<RenderEncoderCapability, "videoCodec" | "ffmpegEncoder" | "backend" | "codec">
> = [
  { videoCodec: "H264_NVENC", ffmpegEncoder: "h264_nvenc", backend: "NVIDIA_NVENC", codec: "H264" },
  { videoCodec: "H265_NVENC", ffmpegEncoder: "hevc_nvenc", backend: "NVIDIA_NVENC", codec: "H265" },
  { videoCodec: "H264_QSV", ffmpegEncoder: "h264_qsv", backend: "INTEL_QSV", codec: "H264" },
  { videoCodec: "H265_QSV", ffmpegEncoder: "hevc_qsv", backend: "INTEL_QSV", codec: "H265" },
  { videoCodec: "H264", ffmpegEncoder: "libx264", backend: "CPU_SOFTWARE", codec: "H264" },
  { videoCodec: "H265", ffmpegEncoder: "libx265", backend: "CPU_SOFTWARE", codec: "H265" },
];

const DECODERS: Array<Pick<RenderDecoderCapability, "backend" | "codec" | "ffmpegDecoder">> = [
  { backend: "NVIDIA_CUDA", codec: "H264", ffmpegDecoder: "h264_cuvid" },
  { backend: "NVIDIA_CUDA", codec: "H265", ffmpegDecoder: "hevc_cuvid" },
  { backend: "INTEL_QSV", codec: "H264", ffmpegDecoder: "h264_qsv" },
  { backend: "INTEL_QSV", codec: "H265", ffmpegDecoder: "hevc_qsv" },
  { backend: "CPU_SOFTWARE", codec: "H264", ffmpegDecoder: "h264" },
  { backend: "CPU_SOFTWARE", codec: "H265", ffmpegDecoder: "hevc" },
];

function compactFailure(error: unknown): string {
  const raw =
    error instanceof ProcessFailure
      ? error.stderr || error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .join(" ")
    .slice(0, 1_200);
}

function firstVersionLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "unknown FFmpeg";
}

function parseGpuAdapters(raw: string): Array<{ name: string; driverVersion?: string }> {
  try {
    const value = JSON.parse(raw.trim()) as
      | { Name?: string; DriverVersion?: string }
      | Array<{ Name?: string; DriverVersion?: string }>;
    return (Array.isArray(value) ? value : [value])
      .filter((item) => typeof item.Name === "string" && item.Name.trim())
      .map((item) => ({ name: item.Name!.trim(), ...(item.DriverVersion ? { driverVersion: item.DriverVersion } : {}) }));
  } catch {
    return [];
  }
}

function listed(table: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m").test(table);
}

function recommendation(encoders: RenderEncoderCapability[]): {
  codec: RenderVideoCodec;
  reason: string;
} {
  const available = (codec: RenderVideoCodec) => encoders.some((item) => item.videoCodec === codec && item.available);
  if (available("H264_NVENC"))
    return { codec: "H264_NVENC", reason: "H.264 NVENC 已通過實際啟動測試；高速模式優先使用 NVIDIA 硬體編碼。" };
  if (available("H264_QSV"))
    return {
      codec: "H264_QSV",
      reason: "目前 NVENC 無法實際啟動；H.264 Intel QSV 已通過測試，且本機歷史 benchmark 較適合作為高速預設。",
    };
  return { codec: "H264", reason: "硬體 H.264 編碼器未通過實際啟動測試，改為明確的 CPU H.264 備援。" };
}

export class RenderHardwareService {
  private readonly profilePath: string;
  private cached?: RenderHardwareCapabilities;

  constructor(
    dataRoot: string,
    private readonly ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
    private readonly runner: ProcessRunner = runProcess,
  ) {
    this.profilePath = path.join(dataRoot, "performance", "render-hardware-profile.json");
  }

  private async inventory() {
    const [version, encoders, decoders, filters, gpu] = await Promise.all([
      this.runner(this.ffmpegExecutable, ["-version"]),
      this.runner(this.ffmpegExecutable, ["-hide_banner", "-encoders"]),
      this.runner(this.ffmpegExecutable, ["-hide_banner", "-decoders"]),
      this.runner(this.ffmpegExecutable, ["-hide_banner", "-filters"]),
      process.platform === "win32"
        ? this.runner("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion) | ConvertTo-Json -Compress",
          ]).catch(() => ({ stdout: "[]", stderr: "" }))
        : Promise.resolve({ stdout: "[]", stderr: "" }),
    ]);
    const ffmpegVersion = firstVersionLine(version.stdout || version.stderr);
    const gpuAdapters = parseGpuAdapters(gpu.stdout);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ffmpegVersion, gpuAdapters }))
      .digest("hex")
      .toUpperCase();
    return {
      fingerprint,
      ffmpegVersion,
      gpuAdapters,
      encoderTable: `${encoders.stdout}\n${encoders.stderr}`,
      decoderTable: `${decoders.stdout}\n${decoders.stderr}`,
      filterTable: `${filters.stdout}\n${filters.stderr}`,
    };
  }

  private async hasActiveFfmpeg(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      const result = await this.runner("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if(Get-Process ffmpeg -ErrorAction SilentlyContinue){'YES'}else{'NO'}",
      ]);
      return result.stdout.trim() === "YES";
    } catch {
      return true;
    }
  }

  private async readCached(fingerprint: string): Promise<RenderHardwareCapabilities | undefined> {
    if (this.cached?.fingerprint === fingerprint) return structuredClone(this.cached);
    try {
      const value = JSON.parse(await readFile(this.profilePath, "utf8")) as RenderHardwareCapabilities;
      if (value.schemaVersion !== 1 || value.fingerprint !== fingerprint || !Array.isArray(value.encoders)) return undefined;
      this.cached = value;
      return structuredClone(value);
    } catch {
      return undefined;
    }
  }

  private async writeProfile(profile: RenderHardwareCapabilities): Promise<void> {
    await mkdir(path.dirname(this.profilePath), { recursive: true });
    const temporary = `${this.profilePath}.${randomUUID()}.partial`;
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await copyFile(temporary, this.profilePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async probeEncoder(ffmpegEncoder: string): Promise<{ available: boolean; failureReason?: string }> {
    try {
      await this.runner(this.ffmpegExecutable, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:r=30:d=0.3",
        "-frames:v",
        "8",
        "-an",
        "-pix_fmt",
        "nv12",
        "-c:v",
        ffmpegEncoder,
        "-f",
        "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ]);
      return { available: true };
    } catch (error) {
      return { available: false, failureReason: compactFailure(error) || "編碼器未能實際啟動。" };
    }
  }

  private async probeDecoder(
    backend: RenderDecoderCapability["backend"],
    inputPath: string,
  ): Promise<{ available: boolean; failureReason?: string }> {
    if (backend === "CPU_SOFTWARE") return { available: true };
    const hwaccel = backend === "NVIDIA_CUDA" ? "cuda" : "qsv";
    try {
      await this.runner(this.ffmpegExecutable, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-hwaccel",
        hwaccel,
        "-hwaccel_output_format",
        hwaccel,
        "-i",
        inputPath,
        "-vf",
        "hwdownload,format=nv12",
        "-frames:v",
        "4",
        "-an",
        "-f",
        "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ]);
      return { available: true };
    } catch (error) {
      return { available: false, failureReason: compactFailure(error) || "硬體解碼器未能實際啟動。" };
    }
  }

  async getCapabilities(force = false): Promise<RenderHardwareCapabilities> {
    const inventory = await this.inventory();
    if (!force) {
      const cached = await this.readCached(inventory.fingerprint);
      if (cached) return cached;
    }
    const activeFfmpeg = await this.hasActiveFfmpeg();
    const encoderCapabilities: RenderEncoderCapability[] = [];
    for (const candidate of ENCODERS) {
      const isListed = listed(inventory.encoderTable, candidate.ffmpegEncoder);
      const runtime =
        candidate.backend === "CPU_SOFTWARE"
          ? { available: isListed }
          : activeFfmpeg
            ? { available: false, failureReason: "偵測到其他 FFmpeg 正在轉檔；為避免搶資源，本次延後實際硬體 probe。" }
            : isListed
              ? await this.probeEncoder(candidate.ffmpegEncoder)
              : { available: false, failureReason: "目前 FFmpeg build 未列出此編碼器。" };
      encoderCapabilities.push({
        ...candidate,
        listed: isListed,
        runtimeVerified: candidate.backend === "CPU_SOFTWARE" ? isListed : isListed && !activeFfmpeg,
        available: runtime.available,
        ...(runtime.failureReason ? { failureReason: runtime.failureReason } : {}),
      });
    }

    const probeRoot = path.join(os.tmpdir(), `SceneryWalker-hardware-probe-${randomUUID()}`);
    const decoderCapabilities: RenderDecoderCapability[] = [];
    try {
      if (!activeFfmpeg) await mkdir(probeRoot, { recursive: true });
      const samples = new Map<"H264" | "H265", string>();
      for (const codec of ["H264", "H265"] as const) {
        const sample = path.join(probeRoot, codec === "H264" ? "sample-h264.mp4" : "sample-h265.mp4");
        if (!activeFfmpeg) {
          const cpuEncoder = codec === "H264" ? "libx264" : "libx265";
          try {
            await this.runner(this.ffmpegExecutable, [
              "-hide_banner",
              "-loglevel",
              "error",
              "-f",
              "lavfi",
              "-i",
              "testsrc2=s=320x180:r=30:d=0.3",
              "-frames:v",
              "8",
              "-pix_fmt",
              "yuv420p",
              "-c:v",
              cpuEncoder,
              "-threads",
              "2",
              "-y",
              sample,
            ]);
            samples.set(codec, sample);
          } catch {
            // Encoder availability already reports the actionable failure.
          }
        }
      }
      for (const candidate of DECODERS) {
        const isListed = listed(inventory.decoderTable, candidate.ffmpegDecoder);
        const sample = samples.get(candidate.codec);
        const runtime =
          candidate.backend === "CPU_SOFTWARE"
            ? { available: isListed }
            : activeFfmpeg
              ? { available: false, failureReason: "偵測到其他 FFmpeg 正在轉檔；為避免搶資源，本次延後實際硬體 probe。" }
              : isListed && sample
                ? await this.probeDecoder(candidate.backend, sample)
                : { available: false, failureReason: isListed ? "無法建立安全的短測試樣本。" : "FFmpeg 未列出此解碼器。" };
        decoderCapabilities.push({
          ...candidate,
          listed: isListed,
          runtimeVerified: candidate.backend === "CPU_SOFTWARE" ? isListed : Boolean(isListed && sample && !activeFfmpeg),
          available: runtime.available,
          ...(runtime.failureReason ? { failureReason: runtime.failureReason } : {}),
        });
      }
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }

    const recommended = recommendation(encoderCapabilities);
    const gpuFilters = ["scale_cuda", "scale_qsv", "overlay_cuda", "overlay_qsv"]
      .filter((name) => listed(inventory.filterTable, name));
    const profile: RenderHardwareCapabilities = {
      schemaVersion: 1,
      fingerprint: inventory.fingerprint,
      capturedAt: new Date().toISOString(),
      ffmpegExecutable: this.ffmpegExecutable,
      ffmpegVersion: inventory.ffmpegVersion,
      gpuAdapters: inventory.gpuAdapters,
      encoders: encoderCapabilities,
      decoders: decoderCapabilities,
      gpuFilters,
      recommendedVideoCodec: recommended.codec,
      recommendationReason: recommended.reason,
      ...(activeFfmpeg ? { probeDeferredReason: "已有 FFmpeg 轉檔進行中，因此未執行會搶資源的 runtime probe。" } : {}),
    };
    if (!activeFfmpeg) {
      await this.writeProfile(profile);
      this.cached = profile;
    }
    return structuredClone(profile);
  }

  async assertCodecAvailable(videoCodec: RenderVideoCodec): Promise<RenderHardwareCapabilities> {
    const capabilities = await this.getCapabilities();
    const selected = capabilities.encoders.find((item) => item.videoCodec === videoCodec);
    if (!selected?.available) {
      const software = videoCodec === "H265_NVENC" || videoCodec === "H265_QSV" ? "H265" : "H264";
      throw new Error(
        `${selected?.ffmpegEncoder ?? videoCodec} 未通過實際 FFmpeg 啟動測試：${selected?.failureReason ?? "目前不可用"}\n` +
          `${software === "H265" ? "H.265 將使用 CPU Software Encoding，預估速度顯著較慢；請明確改選 H.265 CPU。" : "請改選已通過測試的 H.264 硬體或 CPU 編碼器。"}`,
      );
    }
    return capabilities;
  }
}
