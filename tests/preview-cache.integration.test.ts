import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaProbe } from "../src/main/services/media-probe";
import { PreviewCache } from "../src/main/services/preview-cache";
import { runProcess } from "../src/main/services/process-runner";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";

let root: string;
let imagePath: string;
let videoPath: string;
let rotatedVideoPath: string;
let appleHevcMovPath: string;
let store: ProjectStore;
let sources: SourceService;
let previews: PreviewCache;

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-app-preview-")));
  imagePath = path.join(root, "photo.jpg");
  videoPath = path.join(root, "clip.mp4");
  rotatedVideoPath = path.join(root, "portrait-rotated.mp4");
  const hevcBasePath = path.join(root, "apple-hevc-base.mp4");
  appleHevcMovPath = path.join(root, "iPhone 中文 空格.MOV");
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x4477aa:s=640x360",
    "-frames:v", "1", "-y", imagePath,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", videoPath,
  ]);
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-display_rotation:v:0", "90", "-i", videoPath, "-c", "copy", "-y", rotatedVideoPath]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1",
    "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error",
    "-tag:v", "hvc1", "-c:a", "aac", "-shortest", "-y", hevcBasePath,
  ]);
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-display_rotation:v:0", "90", "-i", hevcBasePath, "-map", "0", "-c", "copy", "-y", appleHevcMovPath]);
  store = new ProjectStore(path.join(root, "app-data"));
  await store.initialize();
  sources = new SourceService(store, new MediaProbe());
  previews = new PreviewCache(path.join(root, "app-data", "cache", "previews"), store, sources);
  await previews.initialize();
  await sources.importSelected([imagePath, videoPath, rotatedVideoPath, appleHevcMovPath]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("preview cache integration", () => {
  it("creates image and video thumbnails plus a seekable low-resolution video proxy", async () => {
    const project = store.getProject();
    const image = project.sources.find((asset) => asset.kind === "IMAGE")!;
    const video = project.sources.find((asset) => asset.kind === "VIDEO")!;
    const imageThumb = await previews.ensure(image.id, "THUMBNAIL");
    const videoThumb = await previews.ensure(video.id, "THUMBNAIL");
    const videoProxy = await previews.ensure(video.id, "VIDEO_PROXY");

    expect(imageThumb.cacheStatus).toBe("CREATED");
    expect(videoThumb.cacheStatus).toBe("CREATED");
    expect(videoProxy.cacheStatus).toBe("CREATED");
    expect((await stat(await previews.resolveExisting(image.id, "THUMBNAIL"))).size).toBeGreaterThan(100);
    expect((await stat(await previews.resolveExisting(video.id, "THUMBNAIL"))).size).toBeGreaterThan(100);
    const proxyPath = await previews.resolveExisting(video.id, "VIDEO_PROXY");
    expect((await stat(proxyPath)).size).toBeGreaterThan(1_000);
    const proxyInfo = await new MediaProbe().probe(proxyPath);
    expect(proxyInfo.durationMs).toBeGreaterThan(500);
    expect(proxyInfo.videoCodec).toBe("h264");
  }, 30_000);

  it("creates only the requested short Intro range, reuses it, and never changes the source", async () => {
    const video = store.getProject().sources.find((asset) => asset.sourcePath === videoPath)!;
    const beforeHash = await sha256(videoPath);
    const created = await previews.ensureClip(video.id, 200, 800);
    const hit = await previews.ensureClip(video.id, 200, 800);
    expect(created).toMatchObject({ variant: "VIDEO_CLIP_PROXY", cacheStatus: "CREATED", sourceStartMs: 200, sourceEndMs: 800 });
    expect(hit).toMatchObject({ variant: "VIDEO_CLIP_PROXY", cacheStatus: "HIT", sourceStartMs: 200, sourceEndMs: 800 });
    const clipKey = /video_clip_proxy\/([a-f0-9]{64})/.exec(created.url)?.[1];
    expect(clipKey).toBeTruthy();
    const clipPath = await previews.resolveClipExisting(video.id, clipKey!);
    const marker = JSON.parse(await readFile(path.join(path.dirname(clipPath), `clip-${clipKey}.json`), "utf8")) as { outputSizeBytes?: number; outputModifiedAt?: string };
    expect(marker.outputSizeBytes).toBe((await stat(clipPath)).size);
    expect(marker.outputModifiedAt).toBeTruthy();
    const clipInfo = await new MediaProbe().probe(clipPath);
    expect(clipInfo.durationMs).toBeGreaterThanOrEqual(500);
    expect(clipInfo.durationMs).toBeLessThanOrEqual(750);
    expect(clipInfo.videoCodec).toBe("h264");
    expect(await sha256(videoPath)).toBe(beforeHash);
    await writeFile(clipPath, "broken");
    expect((await previews.ensureClip(video.id, 200, 800)).cacheStatus).toBe("CREATED");
    expect((await new MediaProbe().probe(clipPath)).videoCodec).toBe("h264");
    expect(await sha256(videoPath)).toBe(beforeHash);
  }, 30_000);

  it("hits valid cache and invalidates only when source identity inputs change", async () => {
    const video = store.getProject().sources.find((asset) => asset.kind === "VIDEO")!;
    expect((await previews.ensure(video.id, "THUMBNAIL")).cacheStatus).toBe("HIT");
    const before = await stat(videoPath);
    await utimes(videoPath, before.atime, new Date(before.mtimeMs + 2_000));
    expect((await previews.ensure(video.id, "THUMBNAIL")).cacheStatus).toBe("INVALIDATED");
  }, 30_000);

  it("does not accept a truncated MP4 as a valid cache hit", async () => {
    const video = store.getProject().sources.find((asset) => asset.sourcePath === videoPath)!;
    await previews.ensure(video.id, "VIDEO_PROXY");
    const proxyPath = await previews.resolveExisting(video.id, "VIDEO_PROXY");
    await writeFile(proxyPath, "broken");
    expect((await previews.ensure(video.id, "VIDEO_PROXY")).cacheStatus).toBe("CREATED");
    expect((await new MediaProbe().probe(proxyPath)).videoCodec).toBe("h264");
  }, 30_000);

  it("never changes source content while probing or generating previews", async () => {
    const project = store.getProject();
    for (const asset of project.sources) {
      const beforeHash = await sha256(asset.sourcePath);
      const beforeSize = (await stat(asset.sourcePath)).size;
      await sources.ensureMetadata(asset.id);
      await previews.ensure(asset.id, "THUMBNAIL");
      const variant = asset.kind === "VIDEO" ? "VIDEO_PROXY" : "IMAGE_PREVIEW";
      await previews.ensure(asset.id, variant);
      expect(await sha256(asset.sourcePath)).toBe(beforeHash);
      expect((await stat(asset.sourcePath)).size).toBe(beforeSize);
    }
  }, 30_000);

  it("uses display rotation dimensions so a portrait proxy is not stretched", async () => {
    const portrait = store.getProject().sources.find((asset) => asset.sourcePath === rotatedVideoPath)!;
    const ready = await sources.ensureMetadata(portrait.id);
    expect(ready.mediaInfo).toMatchObject({ displayWidth: 360, displayHeight: 640, rotationDegrees: 90, isPortrait: true });
    await previews.ensure(portrait.id, "VIDEO_PROXY");
    const proxyInfo = await new MediaProbe().probe(await previews.resolveExisting(portrait.id, "VIDEO_PROXY"));
    expect(proxyInfo.width).toBeLessThan(proxyInfo.height!);
    expect(proxyInfo.width! / proxyInfo.height!).toBeCloseTo(360 / 640, 2);
  }, 30_000);

  it("converts a rotated 10-bit Apple-style HEVC MOV to a seekable H.264 MP4 proxy without changing the source", async () => {
    const sourceHash = await sha256(appleHevcMovPath);
    const mov = store.getProject().sources.find((asset) => asset.sourcePath === appleHevcMovPath)!;
    const ready = await sources.ensureMetadata(mov.id);
    expect(ready).toMatchObject({ extension: ".mov", mediaInfo: { videoCodec: "hevc", displayWidth: 180, displayHeight: 320 } });
    const created = await previews.ensure(mov.id, "VIDEO_PROXY");
    expect(["CREATED", "HIT"]).toContain(created.cacheStatus);
    const proxyPath = await previews.resolveExisting(mov.id, "VIDEO_PROXY");
    expect(path.extname(proxyPath)).toBe(".mp4");
    const proxyInfo = await new MediaProbe().probe(proxyPath);
    expect(proxyInfo).toMatchObject({ videoCodec: "h264", audioCodec: "aac" });
    expect(proxyInfo.width).toBeLessThan(proxyInfo.height!);
    expect(await sha256(appleHevcMovPath)).toBe(sourceHash);
  }, 30_000);
});
