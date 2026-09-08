import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeHexId, assertWithinRoot } from "../src/main/services/path-safety";

describe("path safety", () => {
  it("accepts a cache descendant", () => {
    const root = path.resolve("C:\\app-cache");
    expect(assertWithinRoot(root, path.join(root, "abc", "thumb.jpg"))).toBe(
      path.join(root, "abc", "thumb.jpg"),
    );
  });

  it("rejects traversal outside cache", () => {
    const root = path.resolve("C:\\app-cache");
    expect(() => assertWithinRoot(root, path.resolve(root, "..", "source.mp4"))).toThrow(/安全範圍/);
  });

  it("only accepts sha256-shaped identifiers", () => {
    expect(assertSafeHexId("a".repeat(64))).toBe("a".repeat(64));
    expect(() => assertSafeHexId("../../source")).toThrow(/格式無效/);
  });
});

