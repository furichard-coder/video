// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProcessingSettings } from "../../src/renderer/components/AudioProcessingSettings";
import { DEFAULT_AUDIO_PROCESSING_OPTIONS, type AudioProcessingOptions, type SourceAsset } from "../../src/shared/domain";

const asset = {
  id: "a".repeat(64),
  sourcePath: "C:/Media/clip.mp4",
  fileName: "clip.mp4",
  kind: "VIDEO",
  mediaInfo: { audioCodec: "aac", durationMs: 60_000 },
} as unknown as SourceAsset;

function Harness({ api, initial = DEFAULT_AUDIO_PROCESSING_OPTIONS }: { api: Record<string, unknown>; initial?: AudioProcessingOptions }) {
  const [value, setValue] = useState(initial);
  return <AudioProcessingSettings value={value} assets={[asset]} timelineRevision={17} stepLabel="A" onChange={setValue} />;
}

function result(mode: AudioProcessingOptions["mode"], startMs = 5_000) {
  return {
    cacheKey: `${mode}-${startMs}`,
    url: `preview-media://audio-preview/${mode}-${startMs}`,
    mode,
    monitoring: "STEREO" as const,
    durationMs: 20_000,
    startMs,
    meter: { channelPeaksDb: [-12, -12], clipping: false, warnings: [] },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AudioProcessingSettings live preview", () => {
  it("requests one proxy and a playhead-centered 20-second A/B range with timeline revision", async () => {
    const api = {
      ensurePreview: vi.fn(async () => ({ url: "preview-media://cache/proxy/video_proxy" })),
      createAudioPreview: vi.fn(async (request) => result(request.options.mode, request.startMs)),
      cancelAudioPreview: vi.fn(),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<Harness api={api} initial={{ ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" }} />);
    fireEvent.click(screen.getByRole("button", { name: "启动 Proxy 即时音效试听" }));
    await waitFor(() => expect(document.querySelector("video")).toBeInTheDocument());
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 12.4 });
    await waitFor(() => expect(api.createAudioPreview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "依目前播放位置重建 20 秒试听" }));
    await waitFor(() => expect(api.createAudioPreview).toHaveBeenCalledTimes(4));
    expect(api.ensurePreview).toHaveBeenCalledOnce();
    expect(api.createAudioPreview).toHaveBeenNthCalledWith(3, expect.objectContaining({ assetId: asset.id, startMs: 7_400, durationMs: 20_000, timelineRevision: 17, options: expect.objectContaining({ mode: "ORIGINAL_STEREO" }) }));
    expect(api.createAudioPreview).toHaveBeenNthCalledWith(4, expect.objectContaining({ startMs: 7_400, durationMs: 20_000, timelineRevision: 17 }));
  });

  it("keeps the proxy playhead when switching A/B and never invokes a render API", async () => {
    const api = {
      ensurePreview: vi.fn(async () => ({ url: "preview-media://cache/proxy/video_proxy" })),
      createAudioPreview: vi.fn(async (request) => result(request.options.mode, request.startMs)),
      cancelAudioPreview: vi.fn(),
      startConcatRender: vi.fn(),
      renderAudio: vi.fn(),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<Harness api={api} initial={{ ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" }} />);
    fireEvent.click(screen.getByRole("button", { name: "启动 Proxy 即时音效试听" }));
    await waitFor(() => expect(document.querySelector("video")).toBeInTheDocument());
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 12 });
    await waitFor(() => expect(api.createAudioPreview).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "B · Enhanced" }));
    const audios = [...document.querySelectorAll("audio")];
    expect(audios[1].currentTime).toBeCloseTo(12, 1);
    expect(api.startConcatRender).not.toHaveBeenCalled();
    expect(api.renderAudio).not.toHaveBeenCalled();
  });

  it("cancels and debounces parameter changes, regenerating only the latest processed preview", async () => {
    const api = {
      ensurePreview: vi.fn(async () => ({ url: "preview-media://cache/proxy/video_proxy" })),
      createAudioPreview: vi.fn(async (request) => result(request.options.mode, request.startMs)),
      cancelAudioPreview: vi.fn(),
    };
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    render(<Harness api={api} initial={{ ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" }} />);
    fireEvent.click(screen.getByRole("button", { name: "启动 Proxy 即时音效试听" }));
    await waitFor(() => expect(api.createAudioPreview).toHaveBeenCalledTimes(2));
    const width = screen.getByRole("slider", { name: /Stereo Width/ });
    fireEvent.change(width, { target: { value: "125" } });
    fireEvent.change(width, { target: { value: "130" } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.createAudioPreview).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await waitFor(() => expect(api.createAudioPreview).toHaveBeenCalledTimes(3));
    expect(api.cancelAudioPreview).toHaveBeenCalled();
    expect(api.createAudioPreview).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ stereoWidthPercent: 130, mode: "ENHANCED_STEREO" }) }));
  });
});
