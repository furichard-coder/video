import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DUNES_SHUTTER_EFFECT_SHA256 } from "../../shared/domain";

export const DUNES_SHUTTER_FILENAME = "camera-shutter-click-14671.mp3";
export const DUNES_SHUTTER_LEGACY_PATH = "C:\\草漯沙丘地質公園 YT長片\\camera shutter sound\\freesound_community-camera-shutter-click-14671.mp3";

async function isVerifiedShutterFile(filePath: string): Promise<boolean> {
  try {
    if (!(await stat(filePath)).isFile()) return false;
    const bytes = await readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex").toUpperCase() === DUNES_SHUTTER_EFFECT_SHA256;
  } catch {
    return false;
  }
}

export async function resolveDunesShutterSoundPath(resourcesPath: string): Promise<string | undefined> {
  const candidates = [
    path.join(resourcesPath, "assets", DUNES_SHUTTER_FILENAME),
    DUNES_SHUTTER_LEGACY_PATH,
  ];
  for (const candidate of candidates) if (await isVerifiedShutterFile(candidate)) return candidate;
  return undefined;
}
