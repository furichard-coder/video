import { describe, expect, it, vi } from "vitest";
import { CodexCliStoryProvider } from "../src/main/services/codex-cli-provider";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("Codex publish provider contract", () => {
  it("uses ephemeral read-only schema args and cleans schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-publish-"));
    const frame = path.join(root, "frame.jpg");
    await writeFile(frame, "fake");
    const response = {
      titles: [
        { text: "一", reason: "a" },
        { text: "二", reason: "b" },
        { text: "三", reason: "c" },
      ],
      description: "d",
      englishSummary: "e",
      hashtags: ["#x"],
      thumbnails: [
        { candidateId: "thumbnail-1", overlayText: "x", layout: "LEFT_TEXT", colorNote: "", reason: "" },
        { candidateId: "thumbnail-1", overlayText: "x", layout: "LEFT_TEXT", colorNote: "", reason: "" },
        { candidateId: "thumbnail-1", overlayText: "x", layout: "LEFT_TEXT", colorNote: "", reason: "" },
      ],
      chapters: [],
      warnings: [],
    };
    const runner = vi.fn(async (_exe: string, args: string[], _signal: AbortSignal, _options: { input: string }) => {
      expect(args).toContain("--ephemeral");
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("read-only");
      expect(args).toContain(frame);
      return {
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify(response) },
        }),
        stderr: "",
      };
    });
    const provider = new CodexCliStoryProvider(root, "C:\\codex.exe", runner as never);
    const result = await provider.generatePublishAssets(
      {
        topic: { topic: "x", locations: [], storySummary: "", audiencePromise: "" },
        durationMs: 0,
        introSummary: [],
        timelineSummary: [],
        candidates: [
          {
            candidateId: "thumbnail-1",
            assetId: "a",
            sourceTimeMs: 0,
            sourceFileName: "a",
            framePath: frame,
            origin: "MAIN",
          },
        ],
      },
      "model",
    );
    expect(result.draft.titles).toHaveLength(3);
    expect((await readdir(root)).filter((name) => name.includes("codex-publish-schema")).length).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
