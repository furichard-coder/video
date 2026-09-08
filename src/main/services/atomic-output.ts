import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";

export async function finalizePartialOutput(partialPath: string, outputPath: string): Promise<void> {
  const parsed = path.parse(outputPath);
  const backupPath = path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.replaced${parsed.ext}`);
  let movedExisting = false;
  try {
    try { await rename(outputPath, backupPath); movedExisting = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(partialPath, outputPath);
    if (movedExisting) await rm(backupPath, { force: true });
  } catch (error) {
    if (movedExisting) {
      await rm(outputPath, { force: true });
      await rename(backupPath, outputPath);
    }
    throw error;
  }
}
