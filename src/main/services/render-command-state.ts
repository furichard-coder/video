import { EventEmitter } from "node:events";
import type {
  ConcatRenderProgress,
  ConcatRenderRequest,
  ConcatRenderResult,
  RemotePreparedRender,
  RemoteRenderSnapshot,
} from "../../shared/domain";

export interface PreparedRenderRecord extends RemotePreparedRender {
  request: ConcatRenderRequest;
}

export interface RenderCommandHandlers {
  startPrepared(request: ConcatRenderRequest): Promise<ConcatRenderResult>;
  resumeCheckpoint(): Promise<ConcatRenderResult>;
  cancel(): Promise<void>;
}

function redactLocalPaths(message: string): string {
  return message.replace(/[A-Za-z]:\\[^\r\n"']+/g, "[本机路径已隐藏]");
}

/**
 * Main-process authority shared by Electron IPC and the LAN adapter.  It never
 * exposes an FFmpeg process handle; commands are routed back through the same
 * checked render entry points used by the desktop UI.
 */
export class RenderCommandState {
  private readonly events = new EventEmitter();
  private revision = 0;
  private prepared?: PreparedRenderRecord;
  private handlers?: RenderCommandHandlers;
  private pauseRequested = false;
  private pauseWaiters: Array<() => void> = [];
  private snapshotValue: RemoteRenderSnapshot;

  constructor(projectName: string) {
    this.snapshotValue = this.blank(projectName);
  }

  private blank(projectName: string): RemoteRenderSnapshot {
    return {
      revision: ++this.revision,
      capturedAt: new Date().toISOString(),
      projectName,
      state: "IDLE",
      prepared: false,
      progressPercent: 0,
    };
  }

  setHandlers(handlers: RenderCommandHandlers): void {
    this.handlers = handlers;
  }

  setProjectName(projectName: string): void {
    this.patch({ projectName });
  }

  prepare(request: ConcatRenderRequest, outputDisplayPath: string): RemotePreparedRender {
    const record: PreparedRenderRecord = {
      request: structuredClone(request),
      preparedAt: new Date().toISOString(),
      outputDisplayPath,
      resolution: request.resolution,
      renderMode: request.lowMemorySegmented ? "LOW_MEMORY" : request.highSpeedMode ? "HIGH_SPEED" : "NORMAL",
      audioMode: request.audioProcessing?.mode ?? "ORIGINAL_STEREO",
    };
    this.prepared = record;
    this.patch({
      state: "PREPARED",
      prepared: true,
      progressPercent: 0,
      resolution: record.resolution,
      renderMode: record.renderMode,
      audioMode: record.audioMode,
      latestError: undefined,
    });
    return this.publicPrepared(record);
  }

  clearPrepared(): void {
    this.prepared = undefined;
    if (this.snapshotValue.state === "PREPARED") this.patch({ state: "IDLE", prepared: false });
    else this.patch({ prepared: false });
  }

  getPrepared(): RemotePreparedRender | undefined {
    return this.prepared ? this.publicPrepared(this.prepared) : undefined;
  }

  snapshot(): RemoteRenderSnapshot {
    return structuredClone(this.snapshotValue);
  }

  subscribe(listener: (snapshot: RemoteRenderSnapshot) => void): () => void {
    this.events.on("snapshot", listener);
    return () => this.events.off("snapshot", listener);
  }

  markStarting(request: ConcatRenderRequest): void {
    this.pauseRequested = false;
    this.prepared = undefined;
    this.patch({
      state: "RUNNING",
      prepared: false,
      progressPercent: 0,
      resolution: request.resolution,
      renderMode: request.lowMemorySegmented ? "LOW_MEMORY" : request.highSpeedMode ? "HIGH_SPEED" : "NORMAL",
      audioMode: request.audioProcessing?.mode ?? "ORIGINAL_STEREO",
      latestError: undefined,
      pauseDetail: undefined,
    });
  }

  markResuming(mode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED"): void {
    this.pauseRequested = false;
    this.prepared = undefined;
    this.patch({
      state: "RUNNING",
      prepared: false,
      progressPercent: this.snapshotValue.progressPercent,
      renderMode: mode,
      latestError: undefined,
      pauseDetail: undefined,
    });
  }

  updateProgress(progress: ConcatRenderProgress): void {
    const resources = progress.resourceUsage;
    this.patch({
      state: this.pauseRequested && this.snapshotValue.state !== "PAUSED" ? "PAUSING" : this.snapshotValue.state,
      progressPercent: progress.percent,
      attemptElapsedMs: progress.attemptElapsedMs,
      cumulativeElapsedMs: progress.cumulativeElapsedMs,
      estimatedRemainingMs: progress.estimatedRemainingMs,
      currentSegment: progress.currentSegment,
      encoder: resources?.encoderName,
      cpuUsagePercent: resources?.cpuUsagePercent,
      gpuEncodeUsagePercent: resources?.gpuEncodeUsagePercent,
      ramUsedBytes: resources
        ? Math.max(0, resources.totalRamBytes - resources.availableRamBytes)
        : this.snapshotValue.ramUsedBytes,
      ramAvailableBytes: resources?.availableRamBytes,
      ssdFreeBytes: resources?.outputDriveFreeBytes,
    });
  }

  markTerminal(result: ConcatRenderResult): void {
    this.pauseRequested = false;
    this.releasePauseWaiters();
    this.patch({
      state: result.cancelled ? "CANCELLED" : "COMPLETED",
      prepared: false,
      progressPercent: result.cancelled ? this.snapshotValue.progressPercent : 100,
      attemptElapsedMs: result.attemptElapsedMs,
      cumulativeElapsedMs: result.cumulativeElapsedMs,
      estimatedRemainingMs: result.cancelled ? this.snapshotValue.estimatedRemainingMs : 0,
      pauseDetail: undefined,
    });
  }

  markFailed(error: unknown): void {
    this.pauseRequested = false;
    this.releasePauseWaiters();
    this.patch({
      state: error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
      prepared: false,
      latestError: redactLocalPaths(error instanceof Error ? error.message : String(error)),
      pauseDetail: undefined,
    });
  }

  async startPrepared(): Promise<void> {
    if (!this.handlers) throw new Error("遠端命令尚未就緒。");
    if (!this.prepared) throw new Error("Windows 端尚未准备可供远端启动的转档工作。");
    if (this.snapshotValue.state === "RUNNING" || this.snapshotValue.state === "PAUSING" || this.snapshotValue.state === "PAUSED")
      throw new Error("目前已有转档工作执行中。");
    const request = structuredClone(this.prepared.request);
    this.prepared = undefined;
    void this.handlers.startPrepared(request).catch((error) => this.markFailed(error));
  }

  async resumeCheckpoint(): Promise<void> {
    if (!this.handlers) throw new Error("遠端命令尚未就緒。");
    if (this.snapshotValue.state === "PAUSED") {
      this.resumeFromPause();
      return;
    }
    if (this.snapshotValue.state === "RUNNING" || this.snapshotValue.state === "PAUSING")
      throw new Error("目前转档没有暂停。");
    void this.handlers.resumeCheckpoint().catch((error) => this.markFailed(error));
  }

  requestPause(): void {
    if (this.snapshotValue.state !== "RUNNING") throw new Error("目前没有可暂停的转档工作。");
    this.pauseRequested = true;
    this.patch({ state: "PAUSING", pauseDetail: "等待目前 FFmpeg 分段完成后暂停，不会强制挂起或终止编码器。" });
  }

  async waitAtSafeBoundary(signal?: AbortSignal, detail = "已在安全分段边界暂停"): Promise<void> {
    if (!this.pauseRequested) return;
    this.patch({ state: "PAUSED", pauseDetail: detail });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.pauseWaiters = this.pauseWaiters.filter((waiter) => waiter !== done);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.pauseWaiters.push(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  resumeFromPause(): void {
    if (!this.pauseRequested && this.snapshotValue.state !== "PAUSED" && this.snapshotValue.state !== "PAUSING")
      throw new Error("目前转档没有暂停。");
    this.pauseRequested = false;
    this.patch({ state: "RUNNING", pauseDetail: undefined });
    this.releasePauseWaiters();
  }

  async cancel(): Promise<void> {
    if (!this.handlers) throw new Error("遠端命令尚未就緒。");
    this.pauseRequested = false;
    this.releasePauseWaiters();
    await this.handlers.cancel();
  }

  private publicPrepared(record: PreparedRenderRecord): RemotePreparedRender {
    const { request: _request, ...publicRecord } = record;
    return structuredClone(publicRecord);
  }

  private releasePauseWaiters(): void {
    for (const waiter of this.pauseWaiters.splice(0)) waiter();
  }

  private patch(patch: Partial<RemoteRenderSnapshot>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      revision: ++this.revision,
      capturedAt: new Date().toISOString(),
    };
    this.events.emit("snapshot", this.snapshot());
  }
}
