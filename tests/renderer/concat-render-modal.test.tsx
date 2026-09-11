// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
      prependIntro: false,
      autoUpload: false,
    },
  })),
  getBackgroundJobs: vi.fn(async () => []),
  onBackgroundJobs: vi.fn(),
  clearBackgroundJobsListeners: vi.fn(),
  setTimelineTransitionSeconds: vi.fn(async () => ({})),
  startConcatRender: vi.fn(() => new Promise(() => {})),
  cancelConcatRender: vi.fn(),
};

describe("concat render background mode", () => {
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
});
