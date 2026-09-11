import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MediaProbe } from "../src/main/services/media-probe";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";

const tempRoots: string[] = [];

async function makeService() {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-app-folder-"));
  tempRoots.push(root);
  const store = new ProjectStore(path.join(root, "app-data"));
  await store.initialize();
  return { root, store, service: new SourceService(store, new MediaProbe()) };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SourceService folder selection", () => {
  it("accepts JPG, PNG, HEIC and MOV case-insensitively and gives photos a five-second default", async () => {
    const { root, service } = await makeService();
    const paths = ["照片一.JPG", "照片二.pNg", "手機照片.HEIC", "手機影片.MOV"].map((name) => path.join(root, name));
    await Promise.all(paths.map((filePath) => writeFile(filePath, "fixture")));
    const result = await service.importSelected(paths);

    expect(result.addedCount).toBe(4);
    expect(result.unsupportedCount).toBe(0);
    expect(result.project.sources.filter((asset) => asset.kind === "IMAGE")).toHaveLength(3);
    expect(
      result.project.sources
        .filter((asset) => asset.kind === "IMAGE")
        .every((asset) => asset.imageDurationMs === 5_000),
    ).toBe(true);
    expect(result.project.sources.find((asset) => asset.extension === ".mov")?.kind).toBe("VIDEO");
  });

  it("discovers supported media recursively without probing the whole folder", async () => {
    const { root, service } = await makeService();
    const sourceFolder = path.join(root, "selected-source");
    const nested = path.join(sourceFolder, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(sourceFolder, "clip02.mp4"), "fixture");
    await writeFile(path.join(nested, "photo01.jpg"), "fixture");
    await writeFile(path.join(nested, "notes.txt"), "unsupported");

    const progress: string[] = [];
    const result = await service.importSelected([sourceFolder], undefined, (event) => {
      progress.push(event.phase);
    });

    expect(result.addedCount).toBe(2);
    expect(result.unsupportedCount).toBe(1);
    expect(result.project.sources.every((asset) => asset.metadataState === "PENDING")).toBe(true);
    expect(progress).toContain("DISCOVERING");
    expect(progress).toContain("ADDING");
  });

  it("honors cancellation before touching the manifest", async () => {
    const { root, store, service } = await makeService();
    const sourcePath = path.join(root, "clip.mp4");
    await writeFile(sourcePath, "fixture");
    const controller = new AbortController();
    controller.abort();

    await expect(service.importSelected([sourcePath], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getProject().sources).toHaveLength(0);
  });

  it("refreshes a stale previewer cache key without discarding unchanged metadata", async () => {
    const { root, store, service } = await makeService();
    const sourcePath = path.join(root, "unchanged.mov");
    await writeFile(sourcePath, "fixture");
    const imported = await service.importSelected([sourcePath]);
    const asset = imported.project.sources[0];
    const mediaInfo = {
      durationMs: 1_000,
      width: 640,
      height: 360,
      displayWidth: 640,
      displayHeight: 360,
      rotationDegrees: 0,
      videoCodec: "hevc",
    };
    await store.updateAsset({ ...asset, previewCacheKey: "0".repeat(64), metadataState: "READY", mediaInfo });

    const refreshed = await service.refreshAsset(asset.id);
    expect(refreshed.previewCacheKey).not.toBe("0".repeat(64));
    expect(refreshed.metadataState).toBe("READY");
    expect(refreshed.mediaInfo).toEqual(mediaInfo);
  });
});
