import { describe, expect, it } from "vitest";
import { filenameDisplayPriority } from "../src/renderer/filename-display";

describe("filename display priority", () => {
  it("prioritizes the trailing time or sequence when neighboring prefixes and dates match", () => {
    expect(
      filenameDisplayPriority("VID_20260718_105000_002.MOV", [
        "VID_20260718_104425_001.MOV",
        "VID_20260718_105329_003.MOV",
      ]),
    ).toBe("END");
    expect(filenameDisplayPriority("DSC_0002.JPG", ["DSC_0001.JPG", "DSC_0003.JPG"])).toBe("END");
  });

  it("keeps the beginning visible when English prefixes, years, or dates differ", () => {
    expect(
      filenameDisplayPriority("VID_20260718_105000.MOV", ["DJI_20260718_104425.MOV", "VID_20260718_105329.MOV"]),
    ).toBe("START");
    expect(
      filenameDisplayPriority("VID_20260718_105000.MOV", ["VID_20260717_104425.MOV", "VID_20260718_105329.MOV"]),
    ).toBe("START");
    expect(filenameDisplayPriority("VID_20260718_105000.MOV", ["VID_2025_104425.MOV", "VID_20260718_105329.MOV"])).toBe(
      "START",
    );
  });

  it("uses the only available neighbor at the first or last card", () => {
    expect(filenameDisplayPriority("0002.mp4", ["0001.mp4", undefined])).toBe("END");
    expect(filenameDisplayPriority("旅程甲_002.mp4", [undefined, "旅程乙_003.mp4"])).toBe("START");
  });
});
