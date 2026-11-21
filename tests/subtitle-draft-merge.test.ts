import { describe, expect, it } from "vitest";
import { mergeSubtitleVisionDrafts } from "../src/main/services/subtitle-draft-merge";

const d = (text: string, startMs: number, endMs: number) => ({ frameId: `${startMs}`, text, startMs, endMs, confidence: .9, provenance: ["VISIBLE" as const] });
describe("scene subtitle merge", () => {
  it("merges adjacent identical scene facts without inheriting sampling cadence", () => {
    expect(mergeSubtitleVisionDrafts([d("森林",0,1800), d("森林",2000,3800), d("湖泊",4000,7000)], { durationMs: 8000 }))
      .toMatchObject([{ text:"森林", startMs:0, endMs:3800 }, { text:"湖泊", startMs:4000, endMs:7000 }]);
  });
  it("clips duration, removes overlaps, and warns above 60 chars", () => {
    const result = mergeSubtitleVisionDrafts([d("甲".repeat(61),0,3000), d("乙",2000,9000)], { durationMs:5000 });
    expect(result[0].warning).toMatch(/60/); expect(result[1]).toMatchObject({ startMs:3000, endMs:5000 });
  });
});
