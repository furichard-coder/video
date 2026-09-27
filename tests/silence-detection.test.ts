import { describe, expect, it, vi } from "vitest";
import type { SourceAsset } from "../src/shared/domain";
import { ClipSilenceDetector, parseMaximumVolumeDb } from "../src/main/services/silence-detection";

const video = (audioCodec?: string): SourceAsset => ({
  id: "a".repeat(64),
  sourcePath: "C:\\來源\\片段.mp4",
  sourceIdentity: "b".repeat(64),
  fileName: "片段.mp4",
  extension: ".mp4",
  kind: "VIDEO",
  sizeBytes: 100,
  fileCreatedAt: "2026-01-01T00:00:00.000Z",
  fileModifiedAt: "2026-01-01T00:00:00.000Z",
  addedAt: "2026-01-01T00:00:00.000Z",
  addedOrder: 0,
  sourcePolicy: "READ_ONLY",
  previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
  previewCacheKey: "c".repeat(64),
  metadataState: "READY",
  mediaInfo: { durationMs: 10_000, videoCodec: "h264", audioCodec },
});

describe("selected-range silence detection", () => {
  it("parses finite and fully silent FFmpeg volumedetect output", () => {
    expect(parseMaximumVolumeDb("[Parsed_volumedetect] max_volume: -inf dB")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseMaximumVolumeDb("max_volume: -18.7 dB")).toBe(-18.7);
    expect(parseMaximumVolumeDb("no measurement")).toBeUndefined();
  });

  it("treats no-audio video as silent and ignores images without starting FFmpeg", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const detector = new ClipSilenceDetector("ffmpeg", runner);
    expect(await detector.isSilent(video(), 0, 2_000)).toBe(true);
    expect(await detector.isSilent({ ...video(), kind: "IMAGE" }, 0, 2_000)).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("checks the exact IN/OUT range, caches it, and distinguishes silent from audible", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "max_volume: -64.0 dB" })
      .mockResolvedValueOnce({ stdout: "", stderr: "max_volume: -12.0 dB" });
    const detector = new ClipSilenceDetector("ffmpeg", runner);
    expect(await detector.isSilent(video("aac"), 1_250, 2_500)).toBe(true);
    expect(await detector.isSilent(video("aac"), 1_250, 2_500)).toBe(true);
    expect(await detector.isSilent(video("aac"), 4_000, 1_000)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1]).toEqual(expect.arrayContaining(["1.250", "2.500", "0:a:0", "volumedetect"]));
  });
});
