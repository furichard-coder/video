import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConcatRenderRequest } from "../src/shared/domain";
import { RenderCheckpointStore } from "../src/main/services/render-checkpoint";
import { RenderElapsedTracker } from "../src/main/services/render-elapsed";
import { runProcess } from "../src/main/services/process-runner";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(): ConcatRenderRequest {
  return {
    outputToken: "token",
    orderedAssetIds: ["asset-1"],
    transitionSeconds: 0.3,
    resolution: "1080P",
    videoCodec: "H265_QSV",
    lowMemorySegmented: true,
    purpose: "CONCAT",
    prependIntro: false,
    includeBgm: false,
    subtitleBurnIn: { enabled: false, tracks: [] },
  };
}

describe("persistent render checkpoint", () => {
  it("creates new work roots in the selected Render TEMP and keeps that root across reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-selected-temp-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const selectedTemp = path.join(root, "selected-render-temp");
    const store = new RenderCheckpointStore(stateRoot);
    const checkpoint = await store.create(
      "91234567-abcd-4def-8123-0123456789ab",
      "2026-09-26T00:00:00.000Z",
      "signature",
      "NORMAL",
      path.join(root, "out.mp4"),
      request(),
      selectedTemp,
    );

    expect(path.dirname(checkpoint.workRoot)).toBe(path.resolve(selectedTemp));
    const restored = await new RenderCheckpointStore(stateRoot).load(checkpoint.projectId);
    expect(restored?.workRoot).toBe(checkpoint.workRoot);
  });

  it("persists one validated rebuildable picture/base-audio master and clears only that cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-base-master-"));
    roots.push(root);
    const source = path.join(root, "base.mkv");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180:r=30",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1", "-t", "1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "flac", "-y", source,
    ]);
    const projectId = "81234567-abcd-4def-8123-0123456789ab";
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const saved = await store.saveVideoBaseMaster(projectId, "PICTURE-A", source, 1_000, "H264", "360P");
    expect(await store.loadVideoBaseMaster(projectId, "PICTURE-A")).toMatchObject({
      outputPath: saved.outputPath, pictureBaseSignature: "PICTURE-A", durationMs: 1_000,
    });
    await store.discardVideoBaseMaster(projectId);
    expect(await store.loadVideoBaseMaster(projectId, "PICTURE-A")).toBeUndefined();
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("survives a new store instance, supports repeated Windows-safe saves and can be discarded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-"));
    roots.push(root);
    const outputPath = path.join(root, "out.mp4");
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const checkpoint = await store.create(
      "01234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "LOW_MEMORY",
      outputPath,
      request(),
    );
    checkpoint.totalSegmentCount = 7;
    checkpoint.concatStatus = "FAILED";
    checkpoint.lastError = "Cannot allocate memory";
    await store.save(checkpoint);
    await store.appendDiagnostic(checkpoint, { event: "TEST_OOM" });

    const restored = await new RenderCheckpointStore(path.join(root, "state")).load(checkpoint.projectId);
    expect(restored).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      totalSegmentCount: 7,
      concatStatus: "FAILED",
      lastError: "Cannot allocate memory",
    });
    expect(await readFile(checkpoint.diagnosticLogPath, "utf8")).toContain("TEST_OOM");
    expect(await store.offer(checkpoint.projectId)).toMatchObject({ completedSegmentCount: 0, totalSegmentCount: 7 });

    await store.discard(checkpoint.projectId, checkpoint.checkpointId);
    expect(await store.offer(checkpoint.projectId)).toBeUndefined();
    await expect(stat(checkpoint.workRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a completed v0.80 checkpoint without recreating an offer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-complete-"));
    roots.push(root);
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const checkpoint = await store.create(
      "d1234567-abcd-4def-8123-0123456789ab",
      "2026-09-27T00:00:00.000Z",
      "signature",
      "NORMAL",
      path.join(root, "out.mp4"),
      request(),
    );
    await store.complete(checkpoint.projectId, checkpoint.checkpointId);
    expect(await store.load(checkpoint.projectId)).toBeUndefined();
    expect(await store.offer(checkpoint.projectId)).toBeUndefined();
  });

  it("migrates schema 1 checkpoints without inventing elapsed time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-migration-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const store = new RenderCheckpointStore(stateRoot);
    const checkpoint = await store.create(
      "11234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "LOW_MEMORY",
      path.join(root, "out.mp4"),
      request(),
    );
    const legacy = { ...checkpoint, schemaVersion: 1 } as Record<string, unknown>;
    delete legacy.timing;
    await writeFile(path.join(stateRoot, `${checkpoint.projectId}.v080.render-state.json`), JSON.stringify(legacy));

    const restored = await store.load(checkpoint.projectId);
    expect(restored).toMatchObject({ schemaVersion: 4, timing: { cumulativeElapsedMs: 0 } });
  });

  it("does not advertise completed JSON records whose physical segment files are missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-physical-"));
    roots.push(root);
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const checkpoint = await store.create(
      "a1234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "NORMAL",
      path.join(root, "out.mp4"),
      request(),
    );
    const presentPath = path.join(checkpoint.workRoot, "present.mkv");
    const missingPath = path.join(checkpoint.workRoot, "missing.mkv");
    await writeFile(presentPath, "segment");
    checkpoint.totalSegmentCount = 2;
    checkpoint.segments = [
      { id: "present", level: 0, index: 0, status: "COMPLETED", outputPath: presentPath, durationMs: 1_000, sizeBytes: 7 },
      { id: "missing", level: 0, index: 1, status: "COMPLETED", outputPath: missingPath, durationMs: 1_000, sizeBytes: 7 },
    ];
    await store.save(checkpoint);

    expect(await store.offer(checkpoint.projectId)).toMatchObject({
      completedSegmentCount: 1,
      recordedCompletedSegmentCount: 2,
      missingCompletedSegmentCount: 1,
      physicalState: "PARTIAL",
    });
  });

  it("releases only completed intermediates inside the owned work root and keeps audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-gc-"));
    roots.push(root);
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const checkpoint = await store.create(
      "b1234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "NORMAL",
      path.join(root, "out.mp4"),
      request(),
    );
    const owned = path.join(checkpoint.workRoot, "owned.mkv");
    const outside = path.join(root, "outside.mkv");
    await writeFile(owned, "owned");
    await writeFile(outside, "outside");
    checkpoint.segments = [
      { id: "owned", level: 0, index: 0, status: "COMPLETED", outputPath: owned, durationMs: 1_000, sizeBytes: 5 },
      { id: "outside", level: 0, index: 1, status: "COMPLETED", outputPath: outside, durationMs: 1_000, sizeBytes: 7 },
    ];
    await store.save(checkpoint);

    expect(await store.releaseConsumedSegments(checkpoint, [owned, outside])).toBe(5);
    await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outside)).resolves.toMatchObject({ size: 7 });
    const restored = await store.load(checkpoint.projectId);
    expect(restored?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "owned", status: "RELEASED" }),
        expect.objectContaining({ id: "outside", status: "COMPLETED" }),
      ]),
    );
  });

  it("imports v0.79 recovery state copy-on-write without deleting or relocating legacy segments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-checkpoint-v079-import-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const legacyTemp = path.join(root, "legacy-temp");
    const store = new RenderCheckpointStore(stateRoot);
    const legacy = await store.create(
      "c1234567-abcd-4def-8123-0123456789ab",
      "2026-09-26T00:00:00.000Z",
      "signature",
      "HIGH_SPEED",
      path.join(root, "out.mp4"),
      request(),
      legacyTemp,
    );
    const legacySegment = path.join(legacy.workRoot, "level-1-part-001.mkv");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=navy:s=160x90:r=30:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", legacySegment,
    ]);
    const legacySegmentSize = (await stat(legacySegment)).size;
    legacy.checkpointProducer = undefined;
    legacy.concatStatus = "PAUSED_DISK_SPACE";
    legacy.segments = [
      { id: "legacy", level: 1, index: 0, status: "COMPLETED", outputPath: legacySegment, durationMs: 1_000, sizeBytes: legacySegmentSize },
    ];
    await store.save(legacy);
    await rm(path.join(stateRoot, `${legacy.projectId}.v080.render-state.json`), { force: true });
    const originalRecordPath = path.join(stateRoot, `${legacy.projectId}.render-state.json`);
    const originalSha = createHash("sha256").update(await readFile(originalRecordPath)).digest("hex");

    await expect(store.discard(legacy.projectId, legacy.checkpointId)).rejects.toThrow("偵測到舊版復原資料");
    await expect(stat(legacySegment)).resolves.toMatchObject({ size: legacySegmentSize });

    const imported = await store.importV079RecoveryCopy(legacy.projectId, legacy.checkpointId);
    expect(imported).toMatchObject({
      checkpointProducer: "v0.80",
      recoveryMigration: {
        sourceCheckpointId: legacy.checkpointId,
        sourceWorkRoot: legacy.workRoot,
        sourcePreserved: true,
        validatedExternalSegmentBytes: legacySegmentSize,
        validatedExternalSegmentDurationMs: 1_000,
      },
    });
    expect(imported?.checkpointId).not.toBe(legacy.checkpointId);
    expect(imported?.workRoot).not.toBe(legacy.workRoot);
    expect(imported?.segments[0]?.outputPath).toBe(legacySegment);
    expect(imported?.segments[0]?.status).toBe("COMPLETED");
    await expect(stat(legacySegment)).resolves.toMatchObject({ size: legacySegmentSize });
    await expect(stat(imported!.recoveryMigration!.sourceStateBackupPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(createHash("sha256").update(await readFile(originalRecordPath)).digest("hex")).toBe(originalSha);

    // Successful cleanup of the v0.80 work root must never remove the v0.79
    // recovery source or its external segment references.
    await store.discard(imported!.projectId, imported!.checkpointId);
    await expect(stat(imported!.workRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(legacySegment)).resolves.toMatchObject({ size: legacySegmentSize });
    await expect(stat(imported!.recoveryMigration!.sourceStateBackupPath)).resolves.toMatchObject({ size: expect.any(Number) });

    // A user discard removes only the v0.80 attempt, so the protected legacy
    // source remains intentionally available. Successful completion writes a
    // marker that suppresses offering that same failed job again.
    expect((await store.load(legacy.projectId))?.checkpointId).toBe(legacy.checkpointId);
    const secondImport = await store.importV079RecoveryCopy(legacy.projectId, legacy.checkpointId);
    await store.complete(secondImport!.projectId, secondImport!.checkpointId);
    expect(await store.load(legacy.projectId)).toBeUndefined();
    await expect(stat(legacySegment)).resolves.toMatchObject({ size: legacySegmentSize });
  });

  it("uses monotonic elapsed time and recovers only through the last persisted heartbeat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-elapsed-"));
    roots.push(root);
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const checkpoint = await store.create(
      "21234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "LOW_MEMORY",
      path.join(root, "out.mp4"),
      request(),
    );
    checkpoint.timing.activeAttempt = {
      attemptId: "previous-attempt",
      startedAt: "2026-09-13T00:00:00.000Z",
      lastHeartbeatAt: "2026-09-13T00:02:00.000Z",
      persistedElapsedMs: 120_000,
    };
    await store.save(checkpoint);

    let wallMs = Date.parse("2026-09-13T08:00:00.000Z");
    let monotonicMs = 5_000;
    const tracker = new RenderElapsedTracker(
      store,
      "31234567-abcd-4def-8123-0123456789ab",
      checkpoint,
      { wallNowMs: () => wallMs, monotonicNowMs: () => monotonicMs },
      60 * 60 * 1000,
    );
    tracker.markFfmpegStarted();
    monotonicMs += 80_000;
    wallMs += 80_000;
    const finished = await tracker.finish("COMPLETED");

    expect(finished).toMatchObject({ attemptElapsedMs: 80_000, cumulativeElapsedMs: 200_000 });
    const restored = await store.load(checkpoint.projectId);
    expect(restored?.timing).toMatchObject({
      cumulativeElapsedMs: 200_000,
      lastAttemptElapsedMs: 80_000,
    });
    expect(restored?.timing.activeAttempt).toBeUndefined();
    expect(await readFile(store.timingDiagnosticPath("31234567-abcd-4def-8123-0123456789ab"), "utf8")).toContain(
      "INTERRUPTED_ATTEMPT_RECOVERED",
    );
  });

  it("writes a timestamp-derived five-minute heartbeat without fixed-step accumulation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-elapsed-heartbeat-"));
    roots.push(root);
    const store = new RenderCheckpointStore(path.join(root, "state"));
    const checkpoint = await store.create(
      "61234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "LOW_MEMORY",
      path.join(root, "out.mp4"),
      request(),
    );
    let wallMs = Date.parse("2026-09-13T01:00:00.000Z");
    let monotonicMs = 7_000;
    const renderId = "71234567-abcd-4def-8123-0123456789ab";
    const tracker = new RenderElapsedTracker(
      store,
      renderId,
      checkpoint,
      { wallNowMs: () => wallMs, monotonicNowMs: () => monotonicMs },
      60 * 60 * 1000,
    );
    tracker.markFfmpegStarted();
    // A delayed callback must save the measured 5:07, never a synthetic 5:00.
    wallMs += 307_654;
    monotonicMs += 307_654;
    await tracker.persistHeartbeat();

    const restored = await store.load(checkpoint.projectId);
    expect(restored?.timing.activeAttempt).toMatchObject({ persistedElapsedMs: 307_654 });
    expect(await readFile(store.timingDiagnosticPath(renderId), "utf8")).toContain("ELAPSED_HEARTBEAT");
    await tracker.finish("INTERRUPTED");
  });

  it.each([
    ["COMPLETED", "ELAPSED_ATTEMPT_COMPLETED"],
    ["FAILED", "ELAPSED_ATTEMPT_FAILED"],
    ["CANCELLED", "ELAPSED_ATTEMPT_CANCELLED"],
  ] as const)("persists exact %s timing independently from disposable checkpoint files", async (status, event) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `render-elapsed-${status.toLowerCase()}-`));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const store = new RenderCheckpointStore(stateRoot);
    const checkpoint = await store.create(
      "41234567-abcd-4def-8123-0123456789ab",
      "2026-09-13T00:00:00.000Z",
      "signature",
      "LOW_MEMORY",
      path.join(root, "out.mp4"),
      request(),
    );
    let wallMs = Date.parse("2026-09-13T01:00:00.000Z");
    let monotonicMs = 10_000;
    const renderId = `51234567-abcd-4def-8123-0123456789a${status === "COMPLETED" ? "1" : status === "FAILED" ? "2" : "3"}`;
    const tracker = new RenderElapsedTracker(
      store,
      renderId,
      checkpoint,
      { wallNowMs: () => wallMs, monotonicNowMs: () => monotonicMs },
      60 * 60 * 1000,
    );

    // Preflight and confirmation time are outside the attempt because the
    // timer has not observed an FFmpeg child process yet.
    wallMs += 90_000;
    monotonicMs += 90_000;
    expect(tracker.snapshot()).toBeUndefined();
    tracker.markFfmpegStarted();
    wallMs += 43_210;
    monotonicMs += 43_210;
    expect(await tracker.finish(status)).toMatchObject({
      attemptElapsedMs: 43_210,
      cumulativeElapsedMs: 43_210,
      timingStatus: status,
    });

    // Completion and user cancellation discard resumable state in the
    // existing flow. The dedicated timing history must remain auditable.
    if (status !== "FAILED") await store.discard(checkpoint.projectId, checkpoint.checkpointId);
    const timingHistory = await readFile(store.timingDiagnosticPath(renderId), "utf8");
    expect(timingHistory).toContain(event);
    expect(timingHistory).toContain('"attemptElapsedMs":43210');
    if (status === "CANCELLED") expect(await store.offer(checkpoint.projectId)).toBeUndefined();
  });
});
