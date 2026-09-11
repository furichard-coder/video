import { createRequire } from "node:module";
import { mkdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const appRoot = path.resolve(import.meta.dirname, "..");
const dataRoot = path.join(process.env.APPDATA, "SceneryWalker 素材整理");
const projectPath = "C:\\大雪山\\我的素材專案.swproj";
const preferencesPath = path.join(dataRoot, "settings", "user-preferences.json");
const outputDirectory = "C:\\大雪山\\output";
const photoSoundPath = path.join(
  appRoot,
  "release",
  "v0.49.0",
  "SceneryWalkerSourceOrganizer-win32-x64",
  "resources",
  "assets",
  "camera-shutter-click-14671.mp3",
);

const { ProjectStore } = require("../dist-electron/main/services/project-store.js");
const { SourceService } = require("../dist-electron/main/services/source-service.js");
const { MediaProbe } = require("../dist-electron/main/services/media-probe.js");
const { ConcatRenderService } = require("../dist-electron/main/services/concat-render.js");
const { OutputHistoryStore } = require("../dist-electron/main/services/output-history.js");
const { SubtitleTranslationService } = require("../dist-electron/main/services/subtitle-translation.js");
const { mainRenderSelections } = require("../dist-electron/shared/editing-rules.js");
const { introSegmentsForOutput } = require("../dist-electron/shared/intro-duration.js");

function stamp() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(/[-: ]/g, "");
  return parts;
}

await mkdir(outputDirectory, { recursive: true });
const [project, preferences] = await Promise.all([
  readFile(projectPath, "utf8").then(JSON.parse),
  readFile(preferencesPath, "utf8").then(JSON.parse),
]);

const missingSources = [];
const changedSources = [];
for (const asset of project.sources) {
  const info = await stat(asset.sourcePath).catch(() => undefined);
  if (!info?.isFile()) {
    missingSources.push(asset.sourcePath);
    continue;
  }
  if (
    info.size !== asset.sizeBytes ||
    info.mtime.toISOString() !== asset.fileModifiedAt
  ) {
    changedSources.push(asset.sourcePath);
  }
}
const missingBgm = [];
for (const track of project.bgmTracks ?? []) {
  if (!track.sourcePath) continue;
  const info = await stat(track.sourcePath).catch(() => undefined);
  if (!info?.isFile()) missingBgm.push(track.sourcePath);
}
if (missingSources.length || missingBgm.length || changedSources.length) {
  throw new Error(
    `來源檢查未通過：缺少影片／照片 ${missingSources.length} 筆、已變更 ${changedSources.length} 筆、缺少配樂 ${missingBgm.length} 筆；已停止重跑。`,
  );
}
const outputVolume = await statfs(outputDirectory);
const freeBytes = Number(outputVolume.bavail) * Number(outputVolume.bsize);
if (freeBytes < 15 * 1024 ** 3) {
  throw new Error(`C 槽剩餘空間不足 15 GB（目前 ${freeBytes} bytes），已停止重跑。`);
}

const store = new ProjectStore(dataRoot);
store.current = project;
store.activeProjectPath = projectPath;
const sourceService = new SourceService(store, new MediaProbe());
const subtitleCacheRoot = path.join(dataRoot, "cache", "subtitle-translations");
const unavailableAccount = {
  getRuntimeAccount() {
    throw new Error("此復原工作只允許使用現有繁體中文字幕，不執行雲端翻譯。");
  },
};
const unavailableTranslation = {
  getGoogleCloudApiKey() {
    throw new Error("此復原工作只允許使用現有繁體中文字幕，不執行雲端翻譯。");
  },
};
const subtitleTranslation = new SubtitleTranslationService(
  subtitleCacheRoot,
  unavailableAccount,
  unavailableTranslation,
);
await subtitleTranslation.initialize();
const renderer = new ConcatRenderService(
  store,
  sourceService,
  undefined,
  undefined,
  photoSoundPath,
  subtitleTranslation,
  path.join(dataRoot, "cache", "subtitle-burnin"),
);
const mainClips = mainRenderSelections(project);
const introClips = introSegmentsForOutput(
  project.introSegments ?? [],
  project.introSegmentMaxDurationMs,
);
const prependIntro = preferences.renderDefaults?.prependIntro !== false;
const clips = [...(prependIntro ? introClips : []), ...mainClips];
const outputPath = path.join(
  outputDirectory,
  `SceneryWalker_preview_${stamp()}_recovery.mp4`,
);
const request = {
  outputToken: "recovery-authorized",
  orderedAssetIds: clips.map((clip) => clip.assetId),
  clipSelections: clips.map((clip) => ({
    assetId: clip.assetId,
    inMs: clip.inMs,
    outMs: clip.outMs,
    ...(clip.mediaInsertionId
      ? { mediaInsertionId: clip.mediaInsertionId }
      : {}),
  })),
  transitionSeconds: preferences.renderDefaults?.transitionSeconds ?? 0.5,
  resolution: preferences.renderDefaults?.resolution ?? "480P",
  videoCodec: "H264",
  includeWatermark: true,
  purpose: "CONCAT",
  prependIntro,
  subtitleBurnIn: preferences.subtitleBurnInDefaults ?? {
    enabled: false,
    tracks: [],
  },
  includeBgm: preferences.renderDefaults?.mainPreviewIncludeBgm !== false,
  ...(prependIntro && preferences.renderDefaults?.mainStartCard
    ? { mainStartCard: preferences.renderDefaults.mainStartCard }
    : {}),
};

if (process.argv.includes("--preflight")) {
  console.log(
    JSON.stringify({
      status: "READY",
      outputPath,
      freeBytes,
      request: {
        resolution: request.resolution,
        videoCodec: request.videoCodec,
        transitionSeconds: request.transitionSeconds,
        clipCount: clips.length,
        mainClipCount: mainClips.length,
        introClipCount: prependIntro ? introClips.length : 0,
        includeBgm: request.includeBgm,
        subtitleBurnIn: request.subtitleBurnIn.enabled,
        includeWatermark: request.includeWatermark,
      },
    }),
  );
  process.exit(0);
}

const startedAt = new Date().toISOString();
console.log(
  JSON.stringify({
    event: "START",
    startedAt,
    outputPath,
    resolution: request.resolution,
    videoCodec: request.videoCodec,
    clipCount: clips.length,
    mainClipCount: mainClips.length,
    introClipCount: prependIntro ? introClips.length : 0,
    includeBgm: request.includeBgm,
    subtitleBurnIn: request.subtitleBurnIn.enabled,
    includeWatermark: request.includeWatermark,
  }),
);

let lastProgress = "";
try {
  const result = await renderer.render(request, outputPath, undefined, (progress) => {
    const progressKey = `${progress.phase}:${Math.floor(progress.percent)}`;
    if (progressKey === lastProgress) return;
    lastProgress = progressKey;
    console.log(
      JSON.stringify({
        event: "PROGRESS",
        at: new Date().toISOString(),
        phase: progress.phase,
        percent: Math.floor(progress.percent),
        outTimeMs: progress.outTimeMs,
        expectedDurationMs: progress.expectedDurationMs,
      }),
    );
  });
  const outputHistory = new OutputHistoryStore(dataRoot);
  await outputHistory.initialize();
  await outputHistory.registerRender(result, project.name);
  console.log(
    JSON.stringify({ event: "COMPLETED", at: new Date().toISOString(), result }),
  );
  await writeFile(
    path.join(import.meta.dirname, "result.json"),
    JSON.stringify({ status: "COMPLETED", startedAt, completedAt: new Date().toISOString(), result }, null, 2),
    "utf8",
  );
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(JSON.stringify({ event: "FAILED", at: new Date().toISOString(), message }));
  await writeFile(
    path.join(import.meta.dirname, "result.json"),
    JSON.stringify({ status: "FAILED", startedAt, failedAt: new Date().toISOString(), message }, null, 2),
    "utf8",
  );
  process.exitCode = 1;
}
