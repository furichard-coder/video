import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AUDIO_PROCESSING_OPTIONS } from "../src/shared/domain";
import { buildAudioRemuxArguments } from "../src/main/services/audio-processing";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";
import { AudioPreviewService } from "../src/main/services/audio-preview";
import type { ProjectStore } from "../src/main/services/project-store";

describe("actual FFmpeg audio processing", () => {
  let root = "";
  let source = "";
  let monoSource = "";
  let multichannelSource = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "SceneryWalker-v069-audio-"));
    source = path.join(root, "stereo.mp4");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=30",
      "-f", "lavfi", "-i", "aevalsrc=0.15*sin(2*PI*440*t)|0.12*sin(2*PI*660*t):s=48000:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source,
    ]);
    monoSource = path.join(root, "mono.mp4");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", "pan=mono|c0=0.5*c0+0.5*c1", "-c:a", "aac", monoSource]);
    multichannelSource = path.join(root, "native-5.1.mp4");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=30", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=5.1(side)", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-af", "aformat=sample_rates=48000:channel_layouts=5.1(side)", "-c:a", "ac3", "-b:a", "448k", "-channel_layout", "5.1(side)", "-shortest", multichannelSource]);
  }, 30_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function avDurationDeltaMs(filePath: string): Promise<number> {
    const { stdout } = await runProcess("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", filePath]);
    const streams = (JSON.parse(stdout) as { streams: Array<{ codec_type: string; duration?: string }> }).streams;
    const video = Number(streams.find((stream) => stream.codec_type === "video")?.duration);
    const audio = Number(streams.find((stream) => stream.codec_type === "audio")?.duration);
    return Math.abs(video - audio) * 1000;
  }

  it.each([
    ["AAC", "aac"],
    ["AC3", "ac3"],
    ["EAC3", "eac3"],
  ] as const)("produces real %s 5.1 in MP4 with copied video", async (codec, expectedCodec) => {
    const output = path.join(root, `${codec}.mp4`);
    const script = path.join(root, `${codec}.filter.txt`);
    const built = buildAudioRemuxArguments(
      source,
      output,
      { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "VIRTUAL_SURROUND_5_1", codec },
      script,
    );
    await writeFile(script, built.filterScript!, "utf8");
    await runProcess("ffmpeg", built.args);
    const info = await new MediaProbe().probe(output);
    expect(info.videoCodec).toBe("h264");
    expect(info.audioCodec).toBe(expectedCodec);
    expect(info.audioChannels).toBe(6);
    expect(info.audioChannelLayout).toMatch(/5\.1/);
    expect(info.audioSampleRate).toBe(48_000);
    expect(Math.abs((info.durationMs ?? 0) - 2_000)).toBeLessThanOrEqual(100);
    expect(await avDurationDeltaMs(output)).toBeLessThanOrEqual(50);
  }, 30_000);

  it("keeps Original Stereo as a copied two-channel track", async () => {
    const output = path.join(root, "original-stereo.mp4");
    const built = buildAudioRemuxArguments(source, output, { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ORIGINAL_STEREO" });
    await runProcess("ffmpeg", built.args);
    const before = await new MediaProbe().probe(source);
    const after = await new MediaProbe().probe(output);
    expect(after.videoCodec).toBe(before.videoCodec);
    expect(after.audioCodec).toBe(before.audioCodec);
    expect(after.audioChannels).toBe(2);
    expect(after.audioChannelLayout).toBe("stereo");
    expect(await avDurationDeltaMs(output)).toBeLessThanOrEqual(50);
  }, 30_000);

  it("keeps Enhanced Stereo at two channels and preserves duration", async () => {
    const output = path.join(root, "enhanced.mp4");
    const built = buildAudioRemuxArguments(source, output, { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" });
    await runProcess("ffmpeg", built.args);
    const info = await new MediaProbe().probe(output);
    expect(info.audioChannels).toBe(2);
    expect(info.audioChannelLayout).toBe("stereo");
    expect(Math.abs((info.durationMs ?? 0) - 2_000)).toBeLessThanOrEqual(100);
  }, 30_000);

  it("maps mono to safe stereo without doubling duration or channel gain", async () => {
    const output = path.join(root, "mono-stereo.mp4");
    const built = buildAudioRemuxArguments(monoSource, output, { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" });
    await runProcess("ffmpeg", built.args);
    const info = await new MediaProbe().probe(output);
    expect(info.audioChannels).toBe(2);
    expect(info.audioChannelLayout).toBe("stereo");
    expect(Math.abs((info.durationMs ?? 0) - 2_000)).toBeLessThanOrEqual(100);
  }, 30_000);

  it("keeps an actual native 5.1 track bit-for-bit codec/layout compatible", async () => {
    const output = path.join(root, "preserved-5.1.mp4");
    const built = buildAudioRemuxArguments(multichannelSource, output, { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "PRESERVE_MULTICHANNEL" });
    await runProcess("ffmpeg", built.args);
    const before = await new MediaProbe().probe(multichannelSource);
    const after = await new MediaProbe().probe(output);
    expect(after.audioCodec).toBe(before.audioCodec);
    expect(after.audioChannels).toBe(6);
    expect(after.audioChannelLayout).toMatch(/5\.1/);
  }, 30_000);

  it("creates a real stereo-monitoring preview and measured meter cache for virtual 5.1", async () => {
    const fakeStore = {
      getProject: () => ({
        sources: [{
          id: "a".repeat(64), sourcePath: source, fileName: "stereo.mp4", kind: "VIDEO",
        }],
      }),
    } as unknown as ProjectStore;
    const service = new AudioPreviewService(path.join(root, "preview"), fakeStore);
    await service.initialize();
    const result = await service.create({
      assetId: "a".repeat(64),
      options: { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "VIRTUAL_SURROUND_5_1" },
    });
    expect(result.monitoring).toBe("DOWNMIXED_5_1");
    expect(result.url).toContain("preview-media://audio-preview/");
    expect(await service.resolveExisting(result.cacheKey)).toMatch(/\.m4a$/);
    expect(result.meter.integratedLufs).toBeTypeOf("number");
    expect(result.meter.truePeakDb).toBeTypeOf("number");
    expect(result.meter.channelPeaksDb).toHaveLength(6);
  }, 30_000);

  it("keeps a real short preview aligned, invalidates by timeline revision, and removes stale cache", async () => {
    const fakeStore = {
      getProject: () => ({
        timelineRevision: 7,
        sources: [{ id: "b".repeat(64), sourcePath: source, fileName: "stereo.mp4", kind: "VIDEO" }],
      }),
    } as unknown as ProjectStore;
    const previewRoot = path.join(root, "preview-sync");
    const service = new AudioPreviewService(previewRoot, fakeStore);
    await service.initialize();
    const previewRequest = {
      assetId: "b".repeat(64),
      startMs: 500,
      durationMs: 1_000,
      timelineRevision: 7,
      options: { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" as const },
    };
    const created = await service.create(previewRequest);
    const cached = await service.create(previewRequest);
    const invalidated = await service.create({ ...previewRequest, timelineRevision: 8 });
    expect(created).toMatchObject({ startMs: 500, durationMs: 1_000, cacheStatus: "CREATED" });
    expect(cached).toMatchObject({ cacheKey: created.cacheKey, cacheStatus: "HIT" });
    expect(invalidated.cacheKey).not.toBe(created.cacheKey);
    const previewPath = await service.resolveExisting(created.cacheKey);
    const probed = await new MediaProbe().probe(previewPath);
    expect(Math.abs((probed.durationMs ?? 0) - created.durationMs)).toBeLessThanOrEqual(75);

    const stalePartial = path.join(previewRoot, ".orphan.partial.m4a");
    await writeFile(stalePartial, "temporary");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(stalePartial, twoHoursAgo, twoHoursAgo);
    const cleaned = await service.cleanup();
    expect(cleaned.removedFiles).toBeGreaterThanOrEqual(1);
    await expect(stat(stalePartial)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
