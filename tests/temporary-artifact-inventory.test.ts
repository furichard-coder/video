import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRegisteredTemporaryArtifacts } from "../src/main/services/temporary-artifact-inventory";
import type { TemporaryArtifactInventory } from "../src/shared/domain";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded temporary artifact inventory", () => {
  it("scans only registered roots and named SceneryWalker/version siblings", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "scenerywalker-inventory-"));
    roots.push(parent);
    const configured = path.join(parent, "SceneryWalker");
    const cache = path.join(parent, "SceneryWalkerCache", "preview-cache");
    const quickbench = path.join(parent, "v080-quickbench");
    const unrelated = path.join(parent, "unrelated-data");
    await Promise.all([configured, cache, quickbench, unrelated].map((item) => mkdir(item, { recursive: true })));
    const current = path.join(configured, "required.mkv");
    await writeFile(current, "required");
    await writeFile(path.join(cache, "thumb.jpg"), "cache");
    await writeFile(path.join(quickbench, "probe.mkv"), "unknown");
    await writeFile(path.join(quickbench, "broken.partial.mkv"), "partial");
    await writeFile(path.join(unrelated, "private.bin"), "do not scan");
    const known: TemporaryArtifactInventory = {
      capturedAt: new Date().toISOString(),
      roots: [configured],
      items: [{ artifactId: "required", artifactType: "COMPLETED_SEGMENT", path: current, drive: path.parse(current).root.toUpperCase(), sizeBytes: 8, status: "RESUME_REQUIRED", referencedByCurrentCheckpoint: true, safeToDelete: false, safeToMove: true, reason: "required" }],
      totalBytes: 8,
      immediatelyReclaimableBytes: 0,
      movableBytes: 8,
    };

    const protectedSource = path.join(cache, "source.mp4");
    await writeFile(protectedSource, "source");
    const inventory = await scanRegisteredTemporaryArtifacts([configured], known, [protectedSource]);
    expect(inventory.roots).toEqual(expect.arrayContaining([configured, path.join(parent, "SceneryWalkerCache"), quickbench]));
    expect(inventory.roots).not.toContain(unrelated);
    expect(inventory.items.find((item) => item.path.endsWith("thumb.jpg"))).toMatchObject({ status: "REBUILDABLE_CACHE", safeToDelete: false });
    expect(inventory.items.find((item) => item.path.endsWith("source.mp4"))).toMatchObject({ status: "UNKNOWN", referencedByCurrentCheckpoint: true, safeToDelete: false });
    expect(inventory.items.find((item) => item.path.endsWith("probe.mkv"))).toMatchObject({ status: "UNKNOWN", safeToDelete: false });
    expect(inventory.items.find((item) => item.path.endsWith("broken.partial.mkv"))).toMatchObject({ status: "UNKNOWN", safeToDelete: false });
    expect(inventory.items.find((item) => item.artifactId === "required")).toMatchObject({ referencedByCurrentCheckpoint: true, safeToDelete: false });
    expect(inventory.items.some((item) => item.path.includes("private.bin"))).toBe(false);
    expect(inventory.immediatelyReclaimableBytes).toBe(0);
  });
});
