import { describe, expect, it } from "vitest";
import type { SourceAsset } from "../src/shared/domain";
import { sortAssets } from "../src/shared/sorting";

function asset(overrides: Partial<SourceAsset> & Pick<SourceAsset, "fileName" | "addedOrder">): SourceAsset {
  return {
    id: String(overrides.addedOrder).padStart(64, "a"),
    sourcePath: `C:\\source\\${overrides.fileName}`,
    sourceIdentity: String(overrides.addedOrder).padStart(64, "b"),
    extension: ".mp4",
    kind: "VIDEO",
    sizeBytes: 100,
    fileCreatedAt: "2026-01-01T00:00:00.000Z",
    fileModifiedAt: "2026-01-01T00:00:00.000Z",
    addedAt: "2026-01-01T00:00:00.000Z",
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewCacheKey: "c".repeat(64),
    metadataState: "READY",
    ...overrides,
  };
}

describe("sortAssets", () => {
  const assets = [
    asset({ fileName: "clip10.mp4", addedOrder: 0, mediaInfo: { captureTime: "2026-01-03T00:00:00Z" } }),
    asset({ fileName: "clip2.mp4", addedOrder: 2, mediaInfo: { captureTime: "2026-01-01T00:00:00Z" } }),
    asset({ fileName: "clip1.mp4", addedOrder: 1, mediaInfo: { captureTime: "2026-01-02T00:00:00Z" } }),
  ];

  it("uses natural numeric filename order", () => {
    expect(sortAssets(assets, "FILE_NAME").map((item) => item.fileName)).toEqual([
      "clip1.mp4",
      "clip2.mp4",
      "clip10.mp4",
    ]);
  });

  it("uses capture/file time for smart sequence", () => {
    expect(sortAssets(assets, "SMART_SEQUENCE").map((item) => item.fileName)).toEqual([
      "clip2.mp4",
      "clip1.mp4",
      "clip10.mp4",
    ]);
  });

  it("preserves explicit added order", () => {
    expect(sortAssets(assets, "ADDED_ORDER").map((item) => item.addedOrder)).toEqual([0, 1, 2]);
  });
});
