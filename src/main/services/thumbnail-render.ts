import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { SourceAsset, ThumbnailCandidate } from "../../shared/domain";
import { finalizePartialOutput } from "./atomic-output";

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
function fontPath(): string {
  return path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "msjh.ttc");
}

export async function renderThumbnail(
  asset: SourceAsset,
  candidate: ThumbnailCandidate,
  outputPath: string,
  format: "jpg" | "png",
  ffmpegExecutable = process.env.FFMPEG_PATH || "ffmpeg",
): Promise<{ sizeBytes: number; width: 1280; height: 720 }> {
  if (!asset.sourcePath || !path.isAbsolute(asset.sourcePath)) throw new Error("縮圖來源路徑無效。");
  const extension = path.extname(outputPath).toLowerCase();
  if ((format === "jpg" && extension !== ".jpg" && extension !== ".jpeg") || (format === "png" && extension !== ".png"))
    throw new Error("縮圖輸出副檔名與格式不一致。");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const partial = `${outputPath}.${process.pid}.partial${extension}`;
  const textPath = `${partial}.txt`;
  await rm(partial, { force: true });
  await writeFile(textPath, candidate.style.text.slice(0, 80), "utf8");
  const scalePad = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black";
  const overlay =
    candidate.style.overlayOpacityPercent > 0
      ? `,drawbox=x=0:y=0:w=iw:h=ih:color=black@${Math.max(0, Math.min(100, candidate.style.overlayOpacityPercent)) / 100}:t=fill`
      : "";
  const text = candidate.style.text.trim()
    ? `,drawtext=fontfile='${escapeFilterPath(fontPath())}':textfile='${escapeFilterPath(textPath)}':fontcolor=${candidate.style.textColor}:fontsize=${Math.max(18, Math.min(180, Math.round(candidate.style.fontSizePx)))}:borderw=${Math.max(0, Math.min(12, Math.round(candidate.style.outlineWidthPx)))}:bordercolor=black:x=w*${Math.max(0, Math.min(100, candidate.style.textXPercent)) / 100}-text_w/2:y=h*${Math.max(0, Math.min(100, candidate.style.textYPercent)) / 100}-text_h/2`
    : "";
  const args = [
    "-y",
    ...(asset.kind === "VIDEO" ? ["-ss", String(Math.max(0, candidate.sourceTimeMs / 1000))] : []),
    "-i",
    asset.sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `${scalePad}${overlay}${text}`,
    "-an",
    ...(format === "jpg" ? ["-q:v", "2", "-f", "image2"] : ["-f", "image2"]),
    partial,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegExecutable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`縮圖產出失敗：${stderr.trim().slice(-400)}`)),
    );
  });
  try {
    const file = await stat(partial);
    if (!file.isFile() || file.size < 128) throw new Error("縮圖檔案無效。");
    if (file.size > 2 * 1024 * 1024) throw new Error("縮圖超過 YouTube 2 MB 上限，請改用 JPG 或降低畫面複雜度後重試。");
    await finalizePartialOutput(partial, outputPath);
    return { sizeBytes: file.size, width: 1280, height: 720 };
  } finally {
    await rm(partial, { force: true });
    await rm(textPath, { force: true });
  }
}
