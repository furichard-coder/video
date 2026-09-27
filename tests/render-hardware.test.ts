import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessFailure } from "../src/main/services/process-runner";
import { RenderHardwareService } from "../src/main/services/render-hardware";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("render hardware runtime capability probe", () => {
  it("recommends verified H.264 QSV when listed NVENC encoders fail to start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-hardware-test-"));
    roots.push(root);
    const runner = async (executable: string, args: string[]) => {
      const joined = args.join(" ");
      if (args.includes("-version")) return { stdout: "ffmpeg version 8.1.2-full_build\n", stderr: "" };
      if (args.includes("-encoders"))
        return {
          stdout: " V....D h264_nvenc NVIDIA\n V....D hevc_nvenc NVIDIA\n V..... h264_qsv Intel\n V..... hevc_qsv Intel\n V..... libx264 CPU\n V..... libx265 CPU\n",
          stderr: "",
        };
      if (args.includes("-decoders"))
        return {
          stdout: " V..... h264_cuvid NVIDIA\n V..... hevc_cuvid NVIDIA\n V..... h264_qsv Intel\n V..... hevc_qsv Intel\n V..... h264 CPU\n V..... hevc CPU\n",
          stderr: "",
        };
      if (args.includes("-filters")) return { stdout: " ... scale_qsv\n ... overlay_qsv\n", stderr: "" };
      if (executable === "powershell.exe" && joined.includes("Win32_VideoController"))
        return { stdout: '[{"Name":"Intel HD Graphics 530"},{"Name":"NVIDIA Quadro M2000M","DriverVersion":"32.0.15.7371"}]', stderr: "" };
      if (executable === "powershell.exe") return { stdout: "NO\n", stderr: "" };
      if (joined.includes("h264_nvenc") || joined.includes("hevc_nvenc"))
        throw new ProcessFailure("probe failed", 1, "Driver does not support the required nvenc API version");
      if (joined.includes("-hwaccel cuda")) throw new ProcessFailure("probe failed", 1, "CUDA device creation failed");
      return { stdout: "", stderr: "" };
    };
    const service = new RenderHardwareService(root, "ffmpeg-test", runner as never);
    const capabilities = await service.getCapabilities(true);
    expect(capabilities.recommendedVideoCodec).toBe("H264_QSV");
    expect(capabilities.encoders.find((item) => item.videoCodec === "H264_NVENC")).toMatchObject({
      listed: true,
      runtimeVerified: true,
      available: false,
    });
    expect(capabilities.encoders.find((item) => item.videoCodec === "H264_QSV")?.available).toBe(true);
    await expect(service.assertCodecAvailable("H265_NVENC")).rejects.toThrow(/CPU Software Encoding.*顯著較慢/);
  });
});
