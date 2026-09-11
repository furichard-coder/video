import type { SortMode, SourceAsset } from "./domain";

const naturalCollator = new Intl.Collator("zh-Hant", {
  numeric: true,
  sensitivity: "base",
});

function timestamp(asset: SourceAsset): number {
  const values = [asset.mediaInfo?.captureTime, asset.fileCreatedAt, asset.fileModifiedAt];

  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Number.MAX_SAFE_INTEGER;
}

function byName(a: SourceAsset, b: SourceAsset): number {
  return naturalCollator.compare(a.fileName, b.fileName);
}

function byAddedOrder(a: SourceAsset, b: SourceAsset): number {
  return a.addedOrder - b.addedOrder;
}

export function sortAssets(assets: SourceAsset[], mode: SortMode, timelineOrder: string[] = []): SourceAsset[] {
  return [...assets].sort((a, b) => {
    if (mode === "MANUAL_ORDER") {
      const left = timelineOrder.indexOf(a.id);
      const right = timelineOrder.indexOf(b.id);
      return (
        (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right) ||
        byAddedOrder(a, b)
      );
    }
    if (mode === "FILE_NAME") {
      return byName(a, b) || byAddedOrder(a, b);
    }

    if (mode === "ADDED_ORDER") {
      return byAddedOrder(a, b);
    }

    const timeComparison = timestamp(a) - timestamp(b);
    if (mode === "CAPTURE_OR_FILE_TIME") {
      return timeComparison || byName(a, b) || byAddedOrder(a, b);
    }

    return timeComparison || byName(a, b) || byAddedOrder(a, b);
  });
}
