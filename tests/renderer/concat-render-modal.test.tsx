// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcatRenderModal } from "../../src/renderer/components/ConcatRenderModal";

const asset = {
  id: "a",
  kind: "VIDEO",
  fileName: "測試.mp4",
  sourcePath: "C:/測試.mp4",
} as never;

const api = {
  onConcatProgress: vi.fn(),
  clearConcatProgressListeners: vi.fn(),
  prepareConcatOutput: vi.fn(async () => ({ token: "t", displayPath: "C:/out.mp4", automatic: true })),
  getUserPreferences: vi.fn(async () => ({
    renderDefaults: {
      transitionSeconds: 0.3,
      resolution: "480P",
      videoCodec: "H265",
      includeWatermark: true,
      audioProtection: {},
      mainBgmScopes: { intro: true, main: false },
      youtubeHandoffMode: "CHROME_DRAG_DROP",
      subtitleBurnInDefaults: { enabled: false, tracks: [] },
      subtitlePreviewStyle: {
        verticalPositionPercent: 82,
        fontSizePx: 28,
        textColor: "#FFFFFF",
        shadowEnabled: true,
        outlineWidthPx: 2,
      },
      introPreviewIncludeBgm: false,
      mainPreviewIncludeBgm: false,
      prependIntro: true,
      autoUpload: true,
      lowMemorySegmented: true,
      youtubeFullAutoUpload: true,
    },
  })),
  updateUserPreferences: vi.fn(async () => ({})),
  getBackgroundJobs: vi.fn(async () => []),
  onBackgroundJobs: vi.fn(),
  clearBackgroundJobsListeners: vi.fn(),
  setTimelineTransitionSeconds: vi.fn(async () => ({})),
  estimateConcatRender: vi.fn(async (request) => ({
    outputPath: "C:/out.mp4",
    driveRoot: "C:/",
    currentFreeBytes: 20 * 1024 ** 3,
    estimatedOutputBytes: 100 * 1024 ** 2,
    estimatedTemporaryBytes: request.lowMemorySegmented ? 300 * 1024 ** 2 : 100 * 1024 ** 2,
    estimatedRenderTimeMs: request.lowMemorySegmented ? 90_000 : 60_000,
    estimatedFreeAfterBytes: 20 * 1024 ** 3 - 100 * 1024 ** 2,
    minimumReserveBytes: 1024 ** 3,
    canRender: true,
    currentAvailableRamBytes: 8 * 1024 ** 3,
    totalRamBytes: 16 * 1024 ** 3,
    modeEstimates: {
      lowMemory: {
        lowMemorySegmented: true,
        usesSegmentedPipeline: true,
        estimatedOutputBytes: 100 * 1024 ** 2,
        estimatedTemporaryBytes: 300 * 1024 ** 2,
        estimatedPeakRamBytes: 2 * 1024 ** 3,
        estimatedRenderTimeMs: 90_000,
        estimatedFreeAfterBytes: 20 * 1024 ** 3 - 100 * 1024 ** 2,
        maximumSimultaneousInputs: 6,
        intermediateJobCount: 2,
        warningLevel: "NONE",
        warnings: [],
        canRender: true,
      },
      normal: {
        lowMemorySegmented: false,
        usesSegmentedPipeline: false,
        estimatedOutputBytes: 100 * 1024 ** 2,
        estimatedTemporaryBytes: 100 * 1024 ** 2,
        estimatedPeakRamBytes: 6 * 1024 ** 3,
        estimatedRenderTimeMs: 60_000,
        estimatedFreeAfterBytes: 20 * 1024 ** 3 - 100 * 1024 ** 2,
        maximumSimultaneousInputs: 12,
        intermediateJobCount: 0,
        warningLevel: "NONE",
        warnings: [],
        canRender: true,
      },
    },
    workload: {
      visualInputCount: 12,
      insertedInputCount: 2,
      photoInputCount: 2,
      videoInputCount: 10,
      sourceDurationMs: 60_000,
      weightedSourceFps: 29.97,
      weightedSourceWidth: 1920,
      weightedSourceHeight: 1080,
      transitionSeconds: 0.3,
    },
  })),
  startConcatRender: vi.fn(() => new Promise(() => {})),
  cancelConcatRender: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("concat render background mode", () => {
  it("shows protected v0.79 recovery evidence without offering to discard its original checkpoint", async () => {
    const discardConcatRenderResume = vi.fn();
    Object.defineProperty(window, "sourceApp", {
      configurable: true,
      value: {
        ...api,
        discardConcatRenderResume,
        getConcatRenderResumeOffer: vi.fn(async () => ({
          checkpointId: "v079-checkpoint",
          projectId: "project-a",
          outputPath: "E:/final.mp4",
          mode: "HIGH_SPEED",
          completedSegmentCount: 10,
          totalSegmentCount: 10,
          concatStatus: "PAUSED_DISK_SPACE",
          updatedAt: "2026-09-26T18:27:21.057Z",
          cumulativeElapsedMs: 85_323_907,
          reusableBytes: 72_527_956_978,
          reusableDurationMs: 8_976_718,
          legacyRecoveryProtected: true,
          currentTempFreeBytes: 155_105_148_928,
          estimatedRemainingWriteBytes: 66_416_310_581,
          tempVolume: "E:/",
        })),
      },
    });
    render(<ConcatRenderModal assets={[asset]} onClose={vi.fn()} />);
    const offer = await screen.findByRole("status", { name: "未完成轉檔續轉" });
    expect(offer).toHaveTextContent("片段階段已完成 100%");
    expect(offer).toHaveTextContent("可重用資料");
    expect(offer).toHaveTextContent("上次磁碟紀錄（非即時");
    expect(offer).toHaveTextContent("v0.79 原 checkpoint 與片段受保護");
    expect(screen.getByRole("button", { name: "捨棄舊進度" })).toBeDisabled();
    expect(discardConcatRenderResume).not.toHaveBeenCalled();
  });

  it("reviews the exact canonical insertion SFX/BGM rows and merged range before render", async () => {
    const photo = {
      id: "photo-a",
      kind: "IMAGE",
      fileName: "照片 A.jpg",
      sourcePath: "C:/照片 A.jpg",
      imageDurationMs: 3_000,
      mediaInfo: { durationMs: 3_000 },
    } as never;
    const host = {
      id: "a", kind: "VIDEO", fileName: "測試.mp4", sourcePath: "C:/測試.mp4",
      mediaInfo: { durationMs: 8_000, audioCodec: "aac" },
    } as never;
    const project = {
      schemaVersion: 20,
      id: "project-a",
      name: "音讯确认",
      sourcePolicy: "READ_ONLY",
      previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
      previewerVersion: "preview-v5-orientation-planar-safe",
      sortMode: "MANUAL_ORDER",
      createdAt: "",
      updatedAt: "",
      sources: [host, photo],
      timelineOrder: ["a"],
      timelineTransitionSeconds: 0.3,
      pendingAssetIds: [],
      excludedMainAssetIds: [],
      recentMainRemovals: [],
      introSegments: [],
      introTargetDurationMs: 90_000,
      introSegmentMaxDurationMs: 15_000,
      colorSettings: { introPresetId: "NATURAL", applyToMain: false },
      introExcludedSegmentIds: [],
      recentIntroRemovals: [],
      placementDecisions: [],
      mediaInsertions: [{
        id: "insert-a", anchorVideoAssetId: "a", insertedAssetId: "photo-a", atMs: 4_000,
        sourceInMs: 0, sourceOutMs: 3_000, sequenceIndex: 0, previousPlacement: "PENDING",
        previousTimelineIndex: 1, createdAt: "", insertionAudio: {
          sfxEnabled: true, sfxId: "DUNES_CAMERA_SHUTTER_CLICK_14671", sfxVolumePercent: 70,
          bgmTrackId: "music", bgmVolumePercent: 28, fadeMs: 180, loopCrossfadeMs: 120,
        },
      }],
      photoSoundEffect: {
        id: "DUNES_CAMERA_SHUTTER_CLICK_14671", displayName: "相機快門效果音（SFX）", sourceProject: "licensed",
        sourceUrl: "", licenseUrl: "", sha256: "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93", volumePercent: 70,
      },
      bgmTracks: [{
        id: "music", sourcePath: "C:/music.mp3", fileName: "旅程.mp3", sizeBytes: 1, durationMs: 1_000,
        sourceInMs: 0, sourceOutMs: 1_000, timelineInMs: 0, timelineOutMs: 1_000,
        fadeInMs: 0, fadeOutMs: 0, volumePercent: 35, sourcePolicy: "READ_ONLY", addedAt: "",
      }],
      sourceAudioVolumePercent: 100,
      aiStoryContext: { topic: "", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh-TW" },
      subtitleCues: [], timelineRevision: 1, subtitleTimelineRevision: 1,
      audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
    } as never;
    const localApi = {
      ...api,
      getUserPreferences: vi.fn(async () => ({
        ...(await api.getUserPreferences()),
        renderDefaults: { ...(await api.getUserPreferences()).renderDefaults, mainPreviewIncludeBgm: true },
      })),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: localApi });
    render(
      <ConcatRenderModal
        project={project}
        assets={[host, photo]}
        mainClips={[
          { assetId: "a", inMs: 0, outMs: 4_000 },
          { assetId: "photo-a", inMs: 0, outMs: 3_000, mediaInsertionId: "insert-a" },
          { assetId: "a", inMs: 4_000, outMs: 8_000 },
        ] as never}
        onClose={vi.fn()}
      />,
    );
    const review = await screen.findByRole("region", { name: "插入素材音訊確認" });
    expect(review).toHaveTextContent("照片 A.jpg");
    expect(review).toHaveTextContent("相機快門效果音（SFX） · 70%");
    expect(review).toHaveTextContent("#1 旅程.mp3");
    expect(review).toHaveTextContent("交叉淡化循環 120 ms");
    expect(review).toHaveTextContent("1 個連續素材");
  });

  it("puts the default-on Intro join and low-memory controls before transition settings", async () => {
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(
      <ConcatRenderModal
        assets={[asset]}
        introClips={[{ id: "intro-1", assetId: "a", fileName: "測試.mp4", inMs: 0, outMs: 1000 }] as never}
        mainClips={[{ assetId: "a", inMs: 0, outMs: 1000 }] as never}
        onClose={vi.fn()}
      />,
    );
    const introHeading = await screen.findByRole("heading", { name: "片頭＋正片串接" });
    const transitionHeading = screen.getByRole("heading", { name: "交接疊化秒數" });
    expect(introHeading.compareDocumentPosition(transitionHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "自動串接已確認片頭加正片" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "低記憶體分段轉檔模式" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "一般轉檔模式" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "高速轉檔模式" })).not.toBeChecked();
    expect(await screen.findByRole("table", { name: "三種轉檔資源策略比較" })).toHaveTextContent("低磁碟／低記憶體");
    expect(screen.getByRole("table", { name: "三種轉檔資源策略比較" })).toHaveTextContent("平衡");
    fireEvent.click(screen.getByRole("radio", { name: "一般轉檔模式" }));
    expect(screen.getByRole("radio", { name: "一般轉檔模式" })).toBeChecked();
    await waitFor(() =>
      expect(api.estimateConcatRender).toHaveBeenLastCalledWith(expect.objectContaining({ lowMemorySegmented: false })),
    );
    expect(screen.getByRole("checkbox", { name: "YouTube 全自動上傳" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "启用成功后自动电源动作" })).not.toBeChecked();
  });

  it("keeps × enabled during rendering; closing does not cancel the render", async () => {
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    const onClose = vi.fn();
    render(
      <ConcatRenderModal
        assets={[asset]}
        mainClips={[{ assetId: "a", inMs: 0, outMs: 1000 }] as never}
        onClose={onClose}
      />,
    );
    const startButton = await screen.findByRole("button", { name: "OK，開始產出" });
    await waitFor(() => expect(startButton).not.toBeDisabled());
    fireEvent.click(startButton);
    await screen.findByRole("button", { name: "取消產出" });
    const closeButton = screen.getByRole("button", { name: "關閉" });
    expect(closeButton).not.toBeDisabled();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.cancelConcatRender).not.toHaveBeenCalled();
  });

  it("shows actual elapsed and ETA separately, then labels a successful total", async () => {
    let progressListener: ((progress: Record<string, unknown>) => void) | undefined;
    (
      api.onConcatProgress as unknown as {
        mockImplementation: (implementation: (listener: NonNullable<typeof progressListener>) => void) => void;
      }
    ).mockImplementation((listener) => {
      progressListener = listener;
    });
    let resolveRender: ((result: unknown) => void) | undefined;
    api.startConcatRender.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
    );
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(
      <ConcatRenderModal
        assets={[asset]}
        mainClips={[{ assetId: "a", inMs: 0, outMs: 1000 }] as never}
        onClose={vi.fn()}
      />,
    );
    const startButton = await screen.findByRole("button", { name: "OK，開始產出" });
    await waitFor(() => expect(startButton).not.toBeDisabled());
    fireEvent.click(startButton);
    await waitFor(() => expect(api.startConcatRender).toHaveBeenCalledTimes(1));
    act(() =>
      progressListener?.({
        phase: "RENDERING",
        percent: 50,
        outTimeMs: 500,
        expectedDurationMs: 1_000,
        attemptElapsedMs: 305_000,
        cumulativeElapsedMs: 305_000,
        estimatedRemainingMs: 610_000,
        timingCapturedAt: new Date().toISOString(),
        timingStatus: "RUNNING",
      }),
    );
    expect(await screen.findByText("已耗時：00:05:05")).toBeInTheDocument();
    expect(screen.getByText("預估剩餘：00:10:10")).toBeInTheDocument();

    await act(async () =>
      resolveRender?.({
        jobId: "job",
        outputPath: "C:/out.mp4",
        sizeBytes: 123,
        expectedDurationMs: 1_000,
        transitionSeconds: 0.3,
        resolution: "480P",
        videoCodec: "H265",
        purpose: "CONCAT",
        attemptElapsedMs: 306_000,
        cumulativeElapsedMs: 306_000,
      }),
    );
    expect(await screen.findByText("轉檔完成")).toBeInTheDocument();
    expect(screen.getByText("總耗時")).toBeInTheDocument();
    expect(screen.getByText("00:05:06")).toBeInTheDocument();
  });

  it.each([
    ["FAILED", "FFmpeg 啟動失敗", "轉檔失敗", 4_363_000, 12_000_000, "01:12:43"],
    ["CANCELLED", "使用者取消", "轉檔已取消", 4_363_000, 4_363_000, "01:12:43"],
  ] as const)(
    "shows persisted %s attempt time when the render exits with an error",
    async (timingStatus, message, heading, attemptElapsedMs, cumulativeElapsedMs, expectedClock) => {
      let progressListener: ((progress: Record<string, unknown>) => void) | undefined;
      (
        api.onConcatProgress as unknown as {
          mockImplementation: (implementation: (listener: NonNullable<typeof progressListener>) => void) => void;
        }
      ).mockImplementation((listener) => {
        progressListener = listener;
      });
      let rejectRender: ((reason: unknown) => void) | undefined;
      api.startConcatRender.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRender = reject;
          }),
      );
      Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
      render(
        <ConcatRenderModal
          assets={[asset]}
          mainClips={[{ assetId: "a", inMs: 0, outMs: 1000 }] as never}
          onClose={vi.fn()}
        />,
      );
      const startButton = await screen.findByRole("button", { name: "OK，開始產出" });
      await waitFor(() => expect(startButton).not.toBeDisabled());
      fireEvent.click(startButton);
      await waitFor(() => expect(api.startConcatRender).toHaveBeenCalledTimes(1));
      act(() =>
        progressListener?.({
          phase: "RENDERING",
          percent: 40,
          outTimeMs: 400,
          expectedDurationMs: 1_000,
          attemptElapsedMs,
          cumulativeElapsedMs,
          timingCapturedAt: new Date().toISOString(),
          timingStatus,
        }),
      );
      await act(async () => rejectRender?.(new Error(message)));
      expect(await screen.findByText(heading)).toBeInTheDocument();
      expect(screen.getByText(`本次耗時：${expectedClock}`)).toBeInTheDocument();
      if (cumulativeElapsedMs !== attemptElapsedMs)
        expect(screen.getByText("累積轉檔耗時：03:20:00")).toBeInTheDocument();
    },
  );
});
