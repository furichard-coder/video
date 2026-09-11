import { describe, expect, it } from "vitest";
import { buildRenderEstimate, MINIMUM_RENDER_RESERVE_BYTES } from "../src/main/services/render-estimate";

describe("render preflight estimate", () => {
  it("estimates output size/time and preserves a 1 GB reserve", () => {
    const estimate = buildRenderEstimate("C:\\Output\\preview.mp4", 20 * 1024 ** 3, 60_000, "4K", "H265_QSV");
    expect(estimate).toMatchObject({
      driveRoot: "C:\\",
      canRender: true,
      minimumReserveBytes: MINIMUM_RENDER_RESERVE_BYTES,
    });
    expect(estimate.estimatedOutputBytes).toBeGreaterThan(100_000_000);
    expect(estimate.estimatedRenderTimeMs).toBeGreaterThan(60_000);
  });

  it("blocks when the estimated file would leave less than 1 GB", () => {
    const estimate = buildRenderEstimate(
      "C:\\Output\\preview.mp4",
      MINIMUM_RENDER_RESERVE_BYTES + 5_000_000,
      60_000,
      "720P",
      "H265_QSV",
    );
    expect(estimate.canRender).toBe(false);
    expect(estimate.warning).toMatch(/低於 1 GB.*不會開始轉檔/);
  });
});
