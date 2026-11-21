import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceProject = "C:\\大雪山\\我的素材專案.swproj";
const artifactRoot = path.join(appRoot, "artifacts", "subtitle-ui-qa");
const cases = [
  { label: "native-1366x768", width: 1366, height: 768, zoom: 1 },
  { label: "native-1920x1080", width: 1920, height: 1080, zoom: 1 },
  { label: "simulated-css-3840x2160-at-40%-host-clamped", width: 3840, height: 2160, zoom: 0.4 },
  { label: "zoom-125%-at-1366x768", width: 1366, height: 768, zoom: 1.25 },
  { label: "zoom-150%-at-1366x768", width: 1366, height: 768, zoom: 1.5 },
];

await mkdir(artifactRoot, { recursive: true });
const userDataRoot = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-subtitle-ui-qa-"));
const manifestPath = path.join(userDataRoot, "projects", "default", "project.source-manifest.json");
const sessionPath = path.join(userDataRoot, "projects", "active-project.json");
const results = [];

try {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await copyFile(sourceProject, manifestPath);
  const fixture = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !Array.isArray(fixture.subtitleCues) ||
    fixture.subtitleCues.length !== 63 ||
    fixture.subtitleCues.some((cue) => cue.reviewStatus !== "DRAFT")
  ) {
    throw new Error("The copied project no longer contains the expected 63 draft subtitle cues.");
  }
  // Keep the copied subtitle drafts but detach them from source/timeline clips so review opens without generating previews.
  fixture.sources = [];
  fixture.timelineOrder = [];
  fixture.introSegments = [];
  fixture.subtitleCues = fixture.subtitleCues.map(({ sourceAssetId: _sourceAssetId, ...cue }) => ({
    ...cue,
    timelineScope: "MAIN",
  }));
  await writeFile(manifestPath, JSON.stringify(fixture), "utf8");
  await writeFile(sessionPath, JSON.stringify({ filePath: manifestPath }, null, 2), "utf8");

  for (const testCase of cases) {
    const screenshotPath = path.join(artifactRoot, `${testCase.label}.png`);
    const metricsPath = path.join(artifactRoot, `${testCase.label}.json`);
    const child = spawn(electron, [appRoot], {
      env: {
        ...process.env,
        APP_TEST_USER_DATA_PATH: userDataRoot,
        APP_SCREENSHOT_PATH: screenshotPath,
        APP_SUBTITLE_UI_QA: "1",
        APP_SUBTITLE_UI_QA_LABEL: testCase.label,
        APP_SUBTITLE_UI_QA_WIDTH: String(testCase.width),
        APP_SUBTITLE_UI_QA_HEIGHT: String(testCase.height),
        APP_SUBTITLE_UI_QA_ZOOM: String(testCase.zoom),
        APP_SUBTITLE_UI_QA_METRICS_PATH: metricsPath,
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
    const exitCode = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        child.kill();
        resolve(124);
      }, 55_000);
      child.once("exit", (code) => {
        clearTimeout(timeoutId);
        resolve(code ?? 1);
      });
    });
    const resultLine = output.split(/\r?\n/).find((line) => line.startsWith("SUBTITLE_UI_QA_RESULT "));
    if (exitCode !== 0 || !resultLine) {
      throw new Error(`Subtitle UI QA failed for ${testCase.label} (exit ${exitCode}).\n${output}`);
    }
    const metrics = JSON.parse(resultLine.slice("SUBTITLE_UI_QA_RESULT ".length));
    results.push({ ...metrics, screenshotPath, metricsPath });
    process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
  }

  const summaryPath = path.join(artifactRoot, "results.json");
  await writeFile(summaryPath, JSON.stringify({ sourceProject, results }, null, 2), "utf8");
  process.stdout.write(`SUBTITLE_UI_QA_COMPLETE ${summaryPath}\n`);
} finally {
  // userDataRoot was created uniquely for this run; all project-store writes are confined to it.
  await rm(userDataRoot, { recursive: true, force: true });
}
