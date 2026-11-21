import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SubtitleAiCheckAction, SubtitleCue } from "../src/shared/domain";
import {
  buildSubtitleAiCheckProposal,
  createSubtitleAiCheckSnapshot,
  parseSubtitleAiCheckResult,
  resolveSubtitleAiCheckAction,
  SubtitleAiCheckError,
  SubtitleAiCheckJobStore,
  OpenAiSubtitleAiCheckProvider,
  classifySubtitleAiCheckError,
  advanceSubtitleAiCheckProgress,
  type SubtitleAiCheckProvider,
} from "../src/main/services/subtitle-ai-check";
import { StandaloneSubtitleStore } from "../src/main/services/standalone-subtitle-store";
import { backupExistingSubtitleOutput, exportSrt } from "../src/main/services/subtitle-export";

const provider: SubtitleAiCheckProvider = {
  kind: "OPENAI",
  modelId: "actual-vision-model",
  checkCue: async () => ({ decision: "KEEP", reason: "ok", confidence: 1, timingConfidence: 1 }),
};
const cue: SubtitleCue = { id: "cue-56", startMs: 55_000, endMs: 56_000, text: "原始字幕", reviewStatus: "DRAFT" };

describe("subtitle AI check safety core", () => {
  it("strictly parses KEEP and EDIT and categorizes malformed/timeline responses", () => {
    expect(
      parseSubtitleAiCheckResult(
        JSON.stringify({
          decision: "KEEP",
          suggestedText: "",
          suggestedStartMs: 0,
          suggestedEndMs: 1,
          reason: "畫面與文字一致",
          confidence: 0.9,
          timingConfidence: 0.8,
        }),
        60_000,
      ),
    ).toMatchObject({ decision: "KEEP" });
    expect(
      parseSubtitleAiCheckResult(
        JSON.stringify({
          decision: "EDIT",
          suggestedText: "修正",
          suggestedStartMs: 55_100,
          suggestedEndMs: 55_900,
          reason: "更貼近畫面",
          confidence: 0.8,
          timingConfidence: 0.7,
        }),
        60_000,
      ),
    ).toMatchObject({ decision: "EDIT", suggestedText: "修正" });
    expect(() => parseSubtitleAiCheckResult("not-json", 60_000)).toThrowError(
      expect.objectContaining({ code: "JSON_PARSE" }),
    );
    expect(() =>
      parseSubtitleAiCheckResult(
        JSON.stringify({
          decision: "EDIT",
          suggestedText: "修正",
          suggestedStartMs: 59_000,
          suggestedEndMs: 61_000,
          reason: "x",
          confidence: 0.8,
          timingConfidence: 0.7,
        }),
        60_000,
      ),
    ).toThrowError(expect.objectContaining({ code: "SUBTITLE_TIMELINE" }));
    for (const malformed of [
      {
        decision: "KEEP",
        suggestedText: "",
        suggestedStartMs: 0,
        suggestedEndMs: 1,
        reason: "x",
        confidence: null,
        timingConfidence: 0.8,
      },
      {
        decision: "KEEP",
        suggestedText: "",
        suggestedStartMs: 0,
        suggestedEndMs: 1,
        reason: "x",
        confidence: "0.8",
        timingConfidence: 0.8,
      },
      {
        decision: "EDIT",
        suggestedText: "修正",
        suggestedStartMs: 55_000.5,
        suggestedEndMs: 56_000,
        reason: "x",
        confidence: 0.8,
        timingConfidence: 0.8,
      },
      {
        decision: "KEEP",
        suggestedText: "",
        suggestedStartMs: 0,
        suggestedEndMs: 1,
        reason: "x",
        confidence: 0.8,
        timingConfidence: 0.8,
        surprise: true,
      },
    ])
      expect(() => parseSubtitleAiCheckResult(JSON.stringify(malformed), 60_000)).toThrowError(
        expect.objectContaining({ code: "BAD_RESPONSE" }),
      );
  });

  it("never overwrites a newer manual edit when applying an older proposal", () => {
    const proposal = buildSubtitleAiCheckProposal(cue, 55, [55_000, 55_500, 55_999], provider, {
      decision: "EDIT",
      suggestedText: "AI 建議",
      suggestedStartMs: 55_000,
      suggestedEndMs: 56_000,
      reason: "建議調整",
      confidence: 0.8,
      timingConfidence: 0.8,
    });
    const manuallyEdited = { ...cue, text: "最新人工內容", userEdited: true };
    const action: SubtitleAiCheckAction = { workspaceId: "workspace", proposalId: proposal.id, action: "APPLY" };
    const result = resolveSubtitleAiCheckAction([manuallyEdited], proposal, action);
    expect(result.conflict).toBe(true);
    expect(result.cues[0].text).toBe("最新人工內容");
    expect(result.proposal.status).toBe("CONFLICT");
  });

  it("treats a confirmed manual proposal edit as applied and validates its exact timeline", () => {
    const proposal = buildSubtitleAiCheckProposal(cue, 55, [], provider, {
      decision: "EDIT",
      suggestedText: "AI 建議",
      suggestedStartMs: 55_000,
      suggestedEndMs: 56_000,
      reason: "建議調整",
      confidence: 0.8,
      timingConfidence: 0.8,
    });
    const applied = resolveSubtitleAiCheckAction(
      [cue],
      proposal,
      {
        workspaceId: "workspace",
        proposalId: proposal.id,
        action: "EDIT",
        editedText: "人工最終內容",
        editedStartMs: 55_100,
        editedEndMs: 55_900,
      },
      60_000,
    );
    expect(applied).toMatchObject({
      conflict: false,
      proposal: { status: "APPLIED" },
      cues: [{ text: "人工最終內容", startMs: 55_100, endMs: 55_900 }],
    });
    expect(() =>
      resolveSubtitleAiCheckAction(
        [cue],
        proposal,
        {
          workspaceId: "workspace",
          proposalId: proposal.id,
          action: "EDIT",
          editedText: "越界",
          editedStartMs: 59_000,
          editedEndMs: 60_001,
        },
        60_000,
      ),
    ).toThrowError(expect.objectContaining({ code: "SUBTITLE_TIMELINE" }));
  });

  it("persists progress and resumes exactly from cue 56 while retaining actual provider/model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-ai-check-"));
    try {
      const store = new SubtitleAiCheckJobStore(path.join(root, "job.json"));
      const snapshot = createSubtitleAiCheckSnapshot(
        "workspace",
        "fingerprint",
        {
          enabled: true,
          interactiveConfirmation: true,
          provider: "CHATGPT",
          displayLanguage: "zh-TW",
          title: "title",
          description: "description",
        },
        100,
      );
      snapshot.progress = {
        ...snapshot.progress,
        status: "PAUSED",
        processed: 56,
        nextCueIndex: 56,
        requests: 56,
        provider: "OPENAI",
        modelId: "actual-vision-model",
      };
      await store.save(snapshot);
      expect((await store.load())?.progress).toMatchObject({
        status: "PAUSED",
        processed: 56,
        nextCueIndex: 56,
        provider: "OPENAI",
        modelId: "actual-vision-model",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses after exactly one proposal when interactive confirmation is on", () => {
    const base = {
      status: "RUNNING" as const,
      processed: 0,
      total: 100,
      nextCueIndex: 0,
      requests: 0,
      cacheHits: 0,
      elapsedMs: 0,
      provider: "OPENAI" as const,
      modelId: "actual-model",
    };
    expect(advanceSubtitleAiCheckProgress(base, 0, "cue-1", true, 25)).toMatchObject({
      status: "PAUSED",
      processed: 1,
      nextCueIndex: 1,
      requests: 1,
      currentCueId: "cue-1",
    });
    expect(advanceSubtitleAiCheckProgress(base, 0, "cue-1", false, 25)).toMatchObject({
      status: "RUNNING",
      processed: 1,
      nextCueIndex: 1,
      requests: 1,
    });
  });

  it("categorizes timeout and preserves the formal sibling SRT when a proposal is accepted into the draft", async () => {
    expect(classifySubtitleAiCheckError(new DOMException("timed out", "TimeoutError"))).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    expect(classifySubtitleAiCheckError(new Error("Gemini 尚未設定 API Key。"))).toMatchObject({
      code: "AUTH",
      retryable: false,
    });
    expect(classifySubtitleAiCheckError(new Error("目前模型不可用。"))).toMatchObject({
      code: "MODEL",
      retryable: false,
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-ai-formal-"));
    try {
      const videoPath = path.join(root, "video.mp4");
      const formalSrt = path.join(root, "video.srt");
      await writeFile(videoPath, "video");
      await writeFile(formalSrt, "FORMAL-SRT-MUST-STAY");
      const store = new StandaloneSubtitleStore(path.join(root, "workspace"));
      const workspace = await store.create(videoPath, "fingerprint", 60_000, [cue]);
      const proposal = buildSubtitleAiCheckProposal(cue, 0, [55_000, 55_500, 55_999], provider, {
        decision: "EDIT",
        suggestedText: "AI 建議",
        suggestedStartMs: 55_000,
        suggestedEndMs: 56_000,
        reason: "建議調整",
        confidence: 0.8,
        timingConfidence: 0.8,
      });
      const resolved = resolveSubtitleAiCheckAction(workspace.cues, proposal, {
        workspaceId: workspace.id,
        proposalId: proposal.id,
        action: "APPLY",
      });
      await store.save(workspace.id, resolved.cues);
      expect(await readFile(formalSrt, "utf8")).toBe("FORMAL-SRT-MUST-STAY");
      expect(await readFile(workspace.draftPath, "utf8")).toContain("AI 建議");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a permanent unique backup before an explicit standalone SRT overwrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "subtitle-ai-export-"));
    try {
      const outputPath = path.join(root, "formal.srt");
      await writeFile(outputPath, "ORIGINAL-FORMAL-SRT");
      const backupPath = await backupExistingSubtitleOutput(outputPath);
      expect(backupPath).toBeTruthy();
      expect(await readFile(backupPath!, "utf8")).toBe("ORIGINAL-FORMAL-SRT");
      await exportSrt([cue], outputPath);
      expect(await readFile(outputPath, "utf8")).toContain("原始字幕");
      expect(await readFile(backupPath!, "utf8")).toBe("ORIGINAL-FORMAL-SRT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a valid proposal before modifying a draft", () => {
    const proposal = buildSubtitleAiCheckProposal(cue, 0, [], provider, {
      decision: "KEEP",
      reason: "ok",
      confidence: 1,
      timingConfidence: 1,
    });
    expect(() =>
      resolveSubtitleAiCheckAction([cue], proposal, {
        workspaceId: "workspace",
        proposalId: proposal.id,
        action: "APPLY",
      }),
    ).toThrow(SubtitleAiCheckError);
  });

  it("rejects incomplete and refusal envelopes before parsing output text", async () => {
    const input = {
      cue,
      cueIndex: 0,
      cueCount: 1,
      videoDurationMs: 60_000,
      title: "",
      description: "",
      displayLanguage: "zh-TW",
      evidence: [{ role: "MIDDLE" as const, timestampMs: 55_500, imageDataUrl: "data:image/jpeg;base64,YQ==" }],
    };
    for (const payload of [
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "{}" },
      { status: "completed", output: [{ content: [{ type: "refusal" }] }] },
    ]) {
      const instance = new OpenAiSubtitleAiCheckProvider(
        "model",
        "secret",
        async () =>
          new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
      await expect(instance.checkCue(input)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    }
  });
});
