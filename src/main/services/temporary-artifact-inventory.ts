import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  TemporaryArtifactInventory,
  TemporaryArtifactInventoryItem,
} from "../../shared/domain";
import { volumeRoot } from "./render-disk-space";

const MAX_DISCOVERED_ROOTS = 24;
const MAX_SCANNED_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 8;
const APP_OWNED_SIBLING = /^(?:\.?scenerywalker|v0?(?:77|78|79|80|81|82|83)(?:[-_.]|$))/i;
const REBUILDABLE_CACHE = /(?:^|[\\/])(?:preview-cache|proxy-cache|thumbnail-cache|thumbnails|waveforms?|analysis-cache|scenerywalkercache)(?:[\\/]|$)/i;

function artifactId(filePath: string): string {
  return `inventory:${createHash("sha256").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 24)}`;
}

function versionFromPath(filePath: string): string | undefined {
  const match = filePath.match(/(?:^|[\\/_.-])v?0?((?:77|78|79|80|81|82|83))(?:[\\/_.-]|$)/i);
  return match ? `0.${Number(match[1])}.0` : undefined;
}

async function discoverRegisteredRoots(configuredRoots: readonly string[]): Promise<string[]> {
  const roots = new Map<string, string>();
  const add = (candidate: string) => {
    const resolved = path.resolve(candidate);
    roots.set(resolved.toLowerCase(), resolved);
  };
  for (const configured of configuredRoots) {
    if (!path.isAbsolute(configured)) continue;
    add(configured);
    const parent = path.dirname(path.resolve(configured));
    const siblings = await readdir(parent, { withFileTypes: true }).catch(() => []);
    for (const sibling of siblings) {
      if (roots.size >= MAX_DISCOVERED_ROOTS) break;
      if (sibling.isDirectory() && APP_OWNED_SIBLING.test(sibling.name)) add(path.join(parent, sibling.name));
    }
  }
  return [...roots.values()];
}

/** Read-only, bounded scan of configured TEMP roots and explicitly named
 * SceneryWalker/version siblings. It never walks a drive or arbitrary parent. */
export async function scanRegisteredTemporaryArtifacts(
  configuredRoots: readonly string[],
  known: TemporaryArtifactInventory,
  protectedSourcePaths: readonly string[] = [],
): Promise<TemporaryArtifactInventory> {
  const roots = await discoverRegisteredRoots(configuredRoots);
  const knownByPath = new Map(known.items.map((item) => [path.resolve(item.path).toLowerCase(), item]));
  const discovered = new Map<string, TemporaryArtifactInventoryItem>(
    known.items.map((item) => [path.resolve(item.path).toLowerCase(), item]),
  );
  const protectedSources = new Set(
    protectedSourcePaths.filter(path.isAbsolute).map((item) => path.resolve(item).toLowerCase()),
  );
  let scanned = 0;
  for (const root of roots) {
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let rootFileCount = 0;
    while (pending.length && scanned < MAX_SCANNED_ENTRIES) {
      const current = pending.pop()!;
      const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED_ENTRIES) break;
        const itemPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < MAX_SCAN_DEPTH && !entry.isSymbolicLink())
            pending.push({ directory: itemPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        rootFileCount += 1;
        const resolved = path.resolve(itemPath);
        const key = resolved.toLowerCase();
        if (knownByPath.has(key)) continue;
        const metadata = await stat(resolved).catch(() => undefined);
        if (!metadata?.isFile()) continue;
        const partial = /\.partial(?:\.[^.]+)?$/i.test(entry.name) || /\.partial\.(?:mkv|mp4)$/i.test(entry.name);
        const rebuildable = !partial && REBUILDABLE_CACHE.test(resolved);
        const isProjectSource = protectedSources.has(key);
        discovered.set(key, {
          artifactId: artifactId(resolved),
          appVersion: versionFromPath(resolved),
          artifactType: partial ? "PARTIAL" : rebuildable && !isProjectSource ? "PREVIEW_CACHE" : "UNKNOWN",
          path: resolved,
          drive: volumeRoot(resolved),
          sizeBytes: metadata.size,
          createdAt: metadata.birthtime.toISOString(),
          modifiedAt: metadata.mtime.toISOString(),
          status: partial ? "UNKNOWN" : rebuildable && !isProjectSource ? "REBUILDABLE_CACHE" : "UNKNOWN",
          referencedByCurrentCheckpoint: isProjectSource,
          safeToDelete: false,
          safeToMove: false,
          reason: isProjectSource
            ? "此檔案是目前專案來源素材，即使位於 cache 命名路徑也禁止清理。"
            : partial
            ? "未經 ffprobe 證明不可恢復的 partial，保守標記 UNKNOWN 並禁止清理。"
            : rebuildable
              ? "位於 SceneryWalker 明確命名的可重建 cache，僅列為候選；尚未證明沒有 checkpoint／目前工作依賴，因此禁止直接刪除。"
              : "無法由 checkpoint、內容指紋或明確 cache 類型證明用途，保守保留。",
        });
      }
    }
    if (!rootFileCount && !known.items.some((item) => path.resolve(item.path).startsWith(path.resolve(root) + path.sep))) {
      const resolved = path.resolve(root);
      discovered.set(`empty:${resolved.toLowerCase()}`, {
        artifactId: artifactId(`${resolved}${path.sep}.empty-root`),
        artifactType: "UNKNOWN",
        path: resolved,
        drive: volumeRoot(resolved),
        sizeBytes: 0,
        status: "UNKNOWN",
        referencedByCurrentCheckpoint: false,
        safeToDelete: false,
        safeToMove: false,
        reason: "已掃描的 SceneryWalker TEMP 目錄目前為空；未自動刪除目錄。",
      });
    }
  }
  const items = [...discovered.values()].sort((left, right) => right.sizeBytes - left.sizeBytes);
  return {
    capturedAt: new Date().toISOString(),
    roots,
    items,
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    immediatelyReclaimableBytes: items.filter((item) => item.safeToDelete).reduce((sum, item) => sum + item.sizeBytes, 0),
    movableBytes: items.filter((item) => item.safeToMove).reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}
