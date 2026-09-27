// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YoutubeUploadModal } from "../../src/renderer/components/YoutubeUploadModal";

describe("YouTube full automatic upload", () => {
  it("selects not-for-kids, confirms the review statement and starts the verified official upload", async () => {
    const uploadYoutubeVideo = vi.fn(async () => ({
      videoId: "video-1",
      videoUrl: "https://youtu.be/video-1",
      title: "自動上傳測試",
      requestedPrivacyStatus: "unlisted",
      channelId: "channel-1",
      channelTitle: "漫步風光SceneryWalker",
      thumbnailStatus: "NOT_REQUESTED",
    }));
    Object.defineProperty(window, "sourceApp", {
      configurable: true,
      value: {
        getYoutubeSettings: vi.fn(async () => ({
          schemaVersion: 1,
          preferredBrowser: "CHROME",
          targetChannelName: "漫步風光SceneryWalker",
          clientConfigured: true,
          connected: true,
          channelId: "channel-1",
          channelTitle: "漫步風光SceneryWalker",
          encryptionAvailable: true,
          browsers: [],
        })),
        getUserPreferences: vi.fn(async () => ({ youtubeUploadDefaults: { privacyStatus: "unlisted" } })),
        getAiPublishAssets: vi.fn(async () => undefined),
        onYoutubeUploadProgress: vi.fn(),
        clearYoutubeUploadProgressListeners: vi.fn(),
        uploadYoutubeVideo,
        cancelYoutubeUpload: vi.fn(),
      },
    });

    render(
      <YoutubeUploadModal
        automaticUpload
        renderResult={{
          jobId: "job-1",
          outputPath: "C:/Output/自動上傳測試.mp4",
          sizeBytes: 1_000,
          durationMs: 60_000,
          resolution: "720P",
          purpose: "CONCAT",
        }}
        onOpenSettings={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /我已播放檢查影片/ })).toBeChecked();
    await waitFor(() =>
      expect(uploadYoutubeVideo).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", madeForKids: false, privacyStatus: "unlisted" }),
      ),
    );
  });
});
