import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ExternalMediaTarget, ExternalOpenResult, ExternalPlayerOption } from "../../shared/domain";
import { PreviewCache } from "./preview-cache";
import { ProjectStore } from "./project-store";
import { SourceService } from "./source-service";
import { PlayerSettingsStore } from "./player-settings";

export type DefaultPathOpener = (targetPath: string) => Promise<string>;
export type ExecutableStarter = (executablePath: string, args: string[]) => Promise<void>;

export function startExternalExecutable(executablePath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { shell: false, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function launchArguments(player: ExternalPlayerOption, targetPath: string): string[] {
  return player.id === "WINDOWS_MEDIA_PLAYER" ? ["/open", targetPath] : [targetPath];
}

async function assertFile(targetPath: string, label: string): Promise<void> {
  try {
    if (!(await stat(targetPath)).isFile()) throw new Error();
  } catch {
    throw new Error(`${label}不存在或目前無法讀取。`);
  }
}

export class ExternalPlayerService {
  constructor(
    private readonly store: ProjectStore,
    private readonly sources: SourceService,
    private readonly previews: PreviewCache,
    private readonly settings: PlayerSettingsStore,
    private readonly openDefault: DefaultPathOpener,
    private readonly startExecutable: ExecutableStarter = startExternalExecutable,
  ) {}

  async open(assetId: string, target: ExternalMediaTarget): Promise<ExternalOpenResult> {
    if (target !== "PROXY" && target !== "ORIGINAL") throw new Error("外部播放目標無效。");
    const listedAsset = this.store.getAsset(assetId);
    if (!listedAsset) throw new Error("找不到來源項目。");
    if (listedAsset.kind !== "VIDEO") throw new Error("外部播放器功能目前只開放影片來源。");

    let targetPath: string;
    if (target === "PROXY") {
      await this.previews.ensure(assetId, "VIDEO_PROXY");
      targetPath = await this.previews.resolveExisting(assetId, "VIDEO_PROXY");
    } else {
      targetPath = (await this.sources.refreshAsset(assetId)).sourcePath;
    }
    await assertFile(targetPath, target === "PROXY" ? "App 預覽 proxy" : "來源檔");

    return this.openResolvedPath(targetPath, listedAsset.extension, target);
  }

  async openFile(targetPath: string): Promise<ExternalOpenResult> {
    await assertFile(targetPath, "完成的預覽影片");
    return this.openResolvedPath(targetPath, pathExtension(targetPath), "ORIGINAL");
  }

  private async openResolvedPath(
    targetPath: string,
    extension: string,
    target: ExternalMediaTarget,
  ): Promise<ExternalOpenResult> {
    const player = await this.settings.resolve(extension);
    if (player.id === "SYSTEM_DEFAULT") return this.openWithSystemDefault(targetPath, target, player.label);
    if (!player.available || !player.executablePath) {
      return this.openWithSystemDefault(targetPath, target, player.label, `${player.label} 的執行檔已遺失或未安裝。`);
    }
    try {
      await assertFile(player.executablePath, "播放器執行檔");
      await this.startExecutable(player.executablePath, launchArguments(player, targetPath));
      return { status: "OPENED", target, playerLabel: player.label };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.openWithSystemDefault(targetPath, target, player.label, `${player.label} 啟動失敗：${reason}`);
    }
  }

  private async openWithSystemDefault(
    targetPath: string,
    target: ExternalMediaTarget,
    requestedLabel: string,
    fallbackReason?: string,
  ): Promise<ExternalOpenResult> {
    try {
      const errorMessage = await this.openDefault(targetPath);
      if (errorMessage) throw new Error(errorMessage);
      return {
        status: fallbackReason ? "FALLBACK_SYSTEM_DEFAULT" : "OPENED",
        target,
        playerLabel: "Windows 系統預設播放器",
        message: fallbackReason ? `${fallbackReason} 已改用 Windows 系統預設播放器。` : undefined,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: "USE_INTERNAL",
        target,
        playerLabel: requestedLabel,
        message: `${fallbackReason ? `${fallbackReason} ` : ""}Windows 系統預設播放器也無法啟動（${reason}）。請使用 App 內建 proxy 播放。`,
      };
    }
  }
}

function pathExtension(targetPath: string): string {
  const match = /\.[a-z0-9]{1,12}$/i.exec(targetPath);
  if (!match) throw new Error("完成檔沒有可辨識的副檔名。");
  return match[0];
}
