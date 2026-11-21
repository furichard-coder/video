// Isolated, synthetic fixtures only. Never render or modify a user's project/media.
import { mkdir, mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactRoot = path.join(appRoot, "artifacts", "v088-review-qa");
const taskRoot = await mkdtemp(path.join(os.tmpdir(), "sw-v088-review-qa-"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function run(executable, args, env, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve(output) : reject(new Error(`Fixture QA exit ${code}: ${output}`));
    });
  });
}
try {
  await mkdir(artifactRoot, { recursive: true });
  const baseline = JSON.parse(
    await readFile(process.env.V088_FIXTURE_PROJECT ?? "C:\\大雪山\\我的素材專案.swproj", "utf8"),
  );
  const template = baseline.sources.find((source) => source.kind === "VIDEO");
  if (!template) throw new Error("Fixture source schema unavailable");
  const sources = [];
  for (const [index, color] of ["red", "green", "blue"].entries()) {
    const sourcePath = path.join(taskRoot, `segment-${index + 1}.mp4`);
    await run(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:r=30:d=10`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${440 + index * 110}:sample_rate=48000:duration=10`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-shortest",
      sourcePath,
    ]);
    const file = await stat(sourcePath);
    const id = hash(sourcePath);
    sources.push({
      ...template,
      id,
      sourceIdentity: id,
      sourcePath,
      fileName: path.basename(sourcePath),
      previewCacheKey: hash(`${id}:${file.size}`),
      sizeBytes: file.size,
      fileCreatedAt: file.birthtime.toISOString(),
      fileModifiedAt: file.mtime.toISOString(),
      addedOrder: index,
      previewRange: { inMs: 0, outMs: 10000 },
      volumeSegments: [],
      mainExclusionRanges: [],
      zoomSegments: [],
      mediaInfo: {
        ...template.mediaInfo,
        width: 320,
        height: 180,
        displayWidth: 320,
        displayHeight: 180,
        durationMs: 10000,
        frameRate: "30/1",
        videoCodec: "h264",
        audioCodec: "aac",
        audioChannels: 2,
        audioSampleRate: 48000,
        rotationDegrees: 0,
      },
    });
  }
  const results = [];
  for (const mode of process.env.V088_QA_MODE ? [process.env.V088_QA_MODE] : ["CONTINUITY", "FOCUS", "MIXED"]) {
    const userData = path.join(taskRoot, mode);
    const manifestPath = path.join(userData, "projects", "default", "project.source-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await mkdir(path.join(userData, "settings"), { recursive: true });
    await writeFile(
      path.join(userData, "settings", "user-preferences.json"),
      JSON.stringify({
        renderDefaults: {
          renderTemporaryFolder: path.join(userData, "isolated-cache"),
          tempLocationSelection: "PRIMARY",
          tempLocations: [
            { id: "qa-temp", path: path.join(userData, "isolated-cache"), role: "PRIMARY", priority: 1, enabled: true },
          ],
        },
      }),
      "utf8",
    );
    const cues =
      mode !== "FOCUS"
        ? [
            [5000, 8000],
            [12000, 16000],
            [19000, 24000],
          ].map(([startMs, endMs], index) => ({
            id: `qa-${index + 1}`,
            startMs,
            endMs,
            text: `測試字幕 ${index + 1}`,
            timelineScope: "MAIN",
            origin: "MANUAL",
            reviewStatus: "DRAFT",
          }))
        : Array.from({ length: 100 }, (_, index) => ({
            id: `qa-${index + 1}`,
            startMs: index * 300,
            endMs: index * 300 + 260,
            text: `檢視字幕 ${index + 1}`,
            timelineScope: "MAIN",
            origin: "MANUAL",
            reviewStatus: "DRAFT",
          }));
    const selectedSources = structuredClone(sources);
    if (mode === "MIXED") {
      const photoPath = path.join(taskRoot, "green-photo.jpg");
      await run(process.env.FFMPEG_PATH ?? "ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        sources[1].sourcePath,
        "-frames:v",
        "1",
        photoPath,
      ]);
      const photo = await stat(photoPath);
      selectedSources[1] = {
        ...selectedSources[1],
        sourcePath: photoPath,
        fileName: "green-photo.jpg",
        extension: ".jpg",
        kind: "IMAGE",
        imageDurationMs: 10000,
        sizeBytes: photo.size,
        mediaInfo: { width: 320, height: 180, displayWidth: 320, displayHeight: 180, durationMs: 10000 },
      };
    }
    const fixture = {
      ...baseline,
      projectId: `qa-v088-${mode.toLowerCase()}`,
      projectName: "隔離字幕測試",
      sources: selectedSources,
      timelineOrder: selectedSources.map((source) => source.id),
      pendingOrder: [],
      introSegments: [],
      mediaInsertions: [],
      subtitleCues: cues,
      timelineTransitionSeconds: 0,
      timelineRevision: 1,
    };
    await writeFile(manifestPath, JSON.stringify(fixture), "utf8");
    await writeFile(
      path.join(userData, "projects", "active-project.json"),
      JSON.stringify({ filePath: manifestPath }),
      "utf8",
    );
    const output = await run(
      require("electron"),
      [appRoot],
      { APP_TEST_USER_DATA_PATH: userData, APP_SUBTITLE_REVIEW_QA: mode, APP_SUBTITLE_REVIEW_QA_OUTPUT: artifactRoot },
      120000,
    );
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SUBTITLE_REVIEW_QA_RESULT "));
    if (!line) throw new Error(`Missing ${mode} QA result: ${output}`);
    const result = JSON.parse(line.slice("SUBTITLE_REVIEW_QA_RESULT ".length));
    results.push(result);
    const { samples: _samples, ...summary } = result;
    console.log(JSON.stringify(summary));
  }
  await writeFile(path.join(artifactRoot, "results.json"), JSON.stringify(results, null, 2), "utf8");
} finally {
  // Only the exact unique directory allocated above is disposable.
  if (!path.basename(taskRoot).startsWith("sw-v088-review-qa-")) throw new Error("Unsafe fixture cleanup path");
  await rm(taskRoot, { recursive: true, force: true });
}
