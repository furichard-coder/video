// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandaloneSubtitleReview } from "../../src/renderer/components/StandaloneSubtitleReview";
import type { AppApi, StandaloneSubtitleWorkspace, SubtitleAiCheckJobSnapshot, SubtitleAiCheckProposal, SubtitleCue } from "../../src/shared/domain";

const cue = (id: string, text: string, startMs = 1_000, endMs = 2_500): SubtitleCue => ({ id, startMs, endMs, text, aiConfidence: 91 });
const workspace: StandaloneSubtitleWorkspace = {
  id: "standalone-1", videoPath: "C:\\video.mp4", videoFingerprint: "sha256:test", videoDurationMs: 10_000,
  draftPath: "C:\\draft.json", cues: [cue("one", "第一句"), cue("two", "第二句", 2_500, 4_000)], updatedAt: "2026-10-02T00:00:00.000Z",
};

function setup(subject: StandaloneSubtitleWorkspace = workspace, overrides: Partial<AppApi> = {}, operationLog?: string[], onSave?: (cues: SubtitleCue[]) => void) {
  const savedWorkspace = { ...subject, cues: subject.cues };
  const saveStandaloneSubtitleWorkspace = vi.fn(async (_id: string, cues: SubtitleCue[]) => {
    operationLog?.push("save");
    onSave?.(cues);
    return { ...savedWorkspace, cues };
  });
  const getSubtitleEvidenceFrame = vi.fn(async () => ({ url: "data:image/png;base64,frame" }));
  const setSubtitleCues = vi.fn();
  Object.defineProperty(window, "sourceApp", { configurable: true, value: {
    saveStandaloneSubtitleWorkspace, getSubtitleEvidenceFrame, setSubtitleCues, ...overrides,
  } as unknown as AppApi });
  const onUpdated = vi.fn();
  render(<StandaloneSubtitleReview workspace={subject} videoUrl="source-media://subtitle/standalone-1" onUpdated={onUpdated} onError={vi.fn()} />);
  return { saveStandaloneSubtitleWorkspace, setSubtitleCues, onUpdated };
}

function videoElement() { return document.querySelector("video")!; }
function timeUpdate(ms: number) {
  Object.defineProperty(videoElement(), "currentTime", { configurable: true, value: ms / 1000 });
  fireEvent.timeUpdate(videoElement());
}

describe("StandaloneSubtitleReview", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows cue timing and confidence, saves text edits to the standalone workspace only", async () => {
    const { saveStandaloneSubtitleWorkspace, setSubtitleCues, onUpdated } = setup();
    expect(screen.getAllByText("第一句")).toHaveLength(2);
    expect(screen.getAllByText("91%")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("已儲存");
    fireEvent.change(screen.getByRole("textbox", { name: "字幕文字" }), { target: { value: "修正後的字幕" } });
    expect(screen.getByRole("status")).toHaveTextContent("尚未儲存");
    fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() => expect(saveStandaloneSubtitleWorkspace).toHaveBeenCalledWith("standalone-1", [
      expect.objectContaining({ id: "one", text: "修正後的字幕", userEdited: true }), cue("two", "第二句", 2_500, 4_000),
    ]));
    expect(onUpdated).toHaveBeenCalledOnce();
    expect(setSubtitleCues).not.toHaveBeenCalled();
  });

  it("deletes a cue from the standalone draft without writing project subtitles", () => {
    const { setSubtitleCues } = setup();
    fireEvent.click(screen.getByRole("button", { name: "刪除第 2 筆" }));
    expect(screen.queryByText("第二句")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("尚未儲存");
    expect(setSubtitleCues).not.toHaveBeenCalled();
  });

  it("keeps a cue active at its start and clears it exactly at its end", () => {
    setup();
    timeUpdate(1_000);
    expect(document.querySelector(".standalone-subtitle-review__overlay")).toHaveTextContent("第一句");
    timeUpdate(2_499);
    expect(document.querySelector(".standalone-subtitle-review__overlay")).toHaveTextContent("第一句");
    timeUpdate(2_500);
    expect(document.querySelector(".standalone-subtitle-review__overlay")).toHaveTextContent("第二句");
    expect(screen.getByRole("button", { name: /選取第 2 筆/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows exact cue clocks and playback navigation, while return-to-cue only resumes list following", () => {
    setup();
    const player = videoElement();
    const firstRow = screen.getByRole("button", { name: /選取第 1 筆/ });
    expect(firstRow).toHaveTextContent("00:00:01.000");
    expect(firstRow).toHaveTextContent("00:00:02.500");
    expect(firstRow).toHaveTextContent("1.500s");

    fireEvent.click(screen.getByRole("button", { name: "下一筆字幕" }));
    expect(player.currentTime).toBe(2.5);
    fireEvent.click(screen.getByRole("button", { name: "倒退兩秒" }));
    expect(player.currentTime).toBe(0.5);
    fireEvent.click(screen.getByRole("button", { name: "前進兩秒" }));
    expect(player.currentTime).toBe(2.5);

    const list = screen.getByRole("list", { name: "字幕 cue 清單" });
    const scrollTo = vi.fn();
    Object.defineProperty(list, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.scroll(list);
    timeUpdate(1_200);
    timeUpdate(1_400);
    const beforeTime = player.currentTime;
    fireEvent.click(screen.getByRole("button", { name: "回到目前字幕" }));
    expect(player.currentTime).toBe(beforeTime);
    expect(screen.getByRole("button", { name: /選取第 1 筆/ })).toHaveAttribute("aria-pressed", "true");
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("plays three runtime segments on one project clock", () => {
    const segmented = { ...workspace, segments: [
      { src: "media://one", inMs: 1_000, outMs: 3_000 },
      { src: "media://two", inMs: 2_000, outMs: 4_000 },
      { src: "media://three", inMs: 0, outMs: 2_000 },
    ] } as StandaloneSubtitleWorkspace;
    setup(segmented);
    const player = videoElement();
    expect(player.getAttribute("src")).toBe("media://one");
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(player, "play", { configurable: true, value: play });
    fireEvent.ended(player);
    expect(player.getAttribute("src")).toBe("media://two");
    fireEvent.ended(player);
    Object.defineProperty(player, "currentTime", { configurable: true, writable: true, value: 3 });
    fireEvent.timeUpdate(player);
    expect(player.getAttribute("src")).toBe("media://two");
    fireEvent.loadedMetadata(player);
    expect(play).toHaveBeenCalledOnce();
    fireEvent.ended(player);
    expect(player.getAttribute("src")).toBe("media://three");
    fireEvent.loadedMetadata(player);
    expect(play).toHaveBeenCalledTimes(2);
    timeUpdate(500);
    expect(screen.getByText(/專案時間/)).toHaveTextContent("00:00:04.500");
  });

  it("follows playback focus, pauses following during manual scrolling, then resumes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    setup();
    const list = screen.getByRole("list", { name: "字幕 cue 清單" });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 400 });
    const scrollTo = vi.fn();
    Object.defineProperty(list, "scrollTo", { configurable: true, value: scrollTo });
    timeUpdate(1_000);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
    fireEvent.wheel(list);
    timeUpdate(2_600);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-03T00:00:05Z"));
    timeUpdate(1_500);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("ignores Space inside text entry and supports player shortcuts and explicit double-click seeking", () => {
    setup();
    const player = videoElement();
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(player, "play", { configurable: true, value: play });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "字幕文字" }), { code: "Space", key: " " });
    expect(play).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    expect(play).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("spinbutton", { name: "開始時間" }), { target: { value: "1234" } });
    expect(player.currentTime).toBe(0);
    fireEvent.doubleClick(screen.getByRole("button", { name: /選取第 2 筆/ }));
    expect(player.currentTime).toBe(2.5);
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(player.currentTime).toBe(0.5);
  });

  it("saves without moving the playhead and applies the playback rate", async () => {
    const { saveStandaloneSubtitleWorkspace } = setup();
    const player = videoElement();
    Object.defineProperty(player, "currentTime", { configurable: true, writable: true, value: 1.7 });
    fireEvent.change(screen.getByRole("textbox", { name: "字幕文字" }), { target: { value: "修正" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() => expect(saveStandaloneSubtitleWorkspace).toHaveBeenCalledOnce());
    expect(player.currentTime).toBe(1.7);
    fireEvent.change(screen.getByRole("combobox", { name: "播放速度" }), { target: { value: "1.5" } });
    expect(player.playbackRate).toBe(1.5);
  });

  it("keeps AI checking opt-in and interactive confirmation on, and never starts before opt-in", async () => {
    const startSubtitleAiCheck = vi.fn(async (request) => ({
      schemaVersion: 1 as const, workspaceId: workspace.id, videoFingerprint: workspace.videoFingerprint,
      options: request, proposals: [], updatedAt: "2026-10-03T00:00:00Z",
      progress: { status: "COMPLETED" as const, processed: 2, total: 2, nextCueIndex: 2, requests: 2, cacheHits: 0, elapsedMs: 10, provider: "OPENAI" as const, modelId: "actual-model" },
    }));
    setup(workspace, { startSubtitleAiCheck, getSubtitleAiCheckJob: vi.fn(async () => undefined) });
    fireEvent.click(screen.getByText("AI 逐筆審核"));
    const enabled = screen.getByRole("checkbox", { name: "啟用逐筆 AI 檢查" });
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "逐筆互動確認" })).toBeChecked();
    expect(screen.getByRole("button", { name: "開始" })).toBeDisabled();
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "開始" }));
    await waitFor(() => expect(startSubtitleAiCheck).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, interactiveConfirmation: true, workspaceId: workspace.id })));
    expect(await screen.findByText(/actual-model/)).toBeInTheDocument();
  });

  it("saves unsaved manual text before APPLY and keeps it when the backend reports a revision conflict", async () => {
    const operationLog: string[] = [];
    let latestSavedText = "";
    let backendSawText = "";
    const proposal: SubtitleAiCheckProposal = {
      id: "proposal-conflict", cueId: "one", cueIndex: 0, decision: "EDIT", suggestedText: "過期 AI 文字",
      reason: "人工修改較新", confidence: 0.8, timingConfidence: 0.9, provider: "OPENAI", modelId: "actual-model",
      baseCueRevision: "stale-revision", baseContextRevision: "stale-context", evidenceTimesMs: [1_000, 1_500, 2_000], status: "PENDING", createdAt: "2026-10-03T00:00:00Z",
    };
    const snapshot: SubtitleAiCheckJobSnapshot = {
      schemaVersion: 1, workspaceId: workspace.id, videoFingerprint: workspace.videoFingerprint,
      options: { enabled: true, interactiveConfirmation: true, provider: "CHATGPT", displayLanguage: "zh-TW", title: "", description: "" },
      progress: { status: "COMPLETED", processed: 1, total: 1, nextCueIndex: 1, requests: 1, cacheHits: 0, elapsedMs: 10 },
      proposals: [proposal], updatedAt: "2026-10-03T00:00:00Z",
    };
    const applySubtitleAiCheckAction = vi.fn(async () => {
      operationLog.push("apply");
      backendSawText = latestSavedText;
      const cues = [cue("one", latestSavedText), cue("two", "第二句", 2_500, 4_000)];
      return { workspace: { ...workspace, cues }, proposal: { ...proposal, status: "CONFLICT" as const }, conflict: true };
    });
    setup(workspace, { getSubtitleAiCheckJob: vi.fn(async () => snapshot), applySubtitleAiCheckAction }, operationLog, (cues) => {
      latestSavedText = cues.find((item) => item.id === "one")?.text ?? "";
    });

    await screen.findByText(/過期 AI 文字/);
    fireEvent.change(screen.getByRole("textbox", { name: "字幕文字" }), { target: { value: "最新人工文字" } });
    fireEvent.click(screen.getByRole("button", { name: "套用建議" }));

    await waitFor(() => expect(applySubtitleAiCheckAction).toHaveBeenCalledOnce());
    expect(operationLog).toEqual(["save", "apply"]);
    expect(backendSawText).toBe("最新人工文字");
    expect(screen.getByRole("textbox", { name: "字幕文字" })).toHaveValue("最新人工文字");
    expect(screen.queryByText("過期 AI 文字")).not.toBeInTheDocument();
  });
});
