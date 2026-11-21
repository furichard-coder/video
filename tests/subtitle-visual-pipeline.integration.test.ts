import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "../src/main/services/process-runner";
import { SubtitleFrameExtractor } from "../src/main/services/subtitle-frame-extractor";
import { DiskSubtitleVisionCache } from "../src/main/services/subtitle-vision-cache";
import {
  runSubtitleVisionDrafts,
  type SubtitleVisionFrame,
  type SubtitleVisionProvider,
} from "../src/main/services/subtitle-vision-orchestrator";
import { mergeSubtitleVisionDrafts } from "../src/main/services/subtitle-draft-merge";
import { createHash } from "node:crypto";

let root = "";
let video = "";
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "subtitle-visual-e2e-"));
  video = path.join(root, "short.mp4");
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:size=640x360:rate=10:d=1",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=10:d=5",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    video,
  ]);
}, 20_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("short subtitle visual pipeline", () => {
  it("extracts real bounded JPEGs, batches a mock provider, and merges draft-only cues", async () => {
    const extracted = await new SubtitleFrameExtractor().extract({
      projectId: "project-test",
      sourcePath: video,
      cacheRoot: path.join(root, "cache"),
      segments: [
        { type: "INTRO", startMs: 0, endMs: 2_000 },
        { type: "MAIN", startMs: 2_000, endMs: 6_000 },
      ],
      intervalSeconds: 2,
      deduplicateFrames: true,
    });
    expect(extracted.frames.every((frame) => /^[a-f0-9]{16}$/.test(frame.perceptualHash ?? ""))).toBe(true);
    expect(extracted.frames.length).toBeGreaterThanOrEqual(2);
    const frames: SubtitleVisionFrame[] = [];
    for (const [index, item] of extracted.frames.entries()) {
      const bytes = await readFile(item.path);
      frames.push({
        id: `f${index}`,
        timestampMs: item.timeMs,
        imageDataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        fingerprint: createHash("sha256").update(bytes).digest("hex"),
        videoFingerprint: "short-video",
        videoDurationMs: 6_000,
        contextRevision: "1",
        segmentType: item.segmentType,
        context: { projectName: "fixture" },
      });
    }
    const provider: SubtitleVisionProvider = {
      kind: "OPENAI",
      version: "mock",
      analyzeBatch: async (batch) => ({
        drafts: batch.map((frame) => ({
          frameId: frame.id,
          startMs: frame.timestampMs,
          endMs: Math.min(6_000, frame.timestampMs + 1_500),
          text: frame.segmentType === "INTRO" ? "開場" : "測試畫面",
          confidence: 0.9,
          provenance: ["VISIBLE"],
        })),
      }),
    };
    const analyzed = await runSubtitleVisionDrafts(
      frames,
      provider,
      new DiskSubtitleVisionCache(path.join(root, "analysis-cache")),
      { batchSize: 10 },
    );
    const merged = mergeSubtitleVisionDrafts(analyzed.drafts, { durationMs: 6_000 });
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.every((cue) => cue.endMs <= 6_000)).toBe(true);
  }, 30_000);
});
