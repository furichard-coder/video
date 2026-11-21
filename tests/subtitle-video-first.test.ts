import { describe, expect, it } from "vitest";
import { subtitleAnalysisMode } from "../src/main/services/subtitle-video-selection";
describe("v087 video-first safety gate", () => {
  it("analyzes 12 min selected video independently of 10 min project", () => {
    expect(subtitleAnalysisMode("MANUAL_PATH", 600000, 720000).mode).toBe("VIDEO_FIRST");
    expect(subtitleAnalysisMode("PROJECT_CONCAT", 600000, 720000).mode).toBe("VIDEO_FIRST");
  });
  it("uses project metadata only for compatible project output", () => {
    expect(subtitleAnalysisMode("PROJECT_CONCAT", 600000, 601500).mode).toBe("PROJECT_AWARE");
    expect(subtitleAnalysisMode("MANUAL_PATH", 600000, 600000).mode).toBe("VIDEO_FIRST");
  });
  it("accepts measured 5.286 second padding on long output, but caps tolerance", () => {
    expect(subtitleAnalysisMode("PROJECT_CONCAT", 8964908, 8970194).mode).toBe("PROJECT_AWARE");
    expect(subtitleAnalysisMode("LATEST_CONCAT", 8964908, 8970194).mode).toBe("VIDEO_FIRST");
    expect(subtitleAnalysisMode("LATEST_CONCAT", 8964908, 8990194).mode).toBe("VIDEO_FIRST");
  });
});
