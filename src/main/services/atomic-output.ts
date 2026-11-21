import { randomUUID } from "node:crypto";
import { copyFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function finalizePartialOutput(partialPath: string, outputPath: string): Promise<void> {
  const parsed = path.parse(outputPath);
  const backupPath = path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.replaced${parsed.ext}`);
  const crossVolumePartial = path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.cross-volume.partial${parsed.ext}`);
  let movedExisting = false;
  try {
    try {
      await rename(outputPath, backupPath);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(partialPath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // Publish through a destination-volume partial so Final Output remains
      // atomic even when its audio mux temporary was scheduled elsewhere.
      await copyFile(partialPath, crossVolumePartial);
      await rename(crossVolumePartial, outputPath);
      await rm(partialPath, { force: true });
    }
    if (movedExisting) await rm(backupPath, { force: true });
  } catch (error) {
    await rm(crossVolumePartial, { force: true });
    if (movedExisting) {
      await rm(outputPath, { force: true });
      await rename(backupPath, outputPath);
    }
    throw error;
  }
}
