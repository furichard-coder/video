import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalPlayerOption, SourceAsset } from "../src/shared/domain";
import { ExternalPlayerService } from "../src/main/services/external-player";
import type { PreviewCache } from "../src/main/services/preview-cache";
import type { ProjectStore } from "../src/main/services/project-store";
import type { SourceService } from "../src/main/services/source-service";
import type { PlayerSettingsStore } from "../src/main/services/player-settings";

const roots: string[] = [];

async function hash(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function fixture(extension = ".MP4") {
  const root = await mkdtemp(path.join(os.tmpdir(), "外部 播放器測試-"));
  roots.push(root);
  const sourcePath = path.join(root, `旅遊 原始片${extension}`);
  const proxyPath = path.join(root, "App cache", "低解析 預覽.mp4");
  const executablePath = path.join(root, "播放器 安裝", "custom player.exe");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(proxyPath), { recursive: true });
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(sourcePath, "immutable-source-bytes");
  await writeFile(proxyPath, "derived-proxy-bytes");
  await writeFile(executablePath, "placeholder-executable");
  const asset: SourceAsset = {
    id: "a".repeat(64),
    sourcePath,
    sourceIdentity: "b".repeat(64),
    fileName: path.basename(sourcePath),
    extension,
    kind: "VIDEO",
    sizeBytes: 22,
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    addedOrder: 0,
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewCacheKey: "c".repeat(64),
    metadataState: "READY",
  };
  return { sourcePath, proxyPath, executablePath, asset };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function serviceFor(
  asset: SourceAsset,
  proxyPath: string,
  player: ExternalPlayerOption,
  openDefault = vi.fn(async () => ""),
  starter = vi.fn(async () => undefined),
) {
  const store = { getAsset: vi.fn(() => structuredClone(asset)) } as unknown as ProjectStore;
  const sources = { refreshAsset: vi.fn(async () => structuredClone(asset)) } as unknown as SourceService;
  const previews = {
    ensure: vi.fn(async () => undefined),
    resolveExisting: vi.fn(async () => proxyPath),
  } as unknown as PreviewCache;
  const settings = { resolve: vi.fn(async () => player) } as unknown as PlayerSettingsStore;
  return {
    instance: new ExternalPlayerService(store, sources, previews, settings, openDefault, starter),
    sources,
    previews,
    openDefault,
    starter,
  };
}

describe("external media launch boundary", () => {
  it("passes a Chinese/space proxy path as one argument and leaves the source hash unchanged", async () => {
    const item = await fixture();
    const before = await hash(item.sourcePath);
    const player: ExternalPlayerOption = {
      id: "CUSTOM:abc",
      label: "Custom",
      kind: "CUSTOM",
      available: true,
      executablePath: item.executablePath,
    };
    const harness = serviceFor(item.asset, item.proxyPath, player);
    const result = await harness.instance.open(item.asset.id, "PROXY");
    expect(result).toMatchObject({ status: "OPENED", target: "PROXY", playerLabel: "Custom" });
    expect(harness.starter).toHaveBeenCalledWith(item.executablePath, [item.proxyPath]);
    expect(harness.previews.ensure).toHaveBeenCalledWith(item.asset.id, "VIDEO_PROXY");
    expect(await hash(item.sourcePath)).toBe(before);
  });

  it("opens the original only after refresh, without modifying its bytes", async () => {
    const item = await fixture(".mov");
    const before = await hash(item.sourcePath);
    const player: ExternalPlayerOption = {
      id: "VLC",
      label: "VLC media player",
      kind: "KNOWN",
      available: true,
      executablePath: item.executablePath,
    };
    const harness = serviceFor(item.asset, item.proxyPath, player);
    await harness.instance.open(item.asset.id, "ORIGINAL");
    expect(harness.sources.refreshAsset).toHaveBeenCalledWith(item.asset.id);
    expect(harness.starter).toHaveBeenCalledWith(item.executablePath, [item.sourcePath]);
    expect(harness.previews.ensure).not.toHaveBeenCalled();
    expect(await hash(item.sourcePath)).toBe(before);
  });

  it("falls back to the system default when a configured player is missing", async () => {
    const item = await fixture();
    const player: ExternalPlayerOption = { id: "MPC_HC", label: "MPC-HC", kind: "KNOWN", available: false };
    const harness = serviceFor(item.asset, item.proxyPath, player);
    const result = await harness.instance.open(item.asset.id, "PROXY");
    expect(result.status).toBe("FALLBACK_SYSTEM_DEFAULT");
    expect(result.message).toMatch(/已遺失或未安裝.*Windows 系統預設/);
    expect(harness.openDefault).toHaveBeenCalledWith(item.proxyPath);
    expect(harness.starter).not.toHaveBeenCalled();
  });

  it("falls back after launch failure and returns to internal playback if Windows also fails", async () => {
    const item = await fixture();
    const player: ExternalPlayerOption = {
      id: "VLC",
      label: "VLC media player",
      kind: "KNOWN",
      available: true,
      executablePath: item.executablePath,
    };
    const openDefault = vi.fn(async () => "Windows association unavailable");
    const starter = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const harness = serviceFor(item.asset, item.proxyPath, player, openDefault, starter);
    const result = await harness.instance.open(item.asset.id, "PROXY");
    expect(result.status).toBe("USE_INTERNAL");
    expect(result.message).toMatch(/spawn failed.*App 內建 proxy/);
  });

  it("uses the Windows Media Player fixed argument without shell composition", async () => {
    const item = await fixture();
    const player: ExternalPlayerOption = {
      id: "WINDOWS_MEDIA_PLAYER",
      label: "Windows Media Player",
      kind: "KNOWN",
      available: true,
      executablePath: item.executablePath,
    };
    const harness = serviceFor(item.asset, item.proxyPath, player);
    await harness.instance.open(item.asset.id, "PROXY");
    expect(harness.starter).toHaveBeenCalledWith(item.executablePath, ["/open", item.proxyPath]);
  });

  it("plays a completed or cancelled-preview MP4 through the configured .mp4 player without changing it", async () => {
    const item = await fixture();
    const completed = path.join(path.dirname(item.sourcePath), "取消後 較小預覽.mp4");
    await writeFile(completed, "playable-preview-bytes");
    const before = await hash(completed);
    const player: ExternalPlayerOption = {
      id: "VLC",
      label: "VLC media player",
      kind: "KNOWN",
      available: true,
      executablePath: item.executablePath,
    };
    const harness = serviceFor(item.asset, item.proxyPath, player);
    const result = await harness.instance.openFile(completed);
    expect(result).toMatchObject({ status: "OPENED", playerLabel: "VLC media player" });
    expect(harness.starter).toHaveBeenCalledWith(item.executablePath, [completed]);
    expect(await hash(completed)).toBe(before);
  });
});
