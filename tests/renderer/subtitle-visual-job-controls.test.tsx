// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtitleStudio } from "../../src/renderer/components/SubtitleStudio";
import type { AppApi, ProjectManifest, SubtitleVisualAnalysisProgress } from "../../src/shared/domain";

describe("SubtitleStudio visual analysis controls", () => {
  afterEach(cleanup);
  it("starts with ChatGPT and sends the selected bounded controls and context", async () => {
    const project = {
      id: "project-a",
      sources: [],
      timelineOrder: [],
      introSegments: [],
      subtitleCues: [],
      aiStoryContext: { topic: "沿海旅行", storySummary: "記錄海岸步道與聚落" },
      timelineTransitionSeconds: 0.3,
    } as unknown as ProjectManifest;
    const startSubtitleVisualAnalysis = vi.fn(async () => undefined);
    const api = {
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
      startSubtitleVisualAnalysis,
      pauseSubtitleVisualAnalysis: vi.fn(async () => undefined),
      resumeSubtitleVisualAnalysis: vi.fn(async () => undefined),
      cancelSubtitleVisualAnalysis: vi.fn(async () => undefined),
      onSubtitleVisualAnalysisProgress: vi.fn(),
      clearSubtitleVisualAnalysisProgressListeners: vi.fn(),
    } as unknown as AppApi;
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(
      <SubtitleStudio
        project={project}
        timelineDurationMs={60_000}
        onProjectUpdated={vi.fn()}
        onOpenAiSettings={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "字幕畫面分析服務" })).toHaveValue("CHATGPT");
    expect(screen.getByRole("spinbutton", { name: "畫面取樣間隔" })).toHaveValue(2);
    fireEvent.change(screen.getByRole("combobox", { name: "字幕畫面分析服務" }), { target: { value: "GEMINI" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "畫面取樣間隔" }), { target: { value: "8" } });
    fireEvent.change(screen.getByRole("combobox", { name: "字幕分析畫面密度" }), { target: { value: "DETAILED" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "偵測場景變化" }));
    fireEvent.change(screen.getByRole("textbox", { name: "字幕分析影片標題" }), { target: { value: "海岸旅記" } });
    fireEvent.click(screen.getByRole("button", { name: "開始畫面分析" }));

    await waitFor(() =>
      expect(startSubtitleVisualAnalysis).toHaveBeenCalledWith({
        provider: "GEMINI",
        intervalSeconds: 8,
        density: "DETAILED",
        displayLanguage: "zh-TW",
        detectSceneChanges: false,
        deduplicateFrames: true,
        title: "海岸旅記",
        description: "記錄海岸步道與聚落",
        scopes: ["MAIN"],
      }),
    );
  });

  it("requires confirmation for an incompatible selected video and starts an independent VIDEO_FIRST draft", async () => {
    const project = {
      id: "project-video-first",
      sources: [],
      timelineOrder: [],
      introSegments: [],
      subtitleCues: [],
      aiStoryContext: { topic: "沿海旅行", storySummary: "海岸步道" },
      timelineTransitionSeconds: 0.3,
    } as unknown as ProjectManifest;
    const selectedVideo = {
      reason: "MANUAL_PATH" as const,
      outputPath: "D:\\selected-video.mp4",
      fileName: "selected-video.mp4",
      durationMs: 720_000,
      sizeBytes: 1234,
    };
    const workspace = {
      id: "standalone-workspace",
      videoPath: selectedVideo.outputPath,
      videoFingerprint: "fingerprint",
      videoDurationMs: 720_000,
      draftPath: "D:\\selected-video.ai-draft.srt",
      cues: [],
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    const getSubtitleVisualPreflight = vi.fn(async () => ({
      videoPath: selectedVideo.outputPath,
      videoDurationMs: 720_000,
      projectDurationMs: 600_000,
      differenceMs: 120_000,
      toleranceMs: 2_000,
      timelineCompatible: false,
      recommendedMode: "VIDEO_FIRST" as const,
      identity: "manual:selected-video",
      existingSrtCount: 0,
      projectSubtitleCount: 0,
      rawFrameEstimate: 360,
      provider: "CHATGPT" as const,
      selectionMode: "MANUAL" as const,
      warning: "影片時長與專案時間線不相容；將建立獨立草稿。",
    }));
    const startSubtitleVisualAnalysis = vi.fn(async () => ({
      mode: "VIDEO_FIRST" as const,
      generatedCount: 0,
      workspace,
    }));
    const onProjectUpdated = vi.fn();
    const api = {
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
      chooseSubtitleAnalysisVideo: vi.fn(async () => selectedVideo),
      getSubtitleVisualPreflight,
      startSubtitleVisualAnalysis,
      getStandaloneSubtitleWorkspace: vi.fn(async () => undefined),
      pauseSubtitleVisualAnalysis: vi.fn(async () => undefined),
      resumeSubtitleVisualAnalysis: vi.fn(async () => undefined),
      cancelSubtitleVisualAnalysis: vi.fn(async () => undefined),
      onSubtitleVisualAnalysisProgress: vi.fn(),
      clearSubtitleVisualAnalysisProgressListeners: vi.fn(),
    } as unknown as AppApi;
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(
      <SubtitleStudio
        project={project}
        timelineDurationMs={600_000}
        onProjectUpdated={onProjectUpdated}
        onOpenAiSettings={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "選擇影片／重新分析" }));
    await waitFor(() => expect(screen.getByText("selected-video.mp4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "開始畫面分析" }));

    expect(await screen.findByText("影片時長與專案時間線不相容；將建立獨立草稿。")).toBeInTheDocument();
    expect(getSubtitleVisualPreflight).toHaveBeenCalledOnce();
    expect(startSubtitleVisualAnalysis).not.toHaveBeenCalled();
    expect(onProjectUpdated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "確認並開始分析" }));

    await waitFor(() =>
      expect(startSubtitleVisualAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ analysisMode: "VIDEO_FIRST", srtPolicy: "BACKUP" }),
      ),
    );
    expect(await screen.findByRole("region", { name: "獨立字幕審核" })).toBeInTheDocument();
    expect(onProjectUpdated).not.toHaveBeenCalled();
  });

  it("keeps existing project draft cues visible when visual analysis fails", async () => {
    const project = {
      id: "project-preserve-cues",
      sources: [],
      timelineOrder: [],
      introSegments: [],
      subtitleCues: [{ id: "existing-cue", startMs: 0, endMs: 2_000, text: "既有字幕草稿", reviewStatus: "DRAFT" }],
      aiStoryContext: { topic: "", storySummary: "" },
      timelineTransitionSeconds: 0.3,
    } as unknown as ProjectManifest;
    const startSubtitleVisualAnalysis = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const onProjectUpdated = vi.fn();
    const api = {
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
      getSubtitleVisualPreflight: vi.fn(async () => ({
        videoPath: "D:\\video.mp4",
        videoDurationMs: 60_000,
        projectDurationMs: 60_000,
        differenceMs: 0,
        toleranceMs: 2_000,
        timelineCompatible: true,
        recommendedMode: "PROJECT_AWARE" as const,
        identity: "project:match",
        existingSrtCount: 0,
        projectSubtitleCount: 1,
        rawFrameEstimate: 30,
        provider: "CHATGPT" as const,
        selectionMode: "AUTO" as const,
      })),
      startSubtitleVisualAnalysis,
      getStandaloneSubtitleWorkspace: vi.fn(async () => undefined),
      pauseSubtitleVisualAnalysis: vi.fn(async () => undefined),
      resumeSubtitleVisualAnalysis: vi.fn(async () => undefined),
      cancelSubtitleVisualAnalysis: vi.fn(async () => undefined),
      onSubtitleVisualAnalysisProgress: vi.fn(),
      clearSubtitleVisualAnalysisProgressListeners: vi.fn(),
    } as unknown as AppApi;
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(
      <SubtitleStudio
        project={project}
        timelineDurationMs={60_000}
        onProjectUpdated={onProjectUpdated}
        onOpenAiSettings={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "開始畫面分析" }));
    fireEvent.click(await screen.findByRole("button", { name: "確認並開始分析" }));

    await waitFor(() => expect(screen.getAllByText("provider unavailable").length).toBeGreaterThan(0));
    expect(screen.getAllByText("既有字幕草稿").length).toBeGreaterThan(0);
    expect(onProjectUpdated).not.toHaveBeenCalled();
  });

  it("displays job progress counters and exposes pause, resume, and cancel controls", async () => {
    const project = {
      id: "project-b",
      sources: [],
      timelineOrder: [],
      introSegments: [],
      subtitleCues: [],
      aiStoryContext: { topic: "", storySummary: "" },
      timelineTransitionSeconds: 0.3,
    } as unknown as ProjectManifest;
    let progressListener: ((progress: SubtitleVisualAnalysisProgress) => void) | undefined;
    const pause = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const api = {
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
      startSubtitleVisualAnalysis: vi.fn(async () => undefined),
      pauseSubtitleVisualAnalysis: pause,
      resumeSubtitleVisualAnalysis: resume,
      cancelSubtitleVisualAnalysis: cancel,
      onSubtitleVisualAnalysisProgress: vi.fn((callback) => {
        progressListener = callback;
      }),
      clearSubtitleVisualAnalysisProgressListeners: vi.fn(),
    } as unknown as AppApi;
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(
      <SubtitleStudio
        project={project}
        timelineDurationMs={60_000}
        onProjectUpdated={vi.fn()}
        onOpenAiSettings={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    progressListener?.({
      status: "RUNNING",
      rawFrames: 40,
      sceneFrames: 5,
      deduplicatedFrames: 3,
      sentFrames: 42,
      requests: 4,
      elapsedMs: 12_000,
      tokens: 900,
      cacheHits: 7,
      temporaryBytes: 2048,
    });
    expect(await screen.findByText(/原始 40 · 場景 5 · 去重 3 · 已送出 42 張/)).toBeInTheDocument();
    expect(screen.getByText(/請求 4 · 經過 .* · Token 900 · 快取命中 7/)).toBeInTheDocument();
    const controls = within(screen.getByRole("region", { name: "字幕畫面分析工作" }));
    fireEvent.click(controls.getAllByRole("button", { name: "暫停" })[0]);
    await waitFor(() => expect(pause).toHaveBeenCalledOnce());
    fireEvent.click(controls.getAllByRole("button", { name: "繼續" })[0]);
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    fireEvent.click(controls.getAllByRole("button", { name: "取消分析" })[0]);
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});
