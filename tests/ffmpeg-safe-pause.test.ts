import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFfmpegWithProgress } from "../src/main/services/concat-render";
import { DiskSpacePauseError } from "../src/main/services/render-disk-space";
import type { RenderDiskRuntimeSnapshot } from "../src/shared/domain";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FFmpeg cooperative disk pause", () => {
  it("gracefully stops and preserves the partial when runtime monitoring reports EMERGENCY", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ffmpeg-disk-pause-"));
    roots.push(root);
    const output = path.join(root, "recoverable.partial.mkv");
    const snapshot = {
      capturedAt: new Date().toISOString(),
      tempPath: root,
      tempVolume: path.parse(root).root,
      outputPath: output,
      outputVolume: path.parse(output).root,
      tempFreeBytes: 4 * 1024 ** 3,
      outputFreeBytes: 4 * 1024 ** 3,
      tempCapacityBytes: 100 * 1024 ** 3,
      outputCapacityBytes: 100 * 1024 ** 3,
      renderTempBytes: 0,
      intermediateBytes: 0,
      finalOutputBytes: 0,
      proxyCacheBytes: 0,
      estimatedRemainingWriteBytes: 8 * 1024 ** 3,
      safetyReserveBytes: 20 * 1024 ** 3,
      requiredAdditionalBytes: 4 * 1024 ** 3,
      pressureLevel: "EMERGENCY",
    } satisfies RenderDiskRuntimeSnapshot;

    const startedAt = Date.now();
    await expect(
      runFfmpegWithProgress(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=30",
          "-progress", "pipe:1", "-c:v", "libx264", "-preset", "ultrafast", "-f", "matroska", "-y", output,
        ],
        30_000,
        undefined,
        () => undefined,
        {
          outputPath: output,
          workingPaths: [output],
          currentSegment: "safe-pause-test",
          onResourceSnapshot: () => {
            throw new DiskSpacePauseError("safe pause", snapshot, output);
          },
        },
      ),
    ).rejects.toBeInstanceOf(DiskSpacePauseError);

    expect(Date.now() - startedAt).toBeLessThan(15_000);
    await expect(stat(output)).resolves.toMatchObject({ size: expect.any(Number) });
    expect((await stat(output)).size).toBeGreaterThan(0);
  }, 20_000);
});
