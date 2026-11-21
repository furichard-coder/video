import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";

const eTemp = "E:\\temp";

it.skipIf(process.platform !== "win32" || !existsSync(eTemp))(
  "reads E: and C: completed segments directly during final concat without mirroring",
  async () => {
    const eRoot = await mkdtemp(path.join(eTemp, "scenerywalker-v081-test-"));
    const cRoot = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-v081-test-"));
    try {
      const segments = [path.join(eRoot, "one.mkv"), path.join(cRoot, "two.mkv")];
      for (const [index, segment] of segments.entries()) {
        await runProcess("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=${index ? "blue" : "red"}:s=160x90:r=30:d=0.5`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          "-y",
          segment,
        ]);
      }
      const listPath = path.join(cRoot, "concat.txt");
      const outputPath = path.join(cRoot, "joined.mkv");
      await writeFile(
        listPath,
        segments.map((segment) => `file '${segment.replaceAll("\\", "/")}'`).join("\n"),
        "utf8",
      );
      await runProcess("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-y",
        outputPath,
      ]);
      const info = await new MediaProbe().probe(outputPath);
      expect(info.videoCodec).toBe("h264");
      expect(info.durationMs).toBeGreaterThan(900);
      expect(await readFile(segments[0])).not.toHaveLength(0);
      expect(await readFile(segments[1])).not.toHaveLength(0);
    } finally {
      for (const [created, parent] of [
        [eRoot, eTemp],
        [cRoot, os.tmpdir()],
      ]) {
        if (
          path.dirname(path.resolve(created)).toLowerCase() !== path.resolve(parent).toLowerCase() ||
          !path.basename(created).startsWith("scenerywalker-v081-test-")
        ) {
          throw new Error("Temporary test root escaped its dedicated parent; refusing cleanup.");
        }
        await rm(created, { recursive: true, force: true });
      }
    }
  },
  30_000,
);
