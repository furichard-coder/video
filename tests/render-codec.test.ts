import { describe, expect, it } from "vitest";
import { buildVideoCodecArgs } from "../src/main/services/concat-render";

describe("render video codec", () => {
  it("uses libx265 with an MP4-friendly hvc1 tag for the preferred H.265 option", () => {
    expect(buildVideoCodecArgs("H265")).toEqual(["-c:v", "libx265", "-preset", "veryfast", "-crf", "27", "-tag:v", "hvc1"]);
  });

  it("keeps H.264 as the compatibility option", () => {
    expect(buildVideoCodecArgs("H264")).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-profile:v", "high"]);
  });
});
