import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const viteBin = require.resolve("vite/bin/vite.js");
const electron = require("electron");
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const devUrl = "http://127.0.0.1:5173";

const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1"], {
  cwd: appRoot,
  stdio: "inherit",
  windowsHide: true,
});

let electronProcess;
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  electronProcess?.kill();
  vite.kill();
  await delay(150);
  process.exit(exitCode);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
vite.once("exit", (code) => {
  if (!stopping) void stop(code ?? 1);
});

for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const response = await fetch(devUrl);
    if (response.ok) break;
  } catch {
    // Vite is still starting.
  }
  if (attempt === 79) await stop(1);
  await delay(250);
}

electronProcess = spawn(electron, [appRoot], {
  cwd: appRoot,
  env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  stdio: "inherit",
  windowsHide: true,
});
electronProcess.once("exit", (code) => void stop(code ?? 0));

