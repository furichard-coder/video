import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTRO_ANALYZER_VERSION, IntroAnalyzer, parseSignalMetrics } from "../src/main/services/intro-analyzer";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";

let root: string;
let sourcePath: string;
let store: ProjectStore;
let analyzer: IntroAnalyzer;

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "source-app-intro-"));
  sourcePath = path.join(root, "moving-scene.mp4");
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    sourcePath,
  ]);
  store = new ProjectStore(path.join(root, "app-data"));
  await store.initialize();
  const sources = new SourceService(store, new MediaProbe());
  await sources.importSelected([sourcePath]);
  analyzer = new IntroAnalyzer(path.join(root, "app-data", "cache", "intro-analysis"), store, sources);
  await analyzer.initialize();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local intro analyzer", () => {
  it("parses exposure, color and frame-difference metrics", () => {
    const metrics = parseSignalMetrics(
      [
        "lavfi.signalstats.YAVG=120",
        "lavfi.signalstats.SATAVG=25",
        "lavfi.signalstats.YDIF=8",
        "lavfi.signalstats.YAVG=124",
        "lavfi.signalstats.SATAVG=30",
        "lavfi.signalstats.YDIF=10",
      ].join("\n"),
    );
    expect(metrics?.exposure).toBeGreaterThan(95);
    expect(metrics?.color).toBeGreaterThan(80);
    expect(metrics?.motion).toBeGreaterThan(60);
  });

  it("samples short windows, returns traceable suggestions, hits cache and never changes the source", async () => {
    const asset = store.getProject().sources[0];
    const beforeHash = await sha256(sourcePath);
    const phases: string[] = [];
    const first = await analyzer.analyze([asset.id], undefined, (progress) => phases.push(progress.phase));
    const second = await analyzer.analyze([asset.id]);
    const limited = await analyzer.analyze([asset.id], undefined, undefined, 3_000);

    expect(first.analyzerVersion).toBe(INTRO_ANALYZER_VERSION);
    expect(first.analyzedAssetCount).toBe(1);
    expect(first.suggestions.length).toBeGreaterThan(0);
    expect(first.suggestions.every((item) => item.assetId === asset.id && item.outMs > item.inMs)).toBe(true);
    expect(phases).toContain("ANALYZING");
    expect(phases).toContain("RANKING");
    expect(second.cacheHits).toBe(1);
    expect(limited.suggestions.reduce((sum, item) => sum + item.outMs - item.inMs, 0)).toBeLessThanOrEqual(3_000);
    expect(await sha256(sourcePath)).toBe(beforeHash);
  }, 30_000);

  it("honors cancellation before analysis starts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(analyzer.analyze([store.getProject().sources[0].id], controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
