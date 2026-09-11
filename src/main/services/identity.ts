import { createHash } from "node:crypto";
import path from "node:path";
import { PREVIEWER_VERSION } from "../../shared/domain";

export function normalizedPathIdentity(sourcePath: string): string {
  const normalized = path.resolve(sourcePath).replaceAll("/", "\\").toLocaleLowerCase("en-US");
  return createHash("sha256").update(normalized).digest("hex");
}

export function previewCacheKey(input: {
  assetId: string;
  sourcePath: string;
  sizeBytes: number;
  modifiedAt: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        assetId: input.assetId,
        sourcePath: path.resolve(input.sourcePath).toLocaleLowerCase("en-US"),
        sizeBytes: input.sizeBytes,
        modifiedAt: input.modifiedAt,
        previewerVersion: PREVIEWER_VERSION,
      }),
    )
    .digest("hex");
}
