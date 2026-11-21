import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell as electronShell } from "electron";
import type {
  AiAccountSaveInput,
  AiPublishGenerationOptions,
  AiStoryContext,
  AiSubtitleGenerationOptions,
  AudioPreviewRequest,
  AudioTrackGates,
  BackgroundJobKind,
  BackgroundJobSnapshot,
  BackgroundJobStatus,
  BgmTrack,
  BrowserUploadPlatform,
  ConcatRenderEstimateRequest,
  ConcatRenderRequest,
  ExternalMediaTarget,
  ExternalPlayerId,
  ExternalPlayerSettingsUpdate,
  GeminiReviewSettingsUpdate,
  IntroSuggestion,
  InsertionAudioScope,
  InsertionAudioSettings,
  MainExclusionRange,
  MainStartCueSettings,
  MaterialSubtitleAnalysisRequest,
  MusicSuggestionRequest,
  PlacementRequest,
  PreviewVariant,
  ProjectColorSettings,
  SortMode,
  SubtitleCue,
  SubtitleAiCheckAction,
  SubtitleAiCheckJobSnapshot,
  SubtitleAiCheckProgress,
  SubtitleAiCheckRequest,
  SubtitleTimelineScope,
  SubtitleVisualAnalysisOptions,
  SubtitleVisualCueRegenerateRequest,
  SubtitleVisualAnalysisProgress,
  SubtitleVisualPreflight,
  ThumbnailRenderRequest,
  TransitionDurationSec,
  TranslationSettingsUpdate,
  UserPreferencesUpdate,
  RenderTempLocationConfig,
  RenderTempLocationStatus,
  RenderCheckpointRemapRequest,
  ExecuteResumeStoragePlanRequest,
  ExecuteTemporaryArtifactActionsRequest,
  VoiceInputRequest,
  VolumeSegment,
  WatermarkSettings,
  YoutubeSettingsUpdate,
  YoutubeUploadRequest,
  ZoomSegment,
} from "../shared/domain";
import { ConcatRenderService } from "./services/concat-render";
import { IntroAnalyzer } from "./services/intro-analyzer";
import { PreviewCache } from "./services/preview-cache";
import { ProjectStore } from "./services/project-store";
import { emptyCancelledResult, MEDIA_DIALOG_FILTERS, SourceService } from "./services/source-service";
import { ExternalPlayerService } from "./services/external-player";
import { PlayerSettingsStore } from "./services/player-settings";
import { BgmService } from "./services/bgm-service";
import { backupExistingSubtitleOutput, exportSrt } from "./services/subtitle-export";
import { importSrtFile } from "./services/subtitle-import";
import {
  preflightSubtitleAiDraft,
  promoteSubtitleAiDraft as promoteStoredSubtitleAiDraft,
  writeSubtitleAiDraft,
} from "./services/subtitle-draft-store";
import { AiSettingsStore } from "./services/ai-settings";
import { AiModelCatalogService } from "./services/ai-model-catalog";
import { AiStoryAnalysisService } from "./services/ai-story-analysis";
import { YoutubeSettingsStore, YoutubeUploadService } from "./services/youtube-upload";
import { PlatformUploadHandoffService } from "./services/platform-upload-handoff";
import { OutputHistoryStore } from "./services/output-history";
import { MediaProbe } from "./services/media-probe";
import {
  selectSubtitleVideoSource,
  subtitleTimelineCompatibility,
  subtitleAnalysisMode,
} from "./services/subtitle-video-selection";
import { StandaloneSubtitleStore, authorizeSubtitleVideo } from "./services/standalone-subtitle-store";
import { SubtitleFrameExtractor } from "./services/subtitle-frame-extractor";
import { OpenAiSubtitleVisionProvider, GeminiSubtitleVisionProvider } from "./services/subtitle-vision-providers";
import { runSubtitleVisionDrafts, type SubtitleVisionFrame } from "./services/subtitle-vision-orchestrator";
import { runSubtitleVisionBatchWithFallback } from "./services/subtitle-vision-fallback";
import {
  buildSubtitleAiCheckProposal,
  advanceSubtitleAiCheckProgress,
  classifySubtitleAiCheckError,
  createSubtitleAiCheckSnapshot,
  GeminiSubtitleAiCheckProvider,
  OpenAiSubtitleAiCheckProvider,
  resolveSubtitleAiCheckAction,
  subtitleCueRevision,
  subtitleAiCheckContextRevision,
  SubtitleAiCheckError,
  SubtitleAiCheckJobStore,
} from "./services/subtitle-ai-check";
import { DiskSubtitleVisionCache } from "./services/subtitle-vision-cache";
import { mergeSubtitleVisionDrafts } from "./services/subtitle-draft-merge";
import { buildTimelinePlan } from "../shared/timeline-plan";
import { UserPreferencesStore } from "./services/user-preferences";
import { TranslationSettingsStore } from "./services/translation-settings";
import { SubtitleTranslationService } from "./services/subtitle-translation";
import { SubtitlePreviewService } from "./services/subtitle-preview";
import { nextAvailableOutputPath, safePreviewFileName } from "./services/output-path";
import { MusicSuggestionService } from "./services/music-suggestion";
import { AiPublishAssetsService } from "./services/ai-publish-assets";
import { renderThumbnail } from "./services/thumbnail-render";
import { buildRenderEstimate, buildRenderEstimateWorkload } from "./services/render-estimate";
import { RenderPowerGuard } from "./services/render-power-guard";
import { buildRuntimeRenderPolicy, captureSystemResources, resourceWarnings } from "./services/system-resource";
import { RenderHardwareService } from "./services/render-hardware";
import { RenderBenchmarkService } from "./services/render-benchmark";
import { resourceProfileFromLegacy } from "../shared/render-resource";
import { AudioPreviewService } from "./services/audio-preview";
import { RenderCommandState } from "./services/render-command-state";
import { validateRenderTemporaryFolder } from "./services/render-disk-space";
import { evaluateRenderTempPreflight, probeRenderTempLocations } from "./services/render-temp-scheduler";
import { describeRenderTempLocation } from "./services/render-temp-scheduler";
import { scanRegisteredTemporaryArtifacts } from "./services/temporary-artifact-inventory";
import { RemoteControlServer } from "./services/remote-control-server";
import {
  completedRenderQualifies,
  completedYoutubeUploadQualifies,
  PostSuccessPowerScheduler,
} from "./services/post-success-power";

const SORT_MODES = new Set<SortMode>([
  "MANUAL_ORDER",
  "SMART_SEQUENCE",
  "FILE_NAME",
  "CAPTURE_OR_FILE_TIME",
  "ADDED_ORDER",
]);
const PREVIEW_VARIANTS = new Set<PreviewVariant>(["THUMBNAIL", "IMAGE_PREVIEW", "VIDEO_PROXY"]);
const RENDER_RESOLUTIONS = new Set(["360P", "480P", "720P", "1080P", "1440P", "4K"]);
const RENDER_CODECS = new Set(["H264_NVENC", "H265_NVENC", "H265_QSV", "H264_QSV", "H265", "H264"]);

export function registerIpc(
  store: ProjectStore,
  sources: SourceService,
  previews: PreviewCache,
  concatRenderer: ConcatRenderService,
  introAnalyzer: IntroAnalyzer,
  playerSettings: PlayerSettingsStore,
  externalPlayers: ExternalPlayerService,
  bgm: BgmService,
  aiSettings: AiSettingsStore,
  aiStory: AiStoryAnalysisService,
  translationSettings: TranslationSettingsStore,
  subtitleTranslation: SubtitleTranslationService,
  youtubeSettings: YoutubeSettingsStore,
  youtubeUpload: YoutubeUploadService,
  platformUploadHandoff: PlatformUploadHandoffService,
  outputHistory: OutputHistoryStore,
  userPreferences: UserPreferencesStore,
  subtitlePreviews: SubtitlePreviewService,
  musicSuggestions: MusicSuggestionService,
  aiPublishAssets: AiPublishAssetsService,
  renderPowerGuard: RenderPowerGuard,
  renderHardware: RenderHardwareService,
  renderBenchmark: RenderBenchmarkService,
  audioPreviews: AudioPreviewService,
  renderCommands: RenderCommandState,
  remoteControl: RemoteControlServer,
  postSuccessPower: PostSuccessPowerScheduler,
): void {
  let importController: AbortController | undefined;
  let concatController: AbortController | undefined;
  let introController: AbortController | undefined;
  let subtitleExportController: AbortController | undefined;
  let aiSubtitleController: AbortController | undefined;
  let materialAnalysisController: AbortController | undefined;
  let subtitlePreviewController: AbortController | undefined;
  let subtitleVisualController: AbortController | undefined;
  let subtitleAiCheckController: AbortController | undefined;
  let subtitleAiCheckRunPromise: Promise<SubtitleAiCheckJobSnapshot> | undefined;
  let subtitleAiCheckPaused = false;
  let subtitleVisualPaused = false;
  let subtitleVisualLastOptions: SubtitleVisualAnalysisOptions | undefined;
  let lastManualSubtitleVideoPath: string | undefined;
  let explicitSubtitleVideoPath: string | undefined;
  let resumedSubtitleSelectionReason: "PROJECT_CONCAT" | "LATEST_CONCAT" | "MANUAL_PATH" | undefined;
  const standaloneSubtitles = new StandaloneSubtitleStore(path.join(app.getPath("userData"), "subtitle-workspaces"));
  const aiModels = new AiModelCatalogService(app.getPath("userData"));
  const aiRuntime = (provider: "OPENAI" | "GEMINI", accountId?: string) => {
    if (provider === "OPENAI") {
      const runtime = aiSettings.getRuntimeAccount(accountId);
      return { key: runtime.apiKey, model: runtime.visionModel };
    }
    const runtime = aiSettings.getRuntimeGeminiReview();
    if (!runtime.apiKey) throw new Error("Gemini 尚未設定 API Key。");
    return { key: runtime.apiKey, model: runtime.model };
  };
  ipcMain.handle("ai:models:refresh", (_event, provider: "OPENAI" | "GEMINI", accountId?: string) => {
    if (provider !== "OPENAI" && provider !== "GEMINI") throw new Error("模型服務無效。");
    const runtime = aiRuntime(provider, accountId);
    return aiModels.refresh(provider, runtime.key, runtime.model);
  });
  ipcMain.handle(
    "ai:vision:test",
    async (_event, provider: "OPENAI" | "GEMINI", accountId?: string, modelId?: string) => {
      if (provider !== "OPENAI" && provider !== "GEMINI") throw new Error("模型服務無效。");
      const runtime = aiRuntime(provider, accountId);
      if (modelId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,150}$/.test(modelId)) throw new Error("模型名稱格式無效。");
      return aiModels.test(provider, runtime.key, modelId ?? runtime.model);
    },
  );
  const subtitleProvider = async (choice: "CHATGPT" | "GEMINI") => {
    const kind = choice === "GEMINI" ? "GEMINI" : "OPENAI";
    const runtime = aiRuntime(kind);
    if (kind === "GEMINI" && !aiSettings.getRuntimeGeminiReview().enabled) throw new Error("請先明確啟用 Gemini。");
    let model: string;
    try {
      model = await aiModels.resolve(kind, runtime.key, runtime.model);
    } catch (error) {
      if (runtime.model.toLowerCase() !== "auto") throw error;
      const probe = await aiModels.test(kind, runtime.key, "auto");
      if (!probe.ok) throw new Error(probe.message);
      model = await aiModels.resolve(kind, runtime.key, "auto");
    }
    return {
      provider:
        kind === "GEMINI"
          ? new GeminiSubtitleVisionProvider(model, runtime.key)
          : new OpenAiSubtitleVisionProvider(model, runtime.key),
      model,
      apiKey: runtime.key,
      selectionMode: runtime.model.toLowerCase() === "auto" ? ("AUTO" as const) : ("MANUAL" as const),
    };
  };
  const subtitleLogPath = path.join(app.getPath("userData"), "jobs", "subtitle-v087.log");
  const subtitleLog = (stage: string, data: unknown) => {
    void mkdir(path.dirname(subtitleLogPath), { recursive: true })
      .then(() =>
        appendFile(subtitleLogPath, `${new Date().toISOString()} [${stage}] ${JSON.stringify(data)}\n`, "utf8"),
      )
      .catch(() => undefined);
  };
  const subtitleVideoProbe = new MediaProbe();
  const subtitleFrameExtractor = new SubtitleFrameExtractor();
  const subtitleVisualCheckpointPath = path.join(app.getPath("userData"), "jobs", "subtitle-visual-job.json");
  const subtitleAiCheckJobs = new SubtitleAiCheckJobStore(
    path.join(app.getPath("userData"), "jobs", "subtitle-ai-check-job.json"),
  );
  const subtitleSourcePreferencePath = path.join(app.getPath("userData"), "settings", "subtitle-analysis-source.json");
  let voiceInputController: AbortController | undefined;
  let musicSuggestionController: AbortController | undefined;
  let audioPreviewController: AbortController | undefined;
  let aiPublishController: AbortController | undefined;
  let youtubeAuthController: AbortController | undefined;
  let youtubeUploadController: AbortController | undefined;
  const previewControllers = new Map<string, AbortController>();
  const outputTokens = new Map<string, { outputPath: string; createdAt: number; allowOverwrite: boolean }>();
  const thumbnailTokens = new Map<string, { outputPath: string; createdAt: number; format: "jpg" | "png" }>();
  const subtitleOutputTokens = new Map<
    string,
    { outputPath: string; createdAt: number; draftScopes?: SubtitleTimelineScope[]; draftCueIds?: string[] }
  >();
  const backgroundJobs = new Map<string, BackgroundJobSnapshot>();
  const appWorkingSetBytes = () =>
    app.getAppMetrics().reduce((sum, metric) => sum + Math.max(0, metric.memory?.workingSetSize ?? 0) * 1024, 0);

  const estimateConcatWithSystem = async (outputPath: string, request: ConcatRenderEstimateRequest) => {
    const defaults = userPreferences.snapshot().renderDefaults;
    const configuredTemp = defaults.renderTemporaryFolder ?? app.getPath("temp");
    const configuredLocations = defaults.tempLocations?.length
      ? defaults.tempLocations
      : [{ id: "primary", path: configuredTemp, role: "PRIMARY" as const, enabled: true, allowFallback: true }];
    const tempLocationStatuses = await probeRenderTempLocations(configuredLocations);
    const resourceTemp =
      tempLocationStatuses.find((item) => item.role === "PRIMARY" && item.available) ??
      tempLocationStatuses.find((item) => item.available);
    const renderTemp = resourceTemp ?? (await validateRenderTemporaryFolder(configuredTemp));
    const workload = buildRenderEstimateWorkload(
      store.getProject().sources,
      request.orderedAssetIds,
      request.clipSelections,
      request.expectedDurationMs,
      request.transitionSeconds,
      request.generatedInputCount,
    );
    const systemResources = await captureSystemResources(outputPath, {
      appWorkingSetBytes: appWorkingSetBytes(),
      tempPath: renderTemp.path,
    });
    const resourceProfile = resourceProfileFromLegacy(request);
    const maximumRenderRamGiB = request.maximumRenderRamGiB ?? defaults.maximumRenderRamGiB;
    const maximumRenderTempGiB = request.maximumRenderTempGiB ?? defaults.maximumRenderTempGiB;
    const baselineEstimate = buildRenderEstimate(
      outputPath,
      systemResources.outputDriveFreeBytes,
      request.expectedDurationMs,
      request.resolution,
      request.videoCodec,
      request.lowMemorySegmented === true,
      workload,
      systemResources.availableRamBytes,
      systemResources.totalRamBytes,
      undefined,
      undefined,
      systemResources.outputDriveCapacityBytes,
      renderTemp.path,
      renderTemp.freeBytes,
      resourceProfile,
    );
    const lowPolicy = buildRuntimeRenderPolicy(
      true,
      baselineEstimate.modeEstimates.lowMemory,
      systemResources.totalRamBytes,
      systemResources.availableRamBytes,
      baselineEstimate.workload.visualInputCount,
      systemResources,
      false,
      maximumRenderRamGiB,
      maximumRenderTempGiB,
    );
    const normalPolicy = buildRuntimeRenderPolicy(
      false,
      baselineEstimate.modeEstimates.normal,
      systemResources.totalRamBytes,
      systemResources.availableRamBytes,
      baselineEstimate.workload.visualInputCount,
      systemResources,
      false,
      maximumRenderRamGiB,
      maximumRenderTempGiB,
    );
    const highSpeedPolicy = buildRuntimeRenderPolicy(
      false,
      baselineEstimate.modeEstimates.highSpeed ?? baselineEstimate.modeEstimates.normal,
      systemResources.totalRamBytes,
      systemResources.availableRamBytes,
      baselineEstimate.workload.visualInputCount,
      systemResources,
      true,
      maximumRenderRamGiB,
      maximumRenderTempGiB,
    );
    const estimate = buildRenderEstimate(
      outputPath,
      systemResources.outputDriveFreeBytes,
      request.expectedDurationMs,
      request.resolution,
      request.videoCodec,
      request.lowMemorySegmented === true,
      workload,
      systemResources.availableRamBytes,
      systemResources.totalRamBytes,
      {
        lowMemory: lowPolicy.maxVisualInputsPerStage,
        normal: normalPolicy.maxVisualInputsPerStage,
        highSpeed: highSpeedPolicy.maxVisualInputsPerStage,
      },
      {
        lowMemory: lowPolicy.maximumParallelJobs,
        normal: normalPolicy.maximumParallelJobs,
        highSpeed: highSpeedPolicy.maximumParallelJobs,
      },
      systemResources.outputDriveCapacityBytes,
      renderTemp.path,
      renderTemp.freeBytes,
      resourceProfile,
    );
    const enrichMode = (base: typeof estimate.modeEstimates.lowMemory, policy: typeof lowPolicy) => {
      const warnings = resourceWarnings(systemResources, base, policy);
      if (
        policy.maximumRenderTempBytes &&
        (base.diskBreakdown?.peakWorkingBytes ?? base.estimatedTemporaryBytes) > policy.maximumRenderTempBytes
      ) {
        warnings.push(
          `此模式預估 APP 工作檔峰值高於 TEMP 上限 ${(policy.maximumRenderTempBytes / 1024 ** 3).toFixed(0)} GB；排程器不會超限，將縮減工作或在安全邊界暫停。`,
        );
      }
      const commitDanger = Boolean(
        systemResources.commitLimitBytes &&
        systemResources.committedBytes &&
        systemResources.commitLimitBytes - systemResources.committedBytes < base.estimatedPeakRamBytes,
      );
      return {
        mode: {
          ...base,
          warnings,
          warningLevel:
            base.warningLevel === "DANGER" || commitDanger
              ? ("DANGER" as const)
              : warnings.length
                ? ("WARNING" as const)
                : base.warningLevel,
        },
        policy,
      };
    };
    const low = enrichMode(estimate.modeEstimates.lowDisk ?? estimate.modeEstimates.lowMemory, lowPolicy);
    const normal = enrichMode(estimate.modeEstimates.balanced ?? estimate.modeEstimates.normal, normalPolicy);
    const high = enrichMode(estimate.modeEstimates.highSpeed ?? estimate.modeEstimates.normal, highSpeedPolicy);
    const selected = resourceProfile === "LOW_DISK" ? low : resourceProfile === "HIGH_SPEED" ? high : normal;
    const estimatedNextTempJobBytes = Math.max(
      1,
      selected.policy.estimatedWorkingBytesPerJob ??
        Math.ceil(
          (selected.mode.diskBreakdown?.concurrentPartialPeakBytes ?? selected.mode.estimatedTemporaryBytes) /
            Math.max(1, selected.policy.maximumParallelJobs),
        ),
    );
    const breakdown = selected.mode.diskBreakdown;
    const outputHardRequiredBytes = selected.mode.estimatedOutputBytes + estimate.minimumReserveBytes;
    const admission = evaluateRenderTempPreflight(
      tempLocationStatuses,
      estimatedNextTempJobBytes,
      request.tempLocationSelection ?? defaults.tempLocationSelection ?? "AUTO",
      breakdown?.currentOutputFreeBytes ?? systemResources.outputDriveFreeBytes,
      outputHardRequiredBytes,
      path.parse(outputPath).root.toUpperCase(),
      selected.mode.estimatedOutputBytes,
      estimate.minimumReserveBytes,
    );
    const { selectedTemp, outputVolumeCanRender } = admission;
    const multiVolumeWarnings = [...selected.mode.warnings];
    if (!selectedTemp) multiVolumeWarnings.push("沒有任何單一 Render TEMP 磁碟可在保留安全空間後容納下一個工作。");
    if (admission.sharedVolumeConflict)
      multiVolumeWarnings.push(
        "TEMP 與 Final Output 位於同一磁碟時，必須同時容納下一工作與成品，不能分開計算可用空間。",
      );
    if (!outputVolumeCanRender) multiVolumeWarnings.push("Final Output 磁碟空間不足；TEMP 備援不會改變成品路徑。");
    return {
      ...estimate,
      estimatedTemporaryBytes: selected.mode.estimatedTemporaryBytes,
      estimatedRenderTimeMs: selected.mode.estimatedRenderTimeMs,
      estimatedFreeAfterBytes: selected.mode.estimatedFreeAfterBytes,
      canRender: admission.canRender,
      warning: multiVolumeWarnings.join(" ") || undefined,
      modeEstimates: {
        lowMemory: low.mode,
        normal: normal.mode,
        lowDisk: low.mode,
        balanced: normal.mode,
        highSpeed: high.mode,
      },
      systemResources,
      runtimePolicy: selected.policy,
      hardwareCapabilities: await renderHardware.getCapabilities(),
      tempLocationStatuses,
      selectedTempLocationId: selectedTemp?.locationId,
      estimatedNextTempJobBytes,
      outputVolumeCanRender,
    };
  };
  const unsubscribeProjectChanges = store.subscribe((change) => {
    renderCommands.setProjectName(change.project.name);
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send("project:changed", change);
  });
  remoteControl.setStatusListener((status) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send("remote-control:status", status);
  });
  const publishBackgroundJobs = () => {
    const jobs = [...backgroundJobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send("background:jobs", jobs);
  };
  const pruneBackgroundJobs = () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of backgroundJobs)
      if (job.status !== "RUNNING" && Date.parse(job.finishedAt ?? job.startedAt) < cutoff) backgroundJobs.delete(id);
  };
  const beginBackgroundJob = (kind: BackgroundJobKind, label: string): string => {
    pruneBackgroundJobs();
    const id = randomUUID();
    const project = store.getProject();
    backgroundJobs.set(id, {
      id,
      kind,
      label,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      projectId: project.id,
      projectName: project.name,
      projectRevision: project.timelineRevision,
    });
    publishBackgroundJobs();
    return id;
  };
  const assertNoRunningProjectJobs = () => {
    const running = [...backgroundJobs.values()].filter((job) => job.status === "RUNNING");
    if (running.length)
      throw new Error(
        `目前有 ${running.length} 個背景工作正在處理「${running[0].projectName ?? "目前專案"}」，完成或取消後才能切換專案。`,
      );
  };
  const updateBackgroundJob = (
    id: string,
    patch: Pick<BackgroundJobSnapshot, "percent" | "detail" | "attemptElapsedMs" | "cumulativeElapsedMs">,
  ) => {
    const current = backgroundJobs.get(id);
    if (!current) return;
    backgroundJobs.set(id, { ...current, ...patch });
    publishBackgroundJobs();
  };
  const finishBackgroundJob = (
    id: string,
    status: BackgroundJobStatus,
    patch: Pick<BackgroundJobSnapshot, "detail" | "error"> = {},
  ) => {
    const current = backgroundJobs.get(id);
    if (!current) return;
    backgroundJobs.set(id, {
      ...current,
      ...patch,
      status,
      percent: status === "COMPLETED" ? 100 : current.percent,
      finishedAt: new Date().toISOString(),
    });
    publishBackgroundJobs();
  };

  const runImport = async (event: Electron.IpcMainInvokeEvent, mode: "FILES" | "FOLDER" | "INTRO_FILES") => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const isFolder = mode === "FOLDER";
    const preferenceKey = mode === "INTRO_FILES" ? "INTRO_MEDIA" : mode === "FILES" ? "SOURCE_MEDIA" : "SOURCE_FOLDER";
    const options: Electron.OpenDialogOptions = {
      title: mode === "INTRO_FILES" ? "加入片頭影片或照片" : mode === "FILES" ? "選擇影片與照片" : "選擇來源資料夾",
      defaultPath: userPreferences.getLastDirectory(preferenceKey, app.getPath("videos")),
      properties: isFolder ? ["openDirectory"] : ["openFile", "multiSelections"],
      filters: isFolder ? undefined : MEDIA_DIALOG_FILTERS,
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return emptyCancelledResult(store.getProject());
    }
    await userPreferences.rememberDirectory(preferenceKey, result.filePaths[0], isFolder);

    importController?.abort();
    importController = new AbortController();
    try {
      return await sources.importSelected(result.filePaths, importController.signal, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("import:progress", progress);
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return emptyCancelledResult(store.getProject());
      }
      throw error;
    } finally {
      importController = undefined;
    }
  };

  ipcMain.handle("app:get-info", () => ({ version: app.getVersion(), productName: app.getName() }));
  ipcMain.handle("power-action:get-status", () => postSuccessPower.status());
  ipcMain.handle("power-action:cancel", () => postSuccessPower.cancel());
  ipcMain.handle("remote-control:get-status", () => remoteControl.status());
  ipcMain.handle("remote-control:enable", () => remoteControl.start());
  ipcMain.handle("remote-control:disable", () => remoteControl.stop());
  ipcMain.handle("remote-control:rotate-pairing", () => remoteControl.rotatePairing());
  ipcMain.handle("preferences:get", () => userPreferences.snapshot());
  ipcMain.handle("background:get-jobs", () => {
    pruneBackgroundJobs();
    return [...backgroundJobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  });
  ipcMain.handle("preferences:update", async (_event, update: UserPreferencesUpdate) => {
    if (update?.renderDefaults?.transitionSeconds !== undefined)
      await store.setTimelineTransitionSeconds(update.renderDefaults.transitionSeconds);
    return userPreferences.update(update);
  });
  ipcMain.handle("render-temp:choose", async (event) => {
    if (concatController) throw new Error("转档进行中，暂时不能切换 Render Temporary Folder。");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const current = userPreferences.snapshot().renderDefaults.renderTemporaryFolder ?? app.getPath("temp");
    const options: Electron.OpenDialogOptions = {
      title: "选择 Render Temporary Folder",
      defaultPath: current,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const validated = await validateRenderTemporaryFolder(result.filePaths[0]);
    const currentLocations = userPreferences.snapshot().renderDefaults.tempLocations ?? [];
    const nextLocations = currentLocations.length
      ? currentLocations.map((item) => (item.role === "PRIMARY" ? { ...item, path: validated.path } : item))
      : [{ id: "primary", path: validated.path, role: "PRIMARY" as const, enabled: true, allowFallback: true }];
    await userPreferences.setRenderTempLocations(nextLocations);
    await userPreferences.update({ renderDefaults: { renderTemporaryFolder: validated.path } });
    return validated;
  });
  ipcMain.handle("render-temp:validate", async (_event, targetPath: string) => {
    if (concatController) throw new Error("转档进行中，暂时不能切换 Render Temporary Folder。");
    const validated = await validateRenderTemporaryFolder(targetPath);
    const currentLocations = userPreferences.snapshot().renderDefaults.tempLocations ?? [];
    const nextLocations = currentLocations.length
      ? currentLocations.map((item) => (item.role === "PRIMARY" ? { ...item, path: validated.path } : item))
      : [{ id: "primary", path: validated.path, role: "PRIMARY" as const, enabled: true, allowFallback: true }];
    await userPreferences.setRenderTempLocations(nextLocations);
    await userPreferences.update({ renderDefaults: { renderTemporaryFolder: validated.path } });
    return validated;
  });
  ipcMain.handle("render-temp:list", async (): Promise<RenderTempLocationStatus[]> => {
    const locations = userPreferences.snapshot().renderDefaults.tempLocations ?? [];
    return Promise.all(
      locations.map(async (config) => {
        try {
          const disk = await validateRenderTemporaryFolder(config.path);
          return describeRenderTempLocation({ config, freeBytes: disk.freeBytes, capacityBytes: disk.capacityBytes });
        } catch {
          return describeRenderTempLocation({ config, freeBytes: 0, capacityBytes: 0, writable: false });
        }
      }),
    );
  });
  ipcMain.handle("render-temp:choose-location", async (event) => {
    if (concatController) throw new Error("轉檔進行中，暫時不能切換 Render TEMP。");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "選擇 Render TEMP 資料夾",
      defaultPath: app.getPath("temp"),
      properties: ["openDirectory", "createDirectory"],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return validateRenderTemporaryFolder(result.filePaths[0]);
  });
  ipcMain.handle("render-temp:set-locations", async (_event, locations: RenderTempLocationConfig[]) => {
    if (concatController) throw new Error("轉檔進行中，暫時不能切換 Render TEMP。");
    for (const item of locations) await validateRenderTemporaryFolder(item.path);
    await userPreferences.setRenderTempLocations(locations);
    const primary = locations.find((item) => item.role === "PRIMARY");
    if (primary) await userPreferences.update({ renderDefaults: { renderTemporaryFolder: primary.path } });
    return userPreferences.snapshot().renderDefaults.tempLocations;
  });
  ipcMain.handle("render-temp:reveal", () => {
    const target = userPreferences.snapshot().renderDefaults.renderTemporaryFolder ?? app.getPath("temp");
    electronShell.openPath(target);
  });
  ipcMain.handle("render-temp:reveal-registered", async (_event, requestedPath: string) => {
    if (typeof requestedPath !== "string" || !path.isAbsolute(requestedPath)) throw new Error("TEMP 路徑無效。");
    const requested = path.resolve(requestedPath);
    const registered = userPreferences.snapshot().renderDefaults.tempLocations ?? [];
    const root = registered
      .map((item) => path.resolve(item.path))
      .find(
        (candidate) =>
          requested.toLowerCase() === candidate.toLowerCase() ||
          requested.toLowerCase().startsWith(candidate.toLowerCase() + path.sep),
      );
    if (!root) throw new Error("只能開啟已登錄 TEMP 內的資料夾。");
    const item = await stat(requested).catch(() => undefined);
    const folder = item?.isDirectory() ? requested : path.dirname(requested);
    const result = await electronShell.openPath(folder);
    if (result) throw new Error(`無法開啟 TEMP 資料夾：${result}`);
  });
  ipcMain.handle("project:get", () => store.getProject());
  ipcMain.handle("project:history-state", () => store.getHistoryState());
  ipcMain.handle("project:undo", () => store.undo());
  ipcMain.handle("project:redo", () => store.redo());
  ipcMain.handle("project:get-file-state", () => store.getProjectFileState());
  ipcMain.handle("project:save", () => store.saveProject());
  ipcMain.handle("project:save-as", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const safeName =
      store
        .getProject()
        .name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .trim() || "SceneryWalker_project";
    const options: Electron.SaveDialogOptions = {
      title: "另存 SceneryWalker 專案",
      defaultPath: path.join(
        userPreferences.getLastDirectory("PROJECT", app.getPath("documents")),
        `${safeName}.swproj`,
      ),
      filters: [{ name: "SceneryWalker 專案", extensions: ["swproj"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const filePath =
      path.extname(result.filePath).toLowerCase() === ".swproj" ? result.filePath : `${result.filePath}.swproj`;
    await userPreferences.rememberDirectory("PROJECT", filePath);
    const projectName = path.basename(filePath, path.extname(filePath)).trim();
    return store.saveProjectAs(filePath, projectName);
  });
  ipcMain.handle("project:open", async (event) => {
    assertNoRunningProjectJobs();
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "開啟 SceneryWalker 專案",
      defaultPath: userPreferences.getLastDirectory("PROJECT", app.getPath("documents")),
      properties: ["openFile"],
      filters: [
        { name: "SceneryWalker 專案", extensions: ["swproj"] },
        { name: "舊版 JSON manifest", extensions: ["json"] },
      ],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("PROJECT", result.filePaths[0]);
    return store.openProject(result.filePaths[0]);
  });
  ipcMain.handle("source:choose-files", (event) => runImport(event, "FILES"));
  ipcMain.handle("source:choose-folder", (event) => runImport(event, "FOLDER"));
  ipcMain.handle("intro:choose-files", (event) => runImport(event, "INTRO_FILES"));
  ipcMain.handle("source:cancel-import", () => importController?.abort());
  ipcMain.handle("main:remove-asset", (_event, assetId: string) => store.removeMainAsset(assetId));
  ipcMain.handle("main:restore-asset", (_event, assetId: string) => store.restoreMainAsset(assetId));
  ipcMain.handle("intro:set-segments", (_event, segments: IntroSuggestion[]) => store.setIntroSegments(segments));
  ipcMain.handle("intro:set-target-duration", (_event, durationMs: number) => store.setIntroTargetDuration(durationMs));
  ipcMain.handle("intro:set-segment-max-duration", (_event, durationMs: number) =>
    store.setIntroSegmentMaxDuration(durationMs),
  );
  ipcMain.handle("project:set-color-settings", (_event, settings: ProjectColorSettings) =>
    store.setProjectColorSettings(settings),
  );
  ipcMain.handle("project:set-watermark-settings", (_event, settings: WatermarkSettings) =>
    store.setWatermarkSettings(settings),
  );
  ipcMain.handle("intro:remove-segment", (_event, segmentId: string) => store.removeIntroSegment(segmentId));
  ipcMain.handle("intro:restore-segment", (_event, segmentId: string) => store.restoreIntroSegment(segmentId));
  ipcMain.handle("source:set-preview-range", (_event, assetId: string, inMs: number, outMs: number) =>
    store.setPreviewRange(assetId, inMs, outMs),
  );
  ipcMain.handle("source:set-image-duration", (_event, assetId: string, durationMs: number) =>
    store.setImageDuration(assetId, durationMs),
  );
  ipcMain.handle("source:set-photo-sound", (_event, assetId: string, enabled: boolean) =>
    store.setPhotoSoundEnabled(assetId, enabled),
  );
  ipcMain.handle("source:set-dub-with-bgm", (_event, assetId: string, enabled: boolean) =>
    store.setDubWithBgm(assetId, enabled),
  );
  ipcMain.handle("main:set-audio-gates", (_event, assetId: string, gates: AudioTrackGates) =>
    store.setMainAudioGates(assetId, gates),
  );
  ipcMain.handle("main:set-start-cue", (_event, settings: MainStartCueSettings) => store.setMainStartCue(settings));
  ipcMain.handle(
    "main:add-media-insertion",
    (
      _event,
      anchorVideoAssetId: string,
      insertedAssetId: string,
      atMs: number,
      sourceRange?: { inMs: number; outMs: number },
    ) => store.addMediaInsertion(anchorVideoAssetId, insertedAssetId, atMs, sourceRange),
  );
  ipcMain.handle(
    "main:update-media-insertion",
    (_event, insertionId: string, atMs: number, sourceRange: { inMs: number; outMs: number }) =>
      store.updateMediaInsertion(insertionId, atMs, sourceRange),
  );
  ipcMain.handle(
    "insertion-audio:set",
    (_event, scope: InsertionAudioScope, instanceId: string, settings: InsertionAudioSettings) =>
      store.setInsertionAudio(scope, instanceId, settings),
  );
  ipcMain.handle("main:remove-media-insertion", (_event, insertionId: string) =>
    store.removeMediaInsertion(insertionId),
  );
  ipcMain.handle("main:move-media-insertion", (_event, insertionId: string, toIndex: number) =>
    store.moveMediaInsertion(insertionId, toIndex),
  );
  ipcMain.handle("source:set-volume-segments", (_event, assetId: string, segments: VolumeSegment[]) =>
    store.setVolumeSegments(assetId, segments),
  );
  ipcMain.handle("main:set-exclusion-ranges", (_event, assetId: string, ranges: MainExclusionRange[]) =>
    store.setMainExclusionRanges(assetId, ranges),
  );
  ipcMain.handle("main:set-zoom-segments", (_event, assetId: string, segments: ZoomSegment[]) =>
    store.setZoomSegments(assetId, segments),
  );
  ipcMain.handle("project:place-asset", (_event, assetId: string, placement: PlacementRequest) =>
    store.placeAsset(assetId, placement),
  );
  ipcMain.handle("project:move-asset", (_event, assetId: string, toIndex: number) =>
    store.moveTimelineAsset(assetId, toIndex),
  );
  ipcMain.handle("project:set-timeline-transition", (_event, seconds: TransitionDurationSec) =>
    store.setTimelineTransitionSeconds(seconds),
  );
  ipcMain.handle("subtitle:force-re-review", (_event, scopes: SubtitleTimelineScope[]) =>
    store.forceSubtitleReReview(scopes),
  );
  ipcMain.handle("source:metadata", (_event, assetId: string) => sources.ensureMetadata(assetId));
  ipcMain.handle("project:set-sort", (_event, sortMode: SortMode) => {
    if (!SORT_MODES.has(sortMode)) throw new Error("排序模式無效。");
    return store.setSortMode(sortMode);
  });
  ipcMain.handle("preview:ensure", async (_event, assetId: string, variant: PreviewVariant) => {
    if (!PREVIEW_VARIANTS.has(variant)) throw new Error("預覽類型無效。");
    const key = `${assetId}:${variant}`;
    previewControllers.get(key)?.abort();
    const controller = new AbortController();
    previewControllers.set(key, controller);
    try {
      return await previews.ensure(assetId, variant, controller.signal);
    } finally {
      if (previewControllers.get(key) === controller) previewControllers.delete(key);
    }
  });
  ipcMain.handle("preview:cancel", (_event, assetId: string, variant: PreviewVariant) => {
    previewControllers.get(`${assetId}:${variant}`)?.abort();
  });
  ipcMain.handle("preview:ensure-clip", async (_event, assetId: string, inMs: number, outMs: number) => {
    const key = `${assetId}:VIDEO_CLIP_PROXY:${Math.round(inMs)}:${Math.round(outMs)}`;
    previewControllers.get(key)?.abort();
    const controller = new AbortController();
    previewControllers.set(key, controller);
    try {
      return await previews.ensureClip(assetId, inMs, outMs, controller.signal);
    } finally {
      if (previewControllers.get(key) === controller) previewControllers.delete(key);
    }
  });
  ipcMain.handle("preview:cancel-clip", (_event, assetId: string, inMs: number, outMs: number) => {
    previewControllers.get(`${assetId}:VIDEO_CLIP_PROXY:${Math.round(inMs)}:${Math.round(outMs)}`)?.abort();
  });
  ipcMain.handle("preview:ensure-intro-thumbnail", async (_event, assetId: string, inMs: number, outMs: number) => {
    const key = `${assetId}:INTRO_THUMBNAIL:${Math.round(inMs)}:${Math.round(outMs)}`;
    previewControllers.get(key)?.abort();
    const controller = new AbortController();
    previewControllers.set(key, controller);
    try {
      return await previews.ensureIntroThumbnail(assetId, inMs, outMs, controller.signal);
    } finally {
      if (previewControllers.get(key) === controller) previewControllers.delete(key);
    }
  });
  ipcMain.handle("audio-preview:create", async (_event, request: AudioPreviewRequest) => {
    audioPreviewController?.abort();
    const controller = new AbortController();
    audioPreviewController = controller;
    try {
      return await audioPreviews.create(request, controller.signal);
    } finally {
      if (audioPreviewController === controller) audioPreviewController = undefined;
    }
  });
  ipcMain.handle("audio-preview:cancel", () => audioPreviewController?.abort());
  ipcMain.handle("concat:choose-output", async (event, suggestedName: string) => {
    for (const [token, item] of outputTokens) {
      if (Date.now() - item.createdAt > 30 * 60 * 1000) outputTokens.delete(token);
    }
    const fileName = safePreviewFileName(suggestedName);
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.SaveDialogOptions = {
      title: "儲存串連預覽影片",
      defaultPath: path.join(userPreferences.getLastDirectory("PREVIEW_OUTPUT", app.getPath("videos")), fileName),
      filters: [{ name: "MP4 影片", extensions: ["mp4"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const outputPath =
      path.extname(result.filePath).toLowerCase() === ".mp4" ? result.filePath : `${result.filePath}.mp4`;
    await userPreferences.rememberDirectory("PREVIEW_OUTPUT", outputPath);
    const token = randomUUID();
    outputTokens.set(token, { outputPath, createdAt: Date.now(), allowOverwrite: true });
    return { token, displayPath: outputPath };
  });
  ipcMain.handle("concat:prepare-output", async (_event, suggestedName: string) => {
    for (const [token, item] of outputTokens)
      if (Date.now() - item.createdAt > 30 * 60 * 1000) outputTokens.delete(token);
    const fallbackDirectory = app.getPath("videos");
    const preferredDirectory = userPreferences.getLastDirectory("PREVIEW_OUTPUT", fallbackDirectory);
    const preferredState = await stat(preferredDirectory).catch(() => undefined);
    const directory = preferredState?.isDirectory() ? preferredDirectory : fallbackDirectory;
    await mkdir(directory, { recursive: true });
    const outputPath = await nextAvailableOutputPath(directory, safePreviewFileName(suggestedName));
    const token = randomUUID();
    outputTokens.set(token, { outputPath, createdAt: Date.now(), allowOverwrite: false });
    return { token, displayPath: outputPath, automatic: true };
  });
  ipcMain.handle("concat:estimate", async (_event, request: ConcatRenderEstimateRequest) => {
    if (!request || typeof request.outputToken !== "string") throw new Error("轉檔預估要求格式無效。");
    const selectedOutput = outputTokens.get(request.outputToken);
    if (!selectedOutput || Date.now() - selectedOutput.createdAt > 30 * 60 * 1000)
      throw new Error("輸出位置授權已失效，請重新選擇儲存位置。");
    if (!RENDER_RESOLUTIONS.has(request.resolution)) throw new Error("預估解析度無效。");
    if (!RENDER_CODECS.has(request.videoCodec)) throw new Error("預估影片格式無效。");
    return estimateConcatWithSystem(selectedOutput.outputPath, request);
  });
  ipcMain.handle("render-hardware:get", async (_event, force = false) =>
    renderHardware.getCapabilities(force === true),
  );
  ipcMain.handle("render-benchmark:run", async () => {
    if (concatController) throw new Error("目前已有 App 轉檔進行中，效能測試不會搶用資源。");
    const releasePowerGuard = renderPowerGuard.acquire();
    try {
      return await renderBenchmark.run();
    } finally {
      releasePowerGuard();
    }
  });
  const publishConcatProgress = (progress: import("../shared/domain").ConcatRenderProgress) => {
    renderCommands.updateProgress(progress);
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send("concat:progress", progress);
  };

  const executeConcatStart = async (request: ConcatRenderRequest) => {
    if (concatController) throw new Error("已有一個串連預覽正在產出，請先等待或取消。");
    if (!request || typeof request.outputToken !== "string") throw new Error("串連預覽要求格式無效。");
    const selectedOutput = outputTokens.get(request.outputToken);
    if (!selectedOutput || Date.now() - selectedOutput.createdAt > 30 * 60 * 1000) {
      throw new Error("輸出位置授權已失效，請重新選擇儲存位置。");
    }
    if (!selectedOutput.allowOverwrite && (await stat(selectedOutput.outputPath).catch(() => undefined))) {
      throw new Error("自動產生的檔名已被其他程式使用，請按『重新產生檔名』後再試；既有檔案不會被覆寫。");
    }
    if (
      !RENDER_RESOLUTIONS.has(request.resolution) ||
      (request.videoCodec !== undefined && !RENDER_CODECS.has(request.videoCodec))
    )
      throw new Error("轉檔解析度或影片格式無效。");
    const renderDefaults = userPreferences.snapshot().renderDefaults;
    request.tempLocations = structuredClone(
      renderDefaults.tempLocations ?? [
        {
          id: "primary",
          path: renderDefaults.renderTemporaryFolder ?? app.getPath("temp"),
          role: "PRIMARY",
          enabled: true,
          allowFallback: true,
        },
      ],
    );
    request.tempLocationSelection = request.tempLocationSelection ?? renderDefaults.tempLocationSelection ?? "AUTO";
    request.renderTemporaryFolder =
      request.tempLocations.find((item) => item.role === "PRIMARY")?.path ?? request.tempLocations[0]?.path;
    const preflight = await estimateConcatWithSystem(selectedOutput.outputPath, {
      outputToken: request.outputToken,
      expectedDurationMs: request.estimatedDurationMs ?? 0,
      resolution: request.resolution,
      videoCodec: request.videoCodec ?? "H264",
      lowMemorySegmented: request.lowMemorySegmented,
      highSpeedMode: request.highSpeedMode,
      resourceProfile: request.resourceProfile,
      maximumRenderRamGiB: request.maximumRenderRamGiB,
      maximumRenderTempGiB: request.maximumRenderTempGiB,
      tempLocations: request.tempLocations,
      tempLocationSelection: request.tempLocationSelection,
      orderedAssetIds: request.orderedAssetIds,
      clipSelections: request.clipSelections,
      transitionSeconds: request.transitionSeconds,
      generatedInputCount: request.mainStartCard ? 1 : 0,
    });
    if (!preflight.canRender) throw new Error(preflight.warning ?? "輸出磁碟空間不足 1 GB，本次不會開始轉檔。");
    // Checkpoint metadata is small, but its initial work root must still be
    // reachable. An offline/full primary must not prevent a new C: fallback
    // job from starting before the per-segment scheduler even runs.
    request.renderTemporaryFolder =
      preflight.tempLocationStatuses?.find((location) => location.id === preflight.selectedTempLocationId)?.path ??
      request.renderTemporaryFolder;
    const selectedProfile = resourceProfileFromLegacy(request);
    const selectedMode =
      selectedProfile === "LOW_DISK"
        ? (preflight.modeEstimates.lowDisk ?? preflight.modeEstimates.lowMemory)
        : selectedProfile === "HIGH_SPEED"
          ? (preflight.modeEstimates.highSpeed ?? preflight.modeEstimates.normal)
          : (preflight.modeEstimates.balanced ?? preflight.modeEstimates.normal);
    if (selectedMode.warnings.length && request.resourceWarningAcknowledged !== true) {
      throw new Error(`RESOURCE_WARNING_CONFIRMATION_REQUIRED\n${selectedMode.warnings.join("\n")}`);
    }
    outputTokens.delete(request.outputToken);
    request.runtimePolicy = preflight.runtimePolicy;
    request.estimatedPeakDiskBytes =
      selectedMode.diskBreakdown?.peakWorkingBytes ?? selectedMode.estimatedTemporaryBytes;
    request.estimatedFinalOutputBytes = selectedMode.estimatedOutputBytes;
    postSuccessPower.cancel("侦测到新的转档工作；已取消先前排定的电源动作。");
    const releasePowerGuard = renderPowerGuard.acquire();
    const controller = new AbortController();
    concatController = controller;
    const backgroundJobId = beginBackgroundJob("CONCAT_RENDER", "片頭／正片預覽產出");
    renderCommands.markStarting(request);
    let successfulResult: import("../shared/domain").ConcatRenderResult | undefined;
    try {
      const result = await concatRenderer.render(request, selectedOutput.outputPath, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, {
          percent: progress.percent,
          detail: progress.currentSegment ?? progress.phase,
          attemptElapsedMs: progress.attemptElapsedMs,
          cumulativeElapsedMs: progress.cumulativeElapsedMs,
        });
        publishConcatProgress(progress);
      });
      await outputHistory.registerRender(result, store.getProject().name, store.getProject().id);
      finishBackgroundJob(backgroundJobId, result.cancelled ? "CANCELLED" : "COMPLETED", {
        detail: result.cancelled ? "使用者取消，已保留可播放結尾" : result.outputPath,
      });
      renderCommands.markTerminal(result);
      if (completedRenderQualifies(result)) successfulResult = result;
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      renderCommands.markFailed(error);
      throw error;
    } finally {
      if (concatController === controller) concatController = undefined;
      releasePowerGuard();
      if (successfulResult)
        postSuccessPower.notifySuccess(
          "RENDER_SUCCESS",
          userPreferences.snapshot().renderDefaults.postSuccessPower ?? {
            enabled: false,
            trigger: "RENDER_SUCCESS",
            action: "SHUTDOWN",
          },
        );
    }
  };
  ipcMain.handle("concat:start", (_event, request: ConcatRenderRequest) => executeConcatStart(request));
  ipcMain.handle("remote-control:prepare-render", async (_event, request: ConcatRenderRequest) => {
    if (!request || typeof request.outputToken !== "string") throw new Error("远端准备转档的要求格式无效。");
    const selectedOutput = outputTokens.get(request.outputToken);
    if (!selectedOutput || Date.now() - selectedOutput.createdAt > 30 * 60 * 1000)
      throw new Error("请先在 Windows 端选择仍有效的输出位置。");
    if (!RENDER_RESOLUTIONS.has(request.resolution)) throw new Error("转档解析度无效。");
    return renderCommands.prepare(request, selectedOutput.outputPath);
  });
  ipcMain.handle("remote-control:clear-prepared-render", () => renderCommands.clearPrepared());
  ipcMain.handle("concat:resume-offer", () => concatRenderer.getResumeOffer());
  ipcMain.handle("concat:analyze-resume", async (_event, checkpointId: string) => {
    if (typeof checkpointId !== "string" || !/^[a-f0-9-]{8,80}$/i.test(checkpointId))
      throw new Error("續轉識別碼無效。");
    return concatRenderer.analyzeResumeCompatibility(
      checkpointId,
      userPreferences.snapshot().renderDefaults.tempLocations ?? [],
    );
  });
  ipcMain.handle("concat:analyze-resume-storage", async (_event, checkpointId: string) => {
    if (typeof checkpointId !== "string" || !/^[a-f0-9-]{8,80}$/i.test(checkpointId))
      throw new Error("續轉識別碼無效。");
    return concatRenderer.analyzeResumeStorage(
      checkpointId,
      userPreferences.snapshot().renderDefaults.tempLocations ?? [],
    );
  });
  ipcMain.handle("concat:execute-resume-storage-plan", async (_event, request: ExecuteResumeStoragePlanRequest) => {
    if (concatController) throw new Error("轉檔進行中，不能搬移 Resume Artifact。");
    if (
      !request ||
      typeof request.checkpointId !== "string" ||
      typeof request.planId !== "string" ||
      !Array.isArray(request.artifactIds)
    )
      throw new Error("空間最佳化要求格式無效。");
    return concatRenderer.executeResumeStoragePlan(
      request.checkpointId,
      request.planId,
      request.artifactIds,
      userPreferences.snapshot().renderDefaults.tempLocations ?? [],
    );
  });
  ipcMain.handle("concat:scan-remap-artifacts", async (_event, checkpointId: string) => {
    if (concatController) throw new Error("轉檔進行中，不能重新對應 Resume Artifact。");
    if (typeof checkpointId !== "string" || !/^[a-f0-9-]{8,80}$/i.test(checkpointId))
      throw new Error("續轉識別碼無效。");
    return concatRenderer.scanAndRemapManuallyMovedArtifacts(
      checkpointId,
      userPreferences.snapshot().renderDefaults.tempLocations ?? [],
    );
  });
  ipcMain.handle("render-temp:analyze-artifacts", async () => {
    const offer = await concatRenderer.getResumeOffer();
    const roots = (userPreferences.snapshot().renderDefaults.tempLocations ?? []).map((item) => item.path);
    const known = !offer
      ? {
          capturedAt: new Date().toISOString(),
          roots,
          items: [],
          totalBytes: 0,
          immediatelyReclaimableBytes: 0,
          movableBytes: 0,
        }
      : (
          await concatRenderer.analyzeResumeStorage(
            offer.checkpointId,
            userPreferences.snapshot().renderDefaults.tempLocations ?? [],
          )
        ).inventory;
    return scanRegisteredTemporaryArtifacts(
      roots,
      known,
      store.getProject().sources.map((asset) => asset.sourcePath),
    );
  });
  ipcMain.handle(
    "render-temp:execute-artifact-actions",
    async (_event, request: ExecuteTemporaryArtifactActionsRequest) => {
      if (concatController) throw new Error("轉檔進行中，不能清理或搬移 TEMP Artifact。");
      if (!request || !Array.isArray(request.artifactIds) || !request.artifactIds.length)
        throw new Error("未選擇要處理的 TEMP Artifact。");
      // The generic inventory currently exposes protected Resume artifacts only.
      // Deletion/move becomes available only when a fresh analyzer can prove the
      // item is independent; never accept a renderer-supplied path or status.
      throw new Error("所選 TEMP Artifact 目前沒有可安全執行的獨立清理證據，已全部保留。");
    },
  );
  ipcMain.handle("concat:discard-resume", async (_event, checkpointId: string) => {
    if (typeof checkpointId !== "string" || !/^[a-f0-9-]{8,80}$/i.test(checkpointId))
      throw new Error("續轉識別碼無效。");
    await concatRenderer.discardResume(checkpointId);
  });
  ipcMain.handle("concat:remap-resume", async (_event, request: RenderCheckpointRemapRequest) => {
    if (concatController) throw new Error("轉檔進行中，不能重新對應 checkpoint。");
    if (!request || typeof request.checkpointId !== "string") throw new Error("重新對應要求格式無效。");
    const target = await validateRenderTemporaryFolder(request.toRoot);
    const remappedSegmentCount = await concatRenderer.remapResumeSegments(
      request.checkpointId,
      request.fromRoot,
      target.path,
    );
    return { ...request, toRoot: target.path, remappedSegmentCount };
  });
  ipcMain.handle("concat:discard-video-master", () => concatRenderer.discardReusableVideoMaster());
  const executeConcatResume = async (checkpointId: string) => {
    if (concatController) throw new Error("已有一個串連預覽正在產出，請先等待或取消。");
    if (typeof checkpointId !== "string" || !/^[a-f0-9-]{8,80}$/i.test(checkpointId))
      throw new Error("續轉識別碼無效。");
    const resumeDefaults = userPreferences.snapshot().renderDefaults;
    const storage = await concatRenderer.analyzeResumeStorage(checkpointId, resumeDefaults.tempLocations ?? []);
    if (!storage.canResumeWithoutCleanup) {
      const shortfall = (storage.plan.shortfallBytes / 1024 ** 3).toFixed(1);
      throw new Error(
        storage.plan.action === "PROPOSE_MOVE" || storage.plan.action === "PROPOSE_CLEANUP"
          ? `APP_PREEMPTIVE_DISK_PAUSE：續轉前需要確認 TEMP 最佳化方案（目前同時峰值尚缺約 ${shortfall} GB）。`
          : `APP_PREEMPTIVE_DISK_PAUSE：目前沒有可安全執行的空間方案（同時峰值尚缺約 ${shortfall} GB）；checkpoint 與完成片段均已保留。`,
      );
    }
    postSuccessPower.cancel("侦测到新的续转工作；已取消先前排定的电源动作。");
    const releasePowerGuard = renderPowerGuard.acquire();
    const controller = new AbortController();
    concatController = controller;
    const backgroundJobId = beginBackgroundJob("CONCAT_RENDER", "從 checkpoint 續轉片頭／正片預覽");
    const offer = await concatRenderer.getResumeOffer();
    renderCommands.markResuming(offer?.mode ?? "NORMAL");
    let successfulResult: import("../shared/domain").ConcatRenderResult | undefined;
    try {
      const result = await concatRenderer.resume(
        checkpointId,
        controller.signal,
        (progress) => {
          updateBackgroundJob(backgroundJobId, {
            percent: progress.percent,
            detail: progress.currentSegment ?? progress.phase,
            attemptElapsedMs: progress.attemptElapsedMs,
            cumulativeElapsedMs: progress.cumulativeElapsedMs,
          });
          publishConcatProgress(progress);
        },
        resumeDefaults.tempLocations,
        resumeDefaults.tempLocationSelection ?? "AUTO",
      );
      await outputHistory.registerRender(result, store.getProject().name, store.getProject().id);
      finishBackgroundJob(backgroundJobId, result.cancelled ? "CANCELLED" : "COMPLETED", {
        detail: result.cancelled ? "使用者取消，已清除本次續轉工作" : result.outputPath,
      });
      renderCommands.markTerminal(result);
      if (completedRenderQualifies(result)) successfulResult = result;
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      renderCommands.markFailed(error);
      throw error;
    } finally {
      if (concatController === controller) concatController = undefined;
      releasePowerGuard();
      if (successfulResult)
        postSuccessPower.notifySuccess(
          "RENDER_SUCCESS",
          userPreferences.snapshot().renderDefaults.postSuccessPower ?? {
            enabled: false,
            trigger: "RENDER_SUCCESS",
            action: "SHUTDOWN",
          },
        );
    }
  };
  ipcMain.handle("concat:resume", (_event, checkpointId: string) => executeConcatResume(checkpointId));
  renderCommands.setHandlers({
    startPrepared: executeConcatStart,
    resumeCheckpoint: async () => {
      const offer = await concatRenderer.getResumeOffer();
      if (!offer) throw new Error("目前没有可续转的 checkpoint。");
      return executeConcatResume(offer.checkpointId);
    },
    cancel: async () => concatController?.abort("USER_CANCEL"),
  });
  ipcMain.handle("concat:cancel", () => concatController?.abort("USER_CANCEL"));
  ipcMain.handle("concat:reveal", async (_event, jobId: string) => {
    const output = await outputHistory.get(jobId);
    electronShell.showItemInFolder(output.outputPath);
  });
  ipcMain.handle("concat:play", async (_event, jobId: string) => {
    const output = await outputHistory.get(jobId);
    const result = await externalPlayers.openFile(output.outputPath);
    if (result.status === "USE_INTERNAL") throw new Error(result.message ?? "無法啟動外部播放器。");
    return result;
  });
  ipcMain.handle("output-history:copy-path", async (_event, jobId: string) => {
    const output = await outputHistory.get(jobId);
    clipboard.writeText(output.outputPath);
  });
  ipcMain.handle("output-history:get", () => outputHistory.snapshot());
  ipcMain.handle("output-history:choose-existing", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "加入以前產出的 MP4 預覽檔",
      defaultPath: userPreferences.getLastDirectory("OUTPUT_HISTORY", app.getPath("videos")),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "MP4 影片", extensions: ["mp4"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length)
      return { cancelled: true, addedCount: 0, duplicateCount: 0, errors: [], history: await outputHistory.snapshot() };
    await userPreferences.rememberDirectory("OUTPUT_HISTORY", result.filePaths[0]);
    return outputHistory.importExisting(result.filePaths);
  });
  ipcMain.handle("output-history:remove-record", (_event, jobId: string) => outputHistory.removeRecord(jobId));
  ipcMain.handle(
    "intro:analyze",
    async (event, assetIds: string[], maxDurationMs: number, maxSegmentDurationMs: number) => {
      if (introController) throw new Error("精彩片頭分析已在進行中。");
      if (!Array.isArray(assetIds) || !Number.isFinite(maxDurationMs) || !Number.isFinite(maxSegmentDurationMs))
        throw new Error("片頭分析要求格式無效。");
      const controller = new AbortController();
      introController = controller;
      const backgroundJobId = beginBackgroundJob("INTRO_ANALYSIS", "AI 精彩片頭建議");
      const cancelIfRendererCloses = () => controller.abort();
      event.sender.once("destroyed", cancelIfRendererCloses);
      try {
        const result = await introAnalyzer.analyze(
          assetIds,
          controller.signal,
          (progress) => {
            updateBackgroundJob(backgroundJobId, {
              percent: progress.total ? Math.round((progress.processed / progress.total) * 100) : 0,
              detail: progress.currentName ?? progress.phase,
            });
            if (!event.sender.isDestroyed()) event.sender.send("intro:analysis-progress", progress);
          },
          maxDurationMs,
          maxSegmentDurationMs,
        );
        await store.setIntroAnalysisResult(result);
        finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: "片頭分析完成；結果已保存，可重新開啟片頭頁查看" });
        return result;
      } catch (error) {
        finishBackgroundJob(
          backgroundJobId,
          error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
          { error: error instanceof Error ? error.message : String(error) },
        );
        throw error;
      } finally {
        event.sender.removeListener("destroyed", cancelIfRendererCloses);
        if (introController === controller) introController = undefined;
      }
    },
  );
  ipcMain.handle("intro:cancel-analysis", () => introController?.abort());
  ipcMain.handle("ai:get-settings", () => aiSettings.getSnapshot());
  ipcMain.handle("ai:save-account", (_event, input: AiAccountSaveInput) => aiSettings.saveAccount(input));
  ipcMain.handle("ai:save-gemini-review", (_event, input: GeminiReviewSettingsUpdate) =>
    aiSettings.saveGeminiReviewSettings(input),
  );
  ipcMain.handle("ai:set-active-account", (_event, accountId: string) => aiSettings.setActiveAccount(accountId));
  ipcMain.handle("ai:remove-account", (_event, accountId: string) => aiSettings.removeAccount(accountId));
  ipcMain.handle("ai:test-account", async (_event, accountId: string) => {
    const diagnostic = await aiStory.testAccount(accountId);
    const account = aiSettings.getSnapshot().accounts.find((item) => item.id === accountId);
    const usingCodex = diagnostic.providerLabel === "CODEX_CHATGPT";
    return {
      ok: true,
      accountId,
      providerLabel: usingCodex ? "Codex／ChatGPT 登入" : "OpenAI API",
      message: usingCodex
        ? "OpenAI API 目前不可用，但已確認這台電腦的 Codex／ChatGPT 登入可產生知識型字幕。語音辨識仍需可用的 OpenAI API。"
        : `完整測試成功：${account?.name ?? accountId} 的 Key、故事模型與語音模型都可實際呼叫。`,
      checks: diagnostic.checks,
      requestIds: diagnostic.requestIds,
    };
  });
  ipcMain.handle("translation:get-settings", () => translationSettings.snapshot());
  ipcMain.handle("translation:update-settings", (_event, update: TranslationSettingsUpdate) =>
    translationSettings.update(update),
  );
  ipcMain.handle("translation:test-google", async () => {
    await subtitleTranslation.testGoogle();
    return { ok: true, message: "Google Cloud Translation 實際翻譯測試成功；OpenAI 不可用時可安全切換為後援。" };
  });
  ipcMain.handle("ai:transcribe-voice-input", async (event, request: VoiceInputRequest) => {
    voiceInputController?.abort();
    const controller = new AbortController();
    voiceInputController = controller;
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      return await aiStory.transcribeVoiceInput(request, controller.signal);
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (voiceInputController === controller) voiceInputController = undefined;
    }
  });
  ipcMain.handle("project:set-ai-story-context", (_event, context: AiStoryContext) => store.setAiStoryContext(context));
  ipcMain.handle("publish:get-assets", () => store.getProject().aiPublishAssets ?? null);
  ipcMain.handle("publish:set-assets", (_event, assets: import("../shared/domain").AiPublishAssets) =>
    store.setAiPublishAssets(assets),
  );
  ipcMain.handle("publish:generate", async (event, options: AiPublishGenerationOptions) => {
    if (aiPublishController) throw new Error("AI 發布素材分析已在進行中。");
    const controller = new AbortController();
    aiPublishController = controller;
    const backgroundJobId = beginBackgroundJob("AI_PUBLISH_ASSETS", "AI 發布素材與縮圖建議");
    try {
      const result = await aiPublishAssets.generate(options, controller.signal, (percent, detail) => {
        updateBackgroundJob(backgroundJobId, { percent, detail });
        if (!event.sender.isDestroyed()) event.sender.send("publish:progress", { percent, detail });
      });
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: "AI 發布素材已保存" });
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    } finally {
      if (aiPublishController === controller) aiPublishController = undefined;
    }
  });
  ipcMain.handle("publish:cancel", () => aiPublishController?.abort());
  ipcMain.handle("publish:thumbnail:choose-output", async (event, format: "jpg" | "png" = "jpg") => {
    if (format !== "jpg" && format !== "png") throw new Error("縮圖格式只支援 JPG 或 PNG。");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = window
      ? await dialog.showSaveDialog(window, {
          title: "另存 YouTube 縮圖",
          defaultPath: path.join(
            userPreferences.getLastDirectory("PREVIEW_OUTPUT", app.getPath("pictures")),
            `SceneryWalker_thumbnail.${format}`,
          ),
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
          properties: ["showOverwriteConfirmation", "createDirectory"],
        })
      : await dialog.showSaveDialog({
          title: "另存 YouTube 縮圖",
          defaultPath: path.join(app.getPath("pictures"), `SceneryWalker_thumbnail.${format}`),
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
          properties: ["showOverwriteConfirmation", "createDirectory"],
        });
    if (result.canceled || !result.filePath) return null;
    const outputPath =
      path.extname(result.filePath).toLowerCase() === `.${format}` ? result.filePath : `${result.filePath}.${format}`;
    const token = randomUUID();
    thumbnailTokens.set(token, { outputPath, createdAt: Date.now(), format });
    await userPreferences.rememberDirectory("PREVIEW_OUTPUT", outputPath);
    return { token, displayPath: outputPath, format };
  });
  ipcMain.handle("publish:thumbnail:choose-import", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "匯入 YouTube JPG／PNG 縮圖",
      properties: ["openFile"],
      filters: [{ name: "圖片", extensions: ["jpg", "jpeg", "png"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const extension = path.extname(result.filePaths[0]).toLowerCase();
    if (extension !== ".jpg" && extension !== ".jpeg" && extension !== ".png")
      throw new Error("只支援 JPG 或 PNG 縮圖。");
    const file = await stat(result.filePaths[0]);
    if (file.size > 2 * 1024 * 1024) throw new Error("縮圖超過 YouTube 2 MB 上限。");
    return { path: result.filePaths[0], format: extension === ".png" ? ("png" as const) : ("jpg" as const) };
  });
  ipcMain.handle("publish:thumbnail:render", async (_event, request: ThumbnailRenderRequest) => {
    if (
      !request ||
      typeof request.outputToken !== "string" ||
      typeof request.candidateId !== "string" ||
      (request.format !== "jpg" && request.format !== "png")
    )
      throw new Error("縮圖產出要求格式無效。");
    const token = thumbnailTokens.get(request.outputToken);
    thumbnailTokens.delete(request.outputToken);
    if (!token || token.format !== request.format || Date.now() - token.createdAt > 30 * 60_000)
      throw new Error("縮圖輸出位置授權已失效，請重新選擇儲存位置。");
    const project = store.getProject();
    const candidate = project.aiPublishAssets?.thumbnails.find((item) => item.id === request.candidateId);
    if (!candidate) throw new Error("找不到縮圖候選，請重新產生或選擇候選影格。");
    const asset = project.sources.find((item) => item.id === candidate.assetId);
    if (!asset) throw new Error("縮圖候選的來源素材不存在；來源檔沒有被修改。");
    const result = await renderThumbnail(asset, candidate, token.outputPath, request.format);
    return { candidateId: candidate.id, outputPath: token.outputPath, ...result, format: request.format };
  });
  ipcMain.handle("external-player:get-settings", () => playerSettings.snapshotWithCurrentAvailability());
  ipcMain.handle("external-player:update-settings", (_event, update: ExternalPlayerSettingsUpdate) =>
    playerSettings.update(update),
  );
  ipcMain.handle("external-player:choose-custom", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "選擇外部播放器執行檔",
      defaultPath: userPreferences.getLastDirectory("CUSTOM_PLAYER", process.env.ProgramFiles || app.getPath("home")),
      properties: ["openFile"],
      filters: [{ name: "Windows 應用程式", extensions: ["exe"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("CUSTOM_PLAYER", result.filePaths[0]);
    return playerSettings.addCustomPlayer(result.filePaths[0]);
  });
  ipcMain.handle("external-player:remove-custom", (_event, playerId: ExternalPlayerId) =>
    playerSettings.removeCustomPlayer(playerId),
  );
  ipcMain.handle("external-player:open", (_event, assetId: string, target: ExternalMediaTarget) =>
    externalPlayers.open(assetId, target),
  );
  ipcMain.handle("bgm:choose-files", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "選擇 MP3 配樂",
      defaultPath: userPreferences.getLastDirectory("BGM", app.getPath("music")),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "MP3 音樂", extensions: ["mp3"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length)
      return { cancelled: true, addedCount: 0, errors: [], project: store.getProject() };
    await userPreferences.rememberDirectory("BGM", result.filePaths[0]);
    return bgm.importSelected(result.filePaths);
  });
  ipcMain.handle("bgm:add-youtube-references", (_event, urls: string[]) =>
    bgm.addYoutubeReferences(Array.isArray(urls) ? urls : []),
  );
  ipcMain.handle("bgm:resolve-reference", async (event, trackId: string, rightsConfirmed: boolean) => {
    if (!rightsConfirmed) throw new Error("請先確認音檔使用權，再指定本機 MP3。");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "選擇自有或已授權的 MP3",
      defaultPath: userPreferences.getLastDirectory("BGM", app.getPath("music")),
      properties: ["openFile"],
      filters: [{ name: "MP3 音樂", extensions: ["mp3"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("BGM", result.filePaths[0]);
    return bgm.resolveReference(trackId, result.filePaths[0], rightsConfirmed);
  });
  ipcMain.handle("bgm:sequence", () => store.sequenceBgmTracks());
  ipcMain.handle("project:set-source-audio-volume", (_event, volumePercent: number) =>
    store.setSourceAudioVolume(volumePercent),
  );
  ipcMain.handle("bgm:update", (_event, track: BgmTrack) => store.updateBgmTrack(track));
  ipcMain.handle("bgm:remove", (_event, trackId: string) => store.removeBgmTrack(trackId));
  ipcMain.handle("bgm:move", (_event, trackId: string, toIndex: number) => store.moveBgmTrack(trackId, toIndex));
  const getReadyBgmTrack = async (trackId: string) => {
    if (typeof trackId !== "string" || !trackId) throw new Error("配樂 ID 無效。");
    const track = store.getProject().bgmTracks.find((item) => item.id === trackId);
    if (!track) throw new Error("找不到這筆配樂。");
    if (track.resolutionStatus === "NEEDS_LOCAL_FILE" || !track.sourcePath || !path.isAbsolute(track.sourcePath))
      throw new Error("這筆配樂尚未指定可用的本機 MP3。");
    const file = await stat(track.sourcePath).catch(() => undefined);
    if (!file?.isFile()) throw new Error("配樂已移動、刪除或離線，請重新指定本機 MP3。");
    return track;
  };
  ipcMain.handle("bgm:play", async (_event, trackId: string) => {
    const track = await getReadyBgmTrack(trackId);
    const result = await externalPlayers.openFile(track.sourcePath);
    if (result.status === "USE_INTERNAL") throw new Error(result.message ?? "無法啟動外部播放器。");
    return result;
  });
  ipcMain.handle("bgm:reveal", async (_event, trackId: string) => {
    const track = await getReadyBgmTrack(trackId);
    electronShell.showItemInFolder(track.sourcePath);
  });
  ipcMain.handle("bgm:copy-path", async (_event, trackId: string) => {
    const track = await getReadyBgmTrack(trackId);
    clipboard.writeText(track.sourcePath);
  });
  ipcMain.handle("bgm:open-youtube-audio-library", async () => {
    await electronShell.openExternal("https://www.youtube.com/audiolibrary");
  });
  ipcMain.handle("bgm:ai-suggest", async (event, request: MusicSuggestionRequest) => {
    if (musicSuggestionController) throw new Error("AI 配樂建議正在產生中。");
    const controller = new AbortController();
    musicSuggestionController = controller;
    const backgroundJobId = beginBackgroundJob("MUSIC_SUGGESTIONS", "AI 配樂建議搜尋");
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await musicSuggestions.generate(request, controller.signal);
      await store.setMusicSuggestionResult(result);
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: `已保存 ${result.suggestions.length} 筆建議` });
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (musicSuggestionController === controller) musicSuggestionController = undefined;
    }
  });
  ipcMain.handle("bgm:ai-suggest-cancel", () => musicSuggestionController?.abort());
  ipcMain.handle("bgm:open-suggestion", (_event, url: string) => musicSuggestions.open(url));
  ipcMain.handle("subtitle:set-cues", (_event, cues: SubtitleCue[]) => store.setSubtitleCues(cues));
  const describeSubtitleVideo = async (selection: ReturnType<typeof selectSubtitleVideoSource>) => {
    if (!selection.path) return { reason: "NONE" as const };
    const media = await subtitleVideoProbe.probe(selection.path);
    const file = await stat(selection.path);
    return {
      reason: selection.reason,
      jobId: selection.record?.jobId,
      outputPath: selection.path,
      fileName: path.basename(selection.path),
      durationMs: media.durationMs,
      width: media.displayWidth ?? media.width,
      height: media.displayHeight ?? media.height,
      videoCodec: media.videoCodec,
      frameRate: media.frameRate,
      sizeBytes: file.size,
      createdAt: file.birthtime.toISOString(),
      modifiedAt: file.mtime.toISOString(),
      previewUrl: authorizeSubtitleVideo(selection.path),
    };
  };
  const persistedManualSubtitlePath = async () => {
    if (lastManualSubtitleVideoPath) return lastManualSubtitleVideoPath;
    try {
      const parsed = JSON.parse(await readFile(subtitleSourcePreferencePath, "utf8")) as { path?: unknown };
      if (typeof parsed.path === "string" && path.isAbsolute(parsed.path)) lastManualSubtitleVideoPath = parsed.path;
    } catch {
      /* no saved manual source */
    }
    return lastManualSubtitleVideoPath;
  };
  const currentSubtitleVideoSelection = async () => {
    if (explicitSubtitleVideoPath)
      return { reason: resumedSubtitleSelectionReason ?? ("MANUAL_PATH" as const), path: explicitSubtitleVideoPath };
    const history = await outputHistory.snapshot();
    return selectSubtitleVideoSource(history.outputs, {
      projectId: store.getProject().id,
      projectName: store.getProject().name,
      lastManualPath: await persistedManualSubtitlePath(),
      isManualPathValid: (candidate) => path.isAbsolute(candidate),
    });
  };
  ipcMain.handle("subtitle:analysis-video:get", async () => {
    const result = await describeSubtitleVideo(await currentSubtitleVideoSelection());
    subtitleLog("SUBTITLE_UI", {
      projectId: store.getProject().id,
      videoPath: "outputPath" in result ? result.outputPath : undefined,
      loadedProjectCues: store.getProject().subtitleCues.length,
    });
    return result;
  });
  ipcMain.handle("subtitle:analysis-video:choose", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "選擇 AI 字幕分析影片（只讀）",
      properties: ["openFile"],
      filters: [{ name: "影片", extensions: ["mp4", "mov", "mkv", "m4v", "avi", "webm"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selectedPath = path.resolve(result.filePaths[0]);
    const file = await stat(selectedPath);
    if (!file.isFile() || file.size < 1) throw new Error("選取的分析影片不存在或是空檔案。");
    lastManualSubtitleVideoPath = selectedPath;
    explicitSubtitleVideoPath = selectedPath;
    resumedSubtitleSelectionReason = undefined;
    await mkdir(path.dirname(subtitleSourcePreferencePath), { recursive: true });
    const preferencePartial = `${subtitleSourcePreferencePath}.${process.pid}.partial`;
    await writeFile(preferencePartial, JSON.stringify({ schemaVersion: 1, path: selectedPath }, null, 2), "utf8");
    await rename(preferencePartial, subtitleSourcePreferencePath);
    return describeSubtitleVideo({ reason: "MANUAL_PATH", path: selectedPath });
  });
  const publishSubtitleVisualProgress = (
    event: Electron.IpcMainInvokeEvent,
    progress: SubtitleVisualAnalysisProgress,
  ) => {
    if (!event.sender.isDestroyed()) event.sender.send("subtitle:visual-job:progress", progress);
  };
  const subtitlePreflight = async (options: SubtitleVisualAnalysisOptions): Promise<SubtitleVisualPreflight> => {
    const project = store.getProject();
    const selected = await currentSubtitleVideoSelection();
    if (!selected.path) throw new Error("請先選擇分析影片。");
    const media = await subtitleVideoProbe.probe(selected.path);
    const videoDurationMs = media.durationMs ?? 0;
    if (videoDurationMs <= 0) throw new Error("影片沒有有效時長。");
    const projectDurationMs = buildTimelinePlan(project, { includeIntro: project.introSegments.length > 0 }).durationMs;
    const comparison = subtitleAnalysisMode(selected.reason, projectDurationMs, videoDurationMs);
    const identity =
      selected.reason === "PROJECT_CONCAT"
        ? ("PROJECT_OUTPUT" as const)
        : selected.reason === "LATEST_CONCAT"
          ? ("LEGACY_PROJECT_OUTPUT" as const)
          : ("EXTERNAL" as const);
    const recommendedMode = comparison.mode;
    const siblingSrt = path.join(path.dirname(selected.path), `${path.parse(selected.path).name}.srt`);
    let existingSrtPath: string | undefined;
    let existingSrtCount = 0;
    try {
      const imported = await importSrtFile(siblingSrt);
      existingSrtPath = siblingSrt;
      existingSrtCount = imported.cues.length;
    } catch {
      /* no readable sibling SRT */
    }
    let modelId: string | undefined;
    let selectionMode: "AUTO" | "MANUAL" = "AUTO";
    try {
      const runtime = aiRuntime(options.provider === "GEMINI" ? "GEMINI" : "OPENAI");
      modelId = runtime.model;
      selectionMode = runtime.model.toLowerCase() === "auto" ? "AUTO" : "MANUAL";
    } catch {
      /* configuration is resolved at start, never prevents viewing subtitles */
    }
    return {
      videoPath: selected.path,
      videoDurationMs,
      projectDurationMs,
      differenceMs: comparison.differenceMs,
      toleranceMs: comparison.toleranceMs,
      timelineCompatible: comparison.compatible,
      recommendedMode,
      identity,
      existingSrtPath,
      existingSrtCount,
      projectSubtitleCount: project.subtitleCues.length,
      rawFrameEstimate: Math.ceil(videoDurationMs / (Math.max(1, Math.min(60, options.intervalSeconds)) * 1000)),
      provider: options.provider,
      selectionMode,
      modelId,
      warning:
        recommendedMode === "VIDEO_FIRST"
          ? "所選影片與目前專案未確認相容；使用影片時間軸建立獨立草稿，不會修改專案。"
          : undefined,
    };
  };
  ipcMain.handle("subtitle:visual-preflight", (_event, options: SubtitleVisualAnalysisOptions) =>
    subtitlePreflight(options),
  );
  ipcMain.handle("subtitle:workspace:get", () => standaloneSubtitles.latest());
  ipcMain.handle("subtitle:workspace:import-srt", async (event) => {
    const selected = await currentSubtitleVideoSelection();
    if (!selected.path) throw new Error("請先選擇要檢查的影片，再匯入既有 SRT。");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "匯入既有 SRT 到獨立影片檢查工作區",
      defaultPath: userPreferences.getLastDirectory("SUBTITLE_INPUT", app.getPath("documents")),
      properties: ["openFile"],
      filters: [{ name: "SubRip 字幕", extensions: ["srt"] }],
    };
    const picked = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (picked.canceled || !picked.filePaths[0]) return null;
    const imported = await importSrtFile(picked.filePaths[0]);
    const media = await subtitleVideoProbe.probe(selected.path);
    const durationMs = media.durationMs ?? 0;
    if (durationMs <= 0) throw new Error("所選影片沒有有效時長。");
    if (imported.cues.some((cue) => cue.endMs > durationMs))
      throw new Error("SRT 字幕超出所選影片時長；來源檔保持不變，請選擇相符影片或修正副本。");
    const file = await stat(selected.path);
    const fingerprint = createHash("sha256").update(`${selected.path}\0${file.size}\0${file.mtimeMs}`).digest("hex");
    await userPreferences.rememberDirectory("SUBTITLE_INPUT", picked.filePaths[0]);
    return standaloneSubtitles.create(
      selected.path,
      fingerprint,
      durationMs,
      imported.cues.map((cue) => ({
        ...cue,
        timelineScope: "MAIN" as const,
        origin: "IMPORTED_SRT" as const,
        reviewStatus: "DRAFT" as const,
      })),
    );
  });
  ipcMain.handle("subtitle:project-ai-check:prepare", async () => {
    const project = store.getProject();
    if (project.introSegments.length > 0)
      throw new Error(
        "目前專案含片頭，片頭與正片字幕使用各自時間軸；為避免把合併成品時間誤套回專案，v0.88 暫不建立可回寫的全專案 AI 檢查工作區。可使用獨立影片工作區，只保存 AI draft。",
      );
    const selected = await currentSubtitleVideoSelection();
    if (!selected.path || selected.reason !== "PROJECT_CONCAT")
      throw new Error(
        "AI 檢查現有專案字幕只接受帶有目前 projectId 的成功輸出；legacy／外部影片請使用獨立影片字幕工作區。",
      );
    const media = await subtitleVideoProbe.probe(selected.path);
    const durationMs = media.durationMs ?? 0;
    const projectDurationMs = buildTimelinePlan(project, { includeIntro: project.introSegments.length > 0 }).durationMs;
    const compatibility = subtitleTimelineCompatibility(projectDurationMs, durationMs);
    if (!compatibility.compatible) throw new Error("目前專案輸出時長與時間線不相容，不能檢查或套回專案字幕。");
    const file = await stat(selected.path);
    const fingerprint = createHash("sha256").update(`${selected.path}\0${file.size}\0${file.mtimeMs}`).digest("hex");
    return standaloneSubtitles.create(selected.path, fingerprint, durationMs, structuredClone(project.subtitleCues), {
      projectId: project.id,
      timelineRevision: project.timelineRevision,
    });
  });
  ipcMain.handle("subtitle:workspace:save", (_event, id: string, cues: SubtitleCue[]) =>
    standaloneSubtitles.save(id, cues),
  );
  ipcMain.handle("subtitle:workspace:export", async (_event, id: string, token: string) => {
    const selected = subtitleOutputTokens.get(token);
    if (!selected || Date.now() - selected.createdAt > 30 * 60 * 1000) throw new Error("請重新選擇字幕儲存位置。");
    const workspace = await standaloneSubtitles.get(id);
    subtitleOutputTokens.delete(token);
    const backupPath = await backupExistingSubtitleOutput(selected.outputPath);
    const result = await exportSrt(workspace.cues, selected.outputPath);
    return { ...result, backupPath };
  });
  const evidenceFrameCache = new Map<string, string>();
  const pendingEvidenceFrames = new Map<string, Promise<{ url: string }>>();
  let evidenceFrameQueue: Promise<unknown> = Promise.resolve();
  const subtitleEvidenceFrame = async (id: string, timestampMs: number): Promise<{ url: string }> => {
    if (!Number.isFinite(timestampMs)) throw new Error("字幕影格時間無效。");
    const workspace = await standaloneSubtitles.get(id);
    await standaloneSubtitles.validateSource(workspace);
    const startMs = Math.max(0, Math.min(workspace.videoDurationMs - 1, Math.round(timestampMs)));
    const key = `${id}:${startMs}`;
    const cached = evidenceFrameCache.get(key);
    if (cached) return { url: cached };
    const pending = pendingEvidenceFrames.get(key);
    if (pending) return pending;
    const job = evidenceFrameQueue
      .catch(() => undefined)
      .then(async () => {
        let image = "";
        await subtitleFrameExtractor.extractBatches(
          {
            sourcePath: workspace.videoPath,
            projectId: workspace.id,
            cacheRoot: path.join(app.getPath("userData"), "cache"),
            segments: [{ type: "MAIN", startMs, endMs: startMs + 1 }],
            intervalSeconds: 1,
            detectSceneChanges: false,
            deduplicateFrames: false,
          },
          async (frames) => {
            if (frames[0]) image = `data:image/jpeg;base64,${(await readFile(frames[0].path)).toString("base64")}`;
          },
        );
        evidenceFrameCache.set(key, image);
        if (evidenceFrameCache.size > 20) evidenceFrameCache.delete(evidenceFrameCache.keys().next().value!);
        return { url: image };
      })
      .finally(() => pendingEvidenceFrames.delete(key));
    pendingEvidenceFrames.set(key, job);
    evidenceFrameQueue = job;
    return job;
  };
  ipcMain.handle("subtitle:workspace:frame", (_event, id: string, timestampMs: number) =>
    subtitleEvidenceFrame(id, timestampMs),
  );

  const publishSubtitleAiCheckProgress = (event: Electron.IpcMainInvokeEvent, progress: SubtitleAiCheckProgress) => {
    if (!event.sender.isDestroyed()) event.sender.send("subtitle:ai-check:progress", progress);
  };
  const runSubtitleAiCheck = async (
    event: Electron.IpcMainInvokeEvent,
    request: SubtitleAiCheckRequest,
    resumeOnly = false,
  ): Promise<SubtitleAiCheckJobSnapshot> => {
    if (!request.enabled) throw new Error("逐筆 AI 檢查預設關閉；請先明確勾選啟用。");
    if (subtitleAiCheckController) throw new Error("逐筆 AI 字幕檢查正在執行中。");
    const workspace = await standaloneSubtitles.get(request.workspaceId);
    const options = {
      enabled: true,
      interactiveConfirmation: request.interactiveConfirmation !== false,
      provider: request.provider,
      displayLanguage: request.displayLanguage,
      title: request.title.slice(0, 240),
      description: request.description.slice(0, 4000),
    };
    const saved = await subtitleAiCheckJobs.load();
    const sameInput =
      saved?.workspaceId === workspace.id &&
      saved.videoFingerprint === workspace.videoFingerprint &&
      JSON.stringify(saved.options) === JSON.stringify(options);
    if (resumeOnly && !sameInput) throw new Error("找不到可繼續的逐筆 AI 字幕檢查工作。");
    let snapshot = sameInput
      ? saved!
      : createSubtitleAiCheckSnapshot(workspace.id, workspace.videoFingerprint, options, workspace.cues.length);
    let runtime: Awaited<ReturnType<typeof subtitleProvider>>;
    try {
      await standaloneSubtitles.validateSource(workspace);
      runtime = await subtitleProvider(request.provider);
    } catch (error) {
      const categorized = classifySubtitleAiCheckError(error);
      snapshot.progress = {
        ...snapshot.progress,
        status: "FAILED",
        total: workspace.cues.length,
        errorCode: categorized.code,
        error: categorized.message,
      };
      await subtitleAiCheckJobs.save(snapshot);
      publishSubtitleAiCheckProgress(event, snapshot.progress);
      throw categorized;
    }
    const provider =
      runtime.provider.kind === "GEMINI"
        ? new GeminiSubtitleAiCheckProvider(runtime.model, runtime.apiKey)
        : new OpenAiSubtitleAiCheckProvider(runtime.model, runtime.apiKey);
    const completedCacheCurrent = workspace.cues.every((cue, index) =>
      snapshot.proposals.some(
        (proposal) =>
          proposal.cueId === cue.id &&
          proposal.baseCueRevision === subtitleCueRevision(cue) &&
          proposal.baseContextRevision ===
            subtitleAiCheckContextRevision(
              cue,
              workspace.cues[index - 1],
              workspace.cues[index + 1],
              options.title,
              options.description,
            ) &&
          proposal.provider === provider.kind &&
          proposal.modelId === provider.modelId,
      ),
    );
    if (snapshot.progress.status === "COMPLETED" && completedCacheCurrent) {
      publishSubtitleAiCheckProgress(event, snapshot.progress);
      return snapshot;
    }
    if (snapshot.progress.status === "COMPLETED")
      snapshot = createSubtitleAiCheckSnapshot(
        workspace.id,
        workspace.videoFingerprint,
        options,
        workspace.cues.length,
      );
    if (
      resumeOnly &&
      options.interactiveConfirmation &&
      snapshot.proposals.some((proposal) => proposal.status === "PENDING" || proposal.status === "EDITING")
    )
      throw new Error("請先處理目前 AI 建議，再繼續下一筆。");
    const controller = new AbortController();
    subtitleAiCheckController = controller;
    subtitleAiCheckPaused = false;
    const startedAt = Date.now();
    const previousElapsed = snapshot.progress.elapsedMs;
    snapshot.progress = {
      ...snapshot.progress,
      status: "RUNNING",
      total: workspace.cues.length,
      provider: provider.kind,
      modelId: provider.modelId,
      error: undefined,
      errorCode: undefined,
    };
    await subtitleAiCheckJobs.save(snapshot);
    publishSubtitleAiCheckProgress(event, snapshot.progress);
    try {
      for (let index = snapshot.progress.nextCueIndex; index < workspace.cues.length; index += 1) {
        if (controller.signal.aborted) throw new DOMException("AI 字幕檢查已停止。", "AbortError");
        const latestWorkspace = await standaloneSubtitles.get(workspace.id);
        const latestCueIndex = latestWorkspace.cues.findIndex((item) => item.id === workspace.cues[index].id);
        const cue = latestWorkspace.cues[latestCueIndex];
        if (!cue) {
          snapshot.progress = {
            ...snapshot.progress,
            processed: index + 1,
            nextCueIndex: index + 1,
            elapsedMs: previousElapsed + Date.now() - startedAt,
          };
          await subtitleAiCheckJobs.save(snapshot);
          continue;
        }
        const previous = latestWorkspace.cues[latestCueIndex - 1];
        const next = latestWorkspace.cues[latestCueIndex + 1];
        const contextRevision = subtitleAiCheckContextRevision(cue, previous, next, options.title, options.description);
        const priorProposal = snapshot.proposals.find(
          (item) =>
            item.cueId === cue.id &&
            item.baseCueRevision === subtitleCueRevision(cue) &&
            item.baseContextRevision === contextRevision &&
            item.provider === provider.kind &&
            item.modelId === provider.modelId,
        );
        if (priorProposal) {
          snapshot.progress = {
            ...snapshot.progress,
            processed: index + 1,
            nextCueIndex: index + 1,
            cacheHits: snapshot.progress.cacheHits + 1,
            currentCueId: cue.id,
            elapsedMs: previousElapsed + Date.now() - startedAt,
          };
          await subtitleAiCheckJobs.save(snapshot);
          publishSubtitleAiCheckProgress(event, snapshot.progress);
          continue;
        }
        const middle = Math.round((cue.startMs + cue.endMs) / 2);
        const times = [
          ...new Set(
            [
              previous ? Math.round((previous.startMs + previous.endMs) / 2) : undefined,
              cue.startMs,
              middle,
              Math.max(cue.startMs, cue.endMs - 1),
              next ? Math.round((next.startMs + next.endMs) / 2) : undefined,
            ].filter((value): value is number => value !== undefined),
          ),
        ];
        const roles = times.map((time) =>
          time === cue.startMs
            ? ("START" as const)
            : time === middle
              ? ("MIDDLE" as const)
              : time === Math.max(cue.startMs, cue.endMs - 1)
                ? ("END" as const)
                : previous && time < cue.startMs
                  ? ("PREVIOUS" as const)
                  : ("NEXT" as const),
        );
        const evidence = [];
        for (let evidenceIndex = 0; evidenceIndex < times.length; evidenceIndex += 1) {
          try {
            const frame = await subtitleEvidenceFrame(workspace.id, times[evidenceIndex]);
            if (frame.url)
              evidence.push({ role: roles[evidenceIndex], timestampMs: times[evidenceIndex], imageDataUrl: frame.url });
          } catch (error) {
            throw new SubtitleAiCheckError(
              "FRAME_EXTRACTION",
              error instanceof Error ? error.message : "字幕檢查影格擷取失敗。",
            );
          }
        }
        const result = await provider.checkCue(
          {
            cue,
            cueIndex: latestCueIndex,
            cueCount: latestWorkspace.cues.length,
            videoDurationMs: workspace.videoDurationMs,
            previousCue: previous,
            nextCue: next,
            title: options.title,
            description: options.description,
            displayLanguage: options.displayLanguage,
            evidence,
          },
          controller.signal,
        );
        snapshot.proposals.push(
          buildSubtitleAiCheckProposal(cue, latestCueIndex, times, provider, result, contextRevision),
        );
        snapshot.progress = advanceSubtitleAiCheckProgress(
          snapshot.progress,
          index,
          cue.id,
          options.interactiveConfirmation,
          previousElapsed + Date.now() - startedAt,
        );
        await subtitleAiCheckJobs.save(snapshot);
        publishSubtitleAiCheckProgress(event, snapshot.progress);
        if (options.interactiveConfirmation) return snapshot;
      }
      snapshot.progress = {
        ...snapshot.progress,
        status: "COMPLETED",
        currentCueId: undefined,
        elapsedMs: previousElapsed + Date.now() - startedAt,
      };
      await subtitleAiCheckJobs.save(snapshot);
      publishSubtitleAiCheckProgress(event, snapshot.progress);
      return snapshot;
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const categorized = classifySubtitleAiCheckError(error);
      snapshot.progress = {
        ...snapshot.progress,
        status: aborted ? (subtitleAiCheckPaused ? "PAUSED" : "STOPPED") : "FAILED",
        elapsedMs: previousElapsed + Date.now() - startedAt,
        errorCode: aborted ? undefined : categorized.code,
        error: aborted ? undefined : categorized.message,
      };
      await subtitleAiCheckJobs.save(snapshot);
      publishSubtitleAiCheckProgress(event, snapshot.progress);
      if (!aborted) throw categorized;
      return snapshot;
    } finally {
      if (subtitleAiCheckController === controller) subtitleAiCheckController = undefined;
    }
  };
  const launchSubtitleAiCheck = (
    event: Electron.IpcMainInvokeEvent,
    request: SubtitleAiCheckRequest,
    resumeOnly = false,
  ) => {
    if (subtitleAiCheckRunPromise) throw new Error("逐筆 AI 字幕檢查正在執行中。");
    const task = runSubtitleAiCheck(event, request, resumeOnly);
    subtitleAiCheckRunPromise = task;
    void task.then(
      () => {
        if (subtitleAiCheckRunPromise === task) subtitleAiCheckRunPromise = undefined;
      },
      () => {
        if (subtitleAiCheckRunPromise === task) subtitleAiCheckRunPromise = undefined;
      },
    );
    return task;
  };
  ipcMain.handle("subtitle:ai-check:get", () => subtitleAiCheckJobs.load());
  ipcMain.handle("subtitle:ai-check:start", (event, request: SubtitleAiCheckRequest) =>
    launchSubtitleAiCheck(event, request),
  );
  ipcMain.handle("subtitle:ai-check:pause", async () => {
    subtitleAiCheckPaused = true;
    const running = subtitleAiCheckRunPromise;
    subtitleAiCheckController?.abort();
    if (running) await running.catch(() => undefined);
  });
  ipcMain.handle("subtitle:ai-check:stop", async () => {
    subtitleAiCheckPaused = false;
    const running = subtitleAiCheckRunPromise;
    if (subtitleAiCheckController) subtitleAiCheckController.abort();
    if (running) await running.catch(() => undefined);
    const snapshot = await subtitleAiCheckJobs.load();
    if (snapshot && (snapshot.progress.status === "PAUSED" || snapshot.progress.status === "RUNNING")) {
      snapshot.progress = { ...snapshot.progress, status: "STOPPED", currentCueId: undefined };
      await subtitleAiCheckJobs.save(snapshot);
    }
    return snapshot;
  });
  ipcMain.handle("subtitle:ai-check:resume", async (event) => {
    const saved = await subtitleAiCheckJobs.load();
    if (!saved) throw new Error("找不到可繼續的逐筆 AI 字幕檢查工作。");
    return launchSubtitleAiCheck(event, { workspaceId: saved.workspaceId, ...saved.options }, true);
  });
  ipcMain.handle("subtitle:ai-check:action", async (_event, action: SubtitleAiCheckAction) => {
    const snapshot = await subtitleAiCheckJobs.load();
    if (!snapshot || snapshot.workspaceId !== action.workspaceId)
      throw new Error("逐筆 AI 字幕檢查工作不存在或已過期。");
    const proposalIndex = snapshot.proposals.findIndex((item) => item.id === action.proposalId);
    if (proposalIndex < 0) throw new Error("找不到這筆 AI 字幕建議。");
    if (snapshot.progress.status === "RUNNING") throw new Error("請先暫停逐筆 AI 檢查，再處理建議。");
    const workspace = await standaloneSubtitles.get(action.workspaceId);
    const linkedProject = workspace.sourceProjectId ? store.getProject() : undefined;
    if (
      (action.action === "APPLY" || action.action === "EDIT") &&
      linkedProject &&
      (linkedProject.id !== workspace.sourceProjectId ||
        linkedProject.timelineRevision !== workspace.sourceTimelineRevision)
    )
      throw new Error("專案時間線已變更；AI 建議保留但不能套用，請重新建立檢查工作。");
    const targetCues =
      linkedProject && linkedProject.id === workspace.sourceProjectId ? linkedProject.subtitleCues : workspace.cues;
    const resolved = resolveSubtitleAiCheckAction(
      targetCues,
      snapshot.proposals[proposalIndex],
      action,
      workspace.videoDurationMs,
    );
    snapshot.proposals[proposalIndex] = resolved.proposal;
    const updatedWorkspace =
      action.action === "APPLY" || action.action === "EDIT"
        ? await standaloneSubtitles.save(workspace.id, resolved.cues)
        : workspace;
    const updatedProject =
      (action.action === "APPLY" || action.action === "EDIT") && linkedProject && !resolved.conflict
        ? await store.setSubtitleCues(resolved.cues)
        : undefined;
    await subtitleAiCheckJobs.save(snapshot);
    return {
      workspace: updatedWorkspace,
      project: updatedProject,
      proposal: resolved.proposal,
      conflict: resolved.conflict,
    };
  });
  let subtitleVisualResumeData: {
    videoPath?: string;
    selectionReason?: "PROJECT_CONCAT" | "LATEST_CONCAT" | "MANUAL_PATH" | "NONE";
    videoFingerprint?: string;
    contextRevision?: string;
    nextBatch?: number;
    drafts?: import("./services/subtitle-vision-orchestrator").SubtitleVisionDraft[];
    frameSegments?: Record<string, SubtitleVisionFrame["segmentType"]>;
    progress?: SubtitleVisualAnalysisProgress;
  } = {};
  const saveSubtitleVisualCheckpoint = async (options: SubtitleVisualAnalysisOptions, status: string) => {
    await mkdir(path.dirname(subtitleVisualCheckpointPath), { recursive: true });
    const partial = `${subtitleVisualCheckpointPath}.${process.pid}.partial`;
    await writeFile(
      partial,
      JSON.stringify(
        {
          schemaVersion: 2,
          projectId: store.getProject().id,
          options,
          status,
          ...subtitleVisualResumeData,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    await rename(partial, subtitleVisualCheckpointPath);
  };
  const runSubtitleVisualJob = async (event: Electron.IpcMainInvokeEvent, options: SubtitleVisualAnalysisOptions) => {
    if (subtitleVisualController) throw new Error("AI 畫面字幕分析已在進行中。");
    const project = store.getProject();
    const selected = await currentSubtitleVideoSelection();
    if (!selected.path) throw new Error("找不到可分析的成功 Final Output，請先選擇影片。");
    const media = await subtitleVideoProbe.probe(selected.path);
    const durationMs = media.durationMs ?? 0;
    if (durationMs <= 0) throw new Error("分析影片沒有有效時長。");
    const combined = buildTimelinePlan(project, { includeIntro: project.introSegments.length > 0 });
    const preflight = await subtitlePreflight(options);
    if (options.srtPolicy === "CANCEL") return;
    const mode = options.analysisMode === "VIDEO_FIRST" ? "VIDEO_FIRST" : preflight.recommendedMode;
    subtitleLog("AI", {
      mode,
      selected: selected.path,
      videoDurationMs: durationMs,
      projectDurationMs: combined.durationMs,
      differenceMs: preflight.differenceMs,
    });
    const assetById = new Map(project.sources.map((asset) => [asset.id, asset]));
    const segments =
      mode === "VIDEO_FIRST"
        ? [{ type: "MAIN" as const, startMs: 0, endMs: durationMs }]
        : combined.clips
            .filter((clip) => options.scopes.includes(clip.scope))
            .map((clip) => ({
              type:
                clip.scope === "INTRO"
                  ? ("INTRO" as const)
                  : assetById.get(clip.assetId)?.kind === "IMAGE"
                    ? ("PHOTO" as const)
                    : clip.mediaInsertionId
                      ? ("INSERT" as const)
                      : ("MAIN" as const),
              startMs: clip.outputStartMs,
              endMs: clip.outputEndMs,
            }));
    if (!segments.length) throw new Error("所選字幕範圍沒有可分析片段。");
    const controller = new AbortController();
    subtitleVisualController = controller;
    subtitleVisualPaused = false;
    subtitleVisualLastOptions = structuredClone(options);
    const startedAt = Date.now();
    let lastProgress: SubtitleVisualAnalysisProgress = {
      status: "RUNNING",
      phase: "PREPARING_VIDEO",
      rawFrames: 0,
      sceneFrames: 0,
      deduplicatedFrames: 0,
      sentFrames: 0,
      requests: 0,
      elapsedMs: 0,
      tokens: 0,
      cacheHits: 0,
      temporaryBytes: 0,
      mode,
    };
    const base = (): SubtitleVisualAnalysisProgress => ({ ...lastProgress, elapsedMs: Date.now() - startedAt });
    const publish = (patch: Partial<SubtitleVisualAnalysisProgress>) => {
      lastProgress = { ...base(), ...patch };
      publishSubtitleVisualProgress(event, lastProgress);
    };
    publishSubtitleVisualProgress(event, base());
    try {
      if (preflight.existingSrtPath && options.srtPolicy === "BACKUP") {
        const backup = `${preflight.existingSrtPath}.backup_${new Date().toISOString().replace(/[:.]/g, "-")}.srt`;
        await copyFile(preflight.existingSrtPath, backup, 1);
      }
      const file = await stat(selected.path);
      const videoFingerprint = createHash("sha256")
        .update(`${selected.path}\0${file.size}\0${file.mtimeMs}`)
        .digest("hex");
      const contextRevision = createHash("sha256")
        .update(
          JSON.stringify({
            title: options.title.trim(),
            description: options.description.trim(),
            mode,
            timeline: segments.map((segment) => [segment.type, segment.startMs, segment.endMs]),
          }),
        )
        .digest("hex");
      try {
        const saved = JSON.parse(
          await readFile(subtitleVisualCheckpointPath, "utf8"),
        ) as typeof subtitleVisualResumeData & {
          projectId?: string;
          status?: string;
          options?: SubtitleVisualAnalysisOptions;
        };
        const sameOptions = JSON.stringify(saved.options) === JSON.stringify(options);
        subtitleVisualResumeData =
          ["PAUSED", "FAILED", "CANCELLED"].includes(saved.status ?? "") &&
          saved.projectId === project.id &&
          saved.videoFingerprint === videoFingerprint &&
          saved.contextRevision === contextRevision &&
          sameOptions
            ? saved
            : {};
      } catch {
        subtitleVisualResumeData = {};
      }
      subtitleVisualResumeData = {
        ...subtitleVisualResumeData,
        videoPath: selected.path,
        selectionReason: selected.reason,
        videoFingerprint,
        contextRevision,
      };
      if (subtitleVisualResumeData.progress)
        lastProgress = { ...subtitleVisualResumeData.progress, status: "RUNNING", mode };
      const resolvedProvider = await subtitleProvider(options.provider);
      let provider: import("./services/subtitle-vision-orchestrator").SubtitleVisionProvider =
        resolvedProvider.provider;
      publish({ modelId: resolvedProvider.model });
      subtitleLog("AI", { provider: provider.kind, model: provider.version });
      const cache = new DiskSubtitleVisionCache(
        path.join(app.getPath("userData"), "cache", "subtitle-vision", project.id),
      );
      const allDrafts: import("./services/subtitle-vision-orchestrator").SubtitleVisionDraft[] = [
        ...(subtitleVisualResumeData.drafts ?? []),
      ];
      const frameSegments = new Map<string, SubtitleVisionFrame["segmentType"]>(
        Object.entries(subtitleVisualResumeData.frameSegments ?? {}) as Array<
          [string, SubtitleVisionFrame["segmentType"]]
        >,
      );
      let processedFrames = subtitleVisualResumeData.progress?.sentFrames ?? 0;
      let requestCount = subtitleVisualResumeData.progress?.requests ?? 0;
      let tokenCount = subtitleVisualResumeData.progress?.tokens ?? 0;
      let cacheHits = subtitleVisualResumeData.progress?.cacheHits ?? 0;
      let frameIndex = 0;
      const extracted = await subtitleFrameExtractor.extractBatches(
        {
          sourcePath: selected.path,
          cacheRoot: path.join(app.getPath("userData"), "cache"),
          projectId: project.id,
          segments,
          intervalSeconds: options.intervalSeconds,
          detectSceneChanges: options.detectSceneChanges,
          deduplicateFrames: options.deduplicateFrames,
          sceneThreshold: 0.3,
          signal: controller.signal,
          onProgress: (item) =>
            publish({
              phase: item.stage === "SCENES" ? "SCENE_DETECTION" : "EXTRACTING_FRAMES",
              rawFrames: item.rawFrames ?? lastProgress.rawFrames,
              sceneFrames: item.sceneFrames ?? lastProgress.sceneFrames,
              deduplicatedFrames: item.deduplicatedFrames ?? lastProgress.deduplicatedFrames,
            }),
        },
        async (items, batchIndex) => {
          if (batchIndex < (subtitleVisualResumeData.nextBatch ?? 0)) {
            frameIndex += items.length;
            return;
          }
          const batch: SubtitleVisionFrame[] = [];
          let temporaryBytes = 0;
          for (const item of items) {
            const bytes = await readFile(item.path);
            temporaryBytes += bytes.byteLength;
            const id = `frame-${frameIndex++}-${item.timeMs}`;
            frameSegments.set(id, item.segmentType);
            batch.push({
              id,
              timestampMs: item.timeMs,
              imageDataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
              fingerprint: createHash("sha256").update(bytes).digest("hex"),
              videoFingerprint,
              videoDurationMs: durationMs,
              contextRevision,
              segmentType: item.segmentType,
              context: {
                projectName: mode === "PROJECT_AWARE" ? project.name : "",
                title: options.title,
                description: options.description,
                previousSubtitle: allDrafts.at(-1)?.text,
                neighborTimestampsMs: items.map((frame) => frame.timeMs),
              },
            });
          }
          publish({ phase: "AI_ANALYZING", temporaryBytes });
          const fallbackResult = await runSubtitleVisionBatchWithFallback(
            batch,
            provider,
            cache,
            { density: options.density, language: options.displayLanguage, signal: controller.signal },
            {
              catalog: aiModels,
              apiKey: resolvedProvider.apiKey,
              selectionMode: resolvedProvider.selectionMode,
              onFallback: (previousModel, nextModel, reason) => {
                publish({ modelId: nextModel });
                subtitleLog("AI_FALLBACK", { previousModel, nextModel, status: reason.status, code: reason.code });
              },
            },
          );
          provider = fallbackResult.provider;
          const analyzed = fallbackResult.result;
          allDrafts.push(...analyzed.drafts);
          processedFrames += batch.length;
          requestCount += analyzed.progress.requests;
          tokenCount += analyzed.progress.inputTokens + analyzed.progress.outputTokens;
          cacheHits += analyzed.progress.cacheHits;
          subtitleLog("AI_BATCH", {
            batchIndex,
            frames: batch.length,
            requests: requestCount,
            tokens: tokenCount,
            cacheHits,
          });
          publish({
            phase: "AI_ANALYZING",
            sentFrames: processedFrames,
            requests: requestCount,
            tokens: tokenCount,
            cacheHits,
            temporaryBytes,
          });
          subtitleVisualResumeData = {
            videoPath: selected.path,
            selectionReason: selected.reason,
            videoFingerprint,
            contextRevision,
            nextBatch: batchIndex + 1,
            drafts: allDrafts,
            frameSegments: Object.fromEntries(frameSegments),
            progress: base(),
          };
          await saveSubtitleVisualCheckpoint(options, "RUNNING");
        },
      );
      publish({ phase: "GENERATING_SUBTITLES" });
      const finalSourceStat = await stat(selected.path);
      if (finalSourceStat.size !== file.size || finalSourceStat.mtimeMs !== file.mtimeMs)
        throw new Error("分析期間影片已變更；既有字幕保留，請重新分析新影片。");
      const merged = mergeSubtitleVisionDrafts(allDrafts, { durationMs, maxCharsPerLine: 60 });
      const currentProject = store.getProject();
      const writeMode =
        mode === "PROJECT_AWARE" &&
        currentProject.id === project.id &&
        currentProject.timelineRevision === project.timelineRevision
          ? "PROJECT_AWARE"
          : "VIDEO_FIRST";
      const introOrigin = combined.clips.find((clip) => clip.scope === "INTRO")?.outputStartMs ?? 0;
      const mainOrigin = combined.clips.find((clip) => clip.scope === "MAIN")?.outputStartMs ?? 0;
      const cues = merged.map((draft) => {
        const scope: SubtitleTimelineScope = frameSegments.get(draft.frameId) === "INTRO" ? "INTRO" : "MAIN";
        const origin = writeMode === "VIDEO_FIRST" ? 0 : scope === "INTRO" ? introOrigin : mainOrigin;
        return {
          id: randomUUID(),
          startMs: Math.max(0, draft.startMs - origin),
          endMs: Math.max(1, draft.endMs - origin),
          text: draft.text,
          timelineScope: scope,
          origin: "AI_VISUAL" as const,
          reviewStatus: "DRAFT" as const,
          aiConfidence: Math.round(draft.confidence * 100),
          aiWarnings: draft.warning ? [draft.warning] : [],
          aiAnalysisVersion: provider.version,
        };
      });
      const workspace =
        writeMode === "VIDEO_FIRST"
          ? await standaloneSubtitles.create(selected.path, videoFingerprint, durationMs, cues)
          : undefined;
      subtitleLog("SUBTITLE", { mode: writeMode, draftGenerated: cues.length, workspaceId: workspace?.id });
      if (writeMode === "PROJECT_AWARE")
        await store.replaceAiSubtitleDrafts(cues, options.scopes, "PRESERVE_USER_EDITED");
      subtitleVisualResumeData = {};
      await saveSubtitleVisualCheckpoint(options, "COMPLETED");
      publish({
        status: "COMPLETED",
        phase: "DRAFT_READY",
        mode: writeMode,
        rawFrames: extracted.plan.counters.raw,
        sceneFrames: extracted.plan.counters.scene,
        deduplicatedFrames: extracted.plan.counters.dedup,
        sentFrames: processedFrames,
        requests: requestCount,
        tokens: tokenCount,
        cacheHits,
        draftCount: cues.length,
        temporaryBytes: 0,
      });
      return { mode: writeMode, generatedCount: cues.length, workspace };
    } catch (error) {
      const paused = subtitleVisualPaused && error instanceof Error && error.name === "AbortError";
      await saveSubtitleVisualCheckpoint(
        options,
        paused ? "PAUSED" : error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
      );
      publishSubtitleVisualProgress(event, {
        ...base(),
        status: paused ? "PAUSED" : error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      if (!paused) throw error;
    } finally {
      if (subtitleVisualController === controller) subtitleVisualController = undefined;
    }
  };
  ipcMain.handle("subtitle:visual-job:start", (event, options: SubtitleVisualAnalysisOptions) =>
    runSubtitleVisualJob(event, options),
  );
  ipcMain.handle("subtitle:visual-job:pause", async () => {
    subtitleVisualPaused = true;
    subtitleVisualController?.abort();
  });
  ipcMain.handle("subtitle:visual-job:cancel", async () => {
    subtitleVisualPaused = false;
    subtitleVisualController?.abort();
    if (subtitleVisualLastOptions) await saveSubtitleVisualCheckpoint(subtitleVisualLastOptions, "CANCELLED");
  });
  ipcMain.handle("subtitle:visual-job:resume", async (event) => {
    const saved = JSON.parse(await readFile(subtitleVisualCheckpointPath, "utf8")) as {
      projectId: string;
      options: SubtitleVisualAnalysisOptions;
      videoPath?: string;
      selectionReason?: string;
    };
    if (saved.projectId !== store.getProject().id) throw new Error("暫停工作不屬於目前專案。");
    if (saved.videoPath && path.isAbsolute(saved.videoPath)) {
      explicitSubtitleVideoPath = saved.videoPath;
      resumedSubtitleSelectionReason =
        saved.selectionReason === "PROJECT_CONCAT" || saved.selectionReason === "LATEST_CONCAT"
          ? saved.selectionReason
          : "MANUAL_PATH";
    }
    if (!subtitleVisualLastOptions) {
      subtitleVisualLastOptions = saved.options;
    }
    return runSubtitleVisualJob(event, subtitleVisualLastOptions);
  });
  ipcMain.handle("subtitle:visual-cue:regenerate", async (_event, request: SubtitleVisualCueRegenerateRequest) => {
    const project = store.getProject();
    const cue = project.subtitleCues.find((item) => item.id === request.cueId);
    if (!cue || cue.origin !== "AI_VISUAL" || cue.reviewStatus !== "DRAFT")
      throw new Error("只能重新產生待確認的畫面 AI 草稿。");
    const selected = await currentSubtitleVideoSelection();
    if (!selected.path) throw new Error("找不到可分析的成功 Final Output。");
    const combined = buildTimelinePlan(project, { includeIntro: project.introSegments.length > 0 });
    const origin =
      cue.timelineScope === "INTRO"
        ? (combined.clips.find((clip) => clip.scope === "INTRO")?.outputStartMs ?? 0)
        : (combined.clips.find((clip) => clip.scope === "MAIN")?.outputStartMs ?? 0);
    const media = await subtitleVideoProbe.probe(selected.path);
    const durationMs = media.durationMs ?? 0;
    const compatibility = subtitleTimelineCompatibility(combined.durationMs, durationMs);
    if (!compatibility.compatible || selected.reason === "MANUAL_PATH")
      throw new Error("此影片不適合直接修改專案字幕；請用影片時間軸分析建立獨立草稿。");
    const center = origin + Math.round((cue.startMs + cue.endMs) / 2);
    const startMs = Math.max(0, center - 1_000);
    const endMs = Math.min(durationMs, center + 1_001);
    const { provider } = await subtitleProvider(request.provider);
    const file = await stat(selected.path);
    const videoFingerprint = createHash("sha256")
      .update(`${selected.path}\0${file.size}\0${file.mtimeMs}`)
      .digest("hex");
    const contextRevision = createHash("sha256")
      .update(JSON.stringify([cue.id, cue.startMs, cue.endMs, request.instruction, request.displayLanguage]))
      .digest("hex");
    const drafts: import("./services/subtitle-vision-orchestrator").SubtitleVisionDraft[] = [];
    await subtitleFrameExtractor.extractBatches(
      {
        projectId: project.id,
        sourcePath: selected.path,
        cacheRoot: path.join(app.getPath("userData"), "cache"),
        segments: [{ type: "MAIN", startMs, endMs }],
        intervalSeconds: 1,
        detectSceneChanges: false,
        deduplicateFrames: true,
      },
      async (items) => {
        const frames: SubtitleVisionFrame[] = [];
        for (let index = 0; index < items.length; index += 1) {
          const bytes = await readFile(items[index].path);
          frames.push({
            id: `cue-${cue.id}-${index}`,
            timestampMs: items[index].timeMs,
            imageDataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
            fingerprint: createHash("sha256").update(bytes).digest("hex"),
            videoFingerprint,
            videoDurationMs: durationMs,
            contextRevision,
            segmentType: "MAIN",
            context: {
              projectName: project.name,
              title: project.aiStoryContext.topic,
              description:
                `${project.aiStoryContext.storySummary ?? ""}\nUser correction: ${request.instruction}`.trim(),
              previousSubtitle: cue.text,
            },
          });
        }
        const result = await runSubtitleVisionDrafts(
          frames,
          provider,
          new DiskSubtitleVisionCache(path.join(app.getPath("userData"), "cache", "subtitle-vision", project.id)),
          { density: "STANDARD", language: request.displayLanguage },
        );
        drafts.push(...result.drafts);
      },
    );
    if (!drafts.length) throw new Error("附近畫面沒有產生可用字幕建議。");
    const text = drafts
      .map((draft) => draft.text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 120);
    return {
      text,
      confidence: Math.min(...drafts.map((draft) => draft.confidence)),
      warning: drafts.find((draft) => draft.warning)?.warning,
    };
  });
  ipcMain.handle("subtitle:ai-generate", async (event, options: AiSubtitleGenerationOptions) => {
    if (aiSubtitleController) throw new Error("AI 字幕分析已在進行中。");
    const controller = new AbortController();
    aiSubtitleController = controller;
    const backgroundJobId = beginBackgroundJob("AI_SUBTITLES", "AI 知識型字幕產出");
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await aiStory.generateSubtitles(options, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, {
          percent: progress.total ? Math.round((progress.processed / progress.total) * 100) : 0,
          detail: progress.currentName ?? progress.phase,
        });
        if (!event.sender.isDestroyed()) event.sender.send("ai:analysis-progress", progress);
      });
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: "字幕草稿已保存到專案" });
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (aiSubtitleController === controller) aiSubtitleController = undefined;
    }
  });
  ipcMain.handle("subtitle:ai-cancel", () => aiSubtitleController?.abort());
  ipcMain.handle("subtitle:material-analyze", async (event, request: MaterialSubtitleAnalysisRequest) => {
    if (materialAnalysisController) throw new Error("素材影像分析已在進行中。");
    const controller = new AbortController();
    materialAnalysisController = controller;
    const backgroundJobId = beginBackgroundJob("AI_MATERIAL_ANALYSIS", "素材影像／物種字幕分析");
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await aiStory.analyzeMaterialForSubtitles(request, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, {
          percent: progress.total ? Math.round((progress.processed / progress.total) * 100) : 0,
          detail: progress.currentName ?? progress.phase,
        });
        if (!event.sender.isDestroyed()) event.sender.send("ai:analysis-progress", progress);
      });
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: `已產生 ${result.drafts.length} 筆待確認字幕` });
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (materialAnalysisController === controller) materialAnalysisController = undefined;
    }
  });
  ipcMain.handle("subtitle:material-cancel", () => materialAnalysisController?.abort());
  ipcMain.handle("subtitle:build-intro-preview", async (event, includeBgm: boolean = false) => {
    if (subtitlePreviewController) throw new Error("480P 片頭字幕預覽正在建立中。");
    if (typeof includeBgm !== "boolean") throw new Error("片頭配樂預覽設定無效。");
    const controller = new AbortController();
    subtitlePreviewController = controller;
    const backgroundJobId = beginBackgroundJob("SUBTITLE_PREVIEW", "字幕片頭 480P 預覽");
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await subtitlePreviews.ensureIntro480p(includeBgm, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, { percent: progress.percent, detail: progress.phase });
        if (!event.sender.isDestroyed()) event.sender.send("subtitle:preview-progress", progress);
      });
      await outputHistory.registerRender(
        {
          jobId: `subprev-${result.cacheKey}`,
          outputPath: result.outputPath,
          sizeBytes: result.sizeBytes,
          expectedDurationMs: result.durationMs,
          transitionSeconds: store.getProject().timelineTransitionSeconds,
          resolution: "480P",
          purpose: "INTRO",
          bgmAppliedCount: includeBgm ? store.getProject().bgmTracks.length : 0,
          includedIntroSegmentCount: store.getProject().introSegments.length,
        },
        store.getProject().name,
        store.getProject().id,
      );
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: result.outputPath });
      return result;
    } catch (error) {
      finishBackgroundJob(
        backgroundJobId,
        error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED",
        { error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (subtitlePreviewController === controller) subtitlePreviewController = undefined;
    }
  });
  ipcMain.handle("subtitle:cancel-intro-preview", () => subtitlePreviewController?.abort());
  ipcMain.handle("subtitle:choose-input", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "匯入 UTF-8 SRT 字幕",
      defaultPath: userPreferences.getLastDirectory("SUBTITLE_INPUT", app.getPath("documents")),
      properties: ["openFile"],
      filters: [{ name: "SubRip 字幕", extensions: ["srt"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("SUBTITLE_INPUT", result.filePaths[0]);
    return importSrtFile(result.filePaths[0]);
  });
  ipcMain.handle("subtitle:choose-output", async (event, suggestedName: string) => {
    for (const [token, item] of subtitleOutputTokens)
      if (Date.now() - item.createdAt > 30 * 60 * 1000) subtitleOutputTokens.delete(token);
    const safeStem = path
      .basename(typeof suggestedName === "string" ? suggestedName : "")
      .replace(/\.srt$/i, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim();
    const options: Electron.SaveDialogOptions = {
      title: "匯出 UTF-8 SRT 字幕",
      defaultPath: path.join(
        userPreferences.getLastDirectory("SUBTITLE_OUTPUT", app.getPath("documents")),
        `${safeStem || "SceneryWalker_subtitles"}.srt`,
      ),
      filters: [{ name: "SubRip 字幕", extensions: ["srt"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const outputPath =
      path.extname(result.filePath).toLowerCase() === ".srt" ? result.filePath : `${result.filePath}.srt`;
    await userPreferences.rememberDirectory("SUBTITLE_OUTPUT", outputPath);
    const token = randomUUID();
    subtitleOutputTokens.set(token, { outputPath, createdAt: Date.now() });
    return { token, displayPath: outputPath };
  });
  ipcMain.handle("subtitle:export", async (_event, token: string, scopes?: SubtitleTimelineScope[]) => {
    const selected = subtitleOutputTokens.get(token);
    subtitleOutputTokens.delete(token);
    if (!selected || Date.now() - selected.createdAt > 30 * 60 * 1000)
      throw new Error("字幕輸出位置授權已失效，請重新選擇。");
    subtitleExportController?.abort();
    subtitleExportController = new AbortController();
    const selectedScopes = new Set(
      (Array.isArray(scopes) && scopes.length ? scopes : ["MAIN"]).filter(
        (scope): scope is SubtitleTimelineScope => scope === "INTRO" || scope === "MAIN",
      ),
    );
    const confirmed = store
      .getProject()
      .subtitleCues.filter(
        (cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" && selectedScopes.has(cue.timelineScope ?? "MAIN"),
      );
    if (!confirmed.length) throw new Error("沒有已確認的字幕可匯出；AI 草稿必須逐項確認。");
    try {
      return await exportSrt(confirmed, selected.outputPath, subtitleExportController.signal);
    } finally {
      subtitleExportController = undefined;
    }
  });
  ipcMain.handle("subtitle:save-ai-draft", async (_event, token: string, scopes?: SubtitleTimelineScope[]) => {
    const selected = subtitleOutputTokens.get(token);
    if (!selected || Date.now() - selected.createdAt > 30 * 60 * 1000)
      throw new Error("字幕輸出位置授權已失效，請重新選擇。");
    const selectedScopes = new Set(
      (Array.isArray(scopes) && scopes.length ? scopes : ["MAIN"]).filter(
        (scope): scope is SubtitleTimelineScope => scope === "INTRO" || scope === "MAIN",
      ),
    );
    const drafts = store
      .getProject()
      .subtitleCues.filter(
        (cue) => (cue.reviewStatus ?? "CONFIRMED") === "DRAFT" && selectedScopes.has(cue.timelineScope ?? "MAIN"),
      )
      .sort(
        (left, right) =>
          (left.timelineScope ?? "MAIN").localeCompare(right.timelineScope ?? "MAIN") || left.startMs - right.startMs,
      );
    if (!drafts.length) throw new Error("目前範圍沒有待確認的 AI 字幕草稿。");
    const saved = await writeSubtitleAiDraft(selected.outputPath, drafts);
    selected.draftScopes = [...selectedScopes];
    selected.draftCueIds = drafts.map((cue) => cue.id);
    const preflight = await preflightSubtitleAiDraft(selected.outputPath);
    return { ...saved, officialExists: preflight.officialExists, defaultChoice: preflight.defaultChoice };
  });
  ipcMain.handle(
    "subtitle:promote-ai-draft",
    async (_event, token: string, choice: "BACKUP" | "OVERWRITE" | "CANCEL") => {
      const selected = subtitleOutputTokens.get(token);
      if (!selected || Date.now() - selected.createdAt > 30 * 60 * 1000)
        throw new Error("字幕輸出位置授權已失效，請重新選擇。");
      if (choice !== "BACKUP" && choice !== "OVERWRITE" && choice !== "CANCEL")
        throw new Error("字幕衝突處理選項無效。");
      if (choice !== "CANCEL") {
        const scopes = new Set(selected.draftScopes ?? []);
        if (!scopes.size) throw new Error("找不到這份草稿的審核範圍，請重新保存 AI 草稿。");
        const cuesById = new Map(store.getProject().subtitleCues.map((cue) => [cue.id, cue]));
        const unconfirmed = (selected.draftCueIds ?? []).filter(
          (id) => (cuesById.get(id)?.reviewStatus ?? "CONFIRMED") !== "CONFIRMED",
        );
        if (!selected.draftCueIds?.length || unconfirmed.length)
          throw new Error(`仍有 ${unconfirmed.length || "未識別"} 筆草稿未逐筆確認；不能升級正式 SRT。`);
      }
      const result = await promoteStoredSubtitleAiDraft(selected.outputPath, choice);
      if (!result.cancelled) subtitleOutputTokens.delete(token);
      return result;
    },
  );
  ipcMain.handle("subtitle:cancel-export", () => subtitleExportController?.abort());
  ipcMain.handle("youtube:get-settings", () => youtubeSettings.getSnapshot());
  ipcMain.handle("youtube:update-settings", (_event, update: YoutubeSettingsUpdate) => youtubeSettings.update(update));
  ipcMain.handle("youtube:choose-oauth-client", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "選擇 Google Desktop app OAuth client JSON",
      defaultPath: userPreferences.getLastDirectory("OAUTH_CLIENT", app.getPath("documents")),
      properties: ["openFile"],
      filters: [{ name: "Google OAuth JSON", extensions: ["json"] }],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("OAUTH_CLIENT", result.filePaths[0]);
    return youtubeSettings.importOAuthClient(result.filePaths[0]);
  });
  ipcMain.handle("youtube:connect", async (event) => {
    if (youtubeAuthController) throw new Error("YouTube 頻道連結正在進行中。");
    const controller = new AbortController();
    youtubeAuthController = controller;
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      return await youtubeUpload.connect(controller.signal);
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (youtubeAuthController === controller) youtubeAuthController = undefined;
    }
  });
  ipcMain.handle("youtube:cancel-connect", () => youtubeAuthController?.abort());
  ipcMain.handle("youtube:disconnect", () => youtubeUpload.disconnect());
  ipcMain.handle("youtube:upload", async (event, request: YoutubeUploadRequest) => {
    if (youtubeUploadController) throw new Error("已有 YouTube 上傳正在進行中。");
    const output = request && typeof request.jobId === "string" ? await outputHistory.get(request.jobId) : undefined;
    if (!output || output.purpose === "CLIP")
      throw new Error("單一時間段預覽不可直接上傳；請選擇正片、片頭、Shorts 或已確認的既有 MP4。");
    postSuccessPower.cancel("侦测到新的 YouTube 上传；已取消先前排定的电源动作。");
    const releasePowerGuard = renderPowerGuard.acquire();
    const controller = new AbortController();
    youtubeUploadController = controller;
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    let successfulUpload = false;
    try {
      const result = await youtubeUpload.upload(output.outputPath, request, controller.signal, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("youtube:upload-progress", progress);
      });
      successfulUpload = completedYoutubeUploadQualifies(result);
      return result;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (youtubeUploadController === controller) youtubeUploadController = undefined;
      releasePowerGuard();
      if (successfulUpload)
        postSuccessPower.notifySuccess(
          "YOUTUBE_UPLOAD_SUCCESS",
          userPreferences.snapshot().renderDefaults.postSuccessPower ?? {
            enabled: false,
            trigger: "RENDER_SUCCESS",
            action: "SHUTDOWN",
          },
        );
    }
  });
  ipcMain.handle("youtube:cancel-upload", () => youtubeUploadController?.abort());
  ipcMain.handle("youtube:retry-thumbnail", async (_event, videoId: string, thumbnailPath: string) => {
    postSuccessPower.cancel("侦测到缩图重试；已取消先前排定的电源动作。");
    const releasePowerGuard = renderPowerGuard.acquire();
    let succeeded = false;
    try {
      const result = await youtubeUpload.retryThumbnail(videoId, thumbnailPath);
      succeeded = true;
      return result;
    } finally {
      releasePowerGuard();
      if (succeeded)
        postSuccessPower.notifySuccess(
          "YOUTUBE_UPLOAD_SUCCESS",
          userPreferences.snapshot().renderDefaults.postSuccessPower ?? {
            enabled: false,
            trigger: "RENDER_SUCCESS",
            action: "SHUTDOWN",
          },
        );
    }
  });
  ipcMain.handle("youtube:open-video", (_event, videoId: string) => youtubeUpload.openVideo(videoId));
  ipcMain.handle("youtube:prepare-chrome-handoff", async (_event, jobId: string) => {
    const output = typeof jobId === "string" ? await outputHistory.get(jobId) : undefined;
    if (!output || output.purpose === "CLIP")
      throw new Error("單一時間段預覽不可直接上傳；請選擇正片、片頭、Shorts 或已確認的既有 MP4。");
    return platformUploadHandoff.openYoutubeChrome(output.outputPath);
  });
  ipcMain.handle("platform-upload:open", async (_event, jobId: string, platform: BrowserUploadPlatform) => {
    const output = typeof jobId === "string" ? await outputHistory.get(jobId) : undefined;
    if (!output || output.purpose === "INTRO" || output.purpose === "CLIP")
      throw new Error("片頭／單一時間段預覽不可直接當正片投稿；請選擇正片或已確認的既有 MP4。");
    return platformUploadHandoff.open(output.outputPath, platform);
  });
  ipcMain.handle("platform-upload:open-portal", (_event, platform: BrowserUploadPlatform) =>
    platformUploadHandoff.openPortal(platform),
  );
}
