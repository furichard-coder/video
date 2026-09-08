import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextAvailableOutputPath, safePreviewFileName } from "../src/main/services/output-path";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });

describe("automatic preview output path", () => {
  it("keeps a readable MP4 name while neutralizing path and Windows-invalid characters", () => {
    expect(safePreviewFileName("C:\\別的資料夾\\河內:片頭?.MP4")).toBe("河內_片頭_.mp4");
    expect(safePreviewFileName("")) .toBe("SceneryWalker_preview.mp4");
  });

  it("uses the requested directory and generates a collision-safe next name without overwriting", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-output-")); roots.push(directory);
    const first = path.join(directory, "河內 預覽.mp4");
    await writeFile(first, "existing preview");
    const next = await nextAvailableOutputPath(directory, "河內 預覽.mp4");
    expect(next).toBe(path.join(directory, "河內 預覽_02.mp4"));
  });
});
