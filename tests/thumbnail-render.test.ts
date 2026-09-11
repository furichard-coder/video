import { describe, expect, it } from "vitest";
import { renderThumbnail } from "../src/main/services/thumbnail-render";

describe("thumbnail safety boundary", () => {
  it("rejects non-absolute source paths before invoking ffmpeg", async () => {
    await expect(
      renderThumbnail(
        {
          id: "a",
          kind: "VIDEO",
          fileName: "a.mp4",
          sourcePath: "relative.mp4",
          sizeBytes: 1,
          modifiedAt: "",
          addedAt: "",
          sourcePolicy: "READ_ONLY",
          metadataState: "READY",
          previewState: "READY",
          previewRange: { inMs: 0, outMs: 1000 },
        } as never,
        {
          id: "t",
          assetId: "a",
          sourceTimeMs: 0,
          sourceFileName: "a.mp4",
          reason: "test",
          layout: "LEFT_TEXT",
          colorNote: "",
          style: {
            text: "",
            textXPercent: 50,
            textYPercent: 50,
            fontSizePx: 40,
            textColor: "#fff",
            outlineWidthPx: 1,
            overlayOpacityPercent: 0,
          },
        },
        "C:\\tmp\\thumb.jpg",
        "jpg",
        "definitely-not-a-real-ffmpeg",
      ),
    ).rejects.toThrow(/來源路徑無效/);
  });
});
