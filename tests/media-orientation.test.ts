import { describe, expect, it } from "vitest";
import {
  normalizeDisplayRotation,
  orientationNormalizationFilter,
  resolveMediaOrientation,
} from "../src/shared/media-orientation";

describe("canonical media orientation", () => {
  it.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [270, 270],
    [-90, 270],
    [-180, 180],
    [-270, 90],
    [360, 0],
  ] as const)("normalizes Display Matrix rotation %s to %s", (input, expected) => {
    expect(normalizeDisplayRotation(input)).toBe(expected);
  });

  it("derives visual portrait dimensions from coded landscape plus -90 matrix", () => {
    expect(resolveMediaOrientation({ width: 3840, height: 2160, rotationDegrees: -90 })).toEqual({
      codedWidth: 3840,
      codedHeight: 2160,
      rotationDegrees: 270,
      displayWidth: 2160,
      displayHeight: 3840,
      isPortrait: true,
      ffmpegFilter: "transpose=clock",
    });
  });

  it("does not rotate physical portrait pixels without rotation metadata", () => {
    expect(resolveMediaOrientation({ width: 1080, height: 1920, rotationDegrees: 0 })).toMatchObject({
      rotationDegrees: 0,
      displayWidth: 1080,
      displayHeight: 1920,
      isPortrait: true,
      ffmpegFilter: undefined,
    });
  });

  it.each([
    [0, undefined],
    [90, "transpose=cclock"],
    [180, "hflip,vflip"],
    [270, "transpose=clock"],
  ] as const)("maps %s degree metadata to one explicit physical correction", (rotation, expected) => {
    expect(orientationNormalizationFilter(rotation)).toBe(expected);
  });
});
