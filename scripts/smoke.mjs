import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const smokeUserData = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-smoke-"));

const child = spawn(electron, [appRoot, "--smoke"], {
  env: { ...process.env, APP_SMOKE_TEST: "1", APP_TEST_USER_DATA_PATH: smokeUserData },
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

let timeoutHandle;
const timeoutExit = new Promise((resolve) => {
  timeoutHandle = setTimeout(() => {
    child.kill();
    resolve(124);
  }, 30_000);
});
const exitCode = await Promise.race([
  new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1))),
  timeoutExit,
]);
clearTimeout(timeoutHandle);
// Renderer/GPU descendants can inherit the capture pipes even after the smoke
// main process exits. The readiness result is complete at this point, so close
// those local test streams rather than keeping the validation shell alive.
child.stdout.destroy();
child.stderr.destroy();

if (exitCode !== 0 || !output.includes("SMOKE_READY")) {
  await rm(smokeUserData, { recursive: true, force: true });
  process.stderr.write(output);
  process.exit(Number(exitCode) || 1);
}

await rm(smokeUserData, { recursive: true, force: true });
process.stdout.write("Electron smoke test: PASS\n");
