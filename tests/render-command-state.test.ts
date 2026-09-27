import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConcatRenderRequest } from "../src/shared/domain";
import { RenderCommandState } from "../src/main/services/render-command-state";
import { RenderCheckpointStore } from "../src/main/services/render-checkpoint";

const request: ConcatRenderRequest = {
  outputToken: "token",
  orderedAssetIds: ["a".repeat(64)],
  transitionSeconds: 0.3,
  resolution: "1080P",
  audioProcessing: {
    mode: "ORIGINAL_STEREO",
    preset: "NATURAL",
    codec: "AAC",
    bitrateKbps: 384,
    sampleRate: 48_000,
    surroundStrengthPercent: 65,
    lfeStrengthPercent: 45,
    lfeCutoffHz: 100,
    loudnessTargetLufs: -16,
    truePeakCeilingDb: -1.5,
  },
};

describe("RenderCommandState", () => {
  it("starts only a PC-prepared render and never exposes its output path in the remote snapshot", async () => {
    const state = new RenderCommandState("Project");
    const start = vi.fn(async () => ({ jobId: "job", outputPath: "C:\\secret.mp4", sizeBytes: 1, expectedDurationMs: 1, transitionSeconds: 0.3 as const, resolution: "1080P" as const, purpose: "CONCAT" as const }));
    state.setHandlers({ startPrepared: start, resumeCheckpoint: start, cancel: async () => undefined });
    await expect(state.startPrepared()).rejects.toThrow("尚未准备");
    state.prepare(request, "C:\\private\\output.mp4");
    expect(JSON.stringify(state.snapshot())).not.toContain("private");
    await state.startPrepared();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("cooperatively pauses only at a safe boundary and resumes without aborting", async () => {
    const state = new RenderCommandState("Project");
    state.markStarting(request);
    state.requestPause();
    expect(state.snapshot().state).toBe("PAUSING");
    let passed = false;
    const waiting = state.waitAtSafeBoundary(undefined, "boundary").then(() => { passed = true; });
    await vi.waitFor(() => expect(state.snapshot().state).toBe("PAUSED"));
    expect(passed).toBe(false);
    state.resumeFromPause();
    await waiting;
    expect(passed).toBe(true);
    expect(state.snapshot().state).toBe("RUNNING");
  });

  it("keeps the completed safe-boundary segment resumable while paused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paused-checkpoint-"));
    try {
      const store = new RenderCheckpointStore(path.join(root, "state"));
      const outputPath = path.join(root, "output.mp4");
      const projectId = "aaaaaaaa-0001";
      const checkpoint = await store.create(projectId, "2026-09-14T00:00:00.000Z", "signature", "NORMAL", outputPath, request);
      const segmentPath = path.join(checkpoint.workRoot, "segment-001.mp4");
      await writeFile(segmentPath, "completed segment");
      checkpoint.segments.push({
        id: "segment-001",
        level: 0,
        index: 0,
        status: "PENDING",
        outputPath: segmentPath,
        durationMs: 1_000,
        renderProfile: "NORMAL",
      });
      await store.completeSegment(checkpoint, checkpoint.segments[0]);

      const state = new RenderCommandState("Project");
      state.markStarting(request);
      state.requestPause();
      const waiting = state.waitAtSafeBoundary(undefined, "segment-001 已完成并写入 checkpoint");
      await vi.waitFor(() => expect(state.snapshot().state).toBe("PAUSED"));

      const restored = await new RenderCheckpointStore(path.join(root, "state")).load(projectId);
      expect(restored?.segments).toEqual([
        expect.objectContaining({ id: "segment-001", status: "COMPLETED", sizeBytes: 17 }),
      ]);
      expect(await store.offer(projectId)).toMatchObject({ completedSegmentCount: 1, totalSegmentCount: 0 });
      state.resumeFromPause();
      await waiting;
      expect(state.snapshot().state).toBe("RUNNING");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
