// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewModal } from "../../src/renderer/components/PreviewModal";
import type { AppApi, ProjectManifest, SourceAsset } from "../../src/shared/domain";

afterEach(cleanup);

const host = {
  id: "host", kind: "VIDEO", fileName: "host.mp4", sourcePath: "C:/host.mp4",
  mediaInfo: { durationMs: 8_000, audioCodec: "aac" },
} as SourceAsset;
const photo = {
  id: "photo", kind: "IMAGE", fileName: "photo.jpg", sourcePath: "C:/photo.jpg",
  imageDurationMs: 3_000, photoSoundEnabled: true, mediaInfo: { width: 1080, height: 1920, isPortrait: true },
} as SourceAsset;

function fixture(): ProjectManifest {
  return {
    schemaVersion: 20, id: "p", name: "p", sourcePolicy: "READ_ONLY", previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewerVersion: "preview-v5-orientation-planar-safe", sortMode: "MANUAL_ORDER", createdAt: "", updatedAt: "",
    sources: [host, photo], timelineOrder: [host.id], timelineTransitionSeconds: 0.3, pendingAssetIds: [],
    excludedMainAssetIds: [], recentMainRemovals: [], introSegments: [], introTargetDurationMs: 90_000,
    introSegmentMaxDurationMs: 15_000, colorSettings: { introPresetId: "NATURAL", applyToMain: false },
    introExcludedSegmentIds: [], recentIntroRemovals: [], placementDecisions: [], mainStartCue: { enabled: true, durationMs: 650 },
    mediaInsertions: [{
      id: "insert-photo", anchorVideoAssetId: host.id, insertedAssetId: photo.id, atMs: 4_000,
      sourceInMs: 0, sourceOutMs: 3_000, sequenceIndex: 0, previousPlacement: "PENDING", previousTimelineIndex: 1,
      createdAt: "", insertionAudio: {
        sfxEnabled: true, sfxId: "DUNES_CAMERA_SHUTTER_CLICK_14671", sfxVolumePercent: 70,
        bgmTrackId: "music", bgmVolumePercent: 28, fadeMs: 180, loopCrossfadeMs: 120,
      },
    }],
    photoSoundEffect: {
      id: "DUNES_CAMERA_SHUTTER_CLICK_14671", displayName: "相機快門效果音（SFX）", sourceProject: "licensed",
      sourceUrl: "", licenseUrl: "", sha256: "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93", volumePercent: 70,
    },
    bgmTracks: [{
      id: "music", sourcePath: "C:/music.mp3", fileName: "music.mp3", sizeBytes: 1, durationMs: 1_000,
      sourceInMs: 0, sourceOutMs: 1_000, timelineInMs: 0, timelineOutMs: 1_000,
      fadeInMs: 0, fadeOutMs: 0, volumePercent: 35, sourcePolicy: "READ_ONLY", addedAt: "",
    }],
    sourceAudioVolumePercent: 100,
    aiStoryContext: { topic: "", locations: [], people: [], storySummary: "", audiencePromise: "", subtitleLanguage: "zh-TW" },
    subtitleCues: [], timelineRevision: 1, subtitleTimelineRevision: 1,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  };
}

describe("enlarged insertion audio preview", () => {
  it("does not guess an occurrence and lets the user select the exact canonical instance", async () => {
    const project = fixture();
    const api = {
      ensureMetadata: vi.fn(async () => photo),
      ensurePreview: vi.fn(async () => ({ assetId: photo.id, variant: "IMAGE_PREVIEW", url: "preview-media://asset/photo", cacheStatus: "HIT" })),
      cancelPreview: vi.fn(async () => undefined),
    } as unknown as AppApi;
    Object.defineProperty(window, "sourceApp", { configurable: true, value: api });
    const { container } = render(
      <PreviewModal
        asset={photo}
        project={project}
        onClose={vi.fn()}
        onAssetUpdated={vi.fn()}
        onProjectUpdated={vi.fn()}
        onOpenExternal={vi.fn()}
        onOpenIntro={vi.fn()}
      />,
    );
    await screen.findByRole("img", { name: photo.fileName });
    expect(screen.getByText(/一般來源預覽只播放原素材/)).toBeInTheDocument();
    const selector = screen.getByRole("combobox", { name: "選擇插入實例混音" });
    expect(selector).toHaveValue("");
    fireEvent.change(selector, { target: { value: "insert-photo" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /試聽這個照片實例/ })).toBeInTheDocument());
    const audioSources = [...container.querySelectorAll("audio")].map((item) => item.getAttribute("src"));
    expect(audioSources).toContain("preview-media://asset/dunes-shutter.mp3");
    expect(audioSources).toContain("preview-media://bgm/music");
  });
});
