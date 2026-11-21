import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StandaloneSubtitleStore } from "../src/main/services/standalone-subtitle-store";
describe("standalone subtitle drafts", () => {
  it("persists separately and leaves existing source and SRT untouched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-v087-"));
    try {
      const source = path.join(root, "video.mp4"), srt = path.join(root, "video.srt");
      await writeFile(source, "original-video"); await writeFile(srt, "original-srt");
      const service = new StandaloneSubtitleStore(path.join(root, "workspaces"));
      const workspace = await service.create(source, "fingerprint", 10000, [{id:"cue",startMs:1000,endMs:5000,text:"林間步道",reviewStatus:"DRAFT"}]);
      expect((await service.latest())?.cues).toHaveLength(1);
      expect(await readFile(workspace.draftPath, "utf8")).toContain("林間步道");
      expect(await readFile(source,"utf8")).toBe("original-video"); expect(await readFile(srt,"utf8")).toBe("original-srt");
      await expect(service.save(workspace.id,[{id:"cue",startMs:9000,endMs:11000,text:"x"}])).rejects.toThrow(/時間/);
      await service.save(workspace.id, []); expect(await readFile(workspace.draftPath,"utf8")).toBe("");
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
