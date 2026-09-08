// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInputButton } from "../../src/renderer/components/VoiceInputButton";

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(value: string) { return value.startsWith("audio/webm"); }
  state: RecordingState = "inactive";
  readonly mimeType: string;
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) { super(); this.mimeType = options?.mimeType ?? "audio/webm"; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: new Blob([new Uint8Array([1, 2, 3]).buffer], { type: this.mimeType }) });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event("stop"));
  }
}

describe("voice input button", () => {
  const stopTrack = vi.fn();
  beforeEach(() => {
    vi.restoreAllMocks(); stopTrack.mockClear();
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    Object.defineProperty(window, "sourceApp", { configurable: true, value: { transcribeVoiceInput: vi.fn(async () => ({ text: "河內旅行特色", language: "zh-TW", segmentCount: 1 })) } });
  });
  afterEach(() => cleanup());

  it("records, stops tracks, sends Chinese audio and returns editable text", async () => {
    const onTranscript = vi.fn(); const onError = vi.fn();
    render(<VoiceInputButton language="zh-TW" onTranscript={onTranscript} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "繁體中文語音輸入" }));
    expect(await screen.findByRole("button", { name: "停止錄音並辨識文字" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止錄音並辨識文字" }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("河內旅行特色"));
    expect(window.sourceApp.transcribeVoiceInput).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/webm;codecs=opus", language: "zh-TW", audioBytes: expect.any(Uint8Array) }));
    expect(stopTrack).toHaveBeenCalled(); expect(onError).toHaveBeenCalledWith("");
  });
});
