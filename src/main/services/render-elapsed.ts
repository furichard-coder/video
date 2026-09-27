import { randomUUID } from "node:crypto";
import type { ConcatRenderProgress } from "../../shared/domain";
import { RenderCheckpointStore, type RenderCheckpointRecord } from "./render-checkpoint";

export const RENDER_TIMING_HEARTBEAT_MS = 5 * 60 * 1000;

export type RenderTimingStatus = NonNullable<ConcatRenderProgress["timingStatus"]>;

export interface RenderTimingSnapshot {
  attemptElapsedMs: number;
  cumulativeElapsedMs: number;
  timingCapturedAt: string;
  timingStatus: RenderTimingStatus;
}

export interface RenderElapsedClock {
  wallNowMs(): number;
  monotonicNowMs(): number;
}

const SYSTEM_CLOCK: RenderElapsedClock = {
  wallNowMs: () => Date.now(),
  monotonicNowMs: () => performance.now(),
};

function elapsed(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * Tracks one user-visible render invocation. The clock starts only when the
 * first FFmpeg child has a PID. UI snapshots use a monotonic clock; wall-clock
 * timestamps exist only for persistence and conservative crash recovery.
 */
export class RenderElapsedTracker {
  private started = false;
  private finished = false;
  private monotonicStartedAt = 0;
  private attemptId?: string;
  private attemptStartedAt?: string;
  private cumulativeBeforeAttemptMs = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private writes: Promise<void> = Promise.resolve();
  private lastSnapshot?: RenderTimingSnapshot;

  constructor(
    private readonly store: RenderCheckpointStore,
    private readonly renderId: string,
    private readonly checkpoint?: RenderCheckpointRecord,
    private readonly clock: RenderElapsedClock = SYSTEM_CLOCK,
    private readonly heartbeatMs = RENDER_TIMING_HEARTBEAT_MS,
  ) {}

  markFfmpegStarted(): void {
    if (this.started || this.finished) return;
    this.started = true;
    this.monotonicStartedAt = this.clock.monotonicNowMs();
    const wallNow = this.clock.wallNowMs();
    this.attemptId = randomUUID();
    this.attemptStartedAt = new Date(wallNow).toISOString();

    if (this.checkpoint) {
      const previous = this.checkpoint.timing.activeAttempt;
      if (previous) {
        const wallThroughHeartbeat = Math.max(0, Date.parse(previous.lastHeartbeatAt) - Date.parse(previous.startedAt));
        // persistedElapsedMs came from a monotonic clock. The wall delta is
        // accepted only within a small drift allowance, never through downtime.
        const recovered = Math.max(
          elapsed(previous.persistedElapsedMs),
          Math.min(elapsed(wallThroughHeartbeat), elapsed(previous.persistedElapsedMs) + 5_000),
        );
        this.checkpoint.timing.cumulativeElapsedMs += recovered;
        this.checkpoint.timing.lastAttemptElapsedMs = recovered;
        this.queueWrite({
          event: "INTERRUPTED_ATTEMPT_RECOVERED",
          recoveredAttemptId: previous.attemptId,
          recoveredElapsedMs: recovered,
          recoveryBoundary: "LAST_PERSISTED_HEARTBEAT",
        });
      }
      this.cumulativeBeforeAttemptMs = elapsed(this.checkpoint.timing.cumulativeElapsedMs);
      this.checkpoint.timing.activeAttempt = {
        attemptId: this.attemptId,
        startedAt: this.attemptStartedAt,
        lastHeartbeatAt: this.attemptStartedAt,
        persistedElapsedMs: 0,
      };
    }

    this.queueWrite({
      event: "ELAPSED_ATTEMPT_STARTED",
      attemptId: this.attemptId,
      attemptStartedAt: this.attemptStartedAt,
      cumulativeBeforeAttemptMs: this.cumulativeBeforeAttemptMs,
    });
    this.heartbeatTimer = setInterval(() => void this.persistHeartbeat(), this.heartbeatMs);
  }

  snapshot(status: RenderTimingStatus = "RUNNING"): RenderTimingSnapshot | undefined {
    if (this.finished) return this.lastSnapshot;
    if (!this.started) return this.lastSnapshot;
    const attemptElapsedMs = elapsed(this.clock.monotonicNowMs() - this.monotonicStartedAt);
    return {
      attemptElapsedMs,
      cumulativeElapsedMs: this.cumulativeBeforeAttemptMs + attemptElapsedMs,
      timingCapturedAt: new Date(this.clock.wallNowMs()).toISOString(),
      timingStatus: status,
    };
  }

  decorate(progress: ConcatRenderProgress): ConcatRenderProgress {
    const timing = this.snapshot();
    return timing ? { ...progress, ...timing } : progress;
  }

  async persistHeartbeat(): Promise<void> {
    if (!this.started || this.finished) return;
    const timing = this.snapshot();
    if (!timing) return;
    if (this.checkpoint?.timing.activeAttempt) {
      this.checkpoint.timing.activeAttempt.persistedElapsedMs = timing.attemptElapsedMs;
      this.checkpoint.timing.activeAttempt.lastHeartbeatAt = timing.timingCapturedAt;
    }
    this.queueWrite({
      event: "ELAPSED_HEARTBEAT",
      attemptId: this.attemptId,
      attemptElapsedMs: timing.attemptElapsedMs,
      cumulativeElapsedMs: timing.cumulativeElapsedMs,
      checkpointPersisted: Boolean(this.checkpoint),
    });
    await this.flush();
  }

  async finish(status: Exclude<RenderTimingStatus, "RUNNING">): Promise<RenderTimingSnapshot | undefined> {
    if (!this.started) return undefined;
    if (this.finished) return this.lastSnapshot;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const timing = this.snapshot(status);
    if (!timing) return undefined;
    this.finished = true;
    this.lastSnapshot = timing;
    if (this.checkpoint) {
      this.checkpoint.timing.cumulativeElapsedMs = timing.cumulativeElapsedMs;
      this.checkpoint.timing.lastAttemptElapsedMs = timing.attemptElapsedMs;
      this.checkpoint.timing.activeAttempt = undefined;
    }
    this.queueWrite({
      event: `ELAPSED_ATTEMPT_${status}`,
      attemptId: this.attemptId,
      attemptElapsedMs: timing.attemptElapsedMs,
      cumulativeElapsedMs: timing.cumulativeElapsedMs,
    });
    await this.flush();
    return timing;
  }

  private queueWrite(event: Record<string, unknown>): void {
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (this.checkpoint) await this.store.save(this.checkpoint);
        await this.store.appendTimingDiagnostic(this.renderId, event);
      })
      // Timing telemetry must never steal resources from or abort FFmpeg.
      .catch(() => undefined);
  }

  private async flush(): Promise<void> {
    await this.writes.catch(() => undefined);
  }
}
