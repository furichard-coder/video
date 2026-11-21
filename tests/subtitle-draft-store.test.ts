import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SUBTITLE_DRAFT_CUE_DURATION_MS,
  preflightSubtitleAiDraft,
  promoteSubtitleAiDraft,
  subtitleAiDraftPath,
  writeSubtitleAiDraft,
} from "../src/main/services/subtitle-draft-store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "srt-ai-draft-"));
  roots.push(root);
  return root;
}

const validCues = [
  { id: "first", startMs: 0, endMs: 1200, text: "河內街景" },
  { id: "second", startMs: 1300, endMs: 2500, text: "第二段字幕" },
];

describe("safe AI subtitle draft storage", () => {
  it("writes UTF-8 to the official stem's draft path atomically", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "河內 字幕.srt");
    const draft = subtitleAiDraftPath(official);
    await writeFile(draft, "previous draft", "utf8");

    const result = await writeSubtitleAiDraft(official, validCues);

    expect(result).toEqual({ draftPath: draft, cueCount: 2 });
    const bytes = await readFile(draft);
    expect(bytes.toString("utf8")).toContain("河內街景");
    expect(bytes[0]).not.toBe(0xff);
    expect(await readdir(root)).toEqual(["河內 字幕.ai-draft.srt"]);
  });

  it("rejects unordered, overlapping, empty, and overlong cues without replacing a prior draft", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    const draft = subtitleAiDraftPath(official);
    await writeFile(draft, "kept draft", "utf8");

    await expect(writeSubtitleAiDraft(official, [...validCues].reverse())).rejects.toThrow(/排序/);
    await expect(
      writeSubtitleAiDraft(official, [validCues[0], { id: "overlap", startMs: 1000, endMs: 1400, text: "重疊" }]),
    ).rejects.toThrow(/不可重疊/);
    await expect(
      writeSubtitleAiDraft(official, [{ id: "empty", startMs: 0, endMs: 1000, text: "  " }]),
    ).rejects.toThrow(/不可空白/);
    await expect(
      writeSubtitleAiDraft(official, [
        { id: "long", startMs: 0, endMs: MAX_SUBTITLE_DRAFT_CUE_DURATION_MS + 1, text: "超長字幕" },
      ]),
    ).rejects.toThrow(/10 分鐘/);

    expect(await readFile(draft, "utf8")).toBe("kept draft");
    expect(await readdir(root)).toEqual(["official.ai-draft.srt"]);
  });

  it("preflights the official path and promotes with a timestamped non-clobbering backup by choice", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    const draft = subtitleAiDraftPath(official);
    await writeFile(official, "existing official", "utf8");
    await writeSubtitleAiDraft(official, validCues);

    expect(await preflightSubtitleAiDraft(official)).toMatchObject({
      officialPath: official,
      draftPath: draft,
      officialExists: true,
      defaultChoice: "BACKUP",
      choices: ["BACKUP", "SAVE_AS", "OVERWRITE", "CANCEL"],
    });

    const result = await promoteSubtitleAiDraft(official, "BACKUP");
    expect(result).toMatchObject({ cancelled: false, outputPath: official });
    expect(result.backupPath).toMatch(/official\.backup-\d{8}-\d{6}-\d{3}(?:-\d+)?\.srt$/);
    expect(await readFile(result.backupPath!, "utf8")).toBe("existing official");
    expect(await readFile(official, "utf8")).toContain("河內街景");
    expect(await readFile(draft, "utf8")).toContain("河內街景");
  });

  it("keeps official and draft untouched when promotion is cancelled", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    const draft = subtitleAiDraftPath(official);
    await writeFile(official, "official", "utf8");
    await writeSubtitleAiDraft(official, validCues);
    const originalDraft = await readFile(draft, "utf8");

    await expect(promoteSubtitleAiDraft(official, "CANCEL")).resolves.toEqual({ cancelled: true });

    expect(await readFile(official, "utf8")).toBe("official");
    expect(await readFile(draft, "utf8")).toBe(originalDraft);
    expect(await readdir(root)).toEqual(["official.ai-draft.srt", "official.srt"]);
  });

  it("saves to a new path without clobbering and refuses an occupied save-as path", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    const draft = subtitleAiDraftPath(official);
    const saveAs = path.join(root, "review-copy.srt");
    await writeFile(official, "official", "utf8");
    await writeSubtitleAiDraft(official, validCues);

    await expect(promoteSubtitleAiDraft(official, "SAVE_AS", { saveAsPath: saveAs })).resolves.toMatchObject({
      cancelled: false,
      outputPath: saveAs,
    });
    expect(await readFile(official, "utf8")).toBe("official");
    expect(await readFile(saveAs, "utf8")).toContain("第二段字幕");
    expect(await readFile(draft, "utf8")).toContain("第二段字幕");
    await expect(promoteSubtitleAiDraft(official, "SAVE_AS", { saveAsPath: saveAs })).rejects.toThrow(/已存在/);
  });

  it("overwrites only after the explicit OVERWRITE choice", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    await writeFile(official, "official", "utf8");
    await writeSubtitleAiDraft(official, validCues);

    await promoteSubtitleAiDraft(official, "OVERWRITE");

    expect(await readFile(official, "utf8")).toContain("河內街景");
    expect((await readdir(root)).sort()).toEqual(["official.ai-draft.srt", "official.srt"]);
  });

  it("cancels draft writing without damaging an existing draft", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    const draft = subtitleAiDraftPath(official);
    await writeFile(draft, "kept draft", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(writeSubtitleAiDraft(official, validCues, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(await readFile(draft, "utf8")).toBe("kept draft");
    expect(await readdir(root)).toEqual(["official.ai-draft.srt"]);
  });

  it("preserves both files when the stored draft is invalid at promotion time", async () => {
    const root = await temporaryRoot();
    const official = path.join(root, "official.srt");
    const draft = subtitleAiDraftPath(official);
    await writeFile(official, "official", "utf8");
    await writeSubtitleAiDraft(official, validCues);
    await writeFile(draft, "broken draft", "utf8");

    await expect(promoteSubtitleAiDraft(official, "OVERWRITE")).rejects.toThrow();

    expect(await readFile(official, "utf8")).toBe("official");
    expect(await readFile(draft, "utf8")).toBe("broken draft");
    expect((await readdir(root)).sort()).toEqual(["official.ai-draft.srt", "official.srt"]);
  });
});
