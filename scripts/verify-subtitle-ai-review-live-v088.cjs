// Opt-in, one real review request, one read-only frame; no SRT/project writes.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { AiSettingsStore } = require("../dist-electron/main/services/ai-settings");
const { AiModelCatalogService } = require("../dist-electron/main/services/ai-model-catalog");
const {
  OpenAiSubtitleAiCheckProvider,
  classifySubtitleAiCheckError,
} = require("../dist-electron/main/services/subtitle-ai-check");
const realProfile = path.join(app.getPath("appData"), "SceneryWalker 素材整理");
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sw-v088-ai-review-"));
const reportRoot = path.resolve(__dirname, "../artifacts/v088-ai-review-live");
fs.mkdirSync(path.join(isolated, "settings"), { recursive: true });
for (const name of ["ai-providers.json", "ai-credentials.encrypted.json"])
  fs.copyFileSync(path.join(realProfile, "settings", name), path.join(isolated, "settings", name));
fs.copyFileSync(path.join(realProfile, "Local State"), path.join(isolated, "Local State"));
app.setPath("userData", isolated);
app.whenReady().then(async () => {
  const videoPath = "E:\\大雪山 YT video\\SceneryWalker_preview_20260926_0243.mp4";
  const report = {
    provider: "OPENAI",
    realRequest: true,
    reviewRequests: 0,
    formalSrtWritten: false,
    projectWritten: false,
    frameTimestampMs: 600000,
  };
  try {
    await fsp.mkdir(reportRoot, { recursive: true });
    const before = await fsp.stat(videoPath);
    const framePath = path.join(reportRoot, "review-frame.jpg");
    const extraction = spawnSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "600",
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=960:-2",
        "-q:v",
        "5",
        "-y",
        framePath,
      ],
      { windowsHide: true, timeout: 30000, encoding: "utf8" },
    );
    if (extraction.status !== 0) throw new Error("FRAME_EXTRACTION_FAILED");
    const image = await fsp.readFile(framePath);
    report.frameBytes = image.length;
    const settings = new AiSettingsStore(isolated, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      protect: (value) => safeStorage.encryptString(value).toString("base64"),
      unprotect: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    });
    await settings.initialize();
    const runtime = settings.getRuntimeAccount();
    const catalog = new AiModelCatalogService(isolated);
    // Manual selection is already the user's selection. The review itself is
    // the actual image/schema capability test, avoiding a second paid probe.
    const model =
      runtime.visionModel.toLowerCase() === "auto"
        ? await catalog.resolve("OPENAI", runtime.apiKey, "auto")
        : runtime.visionModel;
    report.modelId = model;
    const provider = new OpenAiSubtitleAiCheckProvider(model, runtime.apiKey);
    const cue = {
      id: "bounded-live-review",
      startMs: 600000,
      endMs: 605000,
      text: "眼前的景色隨鏡頭移動。",
      reviewStatus: "DRAFT",
    };
    report.originalCue = cue;
    report.reviewRequests = 1;
    const result = await provider.checkCue(
      {
        cue,
        cueIndex: 0,
        cueCount: 1,
        videoDurationMs: 8970194,
        title: "大雪山旅遊影片",
        description: "只依畫面校對這筆測試字幕，不猜測景點或物種；不是正式字幕。",
        displayLanguage: "zh-TW",
        evidence: [
          { role: "START", timestampMs: 600000, imageDataUrl: `data:image/jpeg;base64,${image.toString("base64")}` },
        ],
      },
      AbortSignal.timeout(90000),
    );
    report.result = result;
    report.status = "PASS";
    const after = await fsp.stat(videoPath);
    report.masterUnchanged = before.size === after.size && before.mtimeMs === after.mtimeMs;
  } catch (error) {
    const classified = classifySubtitleAiCheckError(error);
    report.status = "BLOCKED";
    report.errorCode = classified.code;
    report.retryable = classified.retryable;
    // Only sanitized provider errors; never dump credentials or raw HTTP bodies.
    report.message = classified.message;
  }
  await fsp.mkdir(reportRoot, { recursive: true });
  await fsp.writeFile(path.join(reportRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!path.basename(isolated).startsWith("sw-v088-ai-review-")) throw new Error("Unsafe test cleanup");
  await fsp.rm(isolated, { recursive: true, force: true });
  app.exit(report.status === "PASS" ? 0 : 2);
});
