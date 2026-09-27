import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildConcatFilterGraph,
  buildWatermarkFilterChain,
  concatInputStartTimesMs,
  ConcatRenderService,
  groupLowMemoryInputs,
  hardwareDecodeIndexes,
  runFfmpegWithProgress,
  selectBgmTracksForScopes,
  validateAudioProtectionOptions,
  validateBgmScopeSelection,
  validateMainStartCardOptions,
} from "../src/main/services/concat-render";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";
import { ProjectStore } from "../src/main/services/project-store";
import { RenderCheckpointStore } from "../src/main/services/render-checkpoint";
import { SourceService } from "../src/main/services/source-service";
import { mainRenderSelections } from "../src/shared/editing-rules";
import { colorPreset } from "../src/shared/color-presets";
import { DEFAULT_AUDIO_PROCESSING_OPTIONS, DEFAULT_AUDIO_PROTECTION_OPTIONS } from "../src/shared/domain";

let root: string;
let firstPath: string;
let secondPath: string;
let outputPath: string;
let shutterPath: string;
let introPath: string;
let store: ProjectStore;
let sources: SourceService;
let introStore: ProjectStore;
let introSources: SourceService;

async function volumeStats(filePath: string, start: number, duration: number): Promise<{ mean: number; max: number }> {
  const result = await runProcess("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-ss",
    String(start),
    "-t",
    String(duration),
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const meanRaw = /mean_volume:\s*(-?inf|[-\d.]+) dB/i.exec(result.stderr)?.[1];
  const maxRaw = /max_volume:\s*(-?inf|[-\d.]+) dB/i.exec(result.stderr)?.[1];
  return {
    mean: meanRaw === "-inf" ? -Infinity : Number(meanRaw),
    max: maxRaw === "-inf" ? -Infinity : Number(maxRaw),
  };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function packetHash(filePath: string, stream: "v:0" | "a:0"): Promise<string> {
  const result = await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", filePath, "-map", `0:${stream}`,
    "-c", "copy", "-f", "hash", "-hash", "sha256", "-",
  ]);
  return result.stdout.trim();
}

function currentMainRequest() {
  const clipSelections = mainRenderSelections(store.getProject());
  return { orderedAssetIds: clipSelections.map((clip) => clip.assetId), clipSelections };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-app-concat-")));
  firstPath = path.join(root, "clip01.mp4");
  secondPath = path.join(root, "clip02.mp4");
  outputPath = path.join(root, "joined-preview.mp4");
  shutterPath = path.join(root, "camera-shutter.wav");
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=960x540:r=30000/1001",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "1.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    firstPath,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1800:sample_rate=48000:duration=0.18",
    "-c:a",
    "pcm_s16le",
    "-y",
    shutterPath,
  ]);
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=480x854:r=24",
    "-t",
    "1.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-y",
    secondPath,
  ]);
  store = new ProjectStore(path.join(root, "app-data"));
  await store.initialize();
  sources = new SourceService(store, new MediaProbe());
  await sources.importSelected([firstPath, secondPath]);
  await Promise.all(store.getProject().sources.map((asset) => sources.ensureMetadata(asset.id)));
  introPath = path.join(root, "intro-long.mp4");
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=550:sample_rate=48000",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    introPath,
  ]);
  introStore = new ProjectStore(path.join(root, "intro-app-data"));
  await introStore.initialize();
  introSources = new SourceService(introStore, new MediaProbe());
  await introSources.importSelected([introPath]);
  await introSources.ensureMetadata(introStore.getProject().sources[0].id);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("concat preview filter plan", () => {
  it.each([
    [0, undefined],
    [90, "transpose=cclock"],
    [180, "hflip,vflip"],
    [270, "transpose=clock"],
    [-90, "transpose=clock"],
    [-180, "hflip,vflip"],
    [-270, "transpose=cclock"],
  ] as const)("normalizes rotation metadata %s exactly once before layout", (rotation, expected) => {
    const plan = buildConcatFilterGraph(
      [
        {
          sourcePath: "rotated.mp4",
          durationMs: 4_000,
          hasAudio: false,
          isPortrait: rotation === 90 || rotation === 270 || rotation === -90 || rotation === -270,
          orientationRotationDegrees: rotation,
        },
      ],
      0.3,
      "1080P",
    );
    const orientationFilters = plan.filterGraph.match(/transpose=(?:c?clock)|hflip,vflip/g) ?? [];
    expect(orientationFilters).toEqual(expected ? [expected] : []);
    if (expected) expect(plan.filterGraph.indexOf(expected)).toBeLessThan(plan.filterGraph.indexOf("fps=30000/1001"));
  });

  it("skips duplicate normalization in reduction stages and bridges QSV frames to CPU filters", () => {
    const inputs = [
      { sourcePath: "a.mp4", durationMs: 4_000, hasAudio: true, orientationRotationDegrees: 270 },
      { sourcePath: "b.mp4", durationMs: 4_000, hasAudio: true },
    ];
    const normalized = buildConcatFilterGraph(inputs, 0.3, "1080P", [], 100, false, undefined, {
      inputsAreNormalized: true,
    });
    expect(normalized.filterGraph).not.toMatch(/scale=|fps=30000\/1001/);
    const hardware = buildConcatFilterGraph(inputs, 0.3, "1080P", [], 100, false, undefined, {
      hardwareDecodedInputIndexes: new Set([0]),
    });
    expect(hardware.filterGraph).toContain("[0:v:0]hwdownload,format=nv12[vdownload0]");
    expect(hardware.filterGraph).toContain("[vdownload0]transpose=clock[voriented0]");
    expect(hardware.filterGraph).toContain("[voriented0]format=yuv420p[vplanar0]");
    expect(hardware.filterGraph).toContain("[vplanar0]fps=30000/1001");
    expect(hardware.filterGraph.indexOf("hwdownload")).toBeLessThan(hardware.filterGraph.indexOf("transpose=clock"));
  });

  it("keeps rotated blurred-fill inputs off the QSV decoder while retaining safe hardware decode candidates", () => {
    const rotatedPortrait = {
      sourcePath: "tunnel.mp4",
      sourceVideoCodec: "h264",
      durationMs: 4_000,
      hasAudio: true,
      isPortrait: true,
      orientationRotationDegrees: 270,
    };
    const landscape = {
      sourcePath: "landscape.mp4",
      sourceVideoCodec: "h264",
      durationMs: 4_000,
      hasAudio: true,
      isPortrait: false,
      orientationRotationDegrees: 0,
    };
    expect([...hardwareDecodeIndexes([rotatedPortrait, landscape], true, false)]).toEqual([1]);
    expect([...hardwareDecodeIndexes([rotatedPortrait], true, true)]).toEqual([]);
  });
  it("uses cumulative overlap offsets and the requested fixed preview size", () => {
    const plan = buildConcatFilterGraph(
      [
        { sourcePath: "one.mp4", durationMs: 10_000, hasAudio: true },
        { sourcePath: "two.mp4", durationMs: 20_000, hasAudio: false },
        { sourcePath: "three.mp4", durationMs: 30_000, hasAudio: true },
      ],
      0.5,
      "480P",
    );

    expect(plan.expectedDurationMs).toBe(59_000);
    expect(plan.width).toBe(854);
    expect(plan.height).toBe(480);
    expect(plan.filterGraph).toContain("duration=0.5:offset=9.5");
    expect(plan.filterGraph).toContain("duration=0.5:offset=29");
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo");
  });

  it("builds bounded voice ducking, speech-band EQ and the selected peak ceiling by default", () => {
    const plan = buildConcatFilterGraph([{ sourcePath: "voice.mp4", durationMs: 4_000, hasAudio: true }], 0.3, "480P");
    expect(plan.filterGraph).toContain("highpass=f=1000,lowpass=f=4000");
    expect(plan.filterGraph).toContain("sidechaincompress=threshold=0.09:ratio=12:attack=45:release=500");
    expect(plan.filterGraph).toContain("volume=0.501187");
    expect(plan.filterGraph).toContain("equalizer=f=2500:t=q:w=0.8:g=-1.5");
    expect(plan.filterGraph).toContain("acompressor=threshold=0.891251:ratio=2");
    expect(plan.filterGraph).toContain("alimiter=limit=0.891251");
    const disabled = buildConcatFilterGraph(
      [{ sourcePath: "voice.mp4", durationMs: 4_000, hasAudio: true }],
      0.3,
      "480P",
      [],
      100,
      false,
      {
        enabled: false,
        autoDuckVoiceAndSuddenSounds: true,
        preserveDistantCrowdAmbience: true,
        preserveSceneMatchedSounds: true,
        eqEnabled: true,
        maxDuckingDb: 6,
        eqReductionDb: 1.5,
        peakCeilingDb: -1,
      },
    );
    expect(disabled.filterGraph).not.toContain("sidechaincompress");
    expect(disabled.filterGraph).not.toContain("equalizer=f=2500");
    expect(disabled.filterGraph).toContain("alimiter=limit=0.95");
    expect(() => validateAudioProtectionOptions({ ...validateAudioProtectionOptions(), maxDuckingDb: 8 })).toThrow(
      /3–6 dB/,
    );
  });

  it("maps independent Intro/Main BGM scopes to the prompt-page boundaries", () => {
    const mainStart = {
      durationSeconds: 3,
      line1: "正片",
      line2: "即將開始",
      line1FontSize1080p: 114,
      line2FontSize1080p: 90,
      lineGap1080p: 122,
      overlayOpacityPercent: 62,
      transitionStyle: "DISSOLVE" as const,
      sourceDurationMs: 4_000,
      line1TextFilePath: "one.txt",
      line2TextFilePath: "two.txt",
      fontFilePath: "font.ttc",
    };
    const starts = concatInputStartTimesMs(
      [
        { sourcePath: "intro.mp4", durationMs: 4_000, hasAudio: true },
        { sourcePath: "prompt.mp4", durationMs: 3_000, hasAudio: false, mainStartCard: mainStart },
        { sourcePath: "main.mp4", durationMs: 8_000, hasAudio: true },
      ],
      0.5,
    );
    expect(starts).toEqual([0, 3_500, 6_000]);
    const track = {
      id: "music",
      sourcePath: "music.mp3",
      fileName: "music.mp3",
      sizeBytes: 1,
      durationMs: 10_000,
      sourceInMs: 0,
      sourceOutMs: 10_000,
      timelineInMs: 0,
      timelineOutMs: 10_000,
      fadeInMs: 200,
      fadeOutMs: 200,
      volumePercent: 100,
      sourcePolicy: "READ_ONLY" as const,
      addedAt: "2026-09-11T00:00:00.000Z",
    };
    expect(
      selectBgmTracksForScopes(
        [track],
        { intro: true, main: false },
        { introEndMs: starts[1], mainStartMs: starts[2] },
      ),
    ).toMatchObject([{ timelineInMs: 0, timelineOutMs: 3_500, sourceOutMs: 3_500, fadeOutMs: 1_500 }]);
    expect(
      selectBgmTracksForScopes(
        [track],
        { intro: false, main: true },
        { introEndMs: starts[1], mainStartMs: starts[2] },
      ),
    ).toMatchObject([{ timelineInMs: 6_000, timelineOutMs: 16_000 }]);
    expect(
      selectBgmTracksForScopes([track], { intro: true, main: true }, { introEndMs: starts[1], mainStartMs: starts[2] }),
    ).toEqual([track]);
    expect(validateBgmScopeSelection({ intro: false, main: true })).toEqual({ intro: false, main: true });
  });

  it("rejects a transition that is not shorter than every clip", () => {
    expect(() =>
      buildConcatFilterGraph(
        [
          { sourcePath: "short.mp4", durationMs: 600, hasAudio: true },
          { sourcePath: "other.mp4", durationMs: 2_000, hasAudio: true },
        ],
        0.7,
        "360P",
      ),
    ).toThrow(/長度必須大於 0.7 秒/);
  });

  it("supports the standard 720p option and 4K preview dimensions", () => {
    const inputs = [
      { sourcePath: "one.mp4", durationMs: 2_000, hasAudio: true },
      { sourcePath: "two.mp4", durationMs: 2_000, hasAudio: true },
    ];
    expect(buildConcatFilterGraph(inputs, 0.3, "720P")).toMatchObject({ width: 1280, height: 720 });
    expect(buildConcatFilterGraph(inputs, 0.3, "4K")).toMatchObject({ width: 3840, height: 2160 });
  });

  it("resumes from a failed segment and retries only final concat after a simulated OOM", async () => {
    const resumeRoot = path.join(root, "resume-final-only");
    const localStore = new ProjectStore(path.join(resumeRoot, "app-data"));
    await localStore.initialize();
    const localSources = new SourceService(localStore, new MediaProbe());
    const paths: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const sourcePath = path.join(resumeRoot, `clip-${index + 1}.mp4`);
      await copyFile(firstPath, sourcePath);
      paths.push(sourcePath);
    }
    await localSources.importSelected(paths);
    await Promise.all(localStore.getProject().sources.map((asset) => localSources.ensureMetadata(asset.id)));
    const clips = mainRenderSelections(localStore.getProject());
    let firstRunCalls = 0;
    const failAtFinal = async (...args: Parameters<typeof runFfmpegWithProgress>) => {
      firstRunCalls += 1;
      if (args[5]?.currentSegment === "独立音讯混音与无损影像重新封装")
        throw new Error("FFmpeg 串連失敗：Error while filtering: Cannot allocate memory return code -12");
      return runFfmpegWithProgress(...args);
    };
    const request = {
      outputToken: "resume-test",
      orderedAssetIds: clips.map((clip) => clip.assetId),
      clipSelections: clips,
      transitionSeconds: 0.3 as const,
      resolution: "360P" as const,
      videoCodec: "H264" as const,
      purpose: "CONCAT" as const,
      lowMemorySegmented: false,
      runtimePolicy: {
        mode: "NORMAL" as const,
        maxVisualInputsPerStage: 3,
        initialParallelJobs: 1,
        maximumParallelJobs: 1,
        filterComplexThreads: 1,
        encoderThreads: 1,
        systemSafetyReserveBytes: 4 * 1024 ** 3,
        renderRamBudgetBytes: 4 * 1024 ** 3,
        pauseNewStageBelowAvailableBytes: 1024 ** 3,
      },
    };
    const output = path.join(resumeRoot, "resumed.mp4");
    const firstService = new ConcatRenderService(localStore, localSources, "ffmpeg", failAtFinal);
    await expect(firstService.render(request, output)).rejects.toThrow(/記憶體配置失敗/);
    const offer = await firstService.getResumeOffer();
    // v0.77 checkpoints keep the validated picture/base-audio master and
    // dependency-GC the now-consumed stage files before the post-audio pass.
    expect(offer).toMatchObject({ concatStatus: "FAILED", completedSegmentCount: 0, totalSegmentCount: 3 });
    expect(firstRunCalls).toBe(5);

    let resumeCalls = 0;
    const countRunner = async (...args: Parameters<typeof runFfmpegWithProgress>) => {
      resumeCalls += 1;
      return runFfmpegWithProgress(...args);
    };
    const resumed = await new ConcatRenderService(localStore, localSources, "ffmpeg", countRunner).resume(
      offer!.checkpointId,
      undefined,
      () => undefined,
    );
    expect(resumeCalls).toBe(1);
    expect(resumed).toMatchObject({ resumedSegmentCount: 1, segmentedRender: true, videoBaseMasterReused: true });
    expect((await new MediaProbe().probe(output)).videoCodec).toBe("h264");
    expect(await firstService.getResumeOffer()).toBeUndefined();

    let midFailureCalls = 0;
    const failMidStage = async (...args: Parameters<typeof runFfmpegWithProgress>) => {
      midFailureCalls += 1;
      if (args[5]?.currentSegment === "片段 2/3")
        throw new Error("FFmpeg 串連失敗：Error while filtering: Cannot allocate memory return code -12");
      return runFfmpegWithProgress(...args);
    };
    const midOutput = path.join(resumeRoot, "resumed-from-middle.mp4");
    const midService = new ConcatRenderService(localStore, localSources, "ffmpeg", failMidStage);
    await expect(midService.render({ ...request, outputToken: "mid-resume-test", resolution: "480P" }, midOutput)).rejects.toThrow(
      /已保留並驗證 1 個完成片段/,
    );
    expect(midFailureCalls).toBe(2);
    const midOffer = await midService.getResumeOffer();
    expect(midOffer).toMatchObject({ concatStatus: "FAILED", completedSegmentCount: 1, totalSegmentCount: 3 });
    let midResumeCalls = 0;
    const midResumeRunner = async (...args: Parameters<typeof runFfmpegWithProgress>) => {
      midResumeCalls += 1;
      return runFfmpegWithProgress(...args);
    };
    const midResumed = await new ConcatRenderService(localStore, localSources, "ffmpeg", midResumeRunner).resume(
      midOffer!.checkpointId,
      undefined,
      () => undefined,
    );
    expect(midResumeCalls).toBe(4);
    expect(midResumed.resumedSegmentCount).toBe(1);
    expect((await new MediaProbe().probe(midOutput)).videoCodec).toBe("h264");
    expect(await midService.getResumeOffer()).toBeUndefined();

    let audioFailureCalls = 0;
    const failPostAudio = async (...args: Parameters<typeof runFfmpegWithProgress>) => {
      audioFailureCalls += 1;
      if (args[5]?.currentSegment === "独立音讯混音与无损影像重新封装") throw new Error("simulated post-audio failure");
      return runFfmpegWithProgress(...args);
    };
    const audioOutput = path.join(resumeRoot, "resumed-post-audio.mp4");
    const audioRequest = {
      ...request,
      outputToken: "audio-resume-test",
      audioProcessing: { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "VIRTUAL_SURROUND_5_1" as const },
    };
    const audioService = new ConcatRenderService(localStore, localSources, "ffmpeg", failPostAudio);
    await expect(audioService.render(audioRequest, audioOutput)).rejects.toThrow(/simulated post-audio failure/);
    const audioOffer = await audioService.getResumeOffer();
    expect(audioOffer).toMatchObject({ concatStatus: "FAILED", completedSegmentCount: 0 });
    let audioResumeCalls = 0;
    const audioResumeRunner = async (...args: Parameters<typeof runFfmpegWithProgress>) => {
      audioResumeCalls += 1;
      return runFfmpegWithProgress(...args);
    };
    const audioResumed = await new ConcatRenderService(localStore, localSources, "ffmpeg", audioResumeRunner).resume(
      audioOffer!.checkpointId,
      undefined,
      () => undefined,
    );
    expect(audioResumeCalls).toBe(1);
    expect(audioResumed).toMatchObject({ audioChannels: 6, audioRemuxedWithoutVideoEncode: true });
  }, 120_000);

  it("reuses a complete external legacy segment level without deriving missing v0.80 paths or encoding it again", async () => {
    const recoveryRoot = path.join(root, "v079-external-segment-recovery");
    const appStore = new ProjectStore(path.join(recoveryRoot, "app-data"));
    await appStore.initialize();
    const checkpointStore = new RenderCheckpointStore(path.join(recoveryRoot, "state"));
    const externalSegment = path.join(recoveryRoot, "v079-read-only-level-1.mkv");
    await copyFile(firstPath, externalSegment);
    const info = await new MediaProbe().probe(externalSegment);
    const item = await stat(externalSegment);
    const request = {
      outputToken: "legacy-recovery",
      orderedAssetIds: Array.from({ length: 93 }, (_, index) => `asset-${index}`),
      transitionSeconds: 0.3 as const,
      resolution: "360P" as const,
      videoCodec: "H264" as const,
      purpose: "CONCAT" as const,
      prependIntro: false,
      includeBgm: false,
      subtitleBurnIn: { enabled: false, tracks: [] },
    };
    const checkpoint = await checkpointStore.create(
      appStore.getProject().id,
      appStore.getProject().updatedAt,
      "legacy-signature",
      "HIGH_SPEED",
      path.join(recoveryRoot, "output.mp4"),
      request,
      path.join(recoveryRoot, "v080-work"),
    );
    checkpoint.segments = Array.from({ length: 10 }, (_, index) => ({
      id: `legacy-segment-${index}`,
      level: 1,
      index: index + 1,
      status: "COMPLETED" as const,
      outputPath: externalSegment,
      durationMs: info.durationMs!,
      sizeBytes: item.size,
    }));
    await checkpointStore.save(checkpoint);
    let encodeCalls = 0;
    const service = new ConcatRenderService(
      appStore,
      new SourceService(appStore, new MediaProbe()),
      "ffmpeg",
      async () => {
        encodeCalls += 1;
        throw new Error("legacy level must not be encoded again");
      },
      undefined,
      undefined,
      undefined,
      undefined,
      checkpointStore,
    );
    const inputs = Array.from({ length: 93 }, (_, index) => ({
      sourcePath: `never-read-${index}.mp4`,
      durationMs: 1_000,
      hasAudio: true,
      checkpointKey: `source-${index}`,
    }));
    const result = await (service as unknown as {
      buildResumableIntermediates: (...args: unknown[]) => Promise<{ inputs: Array<{ sourcePath: string }>; resumedSegmentCount: number }>;
    }).buildResumableIntermediates(
      inputs,
      0.3,
      "360P",
      "H264",
      false,
      100,
      DEFAULT_AUDIO_PROTECTION_OPTIONS,
      checkpoint,
      10,
      1,
      1,
      undefined,
      new Set<number>(),
      () => undefined,
      93_000,
      undefined,
      () => undefined,
    );

    expect(encodeCalls).toBe(0);
    expect(result.resumedSegmentCount).toBe(10);
    expect(result.inputs).toHaveLength(10);
    expect(result.inputs.every((input) => input.sourcePath === externalSegment)).toBe(true);
    await expect(stat(externalSegment)).resolves.toMatchObject({ size: item.size });
  }, 30_000);

  it("keeps the eight 1080p/1440p landscape/portrait mode combinations on the same canvas profile", () => {
    const inputs = [{ sourcePath: "one.mp4", durationMs: 2_000, hasAudio: true }];
    for (const lowMemorySegmented of [true, false]) {
      for (const portrait of [true, false]) {
        for (const resolution of ["1080P", "1440P"] as const) {
          const plan = buildConcatFilterGraph(inputs, 0.3, resolution, [], 100, portrait);
          const expected =
            resolution === "1080P" ? (portrait ? [1080, 1920] : [1920, 1080]) : portrait ? [1440, 2560] : [2560, 1440];
          expect([plan.width, plan.height], `${resolution}/${portrait}/${lowMemorySegmented}`).toEqual(expected);
          expect(plan.expectedDurationMs).toBe(2_000);
          expect(plan.filterGraph).toContain(`scale=${expected[0]}:${expected[1]}`);
        }
      }
    }
  });

  it("bounds low-memory groups and keeps a Main-start card with both neighbours", () => {
    const inputs = Array.from({ length: 14 }, (_, index) => ({
      sourcePath: `${index}.mp4`,
      durationMs: 2_000,
      hasAudio: true,
      ...(index === 6
        ? {
            mainStartCard: {
              ...validateMainStartCardOptions({
                durationSeconds: 4,
                line1: "正片",
                line2: "開始",
                line1FontSize1080p: 114,
                line2FontSize1080p: 90,
                lineGap1080p: 122,
                overlayOpacityPercent: 62,
                transitionStyle: "DISSOLVE",
              }),
              sourceDurationMs: 2_000,
              line1TextFilePath: "one.txt",
              line2TextFilePath: "two.txt",
              fontFilePath: "font.ttc",
            },
          }
        : {}),
    }));
    const groups = groupLowMemoryInputs(inputs);
    expect(groups.every((group) => group.length <= 7)).toBe(true);
    const cardGroup = groups.find((group) => group.some((input) => input.mainStartCard))!;
    expect(cardGroup.map((input) => input.sourcePath)).toEqual(expect.arrayContaining(["5.mp4", "6.mp4", "7.mp4"]));
  });

  it("supports dissolve, fade-to-black and hard-cut joins around a validated Main-start card", () => {
    const options = {
      durationSeconds: 4,
      line1: "地點名稱",
      line2: "旅程開始",
      line1FontSize1080p: 114,
      line2FontSize1080p: 90,
      lineGap1080p: 122,
      overlayOpacityPercent: 62,
      transitionStyle: "FADE_BLACK" as const,
    };
    expect(validateMainStartCardOptions(options)).toEqual(options);
    expect(() => validateMainStartCardOptions({ ...options, durationSeconds: 8 })).toThrow(/3–7 秒/);
    const inputs = [
      { sourcePath: "intro.mp4", durationMs: 3_000, hasAudio: true },
      {
        sourcePath: "main.mp4",
        durationMs: 4_000,
        hasAudio: false,
        mainStartCard: {
          ...options,
          line1TextFilePath: "C:\\Temp\\第一行.txt",
          line2TextFilePath: "C:\\Temp\\第二行.txt",
          fontFilePath: "C:\\Windows\\Fonts\\msjh.ttc",
        },
      },
      { sourcePath: "main.mp4", durationMs: 5_000, hasAudio: true },
    ];
    const fade = buildConcatFilterGraph(inputs, 0.5, "480P");
    expect(fade.expectedDurationMs).toBe(11_000);
    expect(fade.filterGraph.match(/transition=fadeblack/g)).toHaveLength(2);
    const hard = buildConcatFilterGraph(
      inputs.map((input) =>
        input.mainStartCard
          ? { ...input, mainStartCard: { ...input.mainStartCard, transitionStyle: "HARD_CUT" as const } }
          : input,
      ),
      0.5,
      "480P",
    );
    expect(hard.expectedDurationMs).toBe(12_000);
    expect(hard.filterGraph).toContain("concat=n=2:v=1:a=0");
  });

  it("uses fixed, auditable temperature and vibrance filters without changing geometry", () => {
    const preset = colorPreset("WARM_VIVID");
    const plan = buildConcatFilterGraph(
      [{ sourcePath: "one.mp4", durationMs: 2_000, hasAudio: true, colorFilters: [...preset.ffmpegFilters] }],
      0.3,
      "480P",
    );
    expect(plan.filterGraph).toContain("colorbalance=rs=.04:gs=.01:bs=-.03");
    expect(plan.filterGraph).toContain("eq=saturation=1.18:contrast=1.03");
    expect(plan.filterGraph).toContain("force_original_aspect_ratio=decrease");
  });

  it("maps source-time local zoom and center settings into the selected clip filter", () => {
    const plan = buildConcatFilterGraph(
      [
        {
          sourcePath: "one.mp4",
          startMs: 2_000,
          durationMs: 4_000,
          hasAudio: true,
          zoomSegments: [
            { id: "focus", startMs: 3_000, endMs: 5_000, zoomPercent: 175, centerXPercent: 25, centerYPercent: 80 },
          ],
        },
      ],
      0.3,
      "480P",
    );
    expect(plan.filterGraph).toContain("zoompan=z='if(between(in_time,1,3),1.75,1)'");
    expect(plan.filterGraph).toContain("(iw-iw/zoom)*if(between(in_time,1,3),0.25,0.5)");
    expect(plan.filterGraph).toContain("(ih-ih/zoom)*if(between(in_time,1,3),0.8,0.5)");
    expect(plan.filterGraph).toContain("hqdn3d=1.2:1.0:2.0:1.6:enable='between(t,1,3)'");
    expect(plan.filterGraph).toContain("unsharp=5:5:0.45:5:5:0:enable='between(t,1,3)'");
  });
});

describe("concat preview integration", () => {
  it("post-processes Virtual 5.1 without re-encoding completed video frames", async () => {
    const localStore = new ProjectStore(path.join(root, "audio-v069-app-data"));
    await localStore.initialize();
    const localSources = new SourceService(localStore, new MediaProbe());
    await localSources.importSelected([firstPath]);
    await localSources.ensureMetadata(localStore.getProject().sources[0].id);
    const selections = mainRenderSelections(localStore.getProject());
    const output = path.join(root, "audio-v069-virtual.mp4");
    const sourceHash = await sha256(firstPath);
    const result = await new ConcatRenderService(localStore, localSources).render(
      {
        outputToken: "unused",
        orderedAssetIds: selections.map((clip) => clip.assetId),
        clipSelections: selections,
        transitionSeconds: 0.3,
        resolution: "360P",
        videoCodec: "H264",
        includeWatermark: false,
        includeBgm: false,
        purpose: "CONCAT",
        audioProcessing: {
          mode: "VIRTUAL_SURROUND_5_1",
          preset: "NATURAL",
          codec: "AAC",
          bitrateKbps: 384,
          sampleRate: 48_000,
          surroundStrengthPercent: 65,
          lfeStrengthPercent: 45,
          lfeCutoffHz: 100,
          loudnessTargetLufs: -16,
          truePeakCeilingDb: -1.5,
        },
      },
      output,
    );
    const info = await new MediaProbe().probe(output);
    expect(result.audioRemuxedWithoutVideoEncode).toBe(true);
    expect(info.audioChannels).toBe(6);
    expect(info.audioChannelLayout).toMatch(/5\.1/);
    expect(info.audioSampleRate).toBe(48_000);
    expect(await sha256(firstPath)).toBe(sourceHash);
  }, 30_000);
  it("renders more than six clips through bounded low-memory stages and removes every work file", async () => {
    const localRoot = path.join(root, "low-memory-case");
    const localStore = new ProjectStore(path.join(localRoot, "app-data"));
    await localStore.initialize();
    const clipPaths = await Promise.all(
      Array.from({ length: 7 }, async (_, index) => {
        const clipPath = path.join(localRoot, `clip-${index + 1}.mp4`);
        await copyFile(firstPath, clipPath);
        return clipPath;
      }),
    );
    const localSources = new SourceService(localStore, new MediaProbe());
    await localSources.importSelected(clipPaths);
    await Promise.all(localStore.getProject().sources.map((asset) => localSources.ensureMetadata(asset.id)));
    const sourceHashesBefore = await Promise.all(clipPaths.map((clipPath) => sha256(clipPath)));
    const clips = mainRenderSelections(localStore.getProject());
    const lowMemoryOutput = path.join(localRoot, "low-memory-preview.mp4");
    const result = await new ConcatRenderService(localStore, localSources).render(
      {
        outputToken: "low-memory",
        orderedAssetIds: clips.map((clip) => clip.assetId),
        clipSelections: clips,
        transitionSeconds: 0.3,
        resolution: "360P",
        videoCodec: "H264",
        lowMemorySegmented: true,
      },
      lowMemoryOutput,
    );
    expect(result).toMatchObject({ lowMemorySegmented: true, lowMemoryStageCount: 3 });
    expect(await new MediaProbe().probe(lowMemoryOutput)).toMatchObject({
      width: 640,
      height: 360,
      videoCodec: "h264",
    });
    expect(
      (await readdir(localRoot)).filter((name) => name.includes("low-memory") && name !== "low-memory-preview.mp4"),
    ).toEqual([]);
    const normalOutput = path.join(localRoot, "normal-preview.mp4");
    const normalResult = await new ConcatRenderService(localStore, localSources).render(
      {
        outputToken: "normal",
        orderedAssetIds: clips.map((clip) => clip.assetId),
        clipSelections: clips,
        transitionSeconds: 0.3,
        resolution: "360P",
        videoCodec: "H264",
        lowMemorySegmented: false,
      },
      normalOutput,
    );
    const [lowInfo, normalInfo] = await Promise.all([
      new MediaProbe().probe(lowMemoryOutput),
      new MediaProbe().probe(normalOutput),
    ]);
    expect(normalResult.lowMemorySegmented).toBe(false);
    expect(normalResult.lowMemoryStageCount).toBeUndefined();
    expect(normalResult.expectedDurationMs).toBe(result.expectedDurationMs);
    expect(normalInfo).toMatchObject({ width: lowInfo.width, height: lowInfo.height, videoCodec: lowInfo.videoCodec });
    expect(Math.abs((normalInfo.durationMs ?? 0) - (lowInfo.durationMs ?? 0))).toBeLessThanOrEqual(100);
    const visualComparison = await runProcess("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-i",
      lowMemoryOutput,
      "-i",
      normalOutput,
      "-lavfi",
      "[0:v][1:v]ssim",
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const ssim = Number(/All:([\d.]+)/.exec(visualComparison.stderr)?.[1]);
    expect(ssim).toBeGreaterThan(0.98);
    expect(await Promise.all(clipPaths.map((clipPath) => sha256(clipPath)))).toEqual(sourceHashesBefore);
  }, 90_000);

  it("outputs one fixed source range as an actual 3840x2160 MP4 with local zoom and leaves the source unchanged", async () => {
    const asset = store.getProject().sources.find((item) => item.sourcePath === firstPath)!;
    await store.setZoomSegments(asset.id, [
      { id: "clip-focus", startMs: 200, endMs: 800, zoomPercent: 175, centerXPercent: 35, centerYPercent: 60 },
    ]);
    const beforeHash = await sha256(firstPath);
    const clipOutput = path.join(root, "highest-4k-clip.mp4");
    const selection = { assetId: asset.id, inMs: 0, outMs: 1_000 };
    const result = await new ConcatRenderService(store, sources).render(
      {
        outputToken: "clip-4k",
        orderedAssetIds: [asset.id],
        clipSelections: [selection],
        transitionSeconds: 0.3,
        resolution: "4K",
        purpose: "CLIP",
      },
      clipOutput,
    );
    expect(result).toMatchObject({ purpose: "CLIP", resolution: "4K", expectedDurationMs: 1_000, bgmAppliedCount: 0 });
    expect(await new MediaProbe().probe(clipOutput)).toMatchObject({
      width: 3840,
      height: 2160,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    expect(await sha256(firstPath)).toBe(beforeHash);
    await expect(
      new ConcatRenderService(store, sources).render(
        {
          outputToken: "clip-wrong-size",
          orderedAssetIds: [asset.id],
          clipSelections: [selection],
          transitionSeconds: 0.3,
          resolution: "720P",
          purpose: "CLIP",
        },
        path.join(root, "wrong.mp4"),
      ),
    ).rejects.toThrow(/固定輸出為 4K/);
    await store.setZoomSegments(asset.id, []);
  }, 60_000);

  it("renders a 360p H.264/AAC dissolve preview while leaving every source byte unchanged", async () => {
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const progressPhases: string[] = [];
    const renderer = new ConcatRenderService(store, sources);
    const result = await renderer.render(
      {
        outputToken: "service-test-token",
        ...currentMainRequest(),
        transitionSeconds: 0.3,
        resolution: "360P",
      },
      outputPath,
      undefined,
      (progress) => progressPhases.push(progress.phase),
    );

    const outputInfo = await new MediaProbe().probe(outputPath);
    expect(outputInfo.width).toBe(640);
    expect(outputInfo.height).toBe(360);
    expect(outputInfo.videoCodec).toBe("h264");
    expect(outputInfo.audioCodec).toBe("aac");
    expect(result.expectedDurationMs).toBeGreaterThan(2_500);
    expect(result.watermarkApplied).toBe(true);
    expect(Math.abs(outputInfo.durationMs! - result.expectedDurationMs)).toBeLessThanOrEqual(120);
    expect(progressPhases).toContain("PREPARING");
    expect(progressPhases).toContain("RENDERING");
    expect(progressPhases).toContain("FINALIZING");
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(beforeHashes);
    expect((await readdir(root)).filter((name) => name.includes(".partial.mp4"))).toEqual([]);
  }, 45_000);

  it("renders the selected color preset into Main when the project consistency option is enabled", async () => {
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    await store.setProjectColorSettings({ introPresetId: "WARM_GOLDEN", applyToMain: true });
    const colorOutput = path.join(root, "warm-main-preview.mp4");
    const result = await new ConcatRenderService(store, sources).render(
      { outputToken: "color-main", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
      colorOutput,
    );
    expect((await stat(colorOutput)).size).toBeGreaterThan(1_000);
    expect(result).toMatchObject({ colorPresetId: "WARM_GOLDEN", colorAppliedToMain: true });
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(beforeHashes);
    await store.setProjectColorSettings({ introPresetId: "NATURAL", applyToMain: false });
  }, 45_000);

  it("cleans a too-early invalid partial when the render is cancelled", async () => {
    const cancelledOutput = path.join(root, "cancelled-preview.mp4");
    const controller = new AbortController();
    const renderer = new ConcatRenderService(
      store,
      sources,
      "fake-ffmpeg",
      async (_executable, args, _expectedDurationMs, signal) => {
        await writeFile(args.at(-1)!, "partial output");
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
        });
      },
    );
    const renderPromise = renderer.render(
      {
        outputToken: "cancel-test-token",
        ...currentMainRequest(),
        transitionSeconds: 0.5,
        resolution: "480P",
      },
      cancelledOutput,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);

    await expect(renderPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(
      (await readdir(root)).filter((name) => name.includes("cancelled-preview") || name.includes(".partial.mp4")),
    ).toEqual([]);
  });

  it("gracefully finalizes a shorter playable MP4 when cancellation happens after frames exist", async () => {
    const cancelledOutput = path.join(root, "cancelled-playable-preview.mp4");
    const controller = new AbortController();
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const slowRunner = async (...parameters: Parameters<typeof runFfmpegWithProgress>) => {
      const [executable, args, expectedDurationMs, signal, onProgress] = parameters;
      const slowedArgs = [...args.slice(0, 4), "-re", ...args.slice(4)];
      const timer = setTimeout(() => controller.abort(), 1_100);
      try {
        return await runFfmpegWithProgress(executable, slowedArgs, expectedDurationMs, signal, onProgress);
      } finally {
        clearTimeout(timer);
      }
    };
    const result = await new ConcatRenderService(store, sources, "ffmpeg", slowRunner).render(
      {
        outputToken: "cancel-playable-token",
        ...currentMainRequest(),
        transitionSeconds: 0.3,
        resolution: "360P",
      },
      cancelledOutput,
      controller.signal,
    );

    expect(result.cancelled).toBe(true);
    expect(result.plannedDurationMs).toBeGreaterThan(result.expectedDurationMs);
    const info = await new MediaProbe().probe(cancelledOutput);
    expect(info).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    expect(info.durationMs).toBeGreaterThanOrEqual(300);
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(beforeHashes);
    expect((await readdir(root)).filter((name) => name.includes(".partial.mp4"))).toEqual([]);
  }, 20_000);

  it("uses persisted per-video IN/OUT points when rendering the sorted concat", async () => {
    const videos = store.getProject().sources;
    await Promise.all(videos.map((asset) => sources.ensureMetadata(asset.id)));
    await store.setPreviewRange(videos[0].id, 200, 1_000);
    await store.setPreviewRange(videos[1].id, 100, 1_100);
    const trimmedOutput = path.join(root, "trimmed-720p.mp4");
    const renderer = new ConcatRenderService(store, sources);
    const result = await renderer.render(
      {
        outputToken: "trim-test-token",
        ...currentMainRequest(),
        transitionSeconds: 0.3,
        resolution: "720P",
        purpose: "CONCAT",
      },
      trimmedOutput,
    );
    const info = await new MediaProbe().probe(trimmedOutput);

    expect(result.expectedDurationMs).toBe(1_500);
    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(Math.abs(info.durationMs! - 1_500)).toBeLessThanOrEqual(120);
  }, 30_000);

  it("removes a middle Main range without black or silent placeholder and preserves every source hash", async () => {
    const videos = store.getProject().sources.slice(0, 2);
    await store.setPreviewRange(videos[0].id, 0, 1_400);
    await store.setPreviewRange(videos[1].id, 0, 1_400);
    await store.setMainExclusionRanges(videos[0].id, [{ id: "middle-cut", startMs: 500, endMs: 900 }]);
    const before = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const excludedOutput = path.join(root, "main-exclusion.mp4");
    const request = currentMainRequest();
    expect(request.clipSelections).toEqual([
      { assetId: videos[0].id, inMs: 0, outMs: 500 },
      { assetId: videos[0].id, inMs: 900, outMs: 1_400 },
      { assetId: videos[1].id, inMs: 0, outMs: 1_400 },
    ]);
    const result = await new ConcatRenderService(store, sources).render(
      { outputToken: "exclude", ...request, transitionSeconds: 0.3, resolution: "360P" },
      excludedOutput,
    );
    const info = await new MediaProbe().probe(excludedOutput);
    expect(result.expectedDurationMs).toBe(1_800);
    expect(Math.abs(info.durationMs! - 1_800)).toBeLessThanOrEqual(120);
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(before);
    const detect = await runProcess("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-t",
      "0.6",
      "-i",
      excludedOutput,
      "-vf",
      "blackdetect=d=0.15:pix_th=0.02",
      "-af",
      "silencedetect=n=-55dB:d=0.15",
      "-f",
      "null",
      "-",
    ]);
    expect(detect.stderr).not.toMatch(/black_start|silence_start/);
    await store.setMainExclusionRanges(videos[0].id, []);
  }, 45_000);

  it("renders multiple adjustable Intro ranges from the same source without using the stored concat trim", async () => {
    const asset = introStore.getProject().sources[0];
    const introOutput = path.join(root, "intro-preview.mp4");
    const renderer = new ConcatRenderService(introStore, introSources);
    const introClips = [
      {
        id: "intro-a",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 0,
        outMs: 3_200,
        score: 80,
        reasons: ["測試"],
      },
      {
        id: "intro-b",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 4_000,
        outMs: 7_200,
        score: 75,
        reasons: ["測試"],
      },
    ];
    await introStore.setIntroSegments(introClips);
    const result = await renderer.render(
      {
        outputToken: "intro-test-token",
        orderedAssetIds: [asset.id, asset.id],
        clipSelections: introClips,
        transitionSeconds: 0.3,
        resolution: "480P",
        purpose: "INTRO",
      },
      introOutput,
    );
    const info = await new MediaProbe().probe(introOutput);

    expect(result.purpose).toBe("INTRO");
    expect(result.expectedDurationMs).toBe(6_100);
    expect(info.width).toBe(854);
    expect(info.height).toBe(480);
  }, 30_000);

  it("renders a manually extended Intro range without applying the configured recommendation as a cap", async () => {
    const asset = introStore.getProject().sources[0];
    await introStore.setIntroSegmentMaxDuration(3_000);
    const reviewRange = {
      id: "long-review",
      assetId: asset.id,
      fileName: asset.fileName,
      inMs: 1_000,
      outMs: 7_000,
      score: 90,
      reasons: ["完整檢看"],
    };
    await introStore.setIntroSegments([reviewRange]);
    const outputRange = { ...reviewRange };
    let ffmpegArgs: string[] = [];
    const fakeRunner = async (_executable: string, args: string[], expectedDurationMs: number) => {
      if (args.includes("copy")) {
        await runProcess("ffmpeg", args);
      } else {
        ffmpegArgs = args;
        await copyFile(asset.sourcePath, args.at(-1)!);
      }
      return { cancelled: false, outTimeMs: expectedDurationMs };
    };
    const result = await new ConcatRenderService(introStore, introSources, "fake-ffmpeg", fakeRunner).render(
      {
        outputToken: "capped-intro-token",
        orderedAssetIds: [asset.id],
        clipSelections: [outputRange],
        transitionSeconds: 0.3,
        resolution: "480P",
        purpose: "INTRO",
      },
      path.join(root, "capped-intro-preview.mp4"),
    );
    expect(result.expectedDurationMs).toBe(6_000);
    expect(ffmpegArgs).toContain("1");
    expect(ffmpegArgs).toContain("6");
    expect(introStore.getProject().introSegments[0]).toMatchObject({ inMs: 1_000, outMs: 7_000 });
    await introStore.setIntroSegmentMaxDuration(15_000);
  });

  it("places confirmed Intro segments before Main when automatic concatenation is selected", async () => {
    const asset = introStore.getProject().sources[0];
    const introClips = [
      {
        id: "combined-intro-a",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 0,
        outMs: 3_200,
        score: 90,
        reasons: ["開場"],
      },
      {
        id: "combined-intro-b",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 4_000,
        outMs: 7_200,
        score: 85,
        reasons: ["人物"],
      },
    ];
    await introStore.setIntroSegments(introClips);
    const mainClips = mainRenderSelections(introStore.getProject());
    const combined = [...introClips, ...mainClips];
    const combinedOutput = path.join(root, "intro-plus-main-preview.mp4");
    let ffmpegArgs: string[] = [];
    let filterGraphFromScript = "";
    const fakeRunner = async (_executable: string, args: string[], expectedDurationMs: number) => {
      const scriptIndex = args.indexOf("-/filter_complex");
      const script = await readFile(args[scriptIndex + 1], "utf8");
      if (!args.includes("copy")) {
        ffmpegArgs = args;
        filterGraphFromScript = script;
      }
      await runProcess("ffmpeg", args);
      return { cancelled: false, outTimeMs: expectedDurationMs };
    };
    const result = await new ConcatRenderService(introStore, introSources, "fake-ffmpeg", fakeRunner).render(
      {
        outputToken: "combined-test-token",
        orderedAssetIds: combined.map((clip) => clip.assetId),
        clipSelections: combined,
        transitionSeconds: 0.3,
        resolution: "480P",
        purpose: "CONCAT",
        prependIntro: true,
        mainStartCard: {
          durationSeconds: 3,
          line1: "漫步風光",
          line2: "旅程開始",
          line1FontSize1080p: 114,
          line2FontSize1080p: 90,
          lineGap1080p: 122,
          overlayOpacityPercent: 62,
          transitionStyle: "DISSOLVE",
          backgroundIntroSegmentId: introClips[1].id,
        },
      },
      combinedOutput,
    );

    expect(result).toMatchObject({
      purpose: "CONCAT",
      includedIntroSegmentCount: 2,
      expectedDurationMs: 16_500,
      mainStartCardDurationSeconds: 3,
    });
    expect(ffmpegArgs).toContain("-/filter_complex");
    expect(ffmpegArgs).not.toContain("-filter_complex_script");
    expect(filterGraphFromScript).toContain("xfade");
    expect(filterGraphFromScript).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=black@0.62");
    expect(filterGraphFromScript).toContain("drawtext=fontfile=");
    expect(filterGraphFromScript.length).toBeGreaterThan(500);
    expect((await readdir(root)).filter((name) => name.endsWith(".filtergraph.txt"))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes("main-start-line"))).toEqual([]);
    const inputPositions = ffmpegArgs.map((item, index) => (item === "-i" ? index : -1)).filter((index) => index >= 0);
    expect(inputPositions.slice(0, 3).map((index) => ffmpegArgs[index + 1])).toEqual([
      asset.sourcePath,
      asset.sourcePath,
      asset.sourcePath,
    ]);
    expect(ffmpegArgs.slice(inputPositions[2] - 5, inputPositions[2] + 2)).toEqual([
      "-ss",
      "4",
      "-t",
      "3",
      "-noautorotate",
      "-i",
      asset.sourcePath,
    ]);
    expect(ffmpegArgs.slice(0, inputPositions[2] + 2).filter((item) => item === "3.2")).toHaveLength(2);
  });

  it("ends Intro-only BGM before the Main-start prompt and shifts Main-only BGM past it", async () => {
    const asset = introStore.getProject().sources[0];
    const introClips = [
      {
        id: "bgm-scope-intro",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 0,
        outMs: 3_200,
        score: 90,
        reasons: ["開場"],
      },
    ];
    await introStore.setIntroSegments(introClips);
    const bgmPath = path.join(root, "scope-music.mp3");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "sine=frequency=330:sample_rate=48000:duration=8", "-c:a", "libmp3lame", "-y", bgmPath,
    ]);
    const track = {
      id: "scope-music",
      sourcePath: bgmPath,
      fileName: "scope-music.mp3",
      sizeBytes: 20,
      durationMs: 8_000,
      sourceInMs: 0,
      sourceOutMs: 8_000,
      timelineInMs: 0,
      timelineOutMs: 8_000,
      fadeInMs: 0,
      fadeOutMs: 200,
      volumePercent: 35,
      sourcePolicy: "READ_ONLY" as const,
      addedAt: "2026-09-11T00:00:00.000Z",
    };
    await introStore.addBgmTracks([track]);
    const clips = [...introClips, ...mainRenderSelections(introStore.getProject())];
    const graphs: string[] = [];
    const fakeRunner = async (_executable: string, args: string[], expectedDurationMs: number) => {
      const scriptIndex = args.indexOf("-/filter_complex");
      graphs.push(await readFile(args[scriptIndex + 1], "utf8"));
      await runProcess("ffmpeg", args);
      return { cancelled: false, outTimeMs: expectedDurationMs };
    };
    const baseRequest = {
      orderedAssetIds: clips.map((clip) => clip.assetId),
      clipSelections: clips,
      transitionSeconds: 0.3 as const,
      resolution: "480P" as const,
      purpose: "CONCAT" as const,
      prependIntro: true,
      includeBgm: true,
      mainStartCard: {
        durationSeconds: 3,
        line1: "正片",
        line2: "即將開始",
        line1FontSize1080p: 114,
        line2FontSize1080p: 90,
        lineGap1080p: 122,
        overlayOpacityPercent: 62,
        transitionStyle: "DISSOLVE" as const,
      },
    };
    const renderer = new ConcatRenderService(
      introStore,
      introSources,
      "fake-ffmpeg",
      fakeRunner,
      undefined,
      undefined,
      undefined,
      { isSilent: async (_asset, _startMs, _durationMs) => false },
    );
    const introOnly = await renderer.render(
      { outputToken: "intro-bgm-only", ...baseRequest, bgmScopes: { intro: true, main: false } },
      path.join(root, "intro-bgm-only.mp4"),
    );
    const mainOnly = await renderer.render(
      { outputToken: "main-bgm-only", ...baseRequest, bgmScopes: { intro: false, main: true } },
      path.join(root, "main-bgm-only.mp4"),
    );
    expect(introOnly.bgmScopesApplied).toEqual({ intro: true, main: false });
    expect(graphs.some((graph) => graph.includes("atrim=start=0:end=2.9"))).toBe(true);
    expect(graphs.some((graph) => graph.includes("afade=t=out:st=1.4:d=1.5"))).toBe(true);
    expect(mainOnly.bgmScopesApplied).toEqual({ intro: false, main: true });
    expect(graphs.some((graph) => graph.includes("adelay=5600:all=1"))).toBe(true);
    await introStore.removeBgmTrack(track.id);
    await rm(bgmPath);
  }, 30_000);

  it("renders the required 3-second Main-start prompt from a read-only source with two Chinese text rows", async () => {
    const asset = introStore.getProject().sources[0];
    const introClips = [
      {
        id: "title-card-intro",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 0,
        outMs: 3_200,
        score: 90,
        reasons: ["開場"],
      },
    ];
    await introStore.setIntroSegments(introClips);
    const mainClips = mainRenderSelections(introStore.getProject());
    const combined = [...introClips, ...mainClips];
    const before = await sha256(asset.sourcePath);
    const cardOutput = path.join(root, "片頭 正片 提示頁.mp4");
    const result = await new ConcatRenderService(introStore, introSources).render(
      {
        outputToken: "real-main-start-card",
        orderedAssetIds: combined.map((clip) => clip.assetId),
        clipSelections: combined,
        transitionSeconds: 0.3,
        resolution: "360P",
        purpose: "CONCAT",
        prependIntro: true,
        mainStartCard: {
          durationSeconds: 3,
          line1: "草漯沙丘",
          line2: "旅程開始",
          line1FontSize1080p: 114,
          line2FontSize1080p: 90,
          lineGap1080p: 122,
          overlayOpacityPercent: 62,
          transitionStyle: "DISSOLVE",
        },
      },
      cardOutput,
    );
    const info = await new MediaProbe().probe(cardOutput);
    expect(result).toMatchObject({ expectedDurationMs: 13_600, mainStartCardDurationSeconds: 3 });
    expect(info).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    expect(Math.abs(info.durationMs! - 13_600)).toBeLessThanOrEqual(150);
    expect(await sha256(asset.sourcePath)).toBe(before);
    expect(
      (await readdir(root)).filter((name) => name.includes("main-start-line") || name.endsWith(".filtergraph.txt")),
    ).toEqual([]);
  }, 45_000);

  it("encodes the 4K preview option as an actual 3840x2160 MP4", async () => {
    const asset = introStore.getProject().sources[0];
    const output4k = path.join(root, "preview-4k.mp4");
    const renderer = new ConcatRenderService(introStore, introSources);
    const introClips = [
      {
        id: "intro-4k-a",
        assetId: asset.id,
        fileName: asset.fileName,
        inMs: 0,
        outMs: 3_000,
        score: 80,
        reasons: ["測試"],
      },
    ];
    await introStore.setIntroSegments(introClips);
    await renderer.render(
      {
        outputToken: "4k-test-token",
        orderedAssetIds: [asset.id],
        clipSelections: introClips,
        transitionSeconds: 0.3,
        resolution: "4K",
        purpose: "INTRO",
      },
      output4k,
    );
    const info = await new MediaProbe().probe(output4k);
    expect(info.width).toBe(3840);
    expect(info.height).toBe(2160);
    expect(info.videoCodec).toBe("h264");
  }, 60_000);

  it("renders the preferred H.265 MP4 and honors the per-render watermark opt-out", async () => {
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const h265Output = path.join(root, "joined-preview-h265.mp4");
    const result = await new ConcatRenderService(store, sources).render(
      {
        outputToken: "service-h265-token",
        ...currentMainRequest(),
        transitionSeconds: 0.3,
        resolution: "360P",
        videoCodec: "H265",
        includeWatermark: false,
      },
      h265Output,
    );
    const outputInfo = await new MediaProbe().probe(h265Output);
    expect(outputInfo).toMatchObject({ width: 640, height: 360, videoCodec: "hevc", audioCodec: "aac" });
    expect(result).toMatchObject({ videoCodec: "H265", watermarkApplied: false });
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(beforeHashes);
  }, 60_000);

  it("renders a photo for its persisted three-to-seven-second duration without changing the image or video source", async () => {
    const photoPath = path.join(root, "直式照片.jpg");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=yellow:s=540x960",
      "-frames:v",
      "1",
      "-y",
      photoPath,
    ]);
    const imageStore = new ProjectStore(path.join(root, "image-project-data"));
    await imageStore.initialize();
    const imageSources = new SourceService(imageStore, new MediaProbe());
    await imageSources.importSelected([firstPath, photoPath]);
    await Promise.all(imageStore.getProject().sources.map((asset) => imageSources.ensureMetadata(asset.id)));
    const photoAsset = imageStore.getProject().sources.find((asset) => asset.kind === "IMAGE")!;
    await imageStore.setImageDuration(photoAsset.id, 3_000);
    const clipSelections = mainRenderSelections(imageStore.getProject());
    expect(clipSelections.find((clip) => clip.assetId === photoAsset.id)).toEqual({
      assetId: photoAsset.id,
      inMs: 0,
      outMs: 3_000,
    });
    const before = await Promise.all([sha256(firstPath), sha256(photoPath)]);
    const imageOutput = path.join(root, "photo-duration-preview.mp4");
    const result = await new ConcatRenderService(imageStore, imageSources, undefined, undefined, shutterPath).render(
      {
        outputToken: "photo",
        orderedAssetIds: clipSelections.map((clip) => clip.assetId),
        clipSelections,
        transitionSeconds: 0.3,
        resolution: "360P",
      },
      imageOutput,
    );
    const info = await new MediaProbe().probe(imageOutput);
    const expectedDurationMs = clipSelections.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0) - 300;
    expect(result.expectedDurationMs).toBe(expectedDurationMs);
    expect(Math.abs(info.durationMs! - expectedDurationMs)).toBeLessThanOrEqual(120);
    expect(info).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    expect(result.photoShutterAppliedCount).toBe(1);
    expect(await Promise.all([sha256(firstPath), sha256(photoPath)])).toEqual(before);
  }, 45_000);

  it("splits an anchor video around an inserted photo and mixes the shutter without changing either source", async () => {
    const photoPath = path.join(root, "插入照片.jpg");
    const anchorPath = path.join(root, "照片安插錨點.mp4");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=cyan:s=960x540",
      "-frames:v",
      "1",
      "-y",
      photoPath,
    ]);
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=960x540:r=30000/1001",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      anchorPath,
    ]);
    const insertionStore = new ProjectStore(path.join(root, "photo-insertion-data"));
    await insertionStore.initialize();
    const insertionSources = new SourceService(insertionStore, new MediaProbe());
    await insertionSources.importSelected([anchorPath, photoPath]);
    await Promise.all(insertionStore.getProject().sources.map((asset) => insertionSources.ensureMetadata(asset.id)));
    const project = insertionStore.getProject();
    const anchor = project.sources.find((asset) => asset.kind === "VIDEO")!;
    const photo = project.sources.find((asset) => asset.kind === "IMAGE")!;
    await insertionStore.setImageDuration(photo.id, 3_000);
    const insertionAtMs = 1_500;
    const inserted = await insertionStore.addMediaInsertion(anchor.id, photo.id, insertionAtMs);
    const clips = mainRenderSelections(inserted);
    expect(clips).toEqual([
      { assetId: anchor.id, inMs: 0, outMs: insertionAtMs },
      { assetId: photo.id, inMs: 0, outMs: 3_000, mediaInsertionId: inserted.mediaInsertions[0].id },
      { assetId: anchor.id, inMs: insertionAtMs, outMs: anchor.mediaInfo!.durationMs! },
    ]);
    const before = await Promise.all([sha256(anchorPath), sha256(photoPath)]);
    const output = path.join(root, "photo-inside-video.mp4");
    const result = await new ConcatRenderService(
      insertionStore,
      insertionSources,
      undefined,
      undefined,
      shutterPath,
    ).render(
      {
        outputToken: "inside",
        orderedAssetIds: clips.map((clip) => clip.assetId),
        clipSelections: clips,
        transitionSeconds: 0.3,
        resolution: "360P",
      },
      output,
    );
    expect(result.photoShutterAppliedCount).toBe(1);
    const expectedDurationMs = anchor.mediaInfo!.durationMs! + 3_000 - 600;
    expect(Math.abs((await new MediaProbe().probe(output)).durationMs! - expectedDurationMs)).toBeLessThanOrEqual(120);
    const firstVideoHash = await packetHash(output, "v:0");
    const firstAudioHash = await packetHash(output, "a:0");
    const firstInsertion = insertionStore.getProject().mediaInsertions[0];
    await insertionStore.setInsertionAudio("MAIN", firstInsertion.id, {
      ...firstInsertion.insertionAudio!,
      sfxEnabled: false,
    });
    const secondOutput = path.join(root, "photo-inside-video-audio-only.mp4");
    let videoEncodeInvocations = 0;
    let postCopyInvocations = 0;
    const countedRunner = async (...parameters: Parameters<typeof runFfmpegWithProgress>) => {
      const args = parameters[1];
      const videoCodecIndex = args.indexOf("-c:v");
      if (videoCodecIndex >= 0 && args[videoCodecIndex + 1] === "copy") postCopyInvocations += 1;
      else if (videoCodecIndex >= 0) videoEncodeInvocations += 1;
      return runFfmpegWithProgress(...parameters);
    };
    const second = await new ConcatRenderService(
      insertionStore, insertionSources, "ffmpeg", countedRunner, shutterPath,
    ).render(
      {
        outputToken: "inside-audio-only",
        orderedAssetIds: clips.map((clip) => clip.assetId),
        clipSelections: clips,
        transitionSeconds: 0.3,
        resolution: "360P",
      },
      secondOutput,
    );
    expect(second.videoBaseMasterReused).toBe(true);
    expect(videoEncodeInvocations).toBe(0);
    expect(postCopyInvocations).toBe(1);
    expect(await packetHash(secondOutput, "v:0")).toBe(firstVideoHash);
    expect(await packetHash(secondOutput, "a:0")).not.toBe(firstAudioHash);
    expect(await Promise.all([sha256(anchorPath), sha256(photoPath)])).toEqual(before);
  }, 60_000);

  it("splits a host around an independently trimmed inserted video and preserves both sources", async () => {
    const anchorPath = path.join(root, "影片安插主片.mp4");
    const insertedPath = path.join(root, "補充 影片.MOV");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=purple:s=960x540:r=30000/1001",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      anchorPath,
    ]);
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=540x960:r=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      insertedPath,
    ]);
    const insertionStore = new ProjectStore(path.join(root, "video-insertion-data"));
    await insertionStore.initialize();
    const insertionSources = new SourceService(insertionStore, new MediaProbe());
    await insertionSources.importSelected([anchorPath, insertedPath]);
    await Promise.all(insertionStore.getProject().sources.map((asset) => insertionSources.ensureMetadata(asset.id)));
    const anchor = insertionStore.getProject().sources.find((asset) => asset.sourcePath === anchorPath)!;
    const insertedVideo = insertionStore.getProject().sources.find((asset) => asset.sourcePath === insertedPath)!;
    const project = await insertionStore.addMediaInsertion(anchor.id, insertedVideo.id, 2_000, {
      inMs: 500,
      outMs: 2_500,
    });
    const clips = mainRenderSelections(project);
    expect(clips).toEqual([
      { assetId: anchor.id, inMs: 0, outMs: 2_000 },
      { assetId: insertedVideo.id, inMs: 500, outMs: 2_500, mediaInsertionId: project.mediaInsertions[0].id },
      { assetId: anchor.id, inMs: 2_000, outMs: anchor.mediaInfo!.durationMs! },
    ]);
    const before = await Promise.all([sha256(anchorPath), sha256(insertedPath)]);
    const output = path.join(root, "video-inside-video.mp4");
    const result = await new ConcatRenderService(insertionStore, insertionSources).render(
      {
        outputToken: "insert-video",
        orderedAssetIds: clips.map((clip) => clip.assetId),
        clipSelections: clips,
        transitionSeconds: 0.3,
        resolution: "360P",
      },
      output,
    );
    const info = await new MediaProbe().probe(output);
    const expectedDurationMs = anchor.mediaInfo!.durationMs! + 2_000 - 600;
    expect(result.expectedDurationMs).toBe(expectedDurationMs);
    expect(Math.abs(info.durationMs! - expectedDurationMs)).toBeLessThanOrEqual(120);
    expect(info).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    expect(await Promise.all([sha256(anchorPath), sha256(insertedPath)])).toEqual(before);
  }, 60_000);

  it("renders measurable 0%/100%/200% clip automation over the 80% default while preserving source hashes", async () => {
    const assets = store.getProject().sources.slice(0, 2);
    await store.setPreviewRange(assets[0].id, 0, 1_400);
    await store.setPreviewRange(assets[1].id, 0, 1_400);
    await store.setVolumeSegments(assets[0].id, [
      { id: "mute", startMs: 0, endMs: 200, volumePercent: 0 },
      { id: "boost", startMs: 900, endMs: 1_200, volumePercent: 200 },
    ]);
    await store.setMainExclusionRanges(assets[0].id, [{ id: "volume-cut", startMs: 600, endMs: 900 }]);
    const before = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const automatedOutput = path.join(root, "volume-automation.mp4");
    await new ConcatRenderService(store, sources).render(
      { outputToken: "volume", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
      automatedOutput,
    );
    const muted = await volumeStats(automatedOutput, 0.03, 0.12);
    const boosted = await volumeStats(automatedOutput, 0.38, 0.1);
    const normal = await volumeStats(automatedOutput, 0.63, 0.08);
    expect(normal.mean).toBeGreaterThan(-35);
    expect(muted.mean).toBeLessThan(-60);
    expect(boosted.mean).toBeGreaterThan(normal.mean + 4.5);
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(before);
    await store.setMainExclusionRanges(assets[0].id, []);
  }, 45_000);

  it("mixes a read-only MP3 with fades and 200% gain under the output limiter, and blocks offline BGM", async () => {
    const bgmPath = path.join(root, "配樂 200%.mp3");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000",
      "-t",
      "1.5",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      "-y",
      bgmPath,
    ]);
    const bgmHash = await sha256(bgmPath);
    const track = {
      id: "bgm-e2e",
      sourcePath: bgmPath,
      fileName: path.basename(bgmPath),
      sizeBytes: (await stat(bgmPath)).size,
      durationMs: 1_500,
      sourceInMs: 0,
      sourceOutMs: 1_500,
      timelineInMs: 0,
      timelineOutMs: 1_500,
      fadeInMs: 100,
      fadeOutMs: 100,
      volumePercent: 200,
      sourcePolicy: "READ_ONLY" as const,
      addedAt: new Date().toISOString(),
    };
    await store.setVolumeSegments(store.getProject().sources[0].id, []);
    await store.addBgmTracks([track]);
    const assets = store.getProject().sources.slice(0, 2);
    await store.setMainExclusionRanges(assets[0].id, [{ id: "bgm-cut", startMs: 500, endMs: 900 }]);
    const mixedOutput = path.join(root, "mixed-bgm.mp4");
    const result = await new ConcatRenderService(store, sources).render(
      { outputToken: "bgm", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
      mixedOutput,
    );
    const stats = await volumeStats(mixedOutput, 0.2, 0.8);
    expect(result).toMatchObject({
      bgmAppliedCount: 2,
      autoDubClipCount: 1,
      mixPolicy: "VOICE_DUCK_EQ_COMPRESS_LIMIT",
      audioProtectionApplied: true,
      audioPeakCeilingDb: -1,
      bgmScopesApplied: { intro: false, main: true },
    });
    expect(result.expectedDurationMs).toBe(1_800);
    expect(stats.max).toBeLessThanOrEqual(0.5);
    expect(stats.mean).toBeGreaterThan(-20);
    expect(await sha256(bgmPath)).toBe(bgmHash);
    await rm(bgmPath);
    await expect(
      new ConcatRenderService(store, sources).render(
        { outputToken: "offline", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
        path.join(root, "offline.mp4"),
      ),
    ).rejects.toThrow(/不存在或離線/);
    await store.removeBgmTrack(track.id);
    const pending = {
      ...track,
      id: "youtube-pending",
      sourcePath: "",
      fileName: "YouTube 參考",
      sizeBytes: 0,
      durationMs: 0,
      sourceInMs: 0,
      sourceOutMs: 0,
      timelineInMs: 0,
      timelineOutMs: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      volumePercent: 35,
      sourceKind: "YOUTUBE_REFERENCE" as const,
      resolutionStatus: "NEEDS_LOCAL_FILE" as const,
      sourceUrl: "https://www.youtube.com/watch?v=abc123XYZ",
    };
    await store.addBgmTracks([pending]);
    await expect(
      new ConcatRenderService(store, sources).render(
        { outputToken: "pending", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
        path.join(root, "pending.mp4"),
      ),
    ).rejects.toThrow(/尚未指定自有或已授權/);
    await store.removeBgmTrack(pending.id);
    await store.setMainExclusionRanges(assets[0].id, []);
  }, 45_000);

  it("auto-dubs silent clips with the first READY BGM track unless opted out", async () => {
    const dubPath = path.join(root, "dub-source.mp3");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000",
      "-t",
      "3",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      "-y",
      dubPath,
    ]);
    // Parked outside the output so it never applies as normal BGM; it only feeds auto-dub.
    await store.addBgmTracks([
      {
        id: "bgm-dub-source",
        sourcePath: dubPath,
        fileName: path.basename(dubPath),
        sizeBytes: (await stat(dubPath)).size,
        durationMs: 3_000,
        sourceInMs: 0,
        sourceOutMs: 3_000,
        timelineInMs: 999_999,
        timelineOutMs: 1_002_999,
        fadeInMs: 100,
        fadeOutMs: 100,
        volumePercent: 100,
        sourcePolicy: "READ_ONLY" as const,
        addedAt: new Date().toISOString(),
      },
    ]);
    const clips = store.getProject().sources.slice(0, 2);
    expect(clips[1].mediaInfo?.audioCodec).toBeUndefined();
    const dubbedOutput = path.join(root, "dubbed.mp4");
    const dubbed = await new ConcatRenderService(store, sources).render(
      { outputToken: "dub", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
      dubbedOutput,
    );
    // First clip has audio, second is silent: exactly one auto-dub.
    expect(dubbed).toMatchObject({ autoDubClipCount: 1, bgmAppliedCount: 1 });
    expect((await volumeStats(dubbedOutput, 1.5, 0.9)).mean).toBeGreaterThan(-35);
    const virtualOutput = path.join(root, "dubbed-virtual-5.1.mp4");
    const virtualResult = await new ConcatRenderService(store, sources).render(
      {
        outputToken: "dub-virtual",
        ...currentMainRequest(),
        transitionSeconds: 0.3,
        resolution: "360P",
        audioProcessing: { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "VIRTUAL_SURROUND_5_1" },
      },
      virtualOutput,
    );
    expect(virtualResult).toMatchObject({
      autoDubClipCount: 1,
      audioChannels: 6,
      audioRemuxedWithoutVideoEncode: true,
    });
    expect((await new MediaProbe().probe(virtualOutput)).audioChannelLayout).toMatch(/5\.1/);
    await store.setDubWithBgm(clips[1].id, false);
    const mutedOutput = path.join(root, "dubbed-optout.mp4");
    const mutedResult = await new ConcatRenderService(store, sources).render(
      { outputToken: "dub-optout", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
      mutedOutput,
    );
    expect(mutedResult).toMatchObject({ autoDubClipCount: 0, bgmAppliedCount: 0 });
    expect((await volumeStats(mutedOutput, 1.5, 0.9)).mean).toBeLessThan(-60);
    await store.setDubWithBgm(clips[1].id, true);
    await store.removeBgmTrack("bgm-dub-source");
  }, 90_000);

  it("auto-dubs a selected video range whose audio track exists but is acoustically silent", async () => {
    const silentVideoPath = path.join(root, "silent-audio-track.mp4");
    const firstMusicPath = path.join(root, "first-page-music.mp3");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=640x360:r=24",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      silentVideoPath,
    ]);
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000",
      "-t",
      "2",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      "-y",
      firstMusicPath,
    ]);
    const localStore = new ProjectStore(path.join(root, "silent-audio-app-data"));
    await localStore.initialize();
    const localSources = new SourceService(localStore, new MediaProbe());
    await localSources.importSelected([silentVideoPath]);
    const localAsset = await localSources.ensureMetadata(localStore.getProject().sources[0].id);
    expect(localAsset.mediaInfo?.audioCodec).toBe("aac");
    await localStore.addBgmTracks([
      {
        id: "literal-first-track",
        sourcePath: firstMusicPath,
        fileName: path.basename(firstMusicPath),
        sizeBytes: (await stat(firstMusicPath)).size,
        durationMs: 2_000,
        sourceInMs: 0,
        sourceOutMs: 2_000,
        timelineInMs: 999_999,
        timelineOutMs: 1_001_999,
        fadeInMs: 0,
        fadeOutMs: 0,
        volumePercent: 100,
        sourcePolicy: "READ_ONLY",
        addedAt: new Date().toISOString(),
      },
    ]);
    const selections = mainRenderSelections(localStore.getProject());
    const output = path.join(root, "silent-audio-auto-dubbed.mp4");
    const result = await new ConcatRenderService(localStore, localSources).render(
      {
        outputToken: "silent-audio-auto-dub",
        orderedAssetIds: selections.map((clip) => clip.assetId),
        clipSelections: selections,
        transitionSeconds: 0.3,
        resolution: "360P",
        purpose: "CONCAT",
      },
      output,
    );
    expect(result).toMatchObject({ autoDubClipCount: 1, bgmAppliedCount: 1 });
    expect((await volumeStats(output, 0.2, 0.8)).mean).toBeGreaterThan(-35);
  }, 60_000);

  it("honors rotation metadata and renders a portrait clip over same-source blurred side fill", async () => {
    const basePath = path.join(root, "rotation-base.mp4");
    const rotatedPath = path.join(root, "手機 rotation 90.mp4");
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=854x480:r=24",
      "-t",
      "1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-y",
      basePath,
    ]);
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-display_rotation:v:0",
      "90",
      "-i",
      basePath,
      "-c",
      "copy",
      "-y",
      rotatedPath,
    ]);
    const imported = await sources.importSelected([rotatedPath]);
    const rotatedId = imported.addedAssetIds[0];
    await store.placeAsset(rotatedId, { action: "END" });
    const rotated = await sources.ensureMetadata(rotatedId);
    expect(rotated.mediaInfo).toMatchObject({
      rotationDegrees: 90,
      displayWidth: 480,
      displayHeight: 854,
      isPortrait: true,
    });
    const graph = buildConcatFilterGraph(
      [
        {
          sourcePath: rotatedPath,
          durationMs: 1500,
          hasAudio: false,
          isPortrait: true,
          orientationRotationDegrees: 90,
        },
      ],
      0.3,
      "360P",
    );
    expect(graph.filterGraph).toContain("transpose=cclock");
    expect(graph.filterGraph).toContain("split=2");
    expect(graph.filterGraph).toContain("boxblur");
    expect(graph.filterGraph).toContain("overlay=(W-w)/2:(H-h)/2");
    await store.setMainExclusionRanges(rotatedId, [{ id: "portrait-cut", startMs: 500, endMs: 900 }]);
    expect(currentMainRequest().clipSelections.filter((clip) => clip.assetId === rotatedId)).toEqual([
      { assetId: rotatedId, inMs: 0, outMs: 500 },
      { assetId: rotatedId, inMs: 900, outMs: 1_500 },
    ]);
    const portraitOutput = path.join(root, "portrait-blur.mp4");
    await new ConcatRenderService(store, sources).render(
      { outputToken: "portrait", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" },
      portraitOutput,
    );
    expect(await new MediaProbe().probe(portraitOutput)).toMatchObject({
      width: 640,
      height: 360,
      rotationDegrees: 0,
    });
  }, 60_000);

  it("actually burns independently styled Traditional Chinese and English subtitles into a playable MP4", async () => {
    const subtitleStore = new ProjectStore(path.join(root, "subtitle-app-data"));
    await subtitleStore.initialize();
    const subtitleSources = new SourceService(subtitleStore, new MediaProbe());
    await subtitleSources.importSelected([firstPath]);
    const source = await subtitleSources.ensureMetadata(subtitleStore.getProject().sources[0].id);
    await subtitleStore.setSubtitleCues([
      { id: "confirmed", startMs: 150, endMs: 1_200, text: "河內散步精彩開始", reviewStatus: "CONFIRMED" },
    ]);
    const before = await sha256(firstPath);
    const translations = {
      translate: async () => ({
        byLanguage: { "zh-TW": ["河內散步精彩開始"], en: ["Our Hanoi walk begins"] },
        providers: ["ORIGINAL", "OPENAI"],
      }),
    };
    const clips = mainRenderSelections(subtitleStore.getProject());
    const output = path.join(root, "雙語 字幕 preview.mp4");
    const result = await new ConcatRenderService(
      subtitleStore,
      subtitleSources,
      undefined,
      undefined,
      undefined,
      translations as never,
      path.join(root, "subtitle-cache"),
    ).render(
      {
        outputToken: "subtitle",
        orderedAssetIds: [source.id],
        clipSelections: clips,
        transitionSeconds: 0.3,
        resolution: "360P",
        subtitleBurnIn: {
          enabled: true,
          tracks: [
            { language: "zh-TW", position: "BOTTOM", fontSize1080p: 60 },
            { language: "en", position: "TOP", fontSize1080p: 42 },
          ],
        },
      },
      output,
    );
    expect(result.subtitleBurnedLanguages).toEqual(["zh-TW", "en"]);
    expect(result.subtitleTranslationProviders).toEqual(["ORIGINAL", "OPENAI"]);
    expect(await new MediaProbe().probe(output)).toMatchObject({
      width: 640,
      height: 360,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    const signal = await runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "0.5",
      "-i",
      output,
      "-vf",
      "signalstats,metadata=print:file=-",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]);
    expect(Number(/lavfi\.signalstats\.YMAX=(\d+)/.exec(signal.stdout)?.[1] ?? 0)).toBeGreaterThan(150);
    expect(await sha256(firstPath)).toBe(before);
    expect((await readdir(path.join(root, "subtitle-cache"))).filter((name) => name.endsWith(".ass"))).toEqual([]);
  }, 45_000);

  it("actually burns confirmed Intro subtitles into an Intro-only YouTube test preview", async () => {
    const introSubtitleStore = new ProjectStore(path.join(root, "intro-subtitle-app-data"));
    await introSubtitleStore.initialize();
    const introSubtitleSources = new SourceService(introSubtitleStore, new MediaProbe());
    await introSubtitleSources.importSelected([introPath]);
    const source = await introSubtitleSources.ensureMetadata(introSubtitleStore.getProject().sources[0].id);
    const segment = {
      id: "intro-subtitle-segment",
      assetId: source.id,
      fileName: source.fileName,
      inMs: 0,
      outMs: 3_200,
      score: 90,
      reasons: ["片頭測試"],
    };
    await introSubtitleStore.setIntroSegments([segment]);
    await introSubtitleStore.setSubtitleCues([
      {
        id: "intro-confirmed",
        startMs: 150,
        endMs: 1_050,
        text: "片頭字幕測試",
        timelineScope: "INTRO",
        reviewStatus: "CONFIRMED",
      },
    ]);
    const before = await sha256(introPath);
    const translations = {
      translate: async () => ({ byLanguage: { "zh-TW": ["片頭字幕測試"] }, providers: ["ORIGINAL"] }),
    };
    const output = path.join(root, "intro-subtitle-youtube-preview.mp4");
    const result = await new ConcatRenderService(
      introSubtitleStore,
      introSubtitleSources,
      undefined,
      undefined,
      undefined,
      translations as never,
      path.join(root, "intro-subtitle-cache"),
    ).render(
      {
        outputToken: "intro-subtitle",
        orderedAssetIds: [source.id],
        clipSelections: [segment],
        transitionSeconds: 0.3,
        resolution: "360P",
        purpose: "INTRO",
        subtitleBurnIn: {
          enabled: true,
          tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 48 }],
          styleProfile: {
            verticalPositionPercent: 82,
            fontSizePx: 36,
            textColor: "#FFFFFF",
            shadowEnabled: true,
            outlineWidthPx: 2,
          },
        },
      },
      output,
    );
    expect(result).toMatchObject({ purpose: "INTRO", subtitleBurnedLanguages: ["zh-TW"] });
    expect(await new MediaProbe().probe(output)).toMatchObject({ width: 640, height: 360, videoCodec: "h264" });
    expect(await sha256(introPath)).toBe(before);
    expect((await readdir(path.join(root, "intro-subtitle-cache"))).filter((name) => name.endsWith(".ass"))).toEqual(
      [],
    );
  }, 45_000);
});
