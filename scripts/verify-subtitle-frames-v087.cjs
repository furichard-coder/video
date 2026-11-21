// Read-only, bounded frame test. No API calls and no output-video encoding.
const { stat, mkdir, readFile, writeFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { SubtitleFrameExtractor } = require("../dist-electron/main/services/subtitle-frame-extractor");
const root = path.resolve(__dirname, "../artifacts/v087-frame-validation");
const videoPath = "E:\\大雪山 YT video\\SceneryWalker_preview_20260926_0243.mp4";
async function directoryBytes(folder) {
  let total = 0;
  for (const item of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(folder, item.name);
    total += item.isDirectory() ? await directoryBytes(file) : (await stat(file)).size;
  }
  return total;
}
(async () => {
  await mkdir(root, { recursive: true });
  const before = await stat(videoPath);
  const start = Date.now();
  const report = { status: "FAILED", videoPath, sampleStartMs: 600000, sampleDurationMs: 180000,
    intervalSeconds: 2, apiRequests: 0, frames: 0, batches: 0, batchImageBytesPeak: 0, masterModified: false };
  try {
    const result = await new SubtitleFrameExtractor().extractBatches({
      sourcePath: videoPath, cacheRoot: root, projectId: "v087-offline-180s",
      segments: [{ type: "MAIN", startMs: 600000, endMs: 780000 }],
      intervalSeconds: 2, detectSceneChanges: true, deduplicateFrames: true,
    }, async (frames) => {
      report.frames += frames.length;
      report.batches += 1;
      let bytes = 0;
      for (const frame of frames) bytes += (await readFile(frame.path)).length;
      report.batchImageBytesPeak = Math.max(report.batchImageBytesPeak, bytes);
    });
    report.counters = result.plan.counters;
    report.sampledTimestampMinMs = result.plan.samples[0]?.timeMs;
    report.sampledTimestampMaxMs = result.plan.samples.at(-1)?.timeMs;
    report.retainedCacheBytes = await directoryBytes(path.join(root, "subtitle-frames"));
    report.status = report.frames > 0 && report.batches > 0 ? "PASS" : "NO_FRAMES";
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  const after = await stat(videoPath);
  report.masterModified = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
  if (report.masterModified) report.status = "SOURCE_CHANGED";
  report.elapsedMs = Date.now() - start;
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report));
  process.exitCode = report.status === "PASS" ? 0 : 1;
})();
