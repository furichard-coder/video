import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactRoot = path.join(appRoot, "artifacts");
const screenshotPath = path.join(artifactRoot, "source-organizer-empty.png");
await mkdir(artifactRoot, { recursive: true });
const screenshotUserData = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-screenshot-"));

const child = spawn(electron, [appRoot], {
  env: { ...process.env, APP_SCREENSHOT_PATH: screenshotPath, APP_TEST_USER_DATA_PATH: screenshotUserData },
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
process.stdout.write(`${screenshotPath}\n`);
