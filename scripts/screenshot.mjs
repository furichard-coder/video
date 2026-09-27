import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactRoot = path.join(appRoot, "artifacts");
const screenshotPath = path.join(artifactRoot, "v078-intro-compact-thumbnail-ui.png");
await mkdir(artifactRoot, { recursive: true });
const screenshotUserData = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-screenshot-"));
const projectDirectory = path.join(screenshotUserData, "projects", "default");
const sourceDirectory = path.join(screenshotUserData, "fixture-media");
await mkdir(projectDirectory, { recursive: true });
await mkdir(sourceDirectory, { recursive: true });
const run = promisify(execFile);
const forestPath = path.join(sourceDirectory, "forest.mp4");
const deerPath = path.join(sourceDirectory, "deer.jpg");
const treePath = path.join(sourceDirectory, "tree.mp4");
const musicPath = path.join(sourceDirectory, "music.wav");
await Promise.all([
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x355c3a:s=640x360:r=24:d=8", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", forestPath], { windowsHide: true }),
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x74563a:s=640x360", "-frames:v", "1", "-y", deerPath], { windowsHide: true }),
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x31506d:s=640x360:r=24:d=8", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", treePath], { windowsHide: true }),
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=30", "-c:a", "pcm_s16le", "-y", musicPath], { windowsHide: true }),
]);
const now = "2026-09-17T00:00:00.000Z";
const source = (id, kind, name, sourcePath, durationMs, order) => ({
  id,
  sourcePath,
  sourceIdentity: `fixture-${id}`,
  fileName: name,
  extension: kind === "IMAGE" ? ".jpg" : ".mp4",
  kind,
  sizeBytes: 1_000_000,
  fileCreatedAt: now,
  fileModifiedAt: now,
  addedAt: now,
  addedOrder: order,
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewCacheKey: id,
  metadataState: "READY",
  mediaInfo: { durationMs, width: 1920, height: 1080, audioCodec: kind === "VIDEO" ? "aac" : undefined },
  ...(kind === "IMAGE" ? { imageDurationMs: durationMs, photoSoundEnabled: true } : {}),
});
const fixtureSources = [
  source("1".repeat(64), "VIDEO", "森林步道晨光.mp4", forestPath, 8_000, 0),
  source("2".repeat(64), "IMAGE", "山羌林間特寫.jpg", deerPath, 5_000, 1),
  source("3".repeat(64), "VIDEO", "神木仰望鏡頭.mp4", treePath, 8_000, 2),
];
await writeFile(path.join(projectDirectory, "project.source-manifest.json"), JSON.stringify({
  schemaVersion: 21,
  id: "v078-screenshot",
  name: "v0.78 Intro Compact UI 驗收",
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewerVersion: "preview-v5-orientation-planar-safe",
  sortMode: "MANUAL_ORDER",
  createdAt: now,
  updatedAt: now,
  sources: fixtureSources,
  timelineOrder: fixtureSources.map((item) => item.id),
  timelineTransitionSeconds: 0.3,
  pendingAssetIds: [], excludedMainAssetIds: [], recentMainRemovals: [],
  introSegments: [
    { id: "intro-forest", assetId: "1".repeat(64), fileName: "森林步道晨光.mp4", inMs: 0, outMs: 6_000, score: 92, reasons: ["開場光線"], insertionAudio: { trackGates: { original: true, voice: true, bgm: true, sfx: true }, sfxEnabled: false, sfxVolumePercent: 70, bgmTrackId: "music", bgmVolumePercent: 28, fadeMs: 180, loopCrossfadeMs: 120 } },
    { id: "intro-deer", assetId: "2".repeat(64), fileName: "山羌林間特寫.jpg", inMs: 0, outMs: 5_000, score: 88, reasons: ["物種亮點"], insertionAudio: { trackGates: { original: true, voice: true, bgm: true, sfx: true }, sfxEnabled: true, sfxVolumePercent: 70, bgmTrackId: "music", bgmVolumePercent: 28, fadeMs: 180, loopCrossfadeMs: 120 } },
    { id: "intro-tree", assetId: "3".repeat(64), fileName: "神木仰望鏡頭.mp4", inMs: 1_000, outMs: 7_000, score: 84, reasons: ["景深變化"], insertionAudio: { trackGates: { original: true, voice: false, bgm: true, sfx: true }, sfxEnabled: false, sfxVolumePercent: 70, bgmTrackId: "music", bgmVolumePercent: 28, fadeMs: 180, loopCrossfadeMs: 120 } },
  ],
  introTargetDurationMs: 30_000, introSegmentMaxDurationMs: 15_000,
  colorSettings: { introPresetId: "NATURAL", applyToMain: false },
  introExcludedSegmentIds: [], recentIntroRemovals: [], placementDecisions: [], mediaInsertions: [],
  mainStartCue: { enabled: true, durationMs: 650 },
  bgmTracks: [{ id: "music", sourcePath: musicPath, fileName: "自然旅程.wav", sizeBytes: 1, durationMs: 30_000, sourceInMs: 0, sourceOutMs: 30_000, timelineInMs: 0, timelineOutMs: 30_000, fadeInMs: 180, fadeOutMs: 180, volumePercent: 28, sourcePolicy: "READ_ONLY", addedAt: now }],
  sourceAudioVolumePercent: 100,
  aiStoryContext: { topic: "森林生態", locations: ["山林步道"], people: [], storySummary: "晨間森林觀察", audiencePromise: "認識自然", subtitleLanguage: "zh-TW" },
  subtitleCues: [], timelineRevision: 1, subtitleTimelineRevision: 1,
  mainTimelineRevision: 1, introTimelineRevision: 1, mainSubtitleReviewRevision: 1, introSubtitleReviewRevision: 1,
  audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
}), "utf8");

const child = spawn(electron, [appRoot], {
  env: {
    ...process.env,
    APP_SCREENSHOT_PATH: screenshotPath,
    APP_SCREENSHOT_CLICK_TEXT: "AI 精彩片頭",
    APP_TEST_USER_DATA_PATH: screenshotUserData,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const exitCode = await Promise.race([
  new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1))),
  delay(30_000).then(() => {
    child.kill();
    return 124;
  }),
]);

if (exitCode !== 0 || !output.includes("SCREENSHOT_READY")) {
  await rm(screenshotUserData, { recursive: true, force: true });
  process.stderr.write(output);
  process.exit(Number(exitCode) || 1);
}

await rm(screenshotUserData, { recursive: true, force: true });
process.stdout.write(`${output}${screenshotPath}\n`);
