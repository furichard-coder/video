import { describe, expect, it } from "vitest";
import { outputCanvasProfile, usesBlurredCanvas } from "../src/shared/output-canvas";

describe("shared output canvas policy", () => {
  it("uses the render canvas aspect in preview", () => {
    expect(outputCanvasProfile("LANDSCAPE_16_9")).toMatchObject({
      width: 1920,
      height: 1080,
      cssAspectRatio: "16 / 9",
    });
    expect(outputCanvasProfile("PORTRAIT_9_16")).toMatchObject({ width: 1080, height: 1920, cssAspectRatio: "9 / 16" });
    expect(outputCanvasProfile("LANDSCAPE_16_9", "1440P")).toMatchObject({ width: 2560, height: 1440 });
    expect(outputCanvasProfile("PORTRAIT_9_16", "1440P")).toMatchObject({ width: 1440, height: 2560 });
  });

  it("matches the FFmpeg blurred-fill decision", () => {
    expect(usesBlurredCanvas(true, "LANDSCAPE_16_9")).toBe(true);
    expect(usesBlurredCanvas(false, "LANDSCAPE_16_9")).toBe(false);
    expect(usesBlurredCanvas(false, "PORTRAIT_9_16")).toBe(true);
  });
});
