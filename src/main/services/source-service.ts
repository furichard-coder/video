import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ImportProgress,
  ImportResult,
  ProjectManifest,
  SourceAsset,
  SourceKind,
} from "../../shared/domain";
import { DEFAULT_IMAGE_DURATION_MS } from "../../shared/domain";
import { normalizedPathIdentity, previewCacheKey } from "./identity";
import { MediaProbe } from "./media-probe";
import { ProjectStore } from "./project-store";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".mkv",
  ".avi",
  ".mts",
  ".m2ts",
  ".webm",
  ".wmv",
  ".mpg",
  ".mpeg",
]);
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".bmp",
  ".avif",
]);

export const MEDIA_DIALOG_FILTERS = [
  { name: "影片與照片", extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].map((item) => item.slice(1)) },
  { name: "影片", extensions: [...VIDEO_EXTENSIONS].map((item) => item.slice(1)) },
  { name: "照片", extensions: [...IMAGE_EXTENSIONS].map((item) => item.slice(1)) },
];

function kindForPath(filePath: string): SourceKind | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "VIDEO";
  if (IMAGE_EXTENSIONS.has(extension)) return "IMAGE";
  return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("匯入已取消。", "AbortError");
}

export class SourceService {
  constructor(
    private readonly store: ProjectStore,
    private readonly probe: MediaProbe,
  ) {}

  async importSelected(
    selectedPaths: string[],
    signal?: AbortSignal,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportResult> {
    const files: string[] = [];
    let unsupportedCount = 0;

    for (const selectedPath of selectedPaths) {
      throwIfAborted(signal);
      const selectedStat = await stat(selectedPath);
      if (selectedStat.isDirectory()) {
        const discovered = await this.walkDirectory(selectedPath, signal, (currentName) => {
          onProgress?.({
            phase: "DISCOVERING",
            discovered: files.length,
            processed: 0,
            currentName,
          });
        });
        files.push(...discovered.files);
        unsupportedCount += discovered.unsupportedCount;
      } else if (selectedStat.isFile()) {
        if (kindForPath(selectedPath)) files.push(selectedPath);
        else unsupportedCount += 1;
      }
    }

    const project = this.store.getProject();
    const existingIds = new Set(project.sources.map((asset) => asset.id));
    const uniqueSelected = new Set<string>();
    const assets: SourceAsset[] = [];
    const errors: string[] = [];
    let duplicateCount = 0;
    let nextOrder = project.sources.reduce((max, asset) => Math.max(max, asset.addedOrder), -1) + 1;

    for (let index = 0; index < files.length; index += 1) {
      throwIfAborted(signal);
      const sourcePath = files[index];
      onProgress?.({
        phase: "ADDING",
        discovered: files.length,
        processed: index,
        currentName: path.basename(sourcePath),
      });
      try {
        const canonicalPath = await realpath(sourcePath);
        const id = normalizedPathIdentity(canonicalPath);
        if (existingIds.has(id) || uniqueSelected.has(id)) {
          duplicateCount += 1;
          continue;
        }
        const fileStat = await stat(canonicalPath);
        const kind = kindForPath(canonicalPath);
        if (!kind || !fileStat.isFile()) {
          unsupportedCount += 1;
          continue;
        }
        const modifiedAt = fileStat.mtime.toISOString();
        assets.push({
          id,
          sourcePath: canonicalPath,
          sourceIdentity: id,
          fileName: path.basename(canonicalPath),
          extension: path.extname(canonicalPath).toLowerCase(),
          kind,
          sizeBytes: fileStat.size,
          fileCreatedAt: fileStat.birthtime.toISOString(),
          fileModifiedAt: modifiedAt,
          addedAt: new Date().toISOString(),
          addedOrder: nextOrder,
          sourcePolicy: "READ_ONLY",
          previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
          previewCacheKey: previewCacheKey({
            assetId: id,
            sourcePath: canonicalPath,
            sizeBytes: fileStat.size,
            modifiedAt,
          }),
          metadataState: "PENDING",
          imageDurationMs: kind === "IMAGE" ? DEFAULT_IMAGE_DURATION_MS : undefined,
        });
        uniqueSelected.add(id);
        nextOrder += 1;
      } catch (error) {
        errors.push(`${path.basename(sourcePath)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const updated = assets.length > 0 ? await this.store.addAssets(assets) : this.store.getProject();
    onProgress?.({
      phase: "ADDING",
      discovered: files.length,
      processed: files.length,
    });
    return {
      cancelled: false,
      addedCount: assets.length,
      duplicateCount,
      unsupportedCount,
      errors: errors.slice(0, 25),
      project: updated,
      addedAssetIds: assets.map((asset) => asset.id),
    };
  }

  async ensureMetadata(assetId: string, signal?: AbortSignal): Promise<SourceAsset> {
    let asset = await this.refreshAsset(assetId);
    const hasDisplayMetadata = Boolean(
      asset.mediaInfo?.displayWidth &&
      asset.mediaInfo?.displayHeight &&
      Number.isFinite(asset.mediaInfo?.rotationDegrees),
    );
    if (asset.metadataState === "READY" && hasDisplayMetadata) return asset;

    try {
      const mediaInfo = await this.probe.probe(asset.sourcePath, signal);
      asset = {
        ...asset,
        mediaInfo,
        metadataState: "READY",
        metadataError: undefined,
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      asset = {
        ...asset,
        metadataState: "FAILED",
        metadataError: error instanceof Error ? error.message : String(error),
      };
    }
    return this.store.updateAsset(asset);
  }

  async refreshAsset(assetId: string): Promise<SourceAsset> {
    const asset = this.store.getAsset(assetId);
    if (!asset) throw new Error("找不到來源項目。");
    const current = await stat(asset.sourcePath);
    if (!current.isFile()) throw new Error("來源路徑已不是檔案。");
    const modifiedAt = current.mtime.toISOString();
    const expectedPreviewCacheKey = previewCacheKey({
      assetId: asset.id,
      sourcePath: asset.sourcePath,
      sizeBytes: current.size,
      modifiedAt,
    });
    const sourceChanged = asset.sizeBytes !== current.size || asset.fileModifiedAt !== modifiedAt;
    if (!sourceChanged && asset.previewCacheKey === expectedPreviewCacheKey) return asset;

    const refreshed: SourceAsset = {
      ...asset,
      sizeBytes: current.size,
      fileModifiedAt: modifiedAt,
      previewCacheKey: expectedPreviewCacheKey,
      ...(sourceChanged ? {
        metadataState: "PENDING" as const,
        metadataError: undefined,
        mediaInfo: undefined,
        previewRange: undefined,
      } : {}),
    };
    return this.store.updateAsset(refreshed);
  }

  private async walkDirectory(
    directoryPath: string,
    signal?: AbortSignal,
    onDiscovered?: (name: string) => void,
  ): Promise<{ files: string[]; unsupportedCount: number }> {
    const files: string[] = [];
    let unsupportedCount = 0;
    const pending = [directoryPath];

    while (pending.length > 0) {
      throwIfAborted(signal);
      const currentDirectory = pending.pop()!;
      const directory = await opendir(currentDirectory);
      for await (const entry of directory) {
        throwIfAborted(signal);
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile()) {
          if (kindForPath(entryPath)) {
            files.push(entryPath);
            onDiscovered?.(entry.name);
          } else {
            unsupportedCount += 1;
          }
        }
      }
    }
    return { files, unsupportedCount };
  }
}

export function emptyCancelledResult(project: ProjectManifest): ImportResult {
  return {
    cancelled: true,
    addedCount: 0,
    duplicateCount: 0,
    unsupportedCount: 0,
    errors: [],
    project,
    addedAssetIds: [],
  };
}
