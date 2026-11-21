// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtitleStudio } from "../../src/renderer/components/SubtitleStudio";
import type { AppApi, ProjectManifest, SubtitleCue } from "../../src/shared/domain";

function makeCue(id: string, startMs: number, text: string, overrides: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    id,
    startMs,
    endMs: startMs + 2_000,
    text,
    timelineScope: "MAIN",
    origin: "AI_VISUAL",
    reviewStatus: "DRAFT",
    ...overrides,
  };
}

function setup(cues: SubtitleCue[]) {
  const project = {
    id: "visual-draft-review",
    sources: [],
    timelineOrder: [],
    introSegments: [],
    subtitleCues: cues,
    aiStoryContext: { topic: "森林旅行", storySummary: "" },
    timelineTransitionSeconds: 0.3,
  } as unknown as ProjectManifest;
  const setSubtitleCues = vi.fn(async (next: SubtitleCue[]) => ({ ...project, subtitleCues: next }));
  const regenerateSubtitleVisualCue = vi.fn(async () => ({ text: "AI 重新產生文字", confidence: 0.88 }));
  const api = {
    setSubtitleCues,
    onAiAnalysisProgress: vi.fn(),
    onSubtitlePreviewProgress: vi.fn(),
    clearAiAnalysisProgressListeners: vi.fn(),
    clearSubtitlePreviewProgressListeners: vi.fn(),
    getUserPreferences: vi.fn(async () => ({
      subtitleGenerationScope: { intro: false, main: true },
      subtitlePreviewStyle: {
        verticalPositionPercent: 82,
        fontSizePx: 28,
        textColor: "#FFFFFF",
        shadowEnabled: true,
        outlineWidthPx: 2,
      },
    })),
    getSubtitleAnalysisVideo: vi.fn(async () => ({ reason: "NONE" as const })),
    regenerateSubtitleVisualCue,
  } as unknown as AppApi;
  Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
  render(
    <SubtitleStudio
      project={project}
      timelineDurationMs={20_000}
      onProjectUpdated={vi.fn()}
      onOpenAiSettings={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { setSubtitleCues, regenerateSubtitleVisualCue };
}

describe("SubtitleStudio AI visual draft review tools", () => {
  afterEach(cleanup);

  it("keeps review controls in a keyboard-scrollable body and exposes AI settings", () => {
    const onOpenAiSettings = vi.fn();
    const project = {
      id: "scroll-review",
      sources: [],
      timelineOrder: [],
      introSegments: [],
      subtitleCues: [makeCue("cue", 0, "保留可見的字幕")],
      aiStoryContext: { topic: "森林旅行", storySummary: "" },
      timelineTransitionSeconds: 0.3,
    } as unknown as ProjectManifest;
    Object.defineProperty(window, "sourceApp", {
      configurable: true,
      value: {
        onAiAnalysisProgress: vi.fn(),
        onSubtitlePreviewProgress: vi.fn(),
        clearAiAnalysisProgressListeners: vi.fn(),
        clearSubtitlePreviewProgressListeners: vi.fn(),
        getUserPreferences: vi.fn(async () => ({
          subtitleGenerationScope: { intro: false, main: true },
          subtitlePreviewStyle: { verticalPositionPercent: 82, fontSizePx: 28, textColor: "#FFFFFF", shadowEnabled: true, outlineWidthPx: 2 },
        })),
        getSubtitleAnalysisVideo: vi.fn(async () => ({ reason: "NONE" as const })),
      },
    });
    render(<SubtitleStudio project={project} timelineDurationMs={20_000} onProjectUpdated={vi.fn()} onOpenAiSettings={onOpenAiSettings} onClose={vi.fn()} />);

    const body = screen.getByRole("region", { name: /字幕審核內容/ });
    expect(body).toContainElement(screen.getByRole("button", { name: /AI 帳號／故事設定/ }));
    expect(body).toContainElement(screen.getByRole("textbox", { name: "直接編輯第 1 筆字幕" }));
    const scrollTo = vi.fn();
    Object.defineProperty(body, "scrollTo", { configurable: true, value: scrollTo });
    fireEvent.keyDown(body, { key: "PageDown" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: "smooth" });
    fireEvent.click(screen.getByRole("button", { name: /AI 帳號／故事設定/ }));
    expect(onOpenAiSettings).toHaveBeenCalledOnce();
  });

  it("applies a local correction, splits at the time midpoint, and merges only draft cues", async () => {
    const confirmed = makeCue("confirmed", 6_000, "已確認文字", { reviewStatus: "CONFIRMED" });
    const manual = makeCue("manual", 9_000, "人工文字", { origin: "MANUAL" });
    const { setSubtitleCues, regenerateSubtitleVisualCue } = setup([
      makeCue("visual-a", 0, "林間有一條安靜的小路"),
      makeCue("visual-b", 3_000, "陽光穿過樹梢"),
      confirmed,
      manual,
    ]);

    expect(screen.getByRole("combobox", { name: "修正文案語言" })).toHaveValue("zh-TW");
    fireEvent.change(screen.getByRole("combobox", { name: "修正文案語言" }), { target: { value: "en" } });
    fireEvent.change(screen.getByRole("textbox", { name: "本機修正指示" }), {
      target: { value: "A quiet path through the woods" },
    });
    fireEvent.click(screen.getByRole("button", { name: "套用本機修正文案" }));
    await waitFor(() => expect(setSubtitleCues).toHaveBeenCalledOnce());
    expect(setSubtitleCues.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "visual-a",
          text: "A quiet path through the woods",
          reviewStatus: "DRAFT",
          userEdited: true,
        }),
        confirmed,
        manual,
      ]),
    );

    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    fireEvent.change(screen.getByRole("textbox", { name: "本機修正指示" }), { target: { value: "更精簡且只描述可見內容" } });
    fireEvent.click(screen.getByRole("button", { name: /依指示用附近畫面重新產生/ }));
    await waitFor(() => expect(regenerateSubtitleVisualCue).toHaveBeenCalledWith(expect.objectContaining({ cueId: "visual-a", instruction: "更精簡且只描述可見內容", displayLanguage: "en" })));
    await waitFor(() => expect(setSubtitleCues).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "在時間中點拆分" }));
    await waitFor(() => expect(setSubtitleCues).toHaveBeenCalledTimes(3));
    const splitCues = setSubtitleCues.mock.calls[2][0];
    const firstHalf = splitCues.find((cue) => cue.id === "visual-a");
    const secondHalf = splitCues.find((cue) => cue.id !== "visual-a" && cue.startMs === 1_000);
    expect(firstHalf).toEqual(expect.objectContaining({ startMs: 0, endMs: 1_000, reviewStatus: "DRAFT" }));
    expect(secondHalf).toEqual(expect.objectContaining({ startMs: 1_000, endMs: 2_000, reviewStatus: "DRAFT" }));
    expect(splitCues).toContainEqual(confirmed);
    expect(splitCues).toContainEqual(manual);

    fireEvent.click(screen.getByRole("button", { name: "與下一筆畫面草稿合併" }));
    await waitFor(() => expect(setSubtitleCues).toHaveBeenCalledTimes(4));
    const mergedCues = setSubtitleCues.mock.calls[3][0];
    expect(mergedCues).toHaveLength(4);
    expect(mergedCues.find((cue) => cue.id === "visual-a")).toEqual(
      expect.objectContaining({ startMs: 0, endMs: 2_000, reviewStatus: "DRAFT", userEdited: true }),
    );
    expect(mergedCues).toContainEqual(confirmed);
    expect(mergedCues).toContainEqual(manual);
  });

  it("keeps confirmed and manual cues outside visual-draft tools and merge targets", () => {
    setup([
      makeCue("visual", 0, "視覺草稿"),
      makeCue("confirmed", 3_000, "確認字幕", { reviewStatus: "CONFIRMED" }),
      makeCue("manual", 6_000, "人工字幕", { origin: "MANUAL" }),
    ]);

    expect(screen.getByRole("region", { name: "AI 畫面情境草稿工具" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "與下一筆畫面草稿合併" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /依指示用附近畫面重新產生/ })).toBeInTheDocument();
  });
});
