import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConcatRenderRequest,
  PreviewResolution,
  RenderResumeOffer,
  RenderVideoCodec,
  RenderDiskRuntimeSnapshot,
  RenderTempLocationConfig,
  SystemResourceSnapshot,
  ResumeArtifactRecoveryResult,
} from "../../shared/domain";
import { MediaProbe } from "./media-probe";
import { hardSafetyLimitBytes, sameVolume } from "./render-disk-space";

export interface RenderCheckpointSegment {
  id: string;
  level: number;
  index: number;
  status: "PENDING" | "COMPLETED" | "FAILED" | "RELEASED";
  outputPath: string;
  /** Persisted assignment; resume never relocates a completed segment. */
  tempLocationId?: string;
  volume?: string;
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
  schemaVersion: 5;
  checkpointProducer?: "v0.80" | "v0.82";
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
  /** App-owned roots only. External v0.79 recovery roots are never added here. */
  ownedWorkRoots?: string[];
  stagePaths?: {
    basePartialPath?: string;
    baseFilterScriptPath?: string;
    audioPartialPath?: string;
    audioFilterScriptPath?: string;
  };
  /** Validated candidates used for new jobs. Existing segment paths stay authoritative. */
  tempLocations?: RenderTempLocationConfig[];
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
    sourceAppVersion: "0.79.0" | "0.80.0" | "0.81.0";
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

type LegacyRenderCheckpointRecord = Omit<RenderCheckpointRecord, "schemaVersion" | "timing"> & {
  schemaVersion: 1 | 2 | 3 | 4;
};

function looksLikeRecord(value: unknown): value is RenderCheckpointRecord | LegacyRenderCheckpointRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Omit<Partial<RenderCheckpointRecord>, "schemaVersion"> & { schemaVersion?: 1 | 2 | 3 | 4 | 5 };
  return (
    (item.schemaVersion === 1 ||
      item.schemaVersion === 2 ||
      item.schemaVersion === 3 ||
      item.schemaVersion === 4 ||
      item.schemaVersion === 5) &&
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

function rationalNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parts = value.split("/");
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? "1");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function expectedDimensions(resolution: PreviewResolution): [number, number] {
  if (resolution === "4K") return [3840, 2160];
  if (resolution === "1080P") return [1920, 1080];
  if (resolution === "720P") return [1280, 720];
  if (resolution === "480P") return [854, 480];
  return [640, 360];
}

function migrateRecord(value: RenderCheckpointRecord | LegacyRenderCheckpointRecord): RenderCheckpointRecord {
  const candidate = value as Partial<RenderCheckpointRecord>;
  const timing = candidate.timing;
  const active = timing?.activeAttempt;
  return {
    ...value,
    schemaVersion: 5,
    tempLocations: candidate.tempLocations?.map((location) => ({ ...location })) ?? [
      {
        id: "legacy-primary",
        path: path.dirname(candidate.workRoot!),
        role: "PRIMARY",
        enabled: true,
        allowFallback: true,
      },
    ],
    ownedWorkRoots: candidate.ownedWorkRoots?.length ? [...candidate.ownedWorkRoots] : [candidate.workRoot!],
    segments: (candidate.segments ?? []).map((segment) => ({
      ...segment,
      volume: segment.volume ?? path.parse(path.resolve(segment.outputPath)).root.toUpperCase(),
    })),
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
  private readonly segmentValidationCache = new Map<string, boolean>();

  constructor(
    private readonly root: string,
    private readonly publishRelocationRegistry: (from: string, to: string) => Promise<void> = rename,
  ) {}

  private validatedOwnedWorkRoots(record: RenderCheckpointRecord): string[] {
    const canonical = path.resolve(record.workRoot);
    const expectedName = path.basename(canonical);
    const normalizedName = expectedName.toLowerCase();
    if (
      !expectedName.startsWith(".") ||
      !normalizedName.endsWith(".resume") ||
      !normalizedName.includes(record.checkpointId.toLowerCase()) ||
      canonical === path.parse(canonical).root
    )
      throw new Error("Checkpoint work root 命名或路徑不安全，已拒絕清理。");
    const allowedParents = new Set(
      [path.dirname(canonical), ...(record.tempLocations ?? []).map((location) => path.resolve(location.path))].map(
        (item) => item.toLowerCase(),
      ),
    );
    const recoverySource = record.recoveryMigration?.sourceWorkRoot
      ? path.resolve(record.recoveryMigration.sourceWorkRoot).toLowerCase()
      : undefined;
    const candidates = record.ownedWorkRoots?.length ? record.ownedWorkRoots : [record.workRoot];
    return candidates.map((candidate) => {
      if (typeof candidate !== "string" || !path.isAbsolute(candidate))
        throw new Error("Checkpoint owned work root 必須是絕對路徑，已拒絕清理。");
      const resolved = path.resolve(candidate);
      const lowered = resolved.toLowerCase();
      if (
        resolved === path.parse(resolved).root ||
        path.basename(resolved).toLowerCase() !== normalizedName ||
        !allowedParents.has(path.dirname(resolved).toLowerCase()) ||
        (recoverySource && (lowered === recoverySource || lowered.startsWith(recoverySource + path.sep.toLowerCase())))
      )
        throw new Error("Checkpoint owned work root 超出核准 TEMP 或指向外部復原資料，已拒絕清理。");
      return resolved;
    });
  }

  private legacyRecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.render-state.json`);
  }

  private v080RecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.v080.render-state.json`);
  }

  private v082RecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.v082.render-state.json`);
  }

  private recoveryCompletedMarkerPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.v080-recovery-completed.json`);
  }

  private recordPathFor(
    record: Pick<RenderCheckpointRecord, "projectId" | "checkpointProducer" | "recoveryMigration">,
  ): string {
    if (record.checkpointProducer === "v0.82") return this.v082RecordPath(record.projectId);
    return record.checkpointProducer === "v0.80" || Boolean(record.recoveryMigration)
      ? this.v080RecordPath(record.projectId)
      : this.legacyRecordPath(record.projectId);
  }

  private baseMasterRecordPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.video-base-master.json`);
  }

  private relocationRegistryPath(projectId: string): string {
    return path.join(this.root, `${safeProjectId(projectId)}.artifact-relocations.json`);
  }

  private async loadArtifactRelocations(
    projectId: string,
  ): Promise<Record<string, { path: string; sizeBytes: number }>> {
    const safeId = safeProjectId(projectId);
    const legacy = this.relocationRegistryPath(projectId);
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const versioned = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith(`${safeId}.artifact-relocations.`) && entry.name.endsWith(".json"),
      )
      .map((entry) => path.join(this.root, entry.name));
    const candidates = [legacy, ...versioned];
    const ordered = (
      await Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          mtimeMs: (await stat(candidate).catch(() => undefined))?.mtimeMs ?? -1,
        })),
      )
    )
      .filter((item) => item.mtimeMs >= 0)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    const merged: Record<string, { path: string; sizeBytes: number }> = {};
    for (const { candidate } of ordered) {
      try {
        const parsed = JSON.parse(await readFile(candidate, "utf8")) as Record<
          string,
          { path?: unknown; sizeBytes?: unknown }
        >;
        for (const [hash, item] of Object.entries(parsed)) {
          if (
            /^[A-F0-9]{64}$/i.test(hash) &&
            typeof item?.path === "string" &&
            path.isAbsolute(item.path) &&
            typeof item.sizeBytes === "number" &&
            Number.isFinite(item.sizeBytes) &&
            item.sizeBytes >= 0
          )
            merged[hash] = { path: path.resolve(item.path), sizeBytes: item.sizeBytes };
        }
      } catch {
        // A corrupt/partial legacy registry is ignored; immutable good versions remain available.
      }
    }
    return merged;
  }

  private async applyArtifactRelocations(record: RenderCheckpointRecord): Promise<RenderCheckpointRecord> {
    const registry = await this.loadArtifactRelocations(record.projectId);
    for (const segment of record.segments) {
      if (segment.status !== "COMPLETED" || !segment.sha256) continue;
      const relocated = registry[segment.sha256];
      if (!relocated || relocated.sizeBytes !== segment.sizeBytes || !path.isAbsolute(relocated.path)) continue;
      if (path.resolve(relocated.path).toLowerCase() === path.resolve(segment.outputPath).toLowerCase()) continue;
      const candidate = { ...segment, outputPath: path.resolve(relocated.path) };
      if (await this.validateSegment(candidate)) {
        segment.outputPath = candidate.outputPath;
        segment.volume = path.parse(candidate.outputPath).root.toUpperCase();
      }
    }
    return record;
  }

  private async saveArtifactRelocations(
    projectId: string,
    items: readonly { sha256: string; path: string; sizeBytes: number }[],
  ): Promise<void> {
    const registry = await this.loadArtifactRelocations(projectId);
    for (const item of items) registry[item.sha256] = { path: path.resolve(item.path), sizeBytes: item.sizeBytes };
    const identity = `${Date.now()}-${randomUUID()}`;
    const registryPath = path.join(this.root, `${safeProjectId(projectId)}.artifact-relocations.${identity}.json`);
    const partial = `${registryPath}.partial`;
    await mkdir(this.root, { recursive: true });
    await writeFile(partial, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      // The final name is unique and never exists. Same-directory rename is an
      // atomic publication; failure leaves every previous registry intact.
      await this.publishRelocationRegistry(partial, registryPath);
      const published = JSON.parse(await readFile(registryPath, "utf8")) as Record<
        string,
        { path?: unknown; sizeBytes?: unknown }
      >;
      for (const item of items) {
        const verified = published[item.sha256];
        if (!verified || verified.path !== path.resolve(item.path) || verified.sizeBytes !== item.sizeBytes)
          throw new Error(`Artifact relocation registry 讀回驗證失敗：${item.sha256}`);
      }
    } finally {
      await rm(partial, { force: true });
    }
  }

  async load(projectId: string): Promise<RenderCheckpointRecord | undefined> {
    for (const candidate of [
      this.v082RecordPath(projectId),
      this.v080RecordPath(projectId),
      this.legacyRecordPath(projectId),
    ]) {
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
          )
            return undefined;
        } catch {
          // No completion marker means the checkpoint may still be offered.
        }
        return this.applyArtifactRelocations(record);
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
      ownedWorkRoots: [workRoot],
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

  /**
   * Creates the writable v0.82 migration record before Resume changes any
   * signature, status, path or timing field. The source checkpoint JSON and
   * every referenced media artifact remain read-only recovery evidence.
   */
  async importResumeRecoveryCopy(projectId: string, checkpointId: string): Promise<RenderCheckpointRecord | undefined> {
    let source = await this.load(projectId);
    if (!source) return undefined;
    if (source.checkpointProducer === "v0.82")
      return source.checkpointId === checkpointId || source.recoveryMigration?.sourceCheckpointId === checkpointId
        ? source
        : undefined;
    if (source.checkpointId !== checkpointId && source.recoveryMigration?.sourceCheckpointId !== checkpointId)
      return undefined;
    if (source.checkpointProducer !== "v0.80") {
      source = await this.importV079RecoveryCopy(projectId, checkpointId);
      if (!source) return undefined;
    }

    const sourceRecordPath = this.recordPathFor(source);
    const recoveryRoot = path.join(this.root, "recovery-sources");
    await mkdir(recoveryRoot, { recursive: true });
    const sourceStateBackupPath = path.join(recoveryRoot, `${source.checkpointId}.pre-v082.render-state.json`);
    try {
      await copyFile(sourceRecordPath, sourceStateBackupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const checkpointIdV082 = randomUUID();
    const parsed = path.parse(source.outputPath);
    const workRoot = path.join(path.dirname(source.workRoot), `.${parsed.name}.${checkpointIdV082}.v082.resume`);
    await mkdir(workRoot, { recursive: true });
    const importedAt = new Date().toISOString();
    const segmentValidity = await Promise.all(
      source.segments.map((segment) =>
        segment.status === "COMPLETED" ? this.validateSegment(segment) : Promise.resolve(false),
      ),
    );
    const segments = source.segments.map((segment, index) =>
      segment.status === "COMPLETED" && !segmentValidity[index]
        ? {
            ...structuredClone(segment),
            status: "FAILED" as const,
            lastError: "v0.82 migration validation failed; only this segment may be rebuilt.",
          }
        : structuredClone(segment),
    );
    const imported: RenderCheckpointRecord = {
      ...structuredClone(source),
      checkpointProducer: "v0.82",
      checkpointId: checkpointIdV082,
      workRoot,
      ownedWorkRoots: [workRoot],
      diagnosticLogPath: path.join(this.root, `${checkpointIdV082}.diagnostics.ndjson`),
      updatedAt: importedAt,
      segments,
      recoveryMigration: {
        sourceAppVersion: source.recoveryMigration?.sourceAppVersion ?? "0.80.0",
        sourceCheckpointId: source.checkpointId,
        sourceWorkRoot: source.workRoot,
        sourceStateBackupPath,
        importedAt,
        sourcePreserved: true,
        validatedExternalSegmentBytes: segments
          .filter((item) => item.status === "COMPLETED")
          .reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
        validatedExternalSegmentDurationMs: segments
          .filter((item) => item.status === "COMPLETED")
          .reduce((sum, item) => sum + item.durationMs, 0),
      },
    };
    await this.save(imported);
    await this.appendDiagnostic(imported, {
      event: "V082_RESUME_MIGRATION_COPY_CREATED",
      sourceCheckpointId: source.checkpointId,
      sourceStateBackupPath,
      sourcePreserved: true,
      reusableSegmentCount: segments.filter((item) => item.status === "COMPLETED").length,
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
      schemaVersion: 5,
      checkpointProducer: "v0.82",
      checkpointId,
      signature,
      projectId,
      projectUpdatedAt,
      mode,
      outputPath: path.resolve(outputPath),
      workRoot,
      tempLocations: request.tempLocations?.length
        ? structuredClone(request.tempLocations)
        : [{ id: "primary", path: workParent, role: "PRIMARY", enabled: true, allowFallback: true }],
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

  async loadVideoBaseMaster(
    projectId: string,
    pictureBaseSignature: string,
  ): Promise<VideoBaseMasterRecord | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.baseMasterRecordPath(projectId), "utf8"),
      ) as Partial<VideoBaseMasterRecord>;
      if (
        parsed.schemaVersion !== 1 ||
        parsed.projectId !== projectId ||
        parsed.pictureBaseSignature !== pictureBaseSignature ||
        typeof parsed.outputPath !== "string" ||
        !path.isAbsolute(parsed.outputPath) ||
        typeof parsed.sizeBytes !== "number" ||
        typeof parsed.sha256 !== "string"
      )
        return undefined;
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
      )
        await rm(previousResolved, { force: true });
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
      const portableOwned = resolved.includes(
        `${path.sep}SceneryWalkerMasters${path.sep}${safeProjectId(projectId)}${path.sep}`,
      );
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
      const cacheKey = JSON.stringify({
        path: path.resolve(segment.outputPath).toLowerCase(),
        size: item.size,
        mtimeMs: item.mtimeMs,
        durationMs: segment.durationMs,
        codec: segment.codec,
        resolution: segment.resolution,
        fps: segment.fps,
        pixelFormat: segment.pixelFormat,
        audioFormat: segment.audioFormat,
        sha256: segment.sha256,
      });
      const cached = this.segmentValidationCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const info = await new MediaProbe().probe(segment.outputPath);
      if (!info.videoCodec || Math.abs((info.durationMs ?? 0) - segment.durationMs) > 250) {
        this.segmentValidationCache.set(cacheKey, false);
        return false;
      }
      if (segment.codec) {
        const expectedCodec = segment.codec.startsWith("H264")
          ? "h264"
          : segment.codec.startsWith("H265")
            ? "hevc"
            : undefined;
        if (expectedCodec && info.videoCodec.toLowerCase() !== expectedCodec) return false;
      }
      if (segment.resolution) {
        const [expectedWidth, expectedHeight] = expectedDimensions(segment.resolution);
        const dimensionsMatch =
          (info.width === expectedWidth && info.height === expectedHeight) ||
          (info.width === expectedHeight && info.height === expectedWidth);
        if (!dimensionsMatch) return false;
      }
      if (segment.fps) {
        const expectedFps = rationalNumber(segment.fps);
        const actualFps = rationalNumber(info.frameRate);
        if (!expectedFps || !actualFps || Math.abs(expectedFps - actualFps) > 0.01) return false;
      }
      if (segment.pixelFormat) {
        const exactPixelFormat = info.pixelFormat === segment.pixelFormat;
        const compatibleFullRange420 =
          segment.pixelFormat === "yuv420p" &&
          info.pixelFormat === "yuvj420p" &&
          (info.colorRange === "pc" || info.colorRange === "jpeg");
        if (!exactPixelFormat && !compatibleFullRange420) return false;
      }
      if (segment.audioFormat) {
        if (segment.audioFormat.includes("AAC") && info.audioCodec?.toLowerCase() !== "aac") return false;
        if (segment.audioFormat.includes("48 kHz") && info.audioSampleRate !== 48_000) return false;
        if (segment.audioFormat.includes("stereo") && info.audioChannels !== 2) return false;
      }
      if (segment.sha256 && (await sha256(segment.outputPath)) !== segment.sha256) {
        this.segmentValidationCache.set(cacheKey, false);
        return false;
      }
      this.segmentValidationCache.set(cacheKey, true);
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

  async remapCompletedSegments(
    projectId: string,
    checkpointId: string,
    fromRoot: string,
    toRoot: string,
  ): Promise<number> {
    const record = await this.load(projectId);
    if (!record || record.checkpointId !== checkpointId) throw new Error("找不到可重新對應的 checkpoint。");
    if (record.checkpointProducer !== "v0.80" && record.checkpointProducer !== "v0.82")
      throw new Error("舊版 checkpoint 必須先建立 copy-on-write 復原副本。");
    if (!path.isAbsolute(fromRoot) || !path.isAbsolute(toRoot)) throw new Error("重新對應路徑必須是絕對路徑。");
    const sourceRoot = path.resolve(fromRoot);
    const destinationRoot = path.resolve(toRoot);
    // The original v0.79 JSON and media remain untouched. Only this v0.80
    // copy-on-write record is updated after the relocated candidate validates.
    const candidates = record.segments.filter((segment) => {
      const current = path.resolve(segment.outputPath);
      return segment.status === "COMPLETED" && current.startsWith(sourceRoot + path.sep);
    });
    if (!candidates.length) throw new Error("舊 TEMP root 下沒有已完成片段可重新對應。");
    const replacements = await Promise.all(
      candidates.map(async (segment) => {
        const relative = path.relative(sourceRoot, path.resolve(segment.outputPath));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
          throw new Error("片段路徑超出舊 TEMP root。");
        const candidate = path.resolve(destinationRoot, relative);
        if (!candidate.startsWith(destinationRoot + path.sep)) throw new Error("候選路徑超出新 TEMP root。");
        const remapped = { ...segment, outputPath: candidate, volume: path.parse(candidate).root.toUpperCase() };
        if (!(await this.validateSegment(remapped))) throw new Error(`重新對應驗證失敗：${path.basename(candidate)}`);
        return { segment, remapped };
      }),
    );
    for (const { segment, remapped } of replacements) Object.assign(segment, remapped);
    await this.save(record);
    await this.appendDiagnostic(record, {
      event: "COMPLETED_SEGMENTS_REMAPPED",
      fromRoot: sourceRoot,
      toRoot: destinationRoot,
      count: replacements.length,
      sourceFilesModified: false,
    });
    return replacements.length;
  }

  /**
   * Reconcile files moved by the user through Explorer. Search is deliberately
   * bounded to registered TEMP roots. Identity is content based (recorded size,
   * media properties and SHA-256), so a drive letter, directory or filename
   * change cannot invalidate a completed render segment.
   */
  async discoverAndRemapCompletedArtifacts(
    projectId: string,
    checkpointId: string,
    registeredRoots: readonly string[],
    missingOnly = false,
    persistOverlay = true,
  ): Promise<ResumeArtifactRecoveryResult> {
    const record = await this.load(projectId);
    if (
      !record ||
      (record.checkpointId !== checkpointId && record.recoveryMigration?.sourceCheckpointId !== checkpointId)
    )
      throw new Error("找不到可重新掃描的 checkpoint。");
    if (record.checkpointProducer !== "v0.80" && record.checkpointProducer !== "v0.82")
      throw new Error("舊版 checkpoint 必須先建立 copy-on-write 復原副本。");
    const roots = [
      ...new Set(registeredRoots.filter((root) => path.isAbsolute(root)).map((root) => path.resolve(root))),
    ];
    if (!roots.length) throw new Error("沒有已登錄的 TEMP root 可供重新掃描。");

    const files: Array<{ path: string; size: number }> = [];
    const maximumFiles = 10_000;
    const maximumDepth = 6;
    let limitReached = false;
    let visitedEntries = 0;
    const walk = async (root: string, depth: number): Promise<void> => {
      if (depth > maximumDepth || limitReached) return;
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > 50_000) {
          limitReached = true;
          return;
        }
        const candidate = path.join(root, entry.name);
        if (entry.isDirectory()) await walk(candidate, depth + 1);
        else if (entry.isFile() && [".mkv", ".mp4"].includes(path.extname(entry.name).toLowerCase())) {
          const item = await stat(candidate).catch(() => undefined);
          if (item) files.push({ path: candidate, size: item.size });
          if (files.length >= maximumFiles) {
            limitReached = true;
            return;
          }
        }
      }
    };
    for (const root of roots) await walk(root, 0);
    if (limitReached)
      throw new Error(
        `TEMP 掃描超過安全上限（${maximumFiles} 個媒體檔／50,000 個項目）；請選擇較精確的 SceneryWalker TEMP 目的地。`,
      );

    const remappedArtifactIds: string[] = [];
    const duplicateSourceArtifactIds: string[] = [];
    const missingArtifactIds: string[] = [];
    const invalidCandidates: ResumeArtifactRecoveryResult["invalidCandidates"] = [];
    for (const segment of record.segments.filter((item) => item.status === "COMPLETED")) {
      const original = path.resolve(segment.outputPath);
      const originalItem = await stat(original).catch(() => undefined);
      const originalExists = Boolean(
        originalItem?.isFile() && (!segment.sizeBytes || originalItem.size === segment.sizeBytes),
      );
      // Relocation discovery is for missing checkpoint artifacts. An existing,
      // correctly-sized source stays authoritative; a duplicate elsewhere must
      // never silently replace it during an automatic Resume preflight.
      if (missingOnly && originalExists) continue;
      const candidates = files
        .filter(
          (file) =>
            file.path.toLowerCase() !== original.toLowerCase() &&
            (!segment.sizeBytes || file.size === segment.sizeBytes),
        )
        .sort((left, right) => {
          const expected = path.basename(original).toLowerCase();
          return (
            Number(path.basename(right.path).toLowerCase() === expected) -
            Number(path.basename(left.path).toLowerCase() === expected)
          );
        });
      let match: string | undefined;
      const rejectedExactNameCandidates: ResumeArtifactRecoveryResult["invalidCandidates"] = [];
      for (const candidate of candidates) {
        const relocated = { ...segment, outputPath: candidate.path };
        if (await this.validateSegment(relocated)) {
          match = candidate.path;
          break;
        }
        if (path.basename(candidate.path).toLowerCase() === path.basename(original).toLowerCase())
          rejectedExactNameCandidates.push({
            artifactId: segment.id,
            path: candidate.path,
            reason: "File size matched, but ffprobe/media fingerprint validation failed.",
          });
      }
      if (!match) {
        invalidCandidates.push(...rejectedExactNameCandidates);
        if (!originalExists) missingArtifactIds.push(segment.id);
        continue;
      }
      segment.outputPath = path.resolve(match);
      segment.volume = path.parse(match).root.toUpperCase();
      segment.tempLocationId = record.tempLocations?.find((location) => {
        const root = path.resolve(location.path);
        const resolved = path.resolve(match!);
        return resolved === root || resolved.startsWith(root + path.sep);
      })?.id;
      remappedArtifactIds.push(segment.id);
      if (originalExists) duplicateSourceArtifactIds.push(segment.id);
    }
    if (remappedArtifactIds.length && persistOverlay) {
      // Publish a path-remap overlay rather than rewriting the source checkpoint.
      // load() applies this registry to a fresh in-memory record after validating
      // the relocated content, preserving the old JSON as recovery evidence.
      await this.saveArtifactRelocations(
        record.projectId,
        record.segments
          .filter((item) => remappedArtifactIds.includes(item.id) && item.sha256 && item.sizeBytes)
          .map((item) => ({ sha256: item.sha256!, path: item.outputPath, sizeBytes: item.sizeBytes! })),
      );
    }
    if (persistOverlay) {
      await this.appendDiagnostic(record, {
        event: "MANUAL_MOVE_SCAN_COMPLETED",
        roots,
        remappedArtifactIds,
        duplicateSourceArtifactIds,
        missingArtifactIds,
        invalidCandidates,
        sourceFilesModified: false,
      });
    }
    return {
      checkpointId: record.checkpointId,
      state: missingArtifactIds.length || invalidCandidates.length ? "FAILED" : "RECALCULATING_STORAGE",
      remappedArtifactIds,
      duplicateSourceArtifactIds,
      missingArtifactIds,
      invalidCandidates,
      remappedPaths: Object.fromEntries(
        record.segments
          .filter((item) => remappedArtifactIds.includes(item.id))
          .map((item) => [item.id, item.outputPath]),
      ),
    };
  }

  /** Add an already validated app preference as an allowed recovery location.
   * This changes storage routing only and is deliberately excluded from render identity. */
  async authorizeRecoveryTempLocation(
    projectId: string,
    checkpointId: string,
    location: RenderTempLocationConfig,
  ): Promise<void> {
    const record = await this.load(projectId);
    if (!record || record.checkpointId !== checkpointId) throw new Error("找不到可更新 TEMP 位置的 checkpoint。");
    if (record.checkpointProducer !== "v0.82") throw new Error("更新 TEMP 位置前必須先建立 v0.82 copy-on-write 副本。");
    if (!path.isAbsolute(location.path) || !location.id) throw new Error("新的 TEMP 位置無效。");
    const normalized = { ...structuredClone(location), path: path.resolve(location.path), enabled: true };
    record.tempLocations = [
      ...(record.tempLocations ?? []).filter(
        (item) => item.id !== normalized.id && path.resolve(item.path).toLowerCase() !== normalized.path.toLowerCase(),
      ),
      normalized,
    ];
    await this.save(record);
    await this.appendDiagnostic(record, {
      event: "RECOVERY_TEMP_LOCATION_AUTHORIZED",
      locationId: normalized.id,
      path: normalized.path,
      renderIdentityChanged: false,
    });
  }

  /**
   * Cross-volume artifact migration for an explicitly confirmed plan. Copies
   * to destination partials, validates the complete media, checkpoints the new
   * absolute paths plus a content-addressed relocation registry, and only then
   * removes old files. The registry keeps immutable legacy checkpoint JSON
   * usable after an explicitly confirmed legacy-artifact relocation.
   */
  async migrateCompletedArtifacts(
    projectId: string,
    checkpointId: string,
    artifactIds: readonly string[],
    destinationTempRoot: string,
  ): Promise<{
    migratedArtifactIds: string[];
    copiedBytes: number;
    deletedSourceBytes: number;
    sourcePreservedArtifactIds: string[];
  }> {
    const record = await this.load(projectId);
    if (!record || record.checkpointId !== checkpointId) throw new Error("找不到可搬移的 checkpoint。");
    if (record.checkpointProducer !== "v0.82")
      throw new Error("舊版 checkpoint 必須先建立 v0.82 copy-on-write 復原副本。");
    if (!path.isAbsolute(destinationTempRoot)) throw new Error("搬移目的 TEMP 必須是絕對路徑。");
    const destinationRoot = path.resolve(destinationTempRoot);
    const destinationConfig = (record.tempLocations ?? []).find(
      (location) =>
        path.resolve(location.path).toLowerCase() === destinationRoot.toLowerCase() && location.enabled !== false,
    );
    if (!destinationConfig) throw new Error("搬移目的地不在 checkpoint 核准的 TEMP 清單中。");
    const requested = new Set(artifactIds);
    if (!requested.size) throw new Error("未選擇要搬移的已完成 Artifact。");
    const candidates = record.segments.filter((segment) => requested.has(segment.id));
    if (candidates.length !== requested.size) throw new Error("搬移清單包含不存在的 Artifact。");
    const prepared: Array<{
      segment: RenderCheckpointSegment;
      source: string;
      destination: string;
      partial: string;
      bytes: number;
    }> = [];
    const transientPaths: string[] = [];
    let checkpointSaved = false;
    try {
      for (const segment of candidates) {
        const source = path.resolve(segment.outputPath);
        if (segment.status !== "COMPLETED" || !(await this.validateSegment(segment)))
          throw new Error(`Artifact 尚未完成或驗證失敗：${segment.id}`);
        if (!segment.sha256) throw new Error(`Artifact 缺少內容指紋，不能安全搬移：${segment.id}`);
        const sourceStat = await stat(source);
        const destinationWorkRoot = path.join(destinationRoot, path.basename(record.workRoot));
        const parsedName = path.parse(source);
        const safeArtifactName =
          segment.id
            .replace(/[^a-z0-9_-]+/gi, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "artifact";
        let destination = path.join(destinationWorkRoot, `${safeArtifactName}-${parsedName.base}`);
        let collision = 0;
        while (await stat(destination).catch(() => undefined)) {
          collision += 1;
          destination = path.join(destinationWorkRoot, `${safeArtifactName}-${collision}-${parsedName.base}`);
        }
        if (source.toLowerCase() === destination.toLowerCase()) throw new Error(`Artifact 已在目的地：${segment.id}`);
        await mkdir(destinationWorkRoot, { recursive: true });
        const destinationFs = await statfs(destinationWorkRoot);
        const destinationFreeBytes = Number(destinationFs.bavail) * Number(destinationFs.bsize);
        const hardLimit = hardSafetyLimitBytes(destinationRoot);
        if (destinationFreeBytes < sourceStat.size + hardLimit)
          throw new Error(`Artifact 目的磁碟低於硬安全空間：${segment.id}`);
        const partial = `${destination}.${randomUUID()}.migration.partial`;
        transientPaths.push(partial);
        await copyFile(source, partial, constants.COPYFILE_EXCL);
        const partialStat = await stat(partial);
        if (sourceStat.size !== partialStat.size) throw new Error(`Artifact 複製大小不一致：${segment.id}`);
        const copied = { ...segment, outputPath: partial };
        if (!(await this.validateSegment(copied))) throw new Error(`Artifact 目的地媒體驗證失敗：${segment.id}`);
        if (segment.sha256 && (await sha256(partial)) !== segment.sha256)
          throw new Error(`Artifact 目的地 SHA-256 不一致：${segment.id}`);
        // A same-directory hard link publishes the already verified bytes and
        // fails with EEXIST instead of replacing a concurrently created file.
        await link(partial, destination);
        await rm(partial, { force: true });
        transientPaths.splice(transientPaths.indexOf(partial), 1);
        prepared.push({ segment, source, destination, partial, bytes: sourceStat.size });
      }

      for (const item of prepared) {
        item.segment.outputPath = item.destination;
        item.segment.volume = path.parse(item.destination).root.toUpperCase();
        item.segment.tempLocationId = destinationConfig.id;
      }
      const destinationWorkRoot = path.join(destinationRoot, path.basename(record.workRoot));
      record.ownedWorkRoots = [...new Set([...(record.ownedWorkRoots ?? [record.workRoot]), destinationWorkRoot])];
      await this.save(record);
      checkpointSaved = true;
      // Keep immutable legacy checkpoint JSON usable without rewriting it.
      // If a legacy path later disappears, load() verifies and follows this
      // content-addressed relocation registry.
      await this.saveArtifactRelocations(
        record.projectId,
        prepared.map((item) => ({
          sha256: item.segment.sha256!,
          path: item.destination,
          sizeBytes: item.bytes,
        })),
      );
      await this.appendDiagnostic(record, {
        event: "COMPLETED_ARTIFACTS_MIGRATED_CHECKPOINTED",
        destinationRoot,
        artifactIds: prepared.map((item) => item.segment.id),
        copiedBytes: prepared.reduce((sum, item) => sum + item.bytes, 0),
      }).catch(() => undefined);

      let deletedSourceBytes = 0;
      const sourcePreservedArtifactIds: string[] = [];
      for (const item of prepared) {
        try {
          await rm(item.source);
          deletedSourceBytes += item.bytes;
        } catch {
          sourcePreservedArtifactIds.push(item.segment.id);
        }
      }
      return {
        migratedArtifactIds: prepared.map((item) => item.segment.id),
        copiedBytes: prepared.reduce((sum, item) => sum + item.bytes, 0),
        deletedSourceBytes,
        sourcePreservedArtifactIds,
      };
    } catch (error) {
      // Until checkpoint save, every source stays authoritative. Best-effort
      // removal here is destination-only and cannot damage Resume.
      for (const transient of transientPaths) await rm(transient, { force: true }).catch(() => undefined);
      if (!checkpointSaved)
        for (const item of prepared) await rm(item.destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Change only where *future* stage files are written. Existing segment
   * paths remain absolute and authoritative; no media is copied or moved. */
  async switchWorkRootForFutureJobs(record: RenderCheckpointRecord, selectedTempRoot: string): Promise<void> {
    if (record.checkpointProducer !== "v0.80" && record.checkpointProducer !== "v0.82")
      throw new Error("舊版 checkpoint 必須先建立 copy-on-write 副本。");
    if (!path.isAbsolute(selectedTempRoot)) throw new Error("新 TEMP 根目錄必須是絕對路徑。");
    if (
      !(record.tempLocations ?? []).some(
        (location) => path.resolve(location.path).toLowerCase() === path.resolve(selectedTempRoot).toLowerCase(),
      )
    )
      throw new Error("新工作目錄不在本 checkpoint 核准的 TEMP 清單中。");
    const destination = path.join(path.resolve(selectedTempRoot), path.basename(record.workRoot));
    if (path.resolve(destination).toLowerCase() === path.resolve(record.workRoot).toLowerCase()) return;
    const previousRoot = record.workRoot;
    await mkdir(destination, { recursive: true });
    record.ownedWorkRoots = [...new Set([...(record.ownedWorkRoots ?? [previousRoot]), previousRoot, destination])];
    record.workRoot = destination;
    await this.save(record);
    await this.appendDiagnostic(record, {
      event: "FUTURE_WORK_ROOT_SWITCHED",
      previousRoot,
      nextRoot: destination,
      existingSegmentsMoved: false,
    });
  }

  /**
   * Release only app-owned intermediates whose complete downstream replacement
   * has already been validated. Metadata remains in the checkpoint audit trail.
   */
  async releaseConsumedSegments(record: RenderCheckpointRecord, outputPaths: readonly string[]): Promise<number> {
    const ownedRoots = this.validatedOwnedWorkRoots(record);
    let releasedBytes = 0;
    for (const candidate of outputPaths) {
      const resolved = path.resolve(candidate);
      if (!ownedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) continue;
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
    const firstMissing = recordedCompleted.find((_segment, index) => !physicalChecks[index]);
    const missingPaths = recordedCompleted
      .filter((_segment, index) => !physicalChecks[index])
      .map((segment) => path.resolve(segment.outputPath));
    const possibleRoots = [
      ...(record.tempLocations ?? []).map((location) => location.path),
      ...(record.request.tempLocations ?? []).map((location) => location.path),
      ...(record.request.renderTemporaryFolder ? [record.request.renderTemporaryFolder] : []),
      path.dirname(record.workRoot),
      ...(record.ownedWorkRoots ?? []).map((root) => path.dirname(root)),
    ].map((root) => path.resolve(root));
    const missingTempRoots = [
      ...new Set(
        possibleRoots.filter((root) =>
          missingPaths.some((missing) => missing.toLowerCase().startsWith((root + path.sep).toLowerCase())),
        ),
      ),
    ];
    return {
      checkpointId: record.checkpointId,
      projectId: record.projectId,
      outputPath: record.outputPath,
      mode: record.mode,
      completedSegmentCount: physicallyPresentCount,
      recordedCompletedSegmentCount: recordedCompleted.length,
      missingCompletedSegmentCount,
      missingCompletedPathExample: firstMissing?.outputPath,
      missingTempRoots,
      physicalState:
        missingCompletedSegmentCount === 0 ? "READY" : physicallyPresentCount > 0 ? "PARTIAL" : "SEGMENT_CACHE_MISSING",
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
      legacyRecoveryProtected: record.checkpointProducer !== "v0.82",
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
    if (record.checkpointProducer !== "v0.82") {
      throw new Error(
        "偵測到 v0.79–v0.81 復原資料；v0.82 建立 copy-on-write migration copy 之前，不能捨棄或清理原始 checkpoint。",
      );
    }
    const ownedRoots = this.validatedOwnedWorkRoots(record);
    await Promise.all(ownedRoots.map((root) => rm(root, { recursive: true, force: true })));
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
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projectId,
          sourceCheckpointId: record.recoveryMigration?.sourceCheckpointId ?? record.checkpointId,
          completedCheckpointId: record.checkpointId,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await copyFile(temporary, markerPath);
    await rm(temporary, { force: true });
    await this.discard(projectId, checkpointId);
  }
}
