import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CustomPlayerDefinition,
  ExternalPlayerId,
  ExternalPlayerOption,
  ExternalPlayerSettings,
  ExternalPlayerSettingsSnapshot,
  ExternalPlayerSettingsUpdate,
} from "../../shared/domain";
import { discoverKnownPlayers, isExecutableFile } from "./player-discovery";

const KNOWN_IDS = new Set<ExternalPlayerId>(["SYSTEM_DEFAULT", "VLC", "WINDOWS_MEDIA_PLAYER", "MPC_HC"]);

export function normalizeMediaExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const extension = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  if (!/^\.[a-z0-9]{1,12}$/.test(extension)) throw new Error("副檔名格式無效，例如請輸入 .mp4。 ");
  return extension;
}

export function resolvePlayerId(settings: ExternalPlayerSettings, extension: string): ExternalPlayerId {
  return settings.extensionOverrides[normalizeMediaExtension(extension)] ?? settings.defaultPlayerId;
}

function createDefaultSettings(): ExternalPlayerSettings {
  return {
    schemaVersion: 1,
    defaultPlayerId: "SYSTEM_DEFAULT",
    extensionOverrides: {},
    customPlayers: [],
    updatedAt: new Date().toISOString(),
  };
}

function isSettings(value: unknown): value is ExternalPlayerSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExternalPlayerSettings>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.defaultPlayerId === "string" &&
    Boolean(candidate.extensionOverrides) &&
    Array.isArray(candidate.customPlayers)
  );
}

export class PlayerSettingsStore {
  readonly settingsPath: string;
  private current = createDefaultSettings();
  private knownPlayers: ExternalPlayerOption[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataRoot: string,
    private readonly discoverPlayers: () => Promise<ExternalPlayerOption[]> = discoverKnownPlayers,
  ) {
    this.settingsPath = path.join(dataRoot, "settings", "external-players.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.settingsPath, "utf8"));
      if (!isSettings(parsed)) throw new Error("播放器設定格式不相容");
      this.current = this.sanitize(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError) && !String(error).includes("不相容")) throw error;
      this.current = createDefaultSettings();
      await this.saveNow();
    }
    this.knownPlayers = await this.discoverPlayers();
  }

  async refreshDiscovery(): Promise<ExternalPlayerSettingsSnapshot> {
    this.knownPlayers = await this.discoverPlayers();
    return this.getSnapshot();
  }

  getSnapshot(): ExternalPlayerSettingsSnapshot {
    const customOptions: ExternalPlayerOption[] = this.current.customPlayers.map((player) => ({
      id: player.id,
      label: player.name,
      kind: "CUSTOM",
      available: false,
      executablePath: player.executablePath,
      detail: "自訂執行檔",
    }));
    return {
      settings: structuredClone(this.current),
      players: [...this.knownPlayers, ...customOptions],
    };
  }

  async snapshotWithCurrentAvailability(): Promise<ExternalPlayerSettingsSnapshot> {
    const snapshot = this.getSnapshot();
    snapshot.players = await Promise.all(
      snapshot.players.map(async (player) =>
        player.kind !== "CUSTOM"
          ? player
          : {
              ...player,
              available: Boolean(player.executablePath && (await isExecutableFile(player.executablePath))),
              detail:
                player.executablePath && (await isExecutableFile(player.executablePath))
                  ? "自訂執行檔可用"
                  : "自訂執行檔已遺失或移動",
            },
      ),
    );
    return snapshot;
  }

  async update(update: ExternalPlayerSettingsUpdate): Promise<ExternalPlayerSettingsSnapshot> {
    this.assertPlayerId(update.defaultPlayerId);
    const overrides: Record<string, ExternalPlayerId> = {};
    for (const [extension, playerId] of Object.entries(update.extensionOverrides ?? {})) {
      this.assertPlayerId(playerId);
      overrides[normalizeMediaExtension(extension)] = playerId;
    }
    await this.mutate((settings) => {
      settings.defaultPlayerId = update.defaultPlayerId;
      settings.extensionOverrides = overrides;
    });
    return this.snapshotWithCurrentAvailability();
  }

  async addCustomPlayer(executablePath: string): Promise<ExternalPlayerSettingsSnapshot> {
    const resolved = path.resolve(executablePath);
    if (!(await isExecutableFile(resolved))) throw new Error("選取的檔案不是可用的 Windows .exe 執行檔。");
    const id =
      `CUSTOM:${createHash("sha256").update(resolved.toLocaleLowerCase()).digest("hex").slice(0, 16)}` as const;
    const definition: CustomPlayerDefinition = {
      id,
      name: path.basename(resolved, path.extname(resolved)),
      executablePath: resolved,
    };
    await this.mutate((settings) => {
      const existing = settings.customPlayers.findIndex((player) => player.id === id);
      if (existing >= 0) settings.customPlayers[existing] = definition;
      else settings.customPlayers.push(definition);
    });
    return this.snapshotWithCurrentAvailability();
  }

  async removeCustomPlayer(playerId: ExternalPlayerId): Promise<ExternalPlayerSettingsSnapshot> {
    if (!playerId.startsWith("CUSTOM:")) throw new Error("內建播放器選項不能移除。");
    await this.mutate((settings) => {
      settings.customPlayers = settings.customPlayers.filter((player) => player.id !== playerId);
      if (settings.defaultPlayerId === playerId) settings.defaultPlayerId = "SYSTEM_DEFAULT";
      for (const extension of Object.keys(settings.extensionOverrides)) {
        if (settings.extensionOverrides[extension] === playerId) delete settings.extensionOverrides[extension];
      }
    });
    return this.snapshotWithCurrentAvailability();
  }

  async resolve(extension: string): Promise<ExternalPlayerOption> {
    const snapshot = await this.snapshotWithCurrentAvailability();
    const id = resolvePlayerId(snapshot.settings, extension);
    return snapshot.players.find((player) => player.id === id) ?? snapshot.players[0];
  }

  private assertPlayerId(playerId: ExternalPlayerId): void {
    if (KNOWN_IDS.has(playerId)) return;
    if (playerId.startsWith("CUSTOM:") && this.current.customPlayers.some((player) => player.id === playerId)) return;
    throw new Error("播放器選項無效或已被移除。");
  }

  private sanitize(settings: ExternalPlayerSettings): ExternalPlayerSettings {
    const customPlayers = settings.customPlayers.filter(
      (item) =>
        item?.id?.startsWith("CUSTOM:") && typeof item.executablePath === "string" && typeof item.name === "string",
    );
    const valid = new Set<ExternalPlayerId>([...KNOWN_IDS, ...customPlayers.map((item) => item.id)]);
    const extensionOverrides: Record<string, ExternalPlayerId> = {};
    for (const [extension, playerId] of Object.entries(settings.extensionOverrides)) {
      try {
        if (valid.has(playerId)) extensionOverrides[normalizeMediaExtension(extension)] = playerId;
      } catch {
        /* discard invalid persisted extension */
      }
    }
    return {
      schemaVersion: 1,
      defaultPlayerId: valid.has(settings.defaultPlayerId) ? settings.defaultPlayerId : "SYSTEM_DEFAULT",
      extensionOverrides,
      customPlayers,
      updatedAt: typeof settings.updatedAt === "string" ? settings.updatedAt : new Date().toISOString(),
    };
  }

  private async mutate(mutator: (settings: ExternalPlayerSettings) => void): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const next = structuredClone(this.current);
      mutator(next);
      next.updatedAt = new Date().toISOString();
      this.current = next;
      await this.saveNow();
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async saveNow(): Promise<void> {
    const temporary = `${this.settingsPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.current, null, 2)}\n`, "utf8");
    await rename(temporary, this.settingsPath);
  }
}
