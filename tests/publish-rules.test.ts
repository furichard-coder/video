import { describe, expect, it } from "vitest";
import { buildYoutubeDescription, chapterText, isValidYoutubeChapterSet, mergePublishTitles, validateYoutubeTitle, youtubeTextLength } from "../src/shared/publish-rules";

describe("AI publishing rules", () => {
  it("counts CJK, spaces and emoji as YouTube title characters", () => {
    expect(youtubeTextLength("森林 🌲 旅程")).toBe(7);
    expect(validateYoutubeTitle("  河內旅程  ").value).toBe("河內旅程");
    expect(() => validateYoutubeTitle("x".repeat(101))).toThrow(/100/);
  });
  it("validates chapter ordering and minimum spacing", () => {
    const valid = [0, 10_000, 20_000].map((startMs, index) => ({ id: String(index), startMs, title: `章節 ${index}`, description: "" }));
    expect(isValidYoutubeChapterSet(valid, 30_000)).toBe(true);
    expect(isValidYoutubeChapterSet([{ ...valid[0], startMs: 1 }, ...valid.slice(1)], 30_000)).toBe(false);
    expect(isValidYoutubeChapterSet(valid.slice(0, 2), 30_000)).toBe(false);
    expect(chapterText(valid)).toContain("0:00 章節 0");
  });
  it("preserves user edits when AI candidates are regenerated", () => {
    const old = [{ id: "a", text: "人工標題", charCount: 4, reason: "人工", userEdited: true }, { id: "b", text: "舊草稿", charCount: 3, reason: "AI" }];
    const next = [{ id: "a", text: "新 AI", charCount: 4, reason: "AI" }, { id: "c", text: "新候選", charCount: 4, reason: "AI" }];
    expect(mergePublishTitles(old, next, "PRESERVE_USER_EDITED").map((item) => item.text)).toEqual(["人工標題", "新候選"]);
    expect(mergePublishTitles(old, next, "REPLACE_AI_DRAFTS")).toEqual(next);
  });
  it("builds the exact upload description with English, chapters and hashtags", () => {
    const chapters = [0, 10_000, 20_000].map((startMs, index) => ({ id: String(index), startMs, title: `章節 ${index}`, description: "" }));
    const draft = buildYoutubeDescription({ description: "森林旅程", englishSummary: "Forest journey", hashtags: ["#大雪山", "#Taiwan"], chapters });
    expect(draft.text).toBe("森林旅程\n\nForest journey\n\n0:00 章節 0\n0:10 章節 1\n0:20 章節 2\n\n#大雪山 #Taiwan");
    expect(draft).toMatchObject({ chaptersIncluded: true, truncated: false });
  });
  it("reserves chapters and hashtags when prose exceeds the description limit", () => {
    const chapters = [0, 10_000, 20_000].map((startMs, index) => ({ id: String(index), startMs, title: `段落 ${index}`, description: "" }));
    const draft = buildYoutubeDescription({ description: "很".repeat(6_000), englishSummary: "", hashtags: ["#保留"], chapters });
    expect(draft.text).toHaveLength(5_000);
    expect(draft.text).toContain("0:00 段落 0");
    expect(draft.text.endsWith("#保留")).toBe(true);
    expect(draft).toMatchObject({ chaptersIncluded: true, truncated: true });
  });
});
