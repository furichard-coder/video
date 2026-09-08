import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformUploadHandoffService } from "../src/main/services/platform-upload-handoff";

const roots: string[] = [];
async function sha256(filePath: string): Promise<string> { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PlatformUploadHandoffService", () => {
  it.each([
    ["BILIBILI" as const, "https://member.bilibili.com/platform/upload/video/frame"],
    ["TIKTOK" as const, "https://www.tiktok.com/tiktokstudio/upload?from=creator_center"],
  ])("opens the official %s login/upload portal without reading credentials or touching files", async (platform, expectedUrl) => {
    const adapter = { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn(), copyText: vi.fn() };
    const result = await new PlatformUploadHandoffService(adapter).openPortal(platform);
    expect(result).toMatchObject({ platform, uploadUrl: expectedUrl });
    expect(result.message).toMatch(/不會讀取或保存/);
    expect(adapter.openExternal).toHaveBeenCalledWith(expectedUrl);
    expect(adapter.copyText).not.toHaveBeenCalled();
    expect(adapter.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each([
    ["BILIBILI" as const, "https://member.bilibili.com/platform/upload/video/frame"],
    ["TIKTOK" as const, "https://www.tiktok.com/tiktokstudio/upload?from=creator_center"],
  ])("hands a Unicode and spaced MP4 to the official %s page without changing it", async (platform, expectedUrl) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "平台 投稿-")); roots.push(root);
    const outputPath = path.join(root, "河內 預覽 片.mp4"); await writeFile(outputPath, "completed-mp4-bytes"); const before = await sha256(outputPath);
    const adapter = { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn(), copyText: vi.fn() };
    const result = await new PlatformUploadHandoffService(adapter).open(outputPath, platform);
    expect(result).toMatchObject({ platform, outputPath: path.resolve(outputPath), uploadUrl: expectedUrl });
    expect(adapter.copyText).toHaveBeenCalledWith(path.resolve(outputPath));
    expect(adapter.showItemInFolder).toHaveBeenCalledWith(path.resolve(outputPath));
    expect(adapter.openExternal).toHaveBeenCalledWith(expectedUrl);
    expect(await sha256(outputPath)).toBe(before);
  });

  it("rejects missing, empty, non-MP4, and unsupported targets before opening anything", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "platform-gate-")); roots.push(root);
    const adapter = { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn(), copyText: vi.fn() };
    const service = new PlatformUploadHandoffService(adapter);
    const empty = path.join(root, "empty.mp4"); const wrong = path.join(root, "preview.mov"); await writeFile(empty, ""); await writeFile(wrong, "data");
    await expect(service.open(path.join(root, "missing.mp4"), "BILIBILI")).rejects.toThrow(/找不到/);
    await expect(service.open(empty, "TIKTOK")).rejects.toThrow(/找不到/);
    await expect(service.open(wrong, "BILIBILI")).rejects.toThrow(/MP4/);
    await expect(service.open(wrong, "UNKNOWN" as never)).rejects.toThrow(/不支援/);
    expect(adapter.openExternal).not.toHaveBeenCalled(); expect(adapter.copyText).not.toHaveBeenCalled(); expect(adapter.showItemInFolder).not.toHaveBeenCalled();
  });
});
