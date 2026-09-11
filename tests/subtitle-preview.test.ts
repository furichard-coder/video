import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceAsset } from "../src/shared/domain";
import type { ConcatRenderService } from "../src/main/services/concat-render";
import { ProjectStore } from "../src/main/services/project-store";
import { SubtitlePreviewService } from "../src/main/services/subtitle-preview";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("subtitle Intro preview cache", () => {
  it("creates a 480P MP4 in App cache, reports progress, reuses a valid key, and never changes the source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-preview-"));
    roots.push(root);
    const sourcePath = path.join(root, "河內 MOV source.mov");
    await writeFile(sourcePath, "read-only-camera-bytes");
    const before = createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex");
    const store = new ProjectStore(path.join(root, "app-data"));
    await store.initialize();
    const asset: SourceAsset = {
      id: "a".repeat(64),
      sourcePath,
      sourceIdentity: "b".repeat(64),
      fileName: path.basename(sourcePath),
      extension: ".mov",
      kind: "VIDEO",
      sizeBytes: 22,
      fileCreatedAt: new Date(0).toISOString(),
      fileModifiedAt: new Date(0).toISOString(),
      addedAt: new Date(0).toISOString(),
      addedOrder: 0,
      sourcePolicy: "READ_ONLY",
      previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
      previewCacheKey: "c".repeat(64),
      metadataState: "READY",
      mediaInfo: { durationMs: 4_000, width: 1920, height: 1080, videoCodec: "hevc" },
    };
    await store.addAssets([asset]);
    await store.setIntroSegments([
      { id: "intro", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_000, score: 90, reasons: ["人物"] },
    ]);
    const render = vi.fn(async (request, outputPath: string, _signal, onProgress) => {
      expect(request).toMatchObject({ resolution: "480P", purpose: "INTRO" });
      onProgress({ phase: "RENDERING", percent: 50, outTimeMs: 1_500, expectedDurationMs: 3_000 });
      await writeFile(outputPath, "playable-mp4-proxy");
      return {
        jobId: "preview",
        outputPath,
        sizeBytes: 18,
        expectedDurationMs: 3_000,
        transitionSeconds: 0.3,
        resolution: "480P",
        purpose: "INTRO",
      };
    });
    const service = new SubtitlePreviewService(path.join(root, "cache"), store, {
      render,
    } as unknown as ConcatRenderService);
    await service.initialize();
    const progress: number[] = [];
    const first = await service.ensureIntro480p(false, undefined, (item) => progress.push(item.percent));
    expect(first).toMatchObject({
      cacheStatus: "CREATED",
      durationMs: 3_000,
      bgmIncluded: false,
      sizeBytes: 18,
      url: expect.stringMatching(/^preview-media:\/\/subtitle\/[a-f0-9]{64}$/),
    });
    expect(progress).toContain(50);
    expect(await service.resolveExisting(first.cacheKey)).toMatch(/intro-subtitle-preview-480p\.mp4$/);
    const second = await service.ensureIntro480p();
    expect(second).toMatchObject({ cacheKey: first.cacheKey, cacheStatus: "HIT" });
    expect(render).toHaveBeenCalledTimes(1);
    const withBgm = await service.ensureIntro480p(true);
    expect(withBgm).toMatchObject({ cacheStatus: "CREATED", bgmIncluded: true });
    expect(withBgm.cacheKey).not.toBe(first.cacheKey);
    expect(await service.resolveExisting(withBgm.cacheKey)).toMatch(/intro-bgm-subtitle-preview-480p\.mp4$/);
    expect(render).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeBgm: true }),
      expect.any(String),
      undefined,
      expect.any(Function),
    );
    expect(
      createHash("sha256")
        .update(await readFile(sourcePath))
        .digest("hex"),
    ).toBe(before);
  });
});
