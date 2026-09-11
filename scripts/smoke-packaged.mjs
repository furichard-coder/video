import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMeta = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
const packageRoot = path.join(appRoot, "release", `v${packageMeta.version}`, "SceneryWalkerSourceOrganizer-win32-x64");
const executable = path.join(packageRoot, `SceneryWalkerSourceOrganizer-v${packageMeta.version}.exe`);
const smokeRoot = path.join(appRoot, "release", `v${packageMeta.version}`, ".smoke");
const markerPath = path.join(smokeRoot, "ready.txt");
const userDataPath = path.join(smokeRoot, "user-data");

await access(executable);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const child = spawn(executable, [], {
  cwd: packageRoot,
  env: {
    ...process.env,
    APP_SMOKE_TEST: "1",
    APP_SMOKE_MARKER_PATH: markerPath,
    APP_TEST_USER_DATA_PATH: userDataPath,
  },
  stdio: "ignore",
  windowsHide: true,
});

let observedExitCode;
const childExit = new Promise((resolve) => {
  child.once("exit", (code) => {
    observedExitCode = code ?? 1;
    resolve(observedExitCode);
  });
});

let exitCode;
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    await access(markerPath);
    exitCode =
      child.exitCode !== null
        ? child.exitCode
        : observedExitCode !== undefined
          ? observedExitCode
          : await Promise.race([
              childExit,
              // Windows can keep Electron's parent process alive briefly while its
              // sandboxed children finish shutting down, even after the ready marker.
              delay(20_000).then(() => 124),
            ]);
    break;
  } catch {
    if (child.exitCode !== null) {
      exitCode = child.exitCode;
      break;
    }
    await delay(250);
  }
}

if (exitCode === undefined) {
  if (observedExitCode !== undefined) {
    exitCode = observedExitCode;
  } else {
    child.kill();
    exitCode = 124;
  }
}

if (exitCode !== 0) {
  process.stderr.write(`Packaged smoke test failed with code ${exitCode}.\n`);
  process.exit(Number(exitCode) || 1);
}

await rm(smokeRoot, { recursive: true, force: true });
process.stdout.write("Packaged Windows App smoke test: PASS\n");
