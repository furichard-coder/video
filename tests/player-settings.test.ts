import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalPlayerOption } from "../src/shared/domain";
import { normalizeMediaExtension, PlayerSettingsStore, resolvePlayerId } from "../src/main/services/player-settings";

const temporaryRoots: string[] = [];
const knownPlayers: ExternalPlayerOption[] = [
  { id: "SYSTEM_DEFAULT", label: "Windows 系統預設播放器", kind: "SYSTEM", available: true },
  { id: "VLC", label: "VLC media player", kind: "KNOWN", available: true, executablePath: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" },
  { id: "WINDOWS_MEDIA_PLAYER", label: "Windows Media Player", kind: "KNOWN", available: false },
  { id: "MPC_HC", label: "MPC-HC", kind: "KNOWN", available: false },
];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "player-settings-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external player settings", () => {
  it("normalizes extension case and resolves override before the global player", () => {
    const settings = {
      schemaVersion: 1 as const,
      defaultPlayerId: "VLC" as const,
      extensionOverrides: { ".mp4": "MPC_HC" as const },
      customPlayers: [],
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(normalizeMediaExtension("MP4")).toBe(".mp4");
    expect(resolvePlayerId(settings, ".MP4")).toBe("MPC_HC");
    expect(resolvePlayerId(settings, "MOV")).toBe("VLC");
    expect(() => normalizeMediaExtension(";calc.exe")).toThrow(/副檔名格式無效/);
  });

  it("persists global, override and a custom executable with spaces and Chinese characters", async () => {
    const root = await tempRoot();
    const executablePath = path.join(root, "自訂 播放器.exe");
    await writeFile(executablePath, "test executable placeholder");
    const discovery = async () => structuredClone(knownPlayers);
    const first = new PlayerSettingsStore(root, discovery);
    await first.initialize();
    const customSnapshot = await first.addCustomPlayer(executablePath);
    const custom = customSnapshot.settings.customPlayers[0];
    await first.update({ defaultPlayerId: "VLC", extensionOverrides: { ".MP4": custom.id } });

    const restored = new PlayerSettingsStore(root, discovery);
    await restored.initialize();
    const snapshot = await restored.snapshotWithCurrentAvailability();
    expect(snapshot.settings.defaultPlayerId).toBe("VLC");
    expect(snapshot.settings.extensionOverrides[".mp4"]).toBe(custom.id);
    expect(snapshot.settings.customPlayers[0].executablePath).toBe(executablePath);
    expect(snapshot.players.find((item) => item.id === custom.id)?.available).toBe(true);
    expect(JSON.parse(await readFile(restored.settingsPath, "utf8"))).toMatchObject({ schemaVersion: 1, defaultPlayerId: "VLC" });
  });

  it("removes references to a deleted custom player without affecting known routes", async () => {
    const root = await tempRoot();
    const executablePath = path.join(root, "custom.exe");
    await writeFile(executablePath, "placeholder");
    const store = new PlayerSettingsStore(root, async () => structuredClone(knownPlayers));
    await store.initialize();
    const custom = (await store.addCustomPlayer(executablePath)).settings.customPlayers[0];
    await store.update({ defaultPlayerId: custom.id, extensionOverrides: { ".mov": custom.id, ".mp4": "VLC" } });
    const snapshot = await store.removeCustomPlayer(custom.id);
    expect(snapshot.settings.defaultPlayerId).toBe("SYSTEM_DEFAULT");
    expect(snapshot.settings.extensionOverrides).toEqual({ ".mp4": "VLC" });
  });
});
