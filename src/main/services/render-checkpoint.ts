import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConcatRenderRequest,
  PreviewResolution,
  RenderResumeOffer,
  RenderVideoCodec,
  RenderDiskRuntimeSnapshot,
  SystemResourceSnapshot,
} from "../../shared/domain";
import { MediaProbe } from "./media-probe";
import { sameVolume } from "./render-disk-space";

export interface RenderCheckpointSegment {
  id: string;
  level: number;
  index: number;
  status: "PENDING" | "COMPLETED" | "FAILED" | "RELEASED";
  outputPath: string;
  durationMs: number;
  /** Self-describing fields make render_state.json auditable and safe to inspect after a crash. */
  renderProfile?: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED";
  codec?: RenderVideoCodec;
  resolution?: PreviewResolution;
  fps?: string;
  pixelFormat?: string;
  audioFormat?: string;
  sizeBytes?: number;
  sha256?: string;
  completedAt?: string;
  lastError?: string;
}

export interface RenderCheckpointRecord {
  schemaVersion: 4;
  checkpointProducer?: "v0.80";
  checkpointId: string;
  signature: string;
  /** Excludes per-insertion SFX/BGM and final Audio Processing. */
  pictureBaseSignature?: string;
  /** Includes canonical insertion plan and final Audio Processing profile. */
  finalAudioSignature?: string;
  projectId: string;
  projectUpdatedAt: string;
  mode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED";
  outputPath: string;
  workRoot: string;
  request: ConcatRenderRequest;
  createdAt: string;
  updatedAt: string;
  segments: RenderCheckpointSegment[];
  /** Timeline-correct video+stereo master reused when only the post-audio stage failed. */
  audioMaster?: RenderCheckpointSegment;
  totalSegmentCount: number;
  concatStatus: "PENDING" | "FAILED" | "PAUSED_DISK_SPACE";
  lastError?: string;
  diagnosticLogPath: string;
  latestResources?: SystemResourceSnapshot;
  diskState?: {
    status: "RUNNING" | "PAUSED_DISK_SPACE" | "FAILED_ENOSPC";
    lastSnapshot?: RenderDiskRuntimeSnapshot;
    failedPath?: string;
    requiredAdditionalBytes?: number;
    completedSegmentCount: number;
    resumable: boolean;
  };
  timing: RenderCheckpointTiming;
  recoveryMigration?: {
    sourceAppVersion: "0.79.0";
    sourceCheckpointId: string;
    sourceWorkRoot: string;
    sourceStateBackupPath: string;
    importedAt: string;
    /** Source media remains read-only; v0.80 writes only to its own workRoot. */
    sourcePreserved: true;
    validatedExternalSegmentBytes?: number;
    validatedExternalSegmentDurationMs?: number;
  };
  recoverablePartial?: {
    path: string;
    sizeBytes: number;
    durationMs?: number;
    videoCodec?: string;
    audioCodec?: string;
    recordedAt: string;
  };
}

export interface RenderCheckpointAttemptTiming {
  attemptId: string;
  startedAt: string;
  lastHeartbeatAt: string;
  /** Monotonic elapsed value captured at lastHeartbeatAt. */
  persistedElapsedMs: number;
}

export interface RenderCheckpointTiming {
  /** Finalized attempts only; an active attempt is stored separately. */
  cumulativeElapsedMs: number;
  lastAttemptElapsedMs?: number;
  activeAttempt?: RenderCheckpointAttemptTiming;
}

function safeProjectId(projectId: string): string {
  if (!/^[a-f0-9-]{8,80}$/i.test(projectId)) throw new Error("專案識別碼無效，無法保存轉檔續傳狀態。");
  return projectId;
}

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

export interface VideoBaseMasterRecord {
  schemaVersion: 1;
  projectId: string;
  pictureBaseSignature: string;
  outputPath: string;
  durationMs: number;
  codec: RenderVideoCodec;
  resolution: PreviewResolution;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

type LegacyRenderCheckpointRecord = Omit<RenderCheckpointRecord, "schemaVersion" | "timing"> & { schemaVersion: 1 | 2 | 3 };

function looksLikeRecord(value: unknown): value is RenderCheckpointRecord | LegacyRenderCheckpointRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Omit<Partial<RenderCheckpointRecord>, "schemaVersion"> & { schemaVersion?: 1 | 2 | 3 | 4 };
  return (
    (item.schemaVersion === 1 || item.schemaVersion === 2 || item.schemaVersion === 3 || item.schemaVersion === 4) &&
    typeof item.checkpointId === "string" &&
    typeof item.signature === "string" &&
    typeof item.projectId === "string" &&
    typeof item.projectUpdatedAt === "string" &&
    (item.mode === "LOW_MEMORY" || item.mode === "NORMAL" || item.mode === "HIGH_SPEED") &&
    typeof item.outputPath === "string" &&
    path.isAbsolute(item.outputPath) &&
    path.extname(item.outputPath).toLowerCase() === ".mp4" &&
    typeof item.workRoot === "string" &&
    path.isAbsolute(item.workRoot) &&
    Boolean(item.request) &&
    Array.isArray(item.segments) &&
    (item.concatStatus === "PENDING" || item.concatStatus === "FAILED" || item.concatStatus === "PAUSED_DISK_SPACE")
  );
}

function finiteElapsed(value: unknown): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.round(Number(value)) : 0;
}

function migrateRecord(value: RenderCheckpointRecord | LegacyRenderCheckpointRecord): RenderCheckpointRecord {
  const candidate = value as Partial<RenderCheckpointRecord>;
  const timing = candidate.timing;
  const active = timing?.activeAttempt;
  return {
    ...value,
    schemaVersion: 4,
    timing: {
      cumulativeElapsedMs: finiteElapsed(timing?.cumulativeElapsedMs),
      ...(Number.isFinite(timing?.lastAttemptElapsedMs)
        ? { lastAttemptElapsedMs: finiteElapsed(timing?.lastAttemptElapsedMs) }
        : {}),
      ...(active &&
      typeof active.attemptId === "string" &&
      typeof active.startedAt === "string" &&
      typeof active.lastHeartbeatAt === "string"
        ? {
            activeAttempt: {
              attemptId: active.attemptId,
              startedAt: active.startedAt,
              lastHeartbeatAt: active.lastHeartbeatAt,
              persistedElapsedMs: finiteElapsed(active.persistedElapsedMs),
            },
          }
        : {}),
    },
  } as RenderCheckpointRecord;
}

export class RenderCheckpointStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private legacyRecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.render-state.json`);
  }

  private v080RecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.v080.render-state.json`);
  }

  private recoveryCompletedMarkerPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.v080-recovery-completed.json`);
  }

  private recordPathFor(record: Pick<RenderCheckpointRecord, "projectId" | "checkpointProducer" | "recoveryMigration">): string {
    return record.checkpointProducer === "v0.80" || Boolean(record.recoveryMigration)
      ? this.v080RecordPath(record.projectId)
      : this.legacyRecordPath(record.projectId);
  }

  private baseMasterRecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.video-base-master.json`);
  }

  async load(projectId: string): Promise<RenderCheckpointRecord | undefined> {
    for (const candidate of [this.v080RecordPath(projectId), this.legacyRecordPath(projectId)]) {
      try {
        const parsed: unknown = JSON.parse(await readFile(candidate, "utf8"));
        if (!looksLikeRecord(parsed) || parsed.projectId !== projectId) continue;
        const record = migrateRecord(parsed);
        try {
          const marker = JSON.parse(await readFile(this.recoveryCompletedMarkerPath(projectId), "utf8")) as {
            sourceCheckpointId?: string;
            completedCheckpointId?: string;
          };
          // A resource-monitor callback can finish after publish/cleanup and
          // persist one last stale PENDING snapshot. The completion marker is
          // authoritative for both that v0.80 record and its immutable legacy
          // recovery source.
          if (
            marker.completedCheckpointId === record.checkpointId ||
            (candidate === this.legacyRecordPath(projectId) && marker.sourceCheckpointId === record.checkpointId)
          ) return undefined;
        } catch {
          // No completion marker means the checkpoint may still be offered.
        }
        return record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
    }
    return undefined;
  }

  /**
   * Imports a v0.79 checkpoint without modifying its work root. The original
   * JSON is archived once, and the new active record writes to a fresh v0.80
   * work root while referencing verified legacy segments read-only.
   */
  async importV079RecoveryCopy(projectId: string, checkpointId: string): Promise<RenderCheckpointRecord | undefined> {
    const record = await this.load(projectId);
    if (!record) return undefined;
    if (record.recoveryMigration) {
      return record.checkpointId === checkpointId || record.recoveryMigration.sourceCheckpointId === checkpointId
        ? record
        : undefined;
    }
    if (record.checkpointId !== checkpointId) return undefined;
    const sourceRecordPath = this.legacyRecordPath(projectId);
    const recoveryRoot = path.join(this.root, "recovery-sources");
    await mkdir(recoveryRoot, { recursive: true });
    const sourceStateBackupPath = path.join(recoveryRoot, `${record.checkpointId}.v079.render-state.json`);
    try {
      await copyFile(sourceRecordPath, sourceStateBackupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const checkpointIdV080 = randomUUID();
    const parsed = path.parse(record.outputPath);
    const workRoot = path.join(path.dirname(record.workRoot), `.${parsed.name}.${checkpointIdV080}.v080.resume`);
    await mkdir(workRoot, { recursive: true });
    const importedAt = new Date().toISOString();
    const segmentValidity = await Promise.all(
      record.segments.map(async (segment) =>
        segment.status === "COMPLETED" ? this.validateSegment(segment) : Promise.resolve(false),
      ),
    );
    const importedSegments = record.segments.map((segment, index) =>
      segment.status === "COMPLETED" && !segmentValidity[index]
        ? { ...segment, status: "FAILED" as const, lastError: "v0.80 匯入驗證失敗；只會重算此片段。" }
        : structuredClone(segment),
    );
    const validatedExternalSegments = importedSegments.filter((segment) => segment.status === "COMPLETED");
    const validatedExternalSegmentBytes = validatedExternalSegments.reduce(
      (sum, segment) => sum + Math.max(0, segment.sizeBytes ?? 0),
      0,
    );
    const validatedExternalSegmentDurationMs = validatedExternalSegments.reduce(
      (sum, segment) => sum + Math.max(0, segment.durationMs),
      0,
    );
    const imported: RenderCheckpointRecord = {
      ...structuredClone(record),
      checkpointProducer: "v0.80",
      checkpointId: checkpointIdV080,
      workRoot,
      diagnosticLogPath: path.join(this.root, `${checkpointIdV080}.diagnostics.ndjson`),
      updatedAt: importedAt,
      segments: importedSegments,
      recoveryMigration: {
        sourceAppVersion: "0.79.0",
        sourceCheckpointId: record.checkpointId,
        sourceWorkRoot: record.workRoot,
        sourceStateBackupPath,
        importedAt,
        sourcePreserved: true,
        validatedExternalSegmentBytes,
        validatedExternalSegmentDurationMs,
      },
    };
    await this.save(imported);
    await this.appendDiagnostic(imported, {
      event: "V079_RECOVERY_IMPORTED_COPY_ON_WRITE",
      sourceCheckpointId: record.checkpointId,
      sourceWorkRoot: record.workRoot,
      sourceStateBackupPath,
      importedWorkRoot: workRoot,
      completedSegmentCount: importedSegments.filter((segment) => segment.status === "COMPLETED").length,
      invalidSegmentCount: importedSegments.filter((segment) => segment.status === "FAILED").length,
      validatedExternalSegmentBytes,
      validatedExternalSegmentDurationMs,
    });
    return imported;
  }

  async save(record: RenderCheckpointRecord): Promise<void> {
    const snapshot = structuredClone({ ...record, updatedAt: new Date().toISOString() });
    const key = record.projectId;
    const prior = this.writeQueues.get(key) ?? Promise.resolve();
    const pending = prior
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.root, { recursive: true });
        const target = this.recordPathFor(record);
        const temporary = `${target}.${randomUUID()}.partial`;
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        try {
          // copyFile replaces an existing target on Windows, unlike rename(), which
          // can fail after the first checkpoint update. The complete JSON is first
          // written to a unique file so a partial write never becomes the record.
          await copyFile(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.writeQueues.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.writeQueues.get(key) === pending) this.writeQueues.delete(key);
    }
  }

  async create(
    projectId: string,
    projectUpdatedAt: string,
    signature: string,
    mode: "LOW_MEMORY" | "NORMAL" | "HIGH_SPEED",
    outputPath: string,
    request: ConcatRenderRequest,
    renderTemporaryFolder?: string,
  ): Promise<RenderCheckpointRecord> {
    const checkpointId = randomUUID();
    const parsed = path.parse(outputPath);
    const workParent = renderTemporaryFolder ? path.resolve(renderTemporaryFolder) : parsed.dir;
    const workRoot = path.join(workParent, `.${parsed.name}.${checkpointId}.resume`);
    const now = new Date().toISOString();
    const record: RenderCheckpointRecord = {
      schemaVersion: 4,
      checkpointProducer: "v0.80",
      checkpointId,
      signature,
      projectId,
      projectUpdatedAt,
      mode,
      outputPath: path.resolve(outputPath),
      workRoot,
      request: { ...structuredClone(request), outputToken: "persisted-checkpoint" },
      createdAt: now,
      updatedAt: now,
      segments: [],
      totalSegmentCount: 0,
      concatStatus: "PENDING",
      diagnosticLogPath: path.join(this.root, `${checkpointId}.diagnostics.ndjson`),
      timing: { cumulativeElapsedMs: 0 },
    };
    await mkdir(workRoot, { recursive: true });
    await this.save(record);
    return record;
  }

  async loadVideoBaseMaster(projectId: string, pictureBaseSignature: string): Promise<VideoBaseMasterRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.baseMasterRecordPath(projectId), "utf8")) as Partial<VideoBaseMasterRecord>;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.projectId !== projectId ||
        parsed.pictureBaseSignature !== pictureBaseSignature ||
        typeof parsed.outputPath !== "string" ||
        !path.isAbsolute(parsed.outputPath) ||
        typeof parsed.sizeBytes !== "number" ||
        typeof parsed.sha256 !== "string"
      ) return undefined;
      const item = await stat(parsed.outputPath);
      if (!item.isFile() || item.size !== parsed.sizeBytes || (await sha256(parsed.outputPath)) !== parsed.sha256)
        return undefined;
      const info = await new MediaProbe().probe(parsed.outputPath);
      if (!info.videoCodec || Math.abs((info.durationMs ?? 0) - (parsed.durationMs ?? 0)) > 250) return undefined;
      return parsed as VideoBaseMasterRecord;
    } catch {
      return undefined;
    }
  }

  async saveVideoBaseMaster(
    projectId: string,
    pictureBaseSignature: string,
    sourcePath: string,
    durationMs: number,
    codec: RenderVideoCodec,
    resolution: PreviewResolution,
    preferredRoot?: string,
  ): Promise<VideoBaseMasterRecord> {
    const directory = preferredRoot
      ? path.join(path.resolve(preferredRoot), "SceneryWalkerMasters", safeProjectId(projectId))
      : path.join(this.root, "video-base-masters", safeProjectId(projectId));
    await mkdir(directory, { recursive: true });
    const outputPath = path.join(directory, `${pictureBaseSignature}.mkv`);
    const temporary = `${outputPath}.${randomUUID()}.partial`;
    await rm(outputPath, { force: true });
    if (sameVolume(sourcePath, outputPath)) {
      // Atomic ownership transfer: the render partial becomes the persistent
      // master without a second full-size copy on the same volume.
      await rename(sourcePath, outputPath);
    } else {
      // Cross-volume rename is unavailable. Keep one destination partial, then
      // atomically publish it; never hold two destination-side master copies.
      await copyFile(sourcePath, temporary);
      await rename(temporary, outputPath);
    }
    const item = await stat(outputPath);
    const record: VideoBaseMasterRecord = {
      schemaVersion: 1,
      projectId,
      pictureBaseSignature,
      outputPath,
      durationMs,
      codec,
      resolution,
      sizeBytes: item.size,
      sha256: await sha256(outputPath),
      createdAt: new Date().toISOString(),
    };
    const recordPath = this.baseMasterRecordPath(projectId);
    const previous = await this.loadAnyVideoBaseMaster(projectId);
    const metadataPartial = `${recordPath}.${randomUUID()}.partial`;
    await writeFile(metadataPartial, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await copyFile(metadataPartial, recordPath);
    await rm(metadataPartial, { force: true });
    if (previous?.outputPath !== outputPath) {
      const previousResolved = previous?.outputPath ? path.resolve(previous.outputPath) : undefined;
      const oldOwnedRoot = path.resolve(path.join(this.root, "video-base-masters", safeProjectId(projectId)));
      const newOwnedRoot = path.resolve(directory);
      if (
        previousResolved &&
        (previousResolved.startsWith(oldOwnedRoot + path.sep) || previousResolved.startsWith(newOwnedRoot + path.sep))
      ) await rm(previousResolved, { force: true });
    }
    return record;
  }

  private async loadAnyVideoBaseMaster(projectId: string): Promise<VideoBaseMasterRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.baseMasterRecordPath(projectId), "utf8")) as VideoBaseMasterRecord;
      return parsed?.schemaVersion === 1 && parsed.projectId === projectId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async discardVideoBaseMaster(projectId: string): Promise<void> {
    const directory = path.join(this.root, "video-base-masters", safeProjectId(projectId));
    const record = await this.loadAnyVideoBaseMaster(projectId);
    if (record?.outputPath) {
      const resolved = path.resolve(record.outputPath);
      const legacyOwned = resolved.startsWith(path.resolve(directory) + path.sep);
      const portableOwned = resolved.includes(`${path.sep}SceneryWalkerMasters${path.sep}${safeProjectId(projectId)}${path.sep}`);
      if (legacyOwned || portableOwned) await rm(resolved, { force: true });
    }
    await rm(this.baseMasterRecordPath(projectId), { force: true });
  }

  async appendDiagnostic(record: RenderCheckpointRecord, event: Record<string, unknown>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(
      record.diagnosticLogPath,
      `${JSON.stringify({ at: new Date().toISOString(), checkpointId: record.checkpointId, ...event })}\n`,
      { encoding: "utf8", flag: "a" },
    );
  }

  timingDiagnosticPath(renderId: string): string {
    return path.join(this.root, `${safeProjectId(renderId)}.timing.ndjson`);
  }

  async appendTimingDiagnostic(renderId: string, event: Record<string, unknown>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(
      this.timingDiagnosticPath(renderId),
      `${JSON.stringify({ at: new Date().toISOString(), renderId, ...event })}\n`,
      { encoding: "utf8", flag: "a" },
    );
  }

  async validateSegment(segment: RenderCheckpointSegment): Promise<boolean> {
    try {
      const item = await stat(segment.outputPath);
      if (!item.isFile() || item.size <= 0 || (segment.sizeBytes && item.size !== segment.sizeBytes)) return false;
      const info = await new MediaProbe().probe(segment.outputPath);
      if (!info.videoCodec || Math.abs((info.durationMs ?? 0) - segment.durationMs) > 250) return false;
      if (segment.sha256 && (await sha256(segment.outputPath)) !== segment.sha256) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cheap resume-offer check. Full probe/hash validation still happens immediately
   * before a segment is reused; the picker must not hash tens of GiB merely to show
   * that a checkpoint exists.
   */
  private async segmentFileIsPresent(segment: RenderCheckpointSegment): Promise<boolean> {
    try {
      const item = await stat(segment.outputPath);
      return item.isFile() && item.size > 0 && (!segment.sizeBytes || item.size === segment.sizeBytes);
    } catch {
      return false;
    }
  }

  async completeSegment(record: RenderCheckpointRecord, segment: RenderCheckpointSegment): Promise<void> {
    const item = await stat(segment.outputPath);
    segment.status = "COMPLETED";
    segment.sizeBytes = item.size;
    segment.sha256 = await sha256(segment.outputPath);
    segment.completedAt = new Date().toISOString();
    segment.lastError = undefined;
    await this.save(record);
  }

  /**
   * Release only app-owned intermediates whose complete downstream replacement
   * has already been validated. Metadata remains in the checkpoint audit trail.
   */
  async releaseConsumedSegments(record: RenderCheckpointRecord, outputPaths: readonly string[]): Promise<number> {
    const workRoot = path.resolve(record.workRoot);
    let releasedBytes = 0;
    for (const candidate of outputPaths) {
      const resolved = path.resolve(candidate);
      if (resolved !== workRoot && !resolved.startsWith(workRoot + path.sep)) continue;
      const segment = record.segments.find((item) => path.resolve(item.outputPath) === resolved);
      if (!segment || segment.status !== "COMPLETED") continue;
      const item = await stat(resolved).catch(() => undefined);
      if (item?.isFile()) releasedBytes += item.size;
      await rm(resolved, { force: true });
      segment.status = "RELEASED";
      segment.lastError = undefined;
    }
    if (releasedBytes > 0) await this.save(record);
    return releasedBytes;
  }

  async offer(projectId: string): Promise<RenderResumeOffer | undefined> {
    const record = await this.load(projectId);
    if (!record) return undefined;
    const recordedCompleted = record.segments.filter((segment) => segment.status === "COMPLETED");
    const physicalChecks = await Promise.all(recordedCompleted.map((segment) => this.segmentFileIsPresent(segment)));
    const physicallyPresentCount = physicalChecks.filter(Boolean).length;
    const missingCompletedSegmentCount = recordedCompleted.length - physicallyPresentCount;
    const physicallyPresent = recordedCompleted.filter((_segment, index) => physicalChecks[index]);
    return {
      checkpointId: record.checkpointId,
      projectId: record.projectId,
      outputPath: record.outputPath,
      mode: record.mode,
      completedSegmentCount: physicallyPresentCount,
      recordedCompletedSegmentCount: recordedCompleted.length,
      missingCompletedSegmentCount,
      physicalState:
        missingCompletedSegmentCount === 0
          ? "READY"
          : physicallyPresentCount > 0
            ? "PARTIAL"
            : "SEGMENT_CACHE_MISSING",
      totalSegmentCount: record.totalSegmentCount,
      concatStatus: record.concatStatus,
      lastError: record.lastError,
      updatedAt: record.updatedAt,
      lastAttemptElapsedMs: record.timing.lastAttemptElapsedMs,
      cumulativeElapsedMs: record.timing.cumulativeElapsedMs + (record.timing.activeAttempt?.persistedElapsedMs ?? 0),
      reusableBytes: physicallyPresent.reduce((sum, segment) => sum + Math.max(0, segment.sizeBytes ?? 0), 0),
      reusableDurationMs: physicallyPresent.reduce((sum, segment) => sum + Math.max(0, segment.durationMs), 0),
      migratedFromCheckpointId: record.recoveryMigration?.sourceCheckpointId,
      recoverySourcePreserved: record.recoveryMigration?.sourcePreserved,
      legacyRecoveryProtected: record.checkpointProducer !== "v0.80" && !record.recoveryMigration,
      currentTempFreeBytes: record.diskState?.lastSnapshot?.tempFreeBytes,
      currentOutputFreeBytes: record.diskState?.lastSnapshot?.outputFreeBytes,
      estimatedRemainingWriteBytes: record.diskState?.lastSnapshot?.estimatedRemainingWriteBytes,
      // v0.79 forced diskState.requiredAdditionalBytes to at least 20 GiB
      // even when the captured snapshot reported zero. Prefer the raw snapshot.
      requiredAdditionalBytes: record.diskState?.lastSnapshot?.requiredAdditionalBytes,
      tempVolume: record.diskState?.lastSnapshot?.tempVolume,
      outputVolume: record.diskState?.lastSnapshot?.outputVolume,
    };
  }

  async discard(projectId: string, checkpointId?: string): Promise<void> {
    const record = await this.load(projectId);
    if (!record || (checkpointId && record.checkpointId !== checkpointId)) return;
    if (record.checkpointProducer !== "v0.80" && !record.recoveryMigration) {
      throw new Error("偵測到舊版復原資料；v0.80 會先建立唯讀復原副本，不能直接捨棄原始 checkpoint。請先使用『接續上次轉檔』完成匯入。");
    }
    await rm(record.workRoot, { recursive: true, force: true });
    await rm(record.diagnosticLogPath, { force: true });
    await rm(this.recordPathFor(record), { force: true });
  }

  async complete(projectId: string, checkpointId: string): Promise<void> {
    const record = await this.load(projectId);
    if (!record || record.checkpointId !== checkpointId) return;
    await mkdir(this.root, { recursive: true });
    const markerPath = this.recoveryCompletedMarkerPath(projectId);
    const temporary = `${markerPath}.${randomUUID()}.partial`;
    await writeFile(
      temporary,
      `${JSON.stringify({
        schemaVersion: 1,
        projectId,
        sourceCheckpointId: record.recoveryMigration?.sourceCheckpointId ?? record.checkpointId,
        completedCheckpointId: record.checkpointId,
        completedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await copyFile(temporary, markerPath);
    await rm(temporary, { force: true });
    await this.discard(projectId, checkpointId);
  }
}
