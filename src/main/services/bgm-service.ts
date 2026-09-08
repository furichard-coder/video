import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BGM_VOLUME_PERCENT, type BgmImportResult, type BgmTrack } from "../../shared/domain";
import { MediaProbe } from "./media-probe";
import { ProjectStore } from "./project-store";

export class BgmService {
  constructor(private readonly store: ProjectStore, private readonly probe: MediaProbe) {}

  async importSelected(paths: string[], signal?: AbortSignal): Promise<BgmImportResult> {
    const tracks: BgmTrack[] = [];
    const errors: string[] = [];
    let timelineCursor = this.store.getProject().bgmTracks.reduce((max, track) => Math.max(max, track.timelineOutMs), 0);
    for (const selected of paths) {
      if (signal?.aborted) throw new DOMException("配樂匯入已取消。", "AbortError");
      try {
        const sourcePath = await realpath(selected);
        if (path.extname(sourcePath).toLowerCase() !== ".mp3") throw new Error("本版配樂匯入只支援 MP3。");
        const sourceStat = await stat(sourcePath);
        if (!sourceStat.isFile()) throw new Error("選取項目不是檔案。");
        const info = await this.probe.probe(sourcePath, signal);
        if (!info.durationMs || !info.audioCodec) throw new Error("無法取得有效音訊或時長。");
        tracks.push({
          id: randomUUID(), sourcePath, fileName: path.basename(sourcePath), sizeBytes: sourceStat.size, durationMs: info.durationMs,
          sourceInMs: 0, sourceOutMs: info.durationMs, timelineInMs: timelineCursor, timelineOutMs: timelineCursor + info.durationMs,
          fadeInMs: Math.min(1000, Math.floor(info.durationMs / 4)), fadeOutMs: Math.min(1000, Math.floor(info.durationMs / 4)),
          volumePercent: DEFAULT_BGM_VOLUME_PERCENT, sourcePolicy: "READ_ONLY", addedAt: new Date().toISOString(), sourceKind: "LOCAL_FILE", resolutionStatus: "READY",
        });
        timelineCursor += info.durationMs;
      } catch (error) {
        errors.push(`${path.basename(selected)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const project = tracks.length ? await this.store.addBgmTracks(tracks) : this.store.getProject();
    return { cancelled: false, addedCount: tracks.length, errors, project };
  }

  async addYoutubeReferences(urls: string[]): Promise<BgmImportResult> {
    const tracks: BgmTrack[] = [];
    const errors: string[] = [];
    const existing = new Set(this.store.getProject().bgmTracks.map((track) => track.sourceUrl).filter(Boolean));
    for (const raw of urls) {
      const candidate = raw.trim();
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        if (url.protocol !== "https:" || !["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) throw new Error("只接受 HTTPS YouTube／youtu.be 連結。");
        const pathParts = url.pathname.split("/").filter(Boolean);
        const videoId = host === "youtu.be" ? pathParts[0] : url.searchParams.get("v") ?? (["shorts", "embed", "live"].includes(pathParts[0] ?? "") ? pathParts[1] : undefined);
        if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("找不到有效的 YouTube 影片 ID。");
        const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
        if (existing.has(normalizedUrl)) throw new Error("此連結已在配樂清單中。");
        existing.add(normalizedUrl);
        tracks.push({
          id: randomUUID(), sourcePath: "", fileName: `YouTube 參考 · ${videoId}`, sizeBytes: 0, durationMs: 0,
          sourceInMs: 0, sourceOutMs: 0, timelineInMs: 0, timelineOutMs: 0, fadeInMs: 0, fadeOutMs: 0,
          volumePercent: DEFAULT_BGM_VOLUME_PERCENT, sourcePolicy: "READ_ONLY", addedAt: new Date().toISOString(),
          sourceKind: "YOUTUBE_REFERENCE", resolutionStatus: "NEEDS_LOCAL_FILE", sourceUrl: normalizedUrl, rightsConfirmed: false,
        });
      } catch (error) { errors.push(`${candidate.slice(0, 120)}：${error instanceof Error ? error.message : String(error)}`); }
    }
    const project = tracks.length ? await this.store.addBgmTracks(tracks) : this.store.getProject();
    return { cancelled: false, addedCount: tracks.length, errors, project };
  }

  async resolveReference(trackId: string, selected: string, rightsConfirmed: boolean, signal?: AbortSignal): Promise<BgmImportResult> {
    if (!rightsConfirmed) throw new Error("請先確認此音檔是您自有、已取得授權，或由 YouTube Audio Library 正式下載。");
    const current = this.store.getProject().bgmTracks.find((track) => track.id === trackId);
    if (!current || current.resolutionStatus !== "NEEDS_LOCAL_FILE") throw new Error("找不到待補音檔的 YouTube 配樂參考。");
    const imported = await this.inspectLocalTrack(selected, current.id, current.sourceUrl, signal);
    const project = await this.store.resolveBgmTrack(trackId, imported);
    return { cancelled: false, addedCount: 1, errors: [], project };
  }

  private async inspectLocalTrack(selected: string, id: string, sourceUrl?: string, signal?: AbortSignal): Promise<BgmTrack> {
    if (signal?.aborted) throw new DOMException("配樂匯入已取消。", "AbortError");
    const sourcePath = await realpath(selected);
    if (path.extname(sourcePath).toLowerCase() !== ".mp3") throw new Error("本版配樂匯入只支援 MP3。");
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error("選取項目不是檔案。");
    const info = await this.probe.probe(sourcePath, signal);
    if (!info.durationMs || !info.audioCodec) throw new Error("無法取得有效音訊或時長。");
    return {
      id, sourcePath, fileName: path.basename(sourcePath), sizeBytes: sourceStat.size, durationMs: info.durationMs,
      sourceInMs: 0, sourceOutMs: info.durationMs, timelineInMs: 0, timelineOutMs: info.durationMs,
      fadeInMs: Math.min(1000, Math.floor(info.durationMs / 4)), fadeOutMs: Math.min(1000, Math.floor(info.durationMs / 4)),
      volumePercent: DEFAULT_BGM_VOLUME_PERCENT, sourcePolicy: "READ_ONLY", addedAt: currentTimestamp(), sourceKind: "LOCAL_FILE", resolutionStatus: "READY", sourceUrl, rightsConfirmed: true,
    };
  }
}

function currentTimestamp(): string { return new Date().toISOString(); }
