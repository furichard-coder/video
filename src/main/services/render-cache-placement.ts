import path from "node:path";
import type { RenderTempLocationConfig } from "../../shared/domain";
import { probeRenderTempLocations, selectRenderTempForNextJob } from "./render-temp-scheduler";

type CacheKind = "previews" | "audio-preview" | "subtitle-preview";
type Selection = "AUTO" | "PRIMARY" | "FALLBACK";

/**
 * Only newly generated, rebuildable cache files are scheduled. Existing cache
 * files remain at their original paths and are never mirrored or relocated.
 */
export class RenderCachePlacement {
  constructor(
    private readonly getLocations: () => readonly RenderTempLocationConfig[],
    private readonly getSelection: () => Selection,
  ) {}

  readRoots(kind: CacheKind): string[] {
    return this.getLocations().map((item) => path.join(path.resolve(item.path), "SceneryWalkerCache", kind));
  }

  async chooseWriteRoot(kind: CacheKind, expectedBytes: number): Promise<string> {
    const selection = this.getSelection();
    const locations = this.getLocations();
    const candidates = selection === "PRIMARY"
      ? locations.filter((item) => item.role === "PRIMARY")
      : selection === "FALLBACK"
        ? locations.filter((item) => item.role === "FALLBACK")
        : [...locations.filter((item) => item.role === "PRIMARY"), ...locations.filter((item) => item.role === "FALLBACK")];
    for (const candidate of candidates) {
      if (selection === "AUTO" && candidate.role === "FALLBACK" && candidate.allowFallback === false) continue;
      const [status] = await probeRenderTempLocations([candidate]);
      if (!status) continue;
      const chosen = selectRenderTempForNextJob([{
        config: status,
        freeBytes: status.freeBytes,
        capacityBytes: status.capacityBytes,
        committedBytes: status.committedBytes,
        writable: status.unavailableReason !== "UNWRITABLE",
      }], expectedBytes, selection);
      if (chosen) return path.join(chosen.path, "SceneryWalkerCache", kind);
    }
    throw new Error("主要與備援 TEMP 目前都不足以建立新的預覽快取；請清理空間或調整 TEMP 位置。");
  }
}
