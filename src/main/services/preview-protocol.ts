import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol } from "electron";
import type { PreviewVariant } from "../../shared/domain";
import { PreviewCache } from "./preview-cache";
import { ProjectStore } from "./project-store";
import path from "node:path";
import type { SubtitlePreviewService } from "./subtitle-preview";
import type { OutputHistoryStore } from "./output-history";

const VARIANTS: Record<string, PreviewVariant> = {
  thumbnail: "THUMBNAIL",
  image_preview: "IMAGE_PREVIEW",
  video_proxy: "VIDEO_PROXY",
  video_clip_proxy: "VIDEO_CLIP_PROXY",
};

function mimeType(variant: PreviewVariant): string {
  return variant === "VIDEO_PROXY" || variant === "VIDEO_CLIP_PROXY" ? "video/mp4" : "image/jpeg";
}

function parseRange(range: string | null, size: number): { start: number; end: number } | undefined {
  if (!range) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return undefined;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

function streamBody(filePath: string, start?: number, end?: number): BodyInit {
  return Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as BodyInit;
}

function sourceMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4": case ".m4v": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    case ".mpeg": case ".mpg": return "video/mpeg";
    case ".wmv": return "video/x-ms-wmv";
    case ".avi": return "video/x-msvideo";
    default: return "application/octet-stream";
  }
}

export function registerPreviewProtocol(cache: PreviewCache, store: ProjectStore, photoSoundPath?: string, subtitlePreviews?: SubtitlePreviewService, outputHistory?: OutputHistoryStore): void {
  protocol.handle("preview-media", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === "output" && outputHistory) {
        const jobId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
        const output = await outputHistory.get(jobId);
        const fileStat = await stat(output.outputPath);
        const range = parseRange(request.headers.get("range"), fileStat.size);
        const baseHeaders = { "Accept-Ranges": "bytes", "Content-Type": "video/mp4", "Cache-Control": "private, no-store" };
        if (range) return new Response(streamBody(output.outputPath, range.start, range.end), { status: 206, headers: { ...baseHeaders, "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`, "Content-Length": String(range.end - range.start + 1) } });
        return new Response(streamBody(output.outputPath), { headers: { ...baseHeaders, "Content-Length": String(fileStat.size) } });
      }
      if (url.hostname === "publish-thumbnail") {
        const candidateId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
        const candidate = store.getProject().aiPublishAssets?.thumbnails.find((item) => item.id === candidateId);
        const filePath = candidate?.outputPath;
        const extension = filePath ? path.extname(filePath).toLowerCase() : "";
        if (!filePath || ![".jpg", ".jpeg", ".png"].includes(extension)) return new Response("Not found", { status: 404 });
        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || fileStat.size <= 0) return new Response("Not found", { status: 404 });
        return new Response(streamBody(filePath), { headers: { "Content-Length": String(fileStat.size), "Content-Type": extension === ".png" ? "image/png" : "image/jpeg", "Cache-Control": "private, no-store" } });
      }
      if (url.hostname === "asset" && url.pathname === "/dunes-shutter.mp3" && photoSoundPath) {
        const fileStat = await stat(photoSoundPath);
        const range = parseRange(request.headers.get("range"), fileStat.size);
        if (range) return new Response(streamBody(photoSoundPath, range.start, range.end), { status: 206, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`, "Content-Length": String(range.end - range.start + 1), "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
        return new Response(streamBody(photoSoundPath), { headers: { "Accept-Ranges": "bytes", "Content-Length": String(fileStat.size), "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      if (url.hostname === "subtitle" && subtitlePreviews) {
        const cacheKey = url.pathname.split("/").filter(Boolean)[0];
        const filePath = await subtitlePreviews.resolveExisting(cacheKey ?? "");
        const fileStat = await stat(filePath);
        const range = parseRange(request.headers.get("range"), fileStat.size);
        if (range) return new Response(streamBody(filePath, range.start, range.end), { status: 206, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`, "Content-Length": String(range.end - range.start + 1), "Content-Type": "video/mp4", "Cache-Control": "private, max-age=31536000, immutable" } });
        return new Response(streamBody(filePath), { headers: { "Accept-Ranges": "bytes", "Content-Length": String(fileStat.size), "Content-Type": "video/mp4", "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const assetId = parts[0];
      const variant = VARIANTS[parts[1]];
      if (url.hostname !== "cache" || !assetId || !variant) {
        return new Response("Not found", { status: 404 });
      }

      const clipKey = parts[2];
      const filePath = variant === "VIDEO_CLIP_PROXY"
        ? await cache.resolveClipExisting(assetId, clipKey ?? "")
        : await cache.resolveExisting(assetId, variant);
      const fileStat = await stat(filePath);
      const range = variant === "VIDEO_PROXY" || variant === "VIDEO_CLIP_PROXY" ? parseRange(request.headers.get("range"), fileStat.size) : undefined;
      if (range) {
        return new Response(streamBody(filePath, range.start, range.end), {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
            "Content-Length": String(range.end - range.start + 1),
            "Content-Type": mimeType(variant),
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      }

      return new Response(streamBody(filePath), {
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(fileStat.size),
          "Content-Type": mimeType(variant),
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "Preview unavailable", { status: 404 });
    }
  });

  protocol.handle("source-media", async (request) => {
    try {
      const url = new URL(request.url);
      const assetId = url.pathname.split("/").filter(Boolean)[0];
      if (url.hostname !== "asset" || !assetId || !/^[a-f0-9]{64}$/i.test(assetId)) return new Response("Not found", { status: 404 });
      const asset = store.getAsset(assetId);
      if (!asset || asset.kind !== "VIDEO" || asset.sourcePolicy !== "READ_ONLY") return new Response("Not found", { status: 404 });
      const fileStat = await stat(asset.sourcePath);
      if (!fileStat.isFile()) return new Response("Source unavailable", { status: 404 });
      const range = parseRange(request.headers.get("range"), fileStat.size);
      const baseHeaders = { "Accept-Ranges": "bytes", "Content-Type": sourceMimeType(asset.sourcePath), "Cache-Control": "private, no-store" };
      if (range) {
        return new Response(streamBody(asset.sourcePath, range.start, range.end), {
          status: 206,
          headers: { ...baseHeaders, "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`, "Content-Length": String(range.end - range.start + 1) },
        });
      }
      return new Response(streamBody(asset.sourcePath), { headers: { ...baseHeaders, "Content-Length": String(fileStat.size) } });
    } catch {
      return new Response("Source unavailable", { status: 404 });
    }
  });
}
