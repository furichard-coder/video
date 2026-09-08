import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputHistoryStore } from "../src/main/services/output-history";
import type { MediaProbe } from "../src/main/services/media-probe";

const roots: string[] = [];

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent preview output history", () => {
  it("persists completed and cancelled playable renders across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-")); roots.push(root);
    const completePath = path.join(root, "河內 正片 preview.mp4");
    const cancelledPath = path.join(root, "取消後短片.mp4");
    await writeFile(completePath, "complete-mp4"); await writeFile(cancelledPath, "short-mp4");
    const first = new OutputHistoryStore(path.join(root, "app-data")); await first.initialize();
    await first.registerRender({ jobId: "render-complete", outputPath: completePath, sizeBytes: 12, expectedDurationMs: 20_000, transitionSeconds: 0.3, resolution: "480P", purpose: "CONCAT", includedIntroSegmentCount: 2 }, "河內");
    await first.registerRender({ jobId: "render-cancelled", outputPath: cancelledPath, sizeBytes: 9, expectedDurationMs: 2_000, plannedDurationMs: 20_000, transitionSeconds: 0.3, resolution: "360P", purpose: "CONCAT", cancelled: true }, "河內");

    const reopened = new OutputHistoryStore(path.join(root, "app-data")); await reopened.initialize();
    expect(await reopened.snapshot()).toMatchObject({ schemaVersion: 1, outputs: [
      { jobId: "render-cancelled", exists: true, cancelled: true },
      { jobId: "render-complete", exists: true, includedIntroSegmentCount: 2, projectName: "河內" },
    ] });
  });

  it("removes only the index record and never changes or deletes the MP4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-safe-")); roots.push(root);
    const outputPath = path.join(root, "含 中文 空格.mp4"); await writeFile(outputPath, "irreplaceable-preview");
    const before = await sha256(outputPath);
    const store = new OutputHistoryStore(path.join(root, "app-data")); await store.initialize();
    await store.registerRender({ jobId: "safe-record", outputPath, sizeBytes: 21, expectedDurationMs: 1_000, transitionSeconds: 0.3, resolution: "360P", purpose: "CONCAT" });
    expect((await store.removeRecord("safe-record")).outputs).toEqual([]);
    expect((await stat(outputPath)).isFile()).toBe(true);
    expect(await sha256(outputPath)).toBe(before);
  });

  it("imports a previously rendered MP4 once and keeps an offline record visible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "output-history-import-")); roots.push(root);
    const outputPath = path.join(root, "以前的 預覽檔.mp4"); await writeFile(outputPath, "existing-mp4");
    const probe = { probe: vi.fn(async () => ({ width: 1280, height: 720, displayWidth: 1280, displayHeight: 720, durationMs: 8_500, videoCodec: "h264", audioCodec: "aac" })) } as unknown as MediaProbe;
    const store = new OutputHistoryStore(path.join(root, "app-data"), probe); await store.initialize();
    const imported = await store.importExisting([outputPath, outputPath]);
    expect(imported).toMatchObject({ addedCount: 1, duplicateCount: 1, errors: [] });
    expect(imported.history.outputs[0]).toMatchObject({ fileName: "以前的 預覽檔.mp4", origin: "IMPORTED_EXISTING", purpose: "UNKNOWN", resolution: "720P", exists: true });
    await rm(outputPath);
    const offline = await store.snapshot();
    expect(offline.outputs[0]).toMatchObject({ exists: false, fileName: "以前的 預覽檔.mp4" });
    await expect(store.get(offline.outputs[0].jobId)).rejects.toThrow(/移動、刪除或離線/);
  });
});
