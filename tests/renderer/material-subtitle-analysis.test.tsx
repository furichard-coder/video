// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MaterialSubtitleAnalysisModal } from "../../src/renderer/components/MaterialSubtitleAnalysisModal";
import type { AppApi, ProjectManifest, SourceAsset, SubtitleCue } from "../../src/shared/domain";

describe("material visual subtitle review", () => {
  it("keeps a photo suggestion, shows the overlapping text, and opens subtitle review as a draft", async () => {
    const photo = {
      id: "photo",
      kind: "IMAGE",
      fileName: "IMG_1000.jpg",
      mediaInfo: {},
      imageDurationMs: 5_000,
    } as SourceAsset;
    const existing = {
      id: "existing",
      startMs: 0,
      endMs: 2_000,
      text: "既有森林字幕",
      timelineScope: "MAIN",
      reviewStatus: "CONFIRMED",
    } as SubtitleCue;
    const draft = {
      id: "draft",
      startMs: 0,
      endMs: 4_000,
      text: "林間可見高大針葉樹",
      timelineScope: "MAIN",
      origin: "AI_VISUAL",
      reviewStatus: "DRAFT",
      visualSummary: "森林步道旁的針葉樹",
    } as SubtitleCue;
    const project = { sources: [photo], subtitleCues: [existing] } as ProjectManifest;
    const analyzeMaterialForSubtitles = vi.fn(async () => ({
      drafts: [draft],
      overlaps: [{ draftId: draft.id, existingCues: [existing] }],
      providerLabel: "GEMINI" as const,
      analyzedFrameTimesMs: [0],
      warnings: ["與既有森林字幕重疊"],
      analysisVersion: "material-subtitle-v3-gemini-timeline-sync",
    }));
    const setSubtitleCues = vi.fn(async (cues: SubtitleCue[]) => ({ ...project, subtitleCues: cues }));
    Object.defineProperty(window, "sourceApp", {
      configurable: true,
      value: { analyzeMaterialForSubtitles, setSubtitleCues } as unknown as AppApi,
    });
    const onOpenSubtitleReview = vi.fn();
    render(
      <MaterialSubtitleAnalysisModal
        asset={photo}
        project={project}
        onClose={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenSubtitleReview={onOpenSubtitleReview}
      />,
    );
    expect(screen.getByRole("combobox", { name: /分析方式/ })).toHaveValue("GEMINI");
    fireEvent.click(screen.getByRole("button", { name: /分析並產生字幕草稿/ }));
    await waitFor(() =>
      expect(analyzeMaterialForSubtitles).toHaveBeenCalledWith(expect.objectContaining({ provider: "GEMINI" })),
    );
    expect(await screen.findByDisplayValue("林間可見高大針葉樹")).toBeInTheDocument();
    expect(screen.getAllByText(/既有森林字幕/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/目前重疊字幕/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入字幕頁調整重疊" }));
    await waitFor(() =>
      expect(setSubtitleCues).toHaveBeenCalledWith([
        existing,
        expect.objectContaining({ id: "draft", reviewStatus: "DRAFT" }),
      ]),
    );
    expect(onOpenSubtitleReview).toHaveBeenCalled();
  });
});
