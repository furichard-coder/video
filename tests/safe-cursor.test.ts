import { describe, expect, it } from "vitest";
import { safeActionCenter } from "../src/main/services/safe-cursor";

describe("safe confirmation cursor positioning", () => {
  it("returns the center of an in-window safe action in screen DIP coordinates", () => {
    expect(
      safeActionCenter(
        { x: 100, y: 50, width: 1200, height: 800 },
        { width: 1200, height: 800 },
        { x: 440, y: 330, width: 160, height: 48 },
      ),
    ).toEqual({ x: 620, y: 404 });
  });

  it("rejects zero-sized, non-finite, or out-of-renderer rectangles", () => {
    const bounds = { x: 0, y: 0, width: 1200, height: 800 };
    const renderer = { width: 1200, height: 800 };
    expect(safeActionCenter(bounds, renderer, { x: 10, y: 10, width: 0, height: 20 })).toBeUndefined();
    expect(safeActionCenter(bounds, renderer, { x: -1, y: 10, width: 20, height: 20 })).toBeUndefined();
    expect(safeActionCenter(bounds, renderer, { x: 1190, y: 10, width: 20, height: 20 })).toBeUndefined();
    expect(safeActionCenter(bounds, renderer, { x: Number.NaN, y: 10, width: 20, height: 20 })).toBeUndefined();
  });
});
