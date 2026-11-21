import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { SubtitleFrameExtractor } from "../src/main/services/subtitle-frame-extractor";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-frame-extractor-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SubtitleFrameExtractor", () => {
  it("preserves explicit scene changes and every intro sample even when perceptual hashes are identical", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "same-looking-scenes.mp4");
    await writeFile(sourcePath, "synthetic source");
    const image = jpeg.encode({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 255) }, 75).data;
    const runner = async (_executable: string, args: string[]) => {
      if (args.includes("-frames:v")) await writeFile(args.at(-1)!, image);
      return { stdout: "", stderr: args.some((arg) => arg.includes("showinfo")) ? "[showinfo] n:0 pts_time:3.250" : "" };
    };
    const result = await new SubtitleFrameExtractor("ffmpeg", runner as never).extract({
      projectId: "boundaries", sourcePath, cacheRoot: path.join(root, "cache"), intervalSeconds: 2,
      detectSceneChanges: true, deduplicateFrames: true,
      segments: [{ type: "INTRO", startMs: 0, endMs: 2_000 }, { type: "INTRO", startMs: 2_000, endMs: 4_000 },
        { type: "MAIN", startMs: 4_000, endMs: 12_000 }],
    });
    expect(result.frames.filter((frame) => frame.segmentType === "INTRO")).toHaveLength(2);
    expect(result.frames.some((frame) => frame.source === "SCENE_CHANGE")).toBe(true);
    expect(result.plan.counters.dedup).toBeGreaterThan(0);
  });

  it("runs scene and black detection, skips black intro frames, and atomically caches bounded 720p stills", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "read-only source.mp4");
    const sourceContents = "source remains untouched";
    await writeFile(sourcePath, sourceContents);
    const calls: string[][] = [];
    const runner = async (_executable: string, args: string[]) => {
      calls.push(args);
      if (args.some((arg) => arg.includes("blackdetect=d=0:pix_th=0.10:pic_th=0.98")))
        return { stdout: "", stderr: "[blackdetect] black_start:0 black_end:1.500 black_duration:1.500" };
      if (args.includes("-f") && args.includes("null"))
        return { stdout: "", stderr: "[showinfo] n:0 pts_time:4.250" };
      await writeFile(args.at(-1)!, Buffer.alloc(256, 7));
      return { stdout: "", stderr: "" };
    };
    const result = await new SubtitleFrameExtractor("ffmpeg", runner as never).extract({
      projectId: "project-a",
      sourcePath,
      cacheRoot: path.join(root, "cache"),
      intervalSeconds: 10,
      maxSamples: 2,
      segments: [
        { type: "INTRO", startMs: 0, endMs: 3_000 },
        { type: "MAIN", startMs: 0, endMs: 10_000 },
      ],
    });

    expect(result.purpose).toBe("FRAME_ANALYSIS_ONLY");
    expect(result.frames).toHaveLength(3);
    expect(result.frames.find((frame) => frame.segmentType === "INTRO")).toMatchObject({
      timeMs: 1_750,
      segmentType: "INTRO",
      source: "FIRST_USABLE",
    });
    expect(result.frames.every((frame) => frame.path.endsWith(".jpg"))).toBe(true);
    expect(calls.some((args) => args.some((arg) => arg.includes("select='gt(scene,0.30)'")))).toBe(true);
    const stillArgs = calls.find((args) => args.includes("-frames:v"))!;
    expect(stillArgs).toContain("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black");
    expect(stillArgs).toContain("-f");
    expect(stillArgs).toContain("image2");
    expect(stillArgs).not.toContain("-c:v");
    expect(await readFile(sourcePath, "utf8")).toBe(sourceContents);
    expect(result.frames.every((frame) => !frame.path.includes("partial"))).toBe(true);
  });

  it("rejects relative source paths before invoking FFmpeg", async () => {
    let invoked = false;
    const runner = async () => {
      invoked = true;
      return { stdout: "", stderr: "" };
    };
    await expect(new SubtitleFrameExtractor("ffmpeg", runner as never).extract({
      projectId: "project-a",
      sourcePath: "relative.mp4",
      cacheRoot: path.resolve("cache"),
      segments: [],
      intervalSeconds: 10,
    })).rejects.toThrow("絕對路徑");
    expect(invoked).toBe(false);
  });

  it("processes beyond the former sample cap in rolling chunks and isolates cache by project", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "synthetic.mp4");
    await writeFile(sourcePath, "synthetic source");
    const calls: string[][] = [];
    const runner = async (_executable: string, args: string[]) => {
      calls.push(args);
      if (args.includes("-frames:v")) await writeFile(args.at(-1)!, Buffer.alloc(256, 7));
      return { stdout: "", stderr: "" };
    };
    const progress: number[] = [];
    const result = await new SubtitleFrameExtractor("ffmpeg", runner as never).extract({
      projectId: "project-a",
      sourcePath,
      cacheRoot: path.join(root, "cache"),
      intervalSeconds: 1,
      maxSamples: 1,
      segments: [{ type: "MAIN", startMs: 0, endMs: 601_000 }],
      onProgress: (item) => { if (item.stage === "FRAMES") progress.push(item.completed); },
    });
    expect(result.frames).toHaveLength(601);
    expect(result.plan.counters.sent).toBe(601);
    expect(progress.at(-1)).toBe(601);
    expect(calls.filter((args) => args.some((arg) => arg.includes("select='gt(scene")))).toHaveLength(2);
    const detectCall = calls.find((args) => args.some((arg) => arg.includes("select='gt(scene")))!;
    expect(detectCall).toContain("scale=320:-2,select='gt(scene,0.30)',showinfo");
    expect(new Set(result.frames.map((frame) => path.dirname(frame.path))).size).toBe(1);
    expect(result.frames[0].path).toContain("subtitle-frames");
  }, 15_000);

  it("streams the full timeline in awaited batches of at most 20 and prunes each batch from its video cache", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "streamed.mp4");
    await writeFile(sourcePath, "synthetic source");
    const runner = async (_executable: string, args: string[]) => {
      if (args.includes("-frames:v")) await writeFile(args.at(-1)!, Buffer.alloc(256, 7));
      return { stdout: "", stderr: "" };
    };
    const received: string[][] = [];
    const result = await new SubtitleFrameExtractor("ffmpeg", runner as never).extractBatches({
      projectId: "project-stream",
      sourcePath,
      cacheRoot: path.join(root, "cache"),
      intervalSeconds: 1,
      segments: [{ type: "MAIN", startMs: 0, endMs: 47_000 }],
    }, async (batch, batchIndex) => {
      expect(batch.length).toBeLessThanOrEqual(20);
      expect(batchIndex).toBe(received.length);
      expect(await Promise.all(batch.map(async (frame) => (await readFile(frame.path)).length))).toEqual(batch.map(() => 256));
      if (received.length > 0)
        await expect(readFile(received.at(-1)![0])).rejects.toMatchObject({ code: "ENOENT" });
      received.push(batch.map((frame) => frame.path));
    });

    expect(result.plan.samples).toHaveLength(47);
    expect(result.batchesEmitted).toBe(3);
    expect(received.map((batch) => batch.length)).toEqual([20, 20, 7]);
    await expect(readFile(received.at(-1)![0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels before scanning and keeps a different project cache untouched", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "synthetic.mp4");
    await writeFile(sourcePath, "synthetic source");
    let invoked = false;
    const controller = new AbortController();
    controller.abort();
    const runner = async () => {
      invoked = true;
      return { stdout: "", stderr: "" };
    };
    await expect(new SubtitleFrameExtractor("ffmpeg", runner as never).extract({
      projectId: "project-b",
      sourcePath,
      cacheRoot: path.join(root, "cache"),
      intervalSeconds: 1,
      segments: [{ type: "MAIN", startMs: 0, endMs: 5_000 }],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(invoked).toBe(false);
  });
});
