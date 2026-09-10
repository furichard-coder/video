import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildConcatFilterGraph,
  buildWatermarkFilterChain,
  ConcatRenderService,
  runFfmpegWithProgress,
  validateMainStartCardOptions,
} from "../src/main/services/concat-render";
import { MediaProbe } from "../src/main/services/media-probe";
import { runProcess } from "../src/main/services/process-runner";
import { ProjectStore } from "../src/main/services/project-store";
import { SourceService } from "../src/main/services/source-service";
import { mainRenderSelections } from "../src/shared/editing-rules";
import { colorPreset } from "../src/shared/color-presets";

let root: string;
let firstPath: string;
let secondPath: string;
let outputPath: string;
let shutterPath: string;
let store: ProjectStore;
let sources: SourceService;
let introStore: ProjectStore;
let introSources: SourceService;

async function volumeStats(filePath: string, start: number, duration: number): Promise<{ mean: number; max: number }> {
  const result = await runProcess("ffmpeg", ["-hide_banner", "-nostats", "-ss", String(start), "-t", String(duration), "-i", filePath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
  const meanRaw = /mean_volume:\s*(-?inf|[-\d.]+) dB/i.exec(result.stderr)?.[1];
  const maxRaw = /max_volume:\s*(-?inf|[-\d.]+) dB/i.exec(result.stderr)?.[1];
  return { mean: meanRaw === "-inf" ? -Infinity : Number(meanRaw), max: maxRaw === "-inf" ? -Infinity : Number(maxRaw) };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function currentMainRequest() {
  const clipSelections = mainRenderSelections(store.getProject());
  return { orderedAssetIds: clipSelections.map((clip) => clip.assetId), clipSelections };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "source-app-concat-"));
  firstPath = path.join(root, "clip01.mp4");
  secondPath = path.join(root, "clip02.mp4");
  outputPath = path.join(root, "joined-preview.mp4");
  shutterPath = path.join(root, "camera-shutter.wav");
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=960x540:r=30000/1001",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", firstPath,
  ]);
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=1800:sample_rate=48000:duration=0.18", "-c:a", "pcm_s16le", "-y", shutterPath]);
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=480x854:r=24",
    "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", secondPath,
  ]);
  store = new ProjectStore(path.join(root, "app-data"));
  await store.initialize();
  sources = new SourceService(store, new MediaProbe());
  await sources.importSelected([firstPath, secondPath]);
  await Promise.all(store.getProject().sources.map((asset) => sources.ensureMetadata(asset.id)));
  const introPath = path.join(root, "intro-long.mp4");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", introPath]);
  introStore = new ProjectStore(path.join(root, "intro-app-data")); await introStore.initialize();
  introSources = new SourceService(introStore, new MediaProbe()); await introSources.importSelected([introPath]);
  await introSources.ensureMetadata(introStore.getProject().sources[0].id);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("concat preview filter plan", () => {
  it("uses cumulative overlap offsets and the requested fixed preview size", () => {
    const plan = buildConcatFilterGraph([
      { sourcePath: "one.mp4", durationMs: 10_000, hasAudio: true },
      { sourcePath: "two.mp4", durationMs: 20_000, hasAudio: false },
      { sourcePath: "three.mp4", durationMs: 30_000, hasAudio: true },
    ], 0.5, "480P");

    expect(plan.expectedDurationMs).toBe(59_000);
    expect(plan.width).toBe(854);
    expect(plan.height).toBe(480);
    expect(plan.filterGraph).toContain("duration=0.5:offset=9.5");
    expect(plan.filterGraph).toContain("duration=0.5:offset=29");
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo");
  });

  it("rejects a transition that is not shorter than every clip", () => {
    expect(() => buildConcatFilterGraph([
      { sourcePath: "short.mp4", durationMs: 600, hasAudio: true },
      { sourcePath: "other.mp4", durationMs: 2_000, hasAudio: true },
    ], 0.7, "360P")).toThrow(/長度必須大於 0.7 秒/);
  });

  it("supports the standard 720p option and 4K preview dimensions", () => {
    const inputs = [
      { sourcePath: "one.mp4", durationMs: 2_000, hasAudio: true },
      { sourcePath: "two.mp4", durationMs: 2_000, hasAudio: true },
    ];
    expect(buildConcatFilterGraph(inputs, 0.3, "720P")).toMatchObject({ width: 1280, height: 720 });
    expect(buildConcatFilterGraph(inputs, 0.3, "4K")).toMatchObject({ width: 3840, height: 2160 });
  });

  it("supports dissolve, fade-to-black and hard-cut joins around a validated Main-start card", () => {
    const options = { durationSeconds: 4, line1: "地點名稱", line2: "旅程開始", line1FontSize1080p: 114, line2FontSize1080p: 90, lineGap1080p: 122, overlayOpacityPercent: 62, transitionStyle: "FADE_BLACK" as const };
    expect(validateMainStartCardOptions(options)).toEqual(options);
    expect(() => validateMainStartCardOptions({ ...options, durationSeconds: 8 })).toThrow(/3–7 秒/);
    const inputs = [
      { sourcePath: "intro.mp4", durationMs: 3_000, hasAudio: true },
      { sourcePath: "main.mp4", durationMs: 4_000, hasAudio: false, mainStartCard: { ...options, line1TextFilePath: "C:\\Temp\\第一行.txt", line2TextFilePath: "C:\\Temp\\第二行.txt", fontFilePath: "C:\\Windows\\Fonts\\msjh.ttc" } },
      { sourcePath: "main.mp4", durationMs: 5_000, hasAudio: true },
    ];
    const fade = buildConcatFilterGraph(inputs, 0.5, "480P");
    expect(fade.expectedDurationMs).toBe(11_000);
    expect(fade.filterGraph.match(/transition=fadeblack/g)).toHaveLength(2);
    const hard = buildConcatFilterGraph(inputs.map((input) => input.mainStartCard ? { ...input, mainStartCard: { ...input.mainStartCard, transitionStyle: "HARD_CUT" as const } } : input), 0.5, "480P");
    expect(hard.expectedDurationMs).toBe(12_000);
    expect(hard.filterGraph).toContain("concat=n=2:v=1:a=0");
  });

  it("uses fixed, auditable temperature and vibrance filters without changing geometry", () => {
    const preset = colorPreset("WARM_VIVID");
    const plan = buildConcatFilterGraph([{ sourcePath: "one.mp4", durationMs: 2_000, hasAudio: true, colorFilters: [...preset.ffmpegFilters] }], 0.3, "480P");
    expect(plan.filterGraph).toContain("colorbalance=rs=.04:gs=.01:bs=-.03");
    expect(plan.filterGraph).toContain("eq=saturation=1.18:contrast=1.03");
    expect(plan.filterGraph).toContain("force_original_aspect_ratio=decrease");
  });

  it("maps source-time local zoom and center settings into the selected clip filter", () => {
    const plan = buildConcatFilterGraph([{ sourcePath: "one.mp4", startMs: 2_000, durationMs: 4_000, hasAudio: true, zoomSegments: [{ id: "focus", startMs: 3_000, endMs: 5_000, zoomPercent: 175, centerXPercent: 25, centerYPercent: 80 }] }], 0.3, "480P");
    expect(plan.filterGraph).toContain("zoompan=z='if(between(in_time,1,3),1.75,1)'");
    expect(plan.filterGraph).toContain("(iw-iw/zoom)*if(between(in_time,1,3),0.25,0.5)");
    expect(plan.filterGraph).toContain("(ih-ih/zoom)*if(between(in_time,1,3),0.8,0.5)");
    expect(plan.filterGraph).toContain("hqdn3d=1.2:1.0:2.0:1.6:enable='between(t,1,3)'");
    expect(plan.filterGraph).toContain("unsharp=5:5:0.45:5:5:0:enable='between(t,1,3)'");
  });
});

describe("concat preview integration", () => {
  it("outputs one fixed source range as an actual 3840x2160 MP4 with local zoom and leaves the source unchanged", async () => {
    const asset = store.getProject().sources.find((item) => item.sourcePath === firstPath)!;
    await store.setZoomSegments(asset.id, [{ id: "clip-focus", startMs: 200, endMs: 800, zoomPercent: 175, centerXPercent: 35, centerYPercent: 60 }]);
    const beforeHash = await sha256(firstPath);
    const clipOutput = path.join(root, "highest-4k-clip.mp4");
    const selection = { assetId: asset.id, inMs: 0, outMs: 1_000 };
    const result = await new ConcatRenderService(store, sources).render({ outputToken: "clip-4k", orderedAssetIds: [asset.id], clipSelections: [selection], transitionSeconds: 0.3, resolution: "4K", purpose: "CLIP" }, clipOutput);
    expect(result).toMatchObject({ purpose: "CLIP", resolution: "4K", expectedDurationMs: 1_000, bgmAppliedCount: 0 });
    expect(await new MediaProbe().probe(clipOutput)).toMatchObject({ width: 3840, height: 2160, videoCodec: "h264", audioCodec: "aac" });
    expect(await sha256(firstPath)).toBe(beforeHash);
    await expect(new ConcatRenderService(store, sources).render({ outputToken: "clip-wrong-size", orderedAssetIds: [asset.id], clipSelections: [selection], transitionSeconds: 0.3, resolution: "720P", purpose: "CLIP" }, path.join(root, "wrong.mp4"))).rejects.toThrow(/固定輸出為 4K/);
    await store.setZoomSegments(asset.id, []);
  }, 60_000);

  it("renders a 360p H.264/AAC dissolve preview while leaving every source byte unchanged", async () => {
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const progressPhases: string[] = [];
    const renderer = new ConcatRenderService(store, sources);
    const result = await renderer.render({
      outputToken: "service-test-token",
      ...currentMainRequest(),
      transitionSeconds: 0.3,
      resolution: "360P",
    }, outputPath, undefined, (progress) => progressPhases.push(progress.phase));

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
    const result = await new ConcatRenderService(store, sources).render({ outputToken: "color-main", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" }, colorOutput);
    expect((await stat(colorOutput)).size).toBeGreaterThan(1_000);
    expect(result).toMatchObject({ colorPresetId: "WARM_GOLDEN", colorAppliedToMain: true });
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(beforeHashes);
    await store.setProjectColorSettings({ introPresetId: "NATURAL", applyToMain: false });
  }, 45_000);

  it("cleans a too-early invalid partial when the render is cancelled", async () => {
    const cancelledOutput = path.join(root, "cancelled-preview.mp4");
    const controller = new AbortController();
    const renderer = new ConcatRenderService(store, sources, "fake-ffmpeg", async (
      _executable,
      args,
      _expectedDurationMs,
      signal,
    ) => {
      await writeFile(args.at(-1)!, "partial output");
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
      });
    });
    const renderPromise = renderer.render({
      outputToken: "cancel-test-token",
      ...currentMainRequest(),
      transitionSeconds: 0.5,
      resolution: "480P",
    }, cancelledOutput, controller.signal);
    setTimeout(() => controller.abort(), 20);

    await expect(renderPromise).rejects.toMatchObject({ name: "AbortError" });
    expect((await readdir(root)).filter((name) => name.includes("cancelled-preview") || name.includes(".partial.mp4"))).toEqual([]);
  });

  it("gracefully finalizes a shorter playable MP4 when cancellation happens after frames exist", async () => {
    const cancelledOutput = path.join(root, "cancelled-playable-preview.mp4");
    const controller = new AbortController();
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const slowRunner = async (...parameters: Parameters<typeof runFfmpegWithProgress>) => {
      const [executable, args, expectedDurationMs, signal, onProgress] = parameters;
      const slowedArgs = [...args.slice(0, 4), "-re", ...args.slice(4)];
      const timer = setTimeout(() => controller.abort(), 1_100);
      try { return await runFfmpegWithProgress(executable, slowedArgs, expectedDurationMs, signal, onProgress); }
      finally { clearTimeout(timer); }
    };
    const result = await new ConcatRenderService(store, sources, "ffmpeg", slowRunner).render({
      outputToken: "cancel-playable-token",
      ...currentMainRequest(),
      transitionSeconds: 0.3,
      resolution: "360P",
    }, cancelledOutput, controller.signal);

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
    const result = await renderer.render({
      outputToken: "trim-test-token",
      ...currentMainRequest(),
      transitionSeconds: 0.3,
      resolution: "720P",
      purpose: "CONCAT",
    }, trimmedOutput);
    const info = await new MediaProbe().probe(trimmedOutput);

    expect(result.expectedDurationMs).toBe(1_500);
    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(Math.abs(info.durationMs! - 1_500)).toBeLessThanOrEqual(120);
  }, 30_000);

  it("removes a middle Main range without black or silent placeholder and preserves every source hash", async () => {
    const videos = store.getProject().sources.slice(0, 2);
    await store.setPreviewRange(videos[0].id, 0, 1_400); await store.setPreviewRange(videos[1].id, 0, 1_400);
    await store.setMainExclusionRanges(videos[0].id, [{ id: "middle-cut", startMs: 500, endMs: 900 }]);
    const before = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const excludedOutput = path.join(root, "main-exclusion.mp4");
    const request = currentMainRequest();
    expect(request.clipSelections).toEqual([
      { assetId: videos[0].id, inMs: 0, outMs: 500 },
      { assetId: videos[0].id, inMs: 900, outMs: 1_400 },
      { assetId: videos[1].id, inMs: 0, outMs: 1_400 },
    ]);
    const result = await new ConcatRenderService(store, sources).render({ outputToken: "exclude", ...request, transitionSeconds: 0.3, resolution: "360P" }, excludedOutput);
    const info = await new MediaProbe().probe(excludedOutput);
    expect(result.expectedDurationMs).toBe(1_800);
    expect(Math.abs(info.durationMs! - 1_800)).toBeLessThanOrEqual(120);
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(before);
    const detect = await runProcess("ffmpeg", ["-hide_banner", "-nostats", "-t", "0.6", "-i", excludedOutput, "-vf", "blackdetect=d=0.15:pix_th=0.02", "-af", "silencedetect=n=-55dB:d=0.15", "-f", "null", "-"]);
    expect(detect.stderr).not.toMatch(/black_start|silence_start/);
    await store.setMainExclusionRanges(videos[0].id, []);
  }, 45_000);

  it("renders multiple adjustable Intro ranges from the same source without using the stored concat trim", async () => {
    const asset = introStore.getProject().sources[0];
    const introOutput = path.join(root, "intro-preview.mp4");
    const renderer = new ConcatRenderService(introStore, introSources);
    const introClips = [
      { id: "intro-a", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_200, score: 80, reasons: ["測試"] },
      { id: "intro-b", assetId: asset.id, fileName: asset.fileName, inMs: 4_000, outMs: 7_200, score: 75, reasons: ["測試"] },
    ];
    await introStore.setIntroSegments(introClips);
    const result = await renderer.render({
      outputToken: "intro-test-token",
      orderedAssetIds: [asset.id, asset.id],
      clipSelections: introClips,
      transitionSeconds: 0.3,
      resolution: "480P",
      purpose: "INTRO",
    }, introOutput);
    const info = await new MediaProbe().probe(introOutput);

    expect(result.purpose).toBe("INTRO");
    expect(result.expectedDurationMs).toBe(6_100);
    expect(info.width).toBe(854);
    expect(info.height).toBe(480);
  }, 30_000);

  it("renders an over-limit review range from its IN point using the configured maximum", async () => {
    const asset = introStore.getProject().sources[0];
    await introStore.setIntroSegmentMaxDuration(3_000);
    const reviewRange = { id: "long-review", assetId: asset.id, fileName: asset.fileName, inMs: 1_000, outMs: 7_000, score: 90, reasons: ["完整檢看"] };
    await introStore.setIntroSegments([reviewRange]);
    const outputRange = { ...reviewRange, outMs: 4_000 };
    let ffmpegArgs: string[] = [];
    const fakeRunner = async (_executable: string, args: string[], expectedDurationMs: number) => {
      ffmpegArgs = args;
      await writeFile(args.at(-1)!, "valid-capped-intro-preview");
      return { cancelled: false, outTimeMs: expectedDurationMs };
    };
    const result = await new ConcatRenderService(introStore, introSources, "fake-ffmpeg", fakeRunner).render({
      outputToken: "capped-intro-token",
      orderedAssetIds: [asset.id],
      clipSelections: [outputRange],
      transitionSeconds: 0.3,
      resolution: "480P",
      purpose: "INTRO",
    }, path.join(root, "capped-intro-preview.mp4"));
    expect(result.expectedDurationMs).toBe(3_000);
    expect(ffmpegArgs).toContain("1");
    expect(ffmpegArgs).toContain("3");
    expect(introStore.getProject().introSegments[0]).toMatchObject({ inMs: 1_000, outMs: 7_000 });
    await introStore.setIntroSegmentMaxDuration(15_000);
  });

  it("places confirmed Intro segments before Main when automatic concatenation is selected", async () => {
    const asset = introStore.getProject().sources[0];
    const introClips = [
      { id: "combined-intro-a", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_200, score: 90, reasons: ["開場"] },
      { id: "combined-intro-b", assetId: asset.id, fileName: asset.fileName, inMs: 4_000, outMs: 7_200, score: 85, reasons: ["人物"] },
    ];
    await introStore.setIntroSegments(introClips);
    const mainClips = mainRenderSelections(introStore.getProject());
    const combined = [...introClips, ...mainClips];
    const combinedOutput = path.join(root, "intro-plus-main-preview.mp4");
    let ffmpegArgs: string[] = [];
    let filterGraphFromScript = "";
    const fakeRunner = async (_executable: string, args: string[], expectedDurationMs: number) => {
      ffmpegArgs = args;
      const scriptIndex = args.indexOf("-filter_complex_script");
      filterGraphFromScript = await readFile(args[scriptIndex + 1], "utf8");
      await writeFile(args.at(-1)!, "valid-combined-preview");
      return { cancelled: false, outTimeMs: expectedDurationMs };
    };
    const result = await new ConcatRenderService(introStore, introSources, "fake-ffmpeg", fakeRunner).render({
      outputToken: "combined-test-token",
      orderedAssetIds: combined.map((clip) => clip.assetId),
      clipSelections: combined,
      transitionSeconds: 0.3,
      resolution: "480P",
      purpose: "CONCAT",
      prependIntro: true,
      mainStartCard: { durationSeconds: 3, line1: "漫步風光", line2: "旅程開始", line1FontSize1080p: 114, line2FontSize1080p: 90, lineGap1080p: 122, overlayOpacityPercent: 62, transitionStyle: "DISSOLVE", backgroundIntroSegmentId: introClips[1].id },
    }, combinedOutput);

    expect(result).toMatchObject({ purpose: "CONCAT", includedIntroSegmentCount: 2, expectedDurationMs: 16_500, mainStartCardDurationSeconds: 3 });
    expect(ffmpegArgs).toContain("-filter_complex_script");
    expect(ffmpegArgs).not.toContain("-filter_complex");
    expect(filterGraphFromScript).toContain("xfade");
    expect(filterGraphFromScript).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=black@0.62");
    expect(filterGraphFromScript).toContain("drawtext=fontfile=");
    expect(filterGraphFromScript.length).toBeGreaterThan(500);
    expect((await readdir(root)).filter((name) => name.endsWith(".filtergraph.txt"))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes("main-start-line"))).toEqual([]);
    const inputPositions = ffmpegArgs.map((item, index) => item === "-i" ? index : -1).filter((index) => index >= 0);
    expect(inputPositions.slice(0, 3).map((index) => ffmpegArgs[index + 1])).toEqual([asset.sourcePath, asset.sourcePath, asset.sourcePath]);
    expect(ffmpegArgs.slice(inputPositions[2] - 4, inputPositions[2] + 2)).toEqual(["-ss", "4", "-t", "3", "-i", asset.sourcePath]);
    expect(ffmpegArgs.slice(0, inputPositions[2] + 2).filter((item) => item === "3.2")).toHaveLength(2);
  });

  it("renders the required 3-second Main-start prompt from a read-only source with two Chinese text rows", async () => {
    const asset = introStore.getProject().sources[0];
    const introClips = [{ id: "title-card-intro", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_200, score: 90, reasons: ["開場"] }];
    await introStore.setIntroSegments(introClips);
    const mainClips = mainRenderSelections(introStore.getProject());
    const combined = [...introClips, ...mainClips];
    const before = await sha256(asset.sourcePath);
    const cardOutput = path.join(root, "片頭 正片 提示頁.mp4");
    const result = await new ConcatRenderService(introStore, introSources).render({
      outputToken: "real-main-start-card",
      orderedAssetIds: combined.map((clip) => clip.assetId),
      clipSelections: combined,
      transitionSeconds: 0.3,
      resolution: "360P",
      purpose: "CONCAT",
      prependIntro: true,
      mainStartCard: { durationSeconds: 3, line1: "草漯沙丘", line2: "旅程開始", line1FontSize1080p: 114, line2FontSize1080p: 90, lineGap1080p: 122, overlayOpacityPercent: 62, transitionStyle: "DISSOLVE" },
    }, cardOutput);
    const info = await new MediaProbe().probe(cardOutput);
    expect(result).toMatchObject({ expectedDurationMs: 13_600, mainStartCardDurationSeconds: 3 });
    expect(info).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    expect(Math.abs(info.durationMs! - 13_600)).toBeLessThanOrEqual(150);
    expect(await sha256(asset.sourcePath)).toBe(before);
    expect((await readdir(root)).filter((name) => name.includes("main-start-line") || name.endsWith(".filtergraph.txt"))).toEqual([]);
  }, 45_000);

  it("encodes the 4K preview option as an actual 3840x2160 MP4", async () => {
    const asset = introStore.getProject().sources[0];
    const output4k = path.join(root, "preview-4k.mp4");
    const renderer = new ConcatRenderService(introStore, introSources);
    const introClips = [
      { id: "intro-4k-a", assetId: asset.id, fileName: asset.fileName, inMs: 0, outMs: 3_000, score: 80, reasons: ["測試"] },
    ];
    await introStore.setIntroSegments(introClips);
    await renderer.render({
      outputToken: "4k-test-token",
      orderedAssetIds: [asset.id],
      clipSelections: introClips,
      transitionSeconds: 0.3,
      resolution: "4K",
      purpose: "INTRO",
    }, output4k);
    const info = await new MediaProbe().probe(output4k);
    expect(info.width).toBe(3840);
    expect(info.height).toBe(2160);
    expect(info.videoCodec).toBe("h264");
  }, 60_000);

  it("renders the preferred H.265 MP4 and honors the per-render watermark opt-out", async () => {
    const beforeHashes = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const h265Output = path.join(root, "joined-preview-h265.mp4");
    const result = await new ConcatRenderService(store, sources).render({
      outputToken: "service-h265-token",
      ...currentMainRequest(),
      transitionSeconds: 0.3,
      resolution: "360P",
      videoCodec: "H265",
      includeWatermark: false,
    }, h265Output);
    const outputInfo = await new MediaProbe().probe(h265Output);
    expect(outputInfo).toMatchObject({ width: 640, height: 360, videoCodec: "hevc", audioCodec: "aac" });
    expect(result).toMatchObject({ videoCodec: "H265", watermarkApplied: false });
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(beforeHashes);
  }, 60_000);

  it("renders a photo for its persisted three-to-seven-second duration without changing the image or video source", async () => {
    const photoPath = path.join(root, "直式照片.jpg");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=yellow:s=540x960", "-frames:v", "1", "-y", photoPath]);
    const imageStore = new ProjectStore(path.join(root, "image-project-data")); await imageStore.initialize();
    const imageSources = new SourceService(imageStore, new MediaProbe());
    await imageSources.importSelected([firstPath, photoPath]);
    await Promise.all(imageStore.getProject().sources.map((asset) => imageSources.ensureMetadata(asset.id)));
    const photoAsset = imageStore.getProject().sources.find((asset) => asset.kind === "IMAGE")!;
    await imageStore.setImageDuration(photoAsset.id, 3_000);
    const clipSelections = mainRenderSelections(imageStore.getProject());
    expect(clipSelections.find((clip) => clip.assetId === photoAsset.id)).toEqual({ assetId: photoAsset.id, inMs: 0, outMs: 3_000 });
    const before = await Promise.all([sha256(firstPath), sha256(photoPath)]);
    const imageOutput = path.join(root, "photo-duration-preview.mp4");
    const result = await new ConcatRenderService(imageStore, imageSources, undefined, undefined, shutterPath).render({ outputToken: "photo", orderedAssetIds: clipSelections.map((clip) => clip.assetId), clipSelections, transitionSeconds: 0.3, resolution: "360P" }, imageOutput);
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
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=cyan:s=960x540", "-frames:v", "1", "-y", photoPath]);
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=960x540:r=30000/1001", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", anchorPath]);
    const insertionStore = new ProjectStore(path.join(root, "photo-insertion-data")); await insertionStore.initialize();
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
    const result = await new ConcatRenderService(insertionStore, insertionSources, undefined, undefined, shutterPath).render({ outputToken: "inside", orderedAssetIds: clips.map((clip) => clip.assetId), clipSelections: clips, transitionSeconds: 0.3, resolution: "360P" }, output);
    expect(result.photoShutterAppliedCount).toBe(1);
    const expectedDurationMs = anchor.mediaInfo!.durationMs! + 3_000 - 600;
    expect(Math.abs((await new MediaProbe().probe(output)).durationMs! - expectedDurationMs)).toBeLessThanOrEqual(120);
    expect(await Promise.all([sha256(anchorPath), sha256(photoPath)])).toEqual(before);
  }, 45_000);

  it("splits a host around an independently trimmed inserted video and preserves both sources", async () => {
    const anchorPath = path.join(root, "影片安插主片.mp4"); const insertedPath = path.join(root, "補充 影片.MOV");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=purple:s=960x540:r=30000/1001", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", anchorPath]);
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=green:s=540x960:r=30", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", insertedPath]);
    const insertionStore = new ProjectStore(path.join(root, "video-insertion-data")); await insertionStore.initialize();
    const insertionSources = new SourceService(insertionStore, new MediaProbe()); await insertionSources.importSelected([anchorPath, insertedPath]);
    await Promise.all(insertionStore.getProject().sources.map((asset) => insertionSources.ensureMetadata(asset.id)));
    const anchor = insertionStore.getProject().sources.find((asset) => asset.sourcePath === anchorPath)!;
    const insertedVideo = insertionStore.getProject().sources.find((asset) => asset.sourcePath === insertedPath)!;
    const project = await insertionStore.addMediaInsertion(anchor.id, insertedVideo.id, 2_000, { inMs: 500, outMs: 2_500 });
    const clips = mainRenderSelections(project);
    expect(clips).toEqual([
      { assetId: anchor.id, inMs: 0, outMs: 2_000 },
      { assetId: insertedVideo.id, inMs: 500, outMs: 2_500, mediaInsertionId: project.mediaInsertions[0].id },
      { assetId: anchor.id, inMs: 2_000, outMs: anchor.mediaInfo!.durationMs! },
    ]);
    const before = await Promise.all([sha256(anchorPath), sha256(insertedPath)]); const output = path.join(root, "video-inside-video.mp4");
    const result = await new ConcatRenderService(insertionStore, insertionSources).render({ outputToken: "insert-video", orderedAssetIds: clips.map((clip) => clip.assetId), clipSelections: clips, transitionSeconds: 0.3, resolution: "360P" }, output);
    const info = await new MediaProbe().probe(output); const expectedDurationMs = anchor.mediaInfo!.durationMs! + 2_000 - 600;
    expect(result.expectedDurationMs).toBe(expectedDurationMs);
    expect(Math.abs(info.durationMs! - expectedDurationMs)).toBeLessThanOrEqual(120);
    expect(info).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    expect(await Promise.all([sha256(anchorPath), sha256(insertedPath)])).toEqual(before);
  }, 60_000);

  it("renders measurable 0%/100%/200% clip automation over the 80% default while preserving source hashes", async () => {
    const assets = store.getProject().sources.slice(0, 2);
    await store.setPreviewRange(assets[0].id, 0, 1_400); await store.setPreviewRange(assets[1].id, 0, 1_400);
    await store.setVolumeSegments(assets[0].id, [
      { id: "mute", startMs: 0, endMs: 200, volumePercent: 0 },
      { id: "boost", startMs: 900, endMs: 1_200, volumePercent: 200 },
    ]);
    await store.setMainExclusionRanges(assets[0].id, [{ id: "volume-cut", startMs: 600, endMs: 900 }]);
    const before = await Promise.all([sha256(firstPath), sha256(secondPath)]);
    const automatedOutput = path.join(root, "volume-automation.mp4");
    await new ConcatRenderService(store, sources).render({ outputToken: "volume", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" }, automatedOutput);
    const muted = await volumeStats(automatedOutput, 0.03, 0.12);
    const boosted = await volumeStats(automatedOutput, 0.38, 0.10);
    const normal = await volumeStats(automatedOutput, 0.63, 0.08);
    expect(normal.mean).toBeGreaterThan(-35);
    expect(muted.mean).toBeLessThan(-60);
    expect(boosted.mean).toBeGreaterThan(normal.mean + 4.5);
    expect(await Promise.all([sha256(firstPath), sha256(secondPath)])).toEqual(before);
    await store.setMainExclusionRanges(assets[0].id, []);
  }, 45_000);

  it("mixes a read-only MP3 with fades and 200% gain under the output limiter, and blocks offline BGM", async () => {
    const bgmPath = path.join(root, "配樂 200%.mp3");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "1.5", "-c:a", "libmp3lame", "-q:a", "4", "-y", bgmPath]);
    const bgmHash = await sha256(bgmPath);
    const track = { id: "bgm-e2e", sourcePath: bgmPath, fileName: path.basename(bgmPath), sizeBytes: (await stat(bgmPath)).size, durationMs: 1_500, sourceInMs: 0, sourceOutMs: 1_500, timelineInMs: 0, timelineOutMs: 1_500, fadeInMs: 100, fadeOutMs: 100, volumePercent: 200, sourcePolicy: "READ_ONLY" as const, addedAt: new Date().toISOString() };
    await store.setVolumeSegments(store.getProject().sources[0].id, []);
    await store.addBgmTracks([track]);
    const assets = store.getProject().sources.slice(0, 2);
    await store.setMainExclusionRanges(assets[0].id, [{ id: "bgm-cut", startMs: 500, endMs: 900 }]);
    const mixedOutput = path.join(root, "mixed-bgm.mp4");
    const result = await new ConcatRenderService(store, sources).render({ outputToken: "bgm", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" }, mixedOutput);
    const stats = await volumeStats(mixedOutput, 0.2, 0.8);
    expect(result.bgmAppliedCount).toBe(1); expect(result.mixPolicy).toBe("ORIGINAL_PLUS_BGM_LIMITED_0_95");
    expect(result.expectedDurationMs).toBe(1_800);
    expect(stats.max).toBeLessThanOrEqual(0.5); expect(stats.mean).toBeGreaterThan(-20);
    expect(await sha256(bgmPath)).toBe(bgmHash);
    await rm(bgmPath);
    await expect(new ConcatRenderService(store, sources).render({ outputToken: "offline", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" }, path.join(root, "offline.mp4"))).rejects.toThrow(/不存在或離線/);
    await store.removeBgmTrack(track.id);
    const pending = { ...track, id: "youtube-pending", sourcePath: "", fileName: "YouTube 參考", sizeBytes: 0, durationMs: 0, sourceInMs: 0, sourceOutMs: 0, timelineInMs: 0, timelineOutMs: 0, fadeInMs: 0, fadeOutMs: 0, volumePercent: 35, sourceKind: "YOUTUBE_REFERENCE" as const, resolutionStatus: "NEEDS_LOCAL_FILE" as const, sourceUrl: "https://www.youtube.com/watch?v=abc123XYZ" };
    await store.addBgmTracks([pending]);
    await expect(new ConcatRenderService(store, sources).render({ outputToken: "pending", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" }, path.join(root, "pending.mp4"))).rejects.toThrow(/尚未指定自有或已授權/);
    await store.removeBgmTrack(pending.id); await store.setMainExclusionRanges(assets[0].id, []);
  }, 45_000);

  it("honors rotation metadata and renders a portrait clip over same-source blurred side fill", async () => {
    const basePath = path.join(root, "rotation-base.mp4"); const rotatedPath = path.join(root, "手機 rotation 90.mp4");
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=854x480:r=24", "-t", "1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", basePath]);
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-display_rotation:v:0", "90", "-i", basePath, "-c", "copy", "-y", rotatedPath]);
    const imported = await sources.importSelected([rotatedPath]); const rotatedId = imported.addedAssetIds[0];
    await store.placeAsset(rotatedId, { action: "END" });
    const rotated = await sources.ensureMetadata(rotatedId);
    expect(rotated.mediaInfo).toMatchObject({ rotationDegrees: 90, displayWidth: 480, displayHeight: 854, isPortrait: true });
    const graph = buildConcatFilterGraph([{ sourcePath: rotatedPath, durationMs: 1500, hasAudio: false, isPortrait: true }], 0.3, "360P");
    expect(graph.filterGraph).toContain("split=2"); expect(graph.filterGraph).toContain("boxblur"); expect(graph.filterGraph).toContain("overlay=(W-w)/2:(H-h)/2");
    await store.setMainExclusionRanges(rotatedId, [{ id: "portrait-cut", startMs: 500, endMs: 900 }]);
    expect(currentMainRequest().clipSelections.filter((clip) => clip.assetId === rotatedId)).toEqual([{ assetId: rotatedId, inMs: 0, outMs: 500 }, { assetId: rotatedId, inMs: 900, outMs: 1_500 }]);
    const portraitOutput = path.join(root, "portrait-blur.mp4");
    await new ConcatRenderService(store, sources).render({ outputToken: "portrait", ...currentMainRequest(), transitionSeconds: 0.3, resolution: "360P" }, portraitOutput);
    expect(await new MediaProbe().probe(portraitOutput)).toMatchObject({ width: 640, height: 360 });
  }, 60_000);

  it("actually burns independently styled Traditional Chinese and English subtitles into a playable MP4", async () => {
    const subtitleStore = new ProjectStore(path.join(root, "subtitle-app-data")); await subtitleStore.initialize();
    const subtitleSources = new SourceService(subtitleStore, new MediaProbe()); await subtitleSources.importSelected([firstPath]);
    const source = await subtitleSources.ensureMetadata(subtitleStore.getProject().sources[0].id);
    await subtitleStore.setSubtitleCues([{ id: "confirmed", startMs: 150, endMs: 1_200, text: "河內散步精彩開始", reviewStatus: "CONFIRMED" }]);
    const before = await sha256(firstPath);
    const translations = { translate: async () => ({ byLanguage: { "zh-TW": ["河內散步精彩開始"], en: ["Our Hanoi walk begins"] }, providers: ["ORIGINAL", "OPENAI"] }) };
    const clips = mainRenderSelections(subtitleStore.getProject());
    const output = path.join(root, "雙語 字幕 preview.mp4");
    const result = await new ConcatRenderService(subtitleStore, subtitleSources, undefined, undefined, undefined, translations as never, path.join(root, "subtitle-cache")).render({ outputToken: "subtitle", orderedAssetIds: [source.id], clipSelections: clips, transitionSeconds: 0.3, resolution: "360P", subtitleBurnIn: { enabled: true, tracks: [{ language: "zh-TW", position: "BOTTOM", fontSize1080p: 60 }, { language: "en", position: "TOP", fontSize1080p: 42 }] } }, output);
    expect(result.subtitleBurnedLanguages).toEqual(["zh-TW", "en"]);
    expect(result.subtitleTranslationProviders).toEqual(["ORIGINAL", "OPENAI"]);
    expect(await new MediaProbe().probe(output)).toMatchObject({ width: 640, height: 360, videoCodec: "h264", audioCodec: "aac" });
    const signal = await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", output, "-vf", "signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"]);
    expect(Number(/lavfi\.signalstats\.YMAX=(\d+)/.exec(signal.stdout)?.[1] ?? 0)).toBeGreaterThan(150);
    expect(await sha256(firstPath)).toBe(before);
    expect((await readdir(path.join(root, "subtitle-cache"))).filter((name) => name.endsWith(".ass"))).toEqual([]);
  }, 45_000);
});
