import { describe, expect, it } from "vitest";
import {
  activeSubtitleCueAt,
  buildSubtitlePlaybackSegments,
  playbackSegmentAt,
  projectClockToSourceMs,
  sourceTimeToProjectClockMs,
} from "../src/renderer/subtitle-playback";
import type { ProjectManifest, SourceAsset, SubtitleCue } from "../src/shared/domain";

const asset = (id: string): SourceAsset =>
  ({
    id,
    kind: "VIDEO",
    sourcePath: `C:\\${id}.mp4`,
    fileName: `${id}.mp4`,
    sizeBytes: 1,
    sourcePolicy: "READ_ONLY",
    addedAt: "2026-10-03T00:00:00Z",
    mediaInfo: { durationMs: 10_000 },
  }) as SourceAsset;
const project = {
  sources: [asset("a"), asset("b"), asset("c")],
  timelineOrder: ["a", "b", "c"],
  mediaInsertions: [],
  mainExclusionRanges: [],
  timelineTransitionSeconds: 0,
} as unknown as ProjectManifest;

describe("subtitle project playback clock", () => {
  it("plays continuously from 5 to 30 seconds through three segments", () => {
    const segments = buildSubtitlePlaybackSegments(project, "MAIN");
    expect(segments.map((segment) => [segment.projectStartMs, segment.ownershipEndMs])).toEqual([
      [0, 10_000],
      [10_000, 20_000],
      [20_000, 30_000],
    ]);
    let clock = 5_000;
    for (const expected of [9_999, 10_000, 19_999, 20_000, 29_999, 30_000]) {
      clock = expected;
      const segment = playbackSegmentAt(segments, clock);
      expect(segment?.asset.id).toBe(expected < 10_000 ? "a" : expected < 20_000 ? "b" : "c");
      expect(projectClockToSourceMs(segment!, clock)).toBe(expected % 10_000 || (expected === 30_000 ? 10_000 : 0));
    }
  });

  it("uses next-clip ownership at an overlap and maps the same monotonic clock to its source offset", () => {
    const withOverlap = { ...project, timelineTransitionSeconds: 1 } as ProjectManifest;
    const segments = buildSubtitlePlaybackSegments(withOverlap, "MAIN");
    expect(segments[0].ownershipEndMs).toBe(9_000);
    expect(playbackSegmentAt(segments, 9_000)?.asset.id).toBe("b");
    expect(projectClockToSourceMs(segments[1], 9_500)).toBe(500);
    expect(sourceTimeToProjectClockMs(segments[1], 500)).toBe(9_500);
  });

  it("uses exact start-inclusive and end-exclusive cue boundaries", () => {
    const cues: SubtitleCue[] = [
      { id: "one", startMs: 0, endMs: 1_000, text: "one", timelineScope: "MAIN" },
      { id: "two", startMs: 1_000, endMs: 2_000, text: "two", timelineScope: "MAIN" },
    ];
    expect(activeSubtitleCueAt(cues, "MAIN", 999)?.id).toBe("one");
    expect(activeSubtitleCueAt(cues, "MAIN", 999.999)?.id).toBe("one");
    expect(activeSubtitleCueAt(cues, "MAIN", 1_000)?.id).toBe("two");
    expect(activeSubtitleCueAt(cues, "MAIN", 1_999.999)?.id).toBe("two");
    expect(activeSubtitleCueAt(cues, "MAIN", 2_000)).toBeUndefined();
    expect(playbackSegmentAt(buildSubtitlePlaybackSegments(project, "MAIN"), 9_999.999)?.asset.id).toBe("a");
    expect(playbackSegmentAt(buildSubtitlePlaybackSegments(project, "MAIN"), 10_000)?.asset.id).toBe("b");
    const lateCue: SubtitleCue = { id: "late", startMs: 5_000, endMs: 8_000, text: "late", timelineScope: "MAIN" };
    expect(activeSubtitleCueAt([lateCue], "MAIN", 4_999.999)).toBeUndefined();
    expect(activeSubtitleCueAt([lateCue], "MAIN", 5_000)?.id).toBe("late");
    expect(activeSubtitleCueAt([lateCue], "MAIN", 8_000)).toBeUndefined();
  });
});
