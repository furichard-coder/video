import { describe, expect, it } from "vitest";
import { buildVideoCodecArgs } from "../src/main/services/concat-render";

describe("render video codec", () => {
  it("uses Intel Quick Sync for the new default GPU H.265 option", () => {
    expect(buildVideoCodecArgs("H265_QSV")).toEqual(["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", "27", "-tag:v", "hvc1"]);
  });

  it("provides a GPU H.264 compatibility option", () => {
    expect(buildVideoCodecArgs("H264_QSV")).toEqual(["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "25", "-profile:v", "high"]);
  });

  it("uses libx265 with an MP4-friendly hvc1 tag for the preferred H.265 option", () => {
    expect(buildVideoCodecArgs("H265")).toEqual(["-c:v", "libx265", "-preset", "veryfast", "-crf", "27", "-tag:v", "hvc1"]);
  });

  it("keeps H.264 as the compatibility option", () => {
    expect(buildVideoCodecArgs("H264")).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-profile:v", "high"]);
  });
});
