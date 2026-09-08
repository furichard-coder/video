import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell as electronShell } from "electron";
import type { AiAccountSaveInput, AiStoryContext, AiSubtitleGenerationOptions, BackgroundJobKind, BackgroundJobSnapshot, BackgroundJobStatus, BgmTrack, BrowserUploadPlatform, ConcatRenderRequest, ExternalMediaTarget, ExternalPlayerId, ExternalPlayerSettingsUpdate, IntroSuggestion, MainExclusionRange, MusicSuggestionRequest, PlacementRequest, PreviewVariant, ProjectColorSettings, SortMode, SubtitleCue, SubtitleTimelineScope, TranslationSettingsUpdate, UserPreferencesUpdate, VoiceInputRequest, VolumeSegment, YoutubeSettingsUpdate, YoutubeUploadRequest, ZoomSegment } from "../shared/domain";
import { ConcatRenderService } from "./services/concat-render";
import { IntroAnalyzer } from "./services/intro-analyzer";
import { PreviewCache } from "./services/preview-cache";
import { ProjectStore } from "./services/project-store";
import { emptyCancelledResult, MEDIA_DIALOG_FILTERS, SourceService } from "./services/source-service";
import { ExternalPlayerService } from "./services/external-player";
import { PlayerSettingsStore } from "./services/player-settings";
import { BgmService } from "./services/bgm-service";
import { exportSrt } from "./services/subtitle-export";
import { importSrtFile } from "./services/subtitle-import";
import { AiSettingsStore } from "./services/ai-settings";
import { AiStoryAnalysisService } from "./services/ai-story-analysis";
import { YoutubeSettingsStore, YoutubeUploadService } from "./services/youtube-upload";
import { PlatformUploadHandoffService } from "./services/platform-upload-handoff";
import { OutputHistoryStore } from "./services/output-history";
import { UserPreferencesStore } from "./services/user-preferences";
import { TranslationSettingsStore } from "./services/translation-settings";
import { SubtitleTranslationService } from "./services/subtitle-translation";
import { SubtitlePreviewService } from "./services/subtitle-preview";
import { nextAvailableOutputPath, safePreviewFileName } from "./services/output-path";
import { MusicSuggestionService } from "./services/music-suggestion";

const SORT_MODES = new Set<SortMode>([
  "MANUAL_ORDER",
  "SMART_SEQUENCE",
  "FILE_NAME",
  "CAPTURE_OR_FILE_TIME",
  "ADDED_ORDER",
]);
const PREVIEW_VARIANTS = new Set<PreviewVariant>(["THUMBNAIL", "IMAGE_PREVIEW", "VIDEO_PROXY"]);

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
): void {
  let importController: AbortController | undefined;
  let concatController: AbortController | undefined;
  let introController: AbortController | undefined;
  let subtitleExportController: AbortController | undefined;
  let aiSubtitleController: AbortController | undefined;
  let subtitlePreviewController: AbortController | undefined;
  let voiceInputController: AbortController | undefined;
  let musicSuggestionController: AbortController | undefined;
  let youtubeAuthController: AbortController | undefined;
  let youtubeUploadController: AbortController | undefined;
  const previewControllers = new Map<string, AbortController>();
  const outputTokens = new Map<string, { outputPath: string; createdAt: number; allowOverwrite: boolean }>();
  const subtitleOutputTokens = new Map<string, { outputPath: string; createdAt: number }>();
  const backgroundJobs = new Map<string, BackgroundJobSnapshot>();
  const publishBackgroundJobs = () => {
    const jobs = [...backgroundJobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("background:jobs", jobs);
  };
  const pruneBackgroundJobs = () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of backgroundJobs) if (job.status !== "RUNNING" && Date.parse(job.finishedAt ?? job.startedAt) < cutoff) backgroundJobs.delete(id);
  };
  const beginBackgroundJob = (kind: BackgroundJobKind, label: string): string => {
    pruneBackgroundJobs();
    const id = randomUUID();
    backgroundJobs.set(id, { id, kind, label, status: "RUNNING", startedAt: new Date().toISOString() });
    publishBackgroundJobs();
    return id;
  };
  const updateBackgroundJob = (id: string, patch: Pick<BackgroundJobSnapshot, "percent" | "detail">) => {
    const current = backgroundJobs.get(id); if (!current) return;
    backgroundJobs.set(id, { ...current, ...patch }); publishBackgroundJobs();
  };
  const finishBackgroundJob = (id: string, status: BackgroundJobStatus, patch: Pick<BackgroundJobSnapshot, "detail" | "error"> = {}) => {
    const current = backgroundJobs.get(id); if (!current) return;
    backgroundJobs.set(id, { ...current, ...patch, status, percent: status === "COMPLETED" ? 100 : current.percent, finishedAt: new Date().toISOString() }); publishBackgroundJobs();
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
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
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
  ipcMain.handle("preferences:get", () => userPreferences.snapshot());
  ipcMain.handle("background:get-jobs", () => { pruneBackgroundJobs(); return [...backgroundJobs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)); });
  ipcMain.handle("preferences:update", (_event, update: UserPreferencesUpdate) => userPreferences.update(update));
  ipcMain.handle("project:get", () => store.getProject());
  ipcMain.handle("project:history-state", () => store.getHistoryState());
  ipcMain.handle("project:undo", () => store.undo());
  ipcMain.handle("project:redo", () => store.redo());
  ipcMain.handle("project:get-file-state", () => store.getProjectFileState());
  ipcMain.handle("project:save", () => store.saveProject());
  ipcMain.handle("project:save-as", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const safeName = store.getProject().name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "SceneryWalker_project";
    const options: Electron.SaveDialogOptions = {
      title: "另存 SceneryWalker 專案",
      defaultPath: path.join(userPreferences.getLastDirectory("PROJECT", app.getPath("documents")), `${safeName}.swproj`),
      filters: [{ name: "SceneryWalker 專案", extensions: ["swproj"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const filePath = path.extname(result.filePath).toLowerCase() === ".swproj" ? result.filePath : `${result.filePath}.swproj`;
    await userPreferences.rememberDirectory("PROJECT", filePath);
    const projectName = path.basename(filePath, path.extname(filePath)).trim();
    return store.saveProjectAs(filePath, projectName);
  });
  ipcMain.handle("project:open", async (event) => {
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
  ipcMain.handle("intro:set-segment-max-duration", (_event, durationMs: number) => store.setIntroSegmentMaxDuration(durationMs));
  ipcMain.handle("project:set-color-settings", (_event, settings: ProjectColorSettings) => store.setProjectColorSettings(settings));
  ipcMain.handle("intro:remove-segment", (_event, segmentId: string) => store.removeIntroSegment(segmentId));
  ipcMain.handle("intro:restore-segment", (_event, segmentId: string) => store.restoreIntroSegment(segmentId));
  ipcMain.handle("source:set-preview-range", (_event, assetId: string, inMs: number, outMs: number) =>
    store.setPreviewRange(assetId, inMs, outMs));
  ipcMain.handle("source:set-image-duration", (_event, assetId: string, durationMs: number) =>
    store.setImageDuration(assetId, durationMs));
  ipcMain.handle("source:set-photo-sound", (_event, assetId: string, enabled: boolean) =>
    store.setPhotoSoundEnabled(assetId, enabled));
  ipcMain.handle("main:add-media-insertion", (_event, anchorVideoAssetId: string, insertedAssetId: string, atMs: number, sourceRange?: { inMs: number; outMs: number }) =>
    store.addMediaInsertion(anchorVideoAssetId, insertedAssetId, atMs, sourceRange));
  ipcMain.handle("main:update-media-insertion", (_event, insertionId: string, atMs: number, sourceRange: { inMs: number; outMs: number }) =>
    store.updateMediaInsertion(insertionId, atMs, sourceRange));
  ipcMain.handle("main:remove-media-insertion", (_event, insertionId: string) =>
    store.removeMediaInsertion(insertionId));
  ipcMain.handle("main:move-media-insertion", (_event, insertionId: string, toIndex: number) =>
    store.moveMediaInsertion(insertionId, toIndex));
  ipcMain.handle("source:set-volume-segments", (_event, assetId: string, segments: VolumeSegment[]) =>
    store.setVolumeSegments(assetId, segments));
  ipcMain.handle("main:set-exclusion-ranges", (_event, assetId: string, ranges: MainExclusionRange[]) =>
    store.setMainExclusionRanges(assetId, ranges));
  ipcMain.handle("main:set-zoom-segments", (_event, assetId: string, segments: ZoomSegment[]) =>
    store.setZoomSegments(assetId, segments));
  ipcMain.handle("project:place-asset", (_event, assetId: string, placement: PlacementRequest) => store.placeAsset(assetId, placement));
  ipcMain.handle("project:move-asset", (_event, assetId: string, toIndex: number) => store.moveTimelineAsset(assetId, toIndex));
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
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const outputPath = path.extname(result.filePath).toLowerCase() === ".mp4"
      ? result.filePath
      : `${result.filePath}.mp4`;
    await userPreferences.rememberDirectory("PREVIEW_OUTPUT", outputPath);
    const token = randomUUID();
    outputTokens.set(token, { outputPath, createdAt: Date.now(), allowOverwrite: true });
    return { token, displayPath: outputPath };
  });
  ipcMain.handle("concat:prepare-output", async (_event, suggestedName: string) => {
    for (const [token, item] of outputTokens) if (Date.now() - item.createdAt > 30 * 60 * 1000) outputTokens.delete(token);
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
  ipcMain.handle("concat:start", async (event, request: ConcatRenderRequest) => {
    if (concatController) throw new Error("已有一個串連預覽正在產出，請先等待或取消。");
    if (!request || typeof request.outputToken !== "string") throw new Error("串連預覽要求格式無效。");
    const selectedOutput = outputTokens.get(request.outputToken);
    outputTokens.delete(request.outputToken);
    if (!selectedOutput || Date.now() - selectedOutput.createdAt > 30 * 60 * 1000) {
      throw new Error("輸出位置授權已失效，請重新選擇儲存位置。");
    }
    if (!selectedOutput.allowOverwrite && await stat(selectedOutput.outputPath).catch(() => undefined)) {
      throw new Error("自動產生的檔名已被其他程式使用，請按『重新產生檔名』後再試；既有檔案不會被覆寫。");
    }
    const controller = new AbortController();
    concatController = controller;
    const backgroundJobId = beginBackgroundJob("CONCAT_RENDER", "片頭／正片預覽產出");
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await concatRenderer.render(
        request,
        selectedOutput.outputPath,
        controller.signal,
        (progress) => {
          updateBackgroundJob(backgroundJobId, { percent: progress.percent, detail: progress.phase });
          if (!event.sender.isDestroyed()) event.sender.send("concat:progress", progress);
        },
      );
      await outputHistory.registerRender(result, store.getProject().name);
      finishBackgroundJob(backgroundJobId, result.cancelled ? "CANCELLED" : "COMPLETED", { detail: result.cancelled ? "使用者取消，已保留可播放結尾" : result.outputPath });
      return result;
    } catch (error) {
      finishBackgroundJob(backgroundJobId, error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (concatController === controller) concatController = undefined;
    }
  });
  ipcMain.handle("concat:cancel", () => concatController?.abort());
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
    const options: Electron.OpenDialogOptions = { title: "加入以前產出的 MP4 預覽檔", defaultPath: userPreferences.getLastDirectory("OUTPUT_HISTORY", app.getPath("videos")), properties: ["openFile", "multiSelections"], filters: [{ name: "MP4 影片", extensions: ["mp4"] }] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return { cancelled: true, addedCount: 0, duplicateCount: 0, errors: [], history: await outputHistory.snapshot() };
    await userPreferences.rememberDirectory("OUTPUT_HISTORY", result.filePaths[0]);
    return outputHistory.importExisting(result.filePaths);
  });
  ipcMain.handle("output-history:remove-record", (_event, jobId: string) => outputHistory.removeRecord(jobId));
  ipcMain.handle("intro:analyze", async (event, assetIds: string[], maxDurationMs: number, maxSegmentDurationMs: number) => {
    if (introController) throw new Error("精彩片頭分析已在進行中。");
    if (!Array.isArray(assetIds) || !Number.isFinite(maxDurationMs) || !Number.isFinite(maxSegmentDurationMs)) throw new Error("片頭分析要求格式無效。");
    const controller = new AbortController();
    introController = controller;
    const backgroundJobId = beginBackgroundJob("INTRO_ANALYSIS", "AI 精彩片頭建議");
    const cancelIfRendererCloses = () => controller.abort();
    event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await introAnalyzer.analyze(assetIds, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, { percent: progress.total ? Math.round(progress.processed / progress.total * 100) : 0, detail: progress.currentName ?? progress.phase });
        if (!event.sender.isDestroyed()) event.sender.send("intro:analysis-progress", progress);
      }, maxDurationMs, maxSegmentDurationMs);
      await store.setIntroAnalysisResult(result);
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: "片頭分析完成；結果已保存，可重新開啟片頭頁查看" });
      return result;
    } catch (error) {
      finishBackgroundJob(backgroundJobId, error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (introController === controller) introController = undefined;
    }
  });
  ipcMain.handle("intro:cancel-analysis", () => introController?.abort());
  ipcMain.handle("ai:get-settings", () => aiSettings.getSnapshot());
  ipcMain.handle("ai:save-account", (_event, input: AiAccountSaveInput) => aiSettings.saveAccount(input));
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
  ipcMain.handle("translation:update-settings", (_event, update: TranslationSettingsUpdate) => translationSettings.update(update));
  ipcMain.handle("translation:test-google", async () => {
    await subtitleTranslation.testGoogle();
    return { ok: true, message: "Google Cloud Translation 實際翻譯測試成功；OpenAI 不可用時可安全切換為後援。" };
  });
  ipcMain.handle("ai:transcribe-voice-input", async (event, request: VoiceInputRequest) => {
    voiceInputController?.abort();
    const controller = new AbortController(); voiceInputController = controller;
    const cancelIfRendererCloses = () => controller.abort(); event.sender.once("destroyed", cancelIfRendererCloses);
    try { return await aiStory.transcribeVoiceInput(request, controller.signal); }
    finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (voiceInputController === controller) voiceInputController = undefined;
    }
  });
  ipcMain.handle("project:set-ai-story-context", (_event, context: AiStoryContext) => store.setAiStoryContext(context));
  ipcMain.handle("external-player:get-settings", () => playerSettings.snapshotWithCurrentAvailability());
  ipcMain.handle("external-player:update-settings", (_event, update: ExternalPlayerSettingsUpdate) =>
    playerSettings.update(update));
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
    playerSettings.removeCustomPlayer(playerId));
  ipcMain.handle("external-player:open", (_event, assetId: string, target: ExternalMediaTarget) =>
    externalPlayers.open(assetId, target));
  ipcMain.handle("bgm:choose-files", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { title: "選擇 MP3 配樂", defaultPath: userPreferences.getLastDirectory("BGM", app.getPath("music")), properties: ["openFile", "multiSelections"], filters: [{ name: "MP3 音樂", extensions: ["mp3"] }] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return { cancelled: true, addedCount: 0, errors: [], project: store.getProject() };
    await userPreferences.rememberDirectory("BGM", result.filePaths[0]);
    return bgm.importSelected(result.filePaths);
  });
  ipcMain.handle("bgm:add-youtube-references", (_event, urls: string[]) => bgm.addYoutubeReferences(Array.isArray(urls) ? urls : []));
  ipcMain.handle("bgm:resolve-reference", async (event, trackId: string, rightsConfirmed: boolean) => {
    if (!rightsConfirmed) throw new Error("請先確認音檔使用權，再指定本機 MP3。");
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { title: "選擇自有或已授權的 MP3", defaultPath: userPreferences.getLastDirectory("BGM", app.getPath("music")), properties: ["openFile"], filters: [{ name: "MP3 音樂", extensions: ["mp3"] }] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("BGM", result.filePaths[0]);
    return bgm.resolveReference(trackId, result.filePaths[0], rightsConfirmed);
  });
  ipcMain.handle("bgm:sequence", () => store.sequenceBgmTracks());
  ipcMain.handle("project:set-source-audio-volume", (_event, volumePercent: number) => store.setSourceAudioVolume(volumePercent));
  ipcMain.handle("bgm:update", (_event, track: BgmTrack) => store.updateBgmTrack(track));
  ipcMain.handle("bgm:remove", (_event, trackId: string) => store.removeBgmTrack(trackId));
  ipcMain.handle("bgm:move", (_event, trackId: string, toIndex: number) => store.moveBgmTrack(trackId, toIndex));
  const getReadyBgmTrack = async (trackId: string) => {
    if (typeof trackId !== "string" || !trackId) throw new Error("配樂 ID 無效。");
    const track = store.getProject().bgmTracks.find((item) => item.id === trackId);
    if (!track) throw new Error("找不到這筆配樂。");
    if (track.resolutionStatus === "NEEDS_LOCAL_FILE" || !track.sourcePath || !path.isAbsolute(track.sourcePath)) throw new Error("這筆配樂尚未指定可用的本機 MP3。");
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
    const controller = new AbortController(); musicSuggestionController = controller;
    const backgroundJobId = beginBackgroundJob("MUSIC_SUGGESTIONS", "AI 配樂建議搜尋");
    const cancelIfRendererCloses = () => controller.abort(); event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await musicSuggestions.generate(request, controller.signal);
      await store.setMusicSuggestionResult(result);
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: `已保存 ${result.suggestions.length} 筆建議` });
      return result;
    } catch (error) {
      finishBackgroundJob(backgroundJobId, error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (musicSuggestionController === controller) musicSuggestionController = undefined;
    }
  });
  ipcMain.handle("bgm:ai-suggest-cancel", () => musicSuggestionController?.abort());
  ipcMain.handle("bgm:open-suggestion", (_event, url: string) => musicSuggestions.open(url));
  ipcMain.handle("subtitle:set-cues", (_event, cues: SubtitleCue[]) => store.setSubtitleCues(cues));
  ipcMain.handle("subtitle:ai-generate", async (event, options: AiSubtitleGenerationOptions) => {
    if (aiSubtitleController) throw new Error("AI 字幕分析已在進行中。");
    const controller = new AbortController(); aiSubtitleController = controller;
    const backgroundJobId = beginBackgroundJob("AI_SUBTITLES", "AI 知識型字幕產出");
    const cancelIfRendererCloses = () => controller.abort(); event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await aiStory.generateSubtitles(options, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, { percent: progress.total ? Math.round(progress.processed / progress.total * 100) : 0, detail: progress.currentName ?? progress.phase });
        if (!event.sender.isDestroyed()) event.sender.send("ai:analysis-progress", progress);
      });
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: "字幕草稿已保存到專案" });
      return result;
    } catch (error) {
      finishBackgroundJob(backgroundJobId, error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (aiSubtitleController === controller) aiSubtitleController = undefined;
    }
  });
  ipcMain.handle("subtitle:ai-cancel", () => aiSubtitleController?.abort());
  ipcMain.handle("subtitle:build-intro-preview", async (event, includeBgm: boolean = false) => {
    if (subtitlePreviewController) throw new Error("480P 片頭字幕預覽正在建立中。");
    if (typeof includeBgm !== "boolean") throw new Error("片頭配樂預覽設定無效。");
    const controller = new AbortController(); subtitlePreviewController = controller;
    const backgroundJobId = beginBackgroundJob("SUBTITLE_PREVIEW", "字幕片頭 480P 預覽");
    const cancelIfRendererCloses = () => controller.abort(); event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      const result = await subtitlePreviews.ensureIntro480p(includeBgm, controller.signal, (progress) => {
        updateBackgroundJob(backgroundJobId, { percent: progress.percent, detail: progress.phase });
        if (!event.sender.isDestroyed()) event.sender.send("subtitle:preview-progress", progress);
      });
      await outputHistory.registerRender({
        jobId: `subprev-${result.cacheKey}`,
        outputPath: result.outputPath,
        sizeBytes: result.sizeBytes,
        expectedDurationMs: result.durationMs,
        transitionSeconds: 0.3,
        resolution: "480P",
        purpose: "INTRO",
        bgmAppliedCount: includeBgm ? store.getProject().bgmTracks.length : 0,
        includedIntroSegmentCount: store.getProject().introSegments.length,
      }, store.getProject().name);
      finishBackgroundJob(backgroundJobId, "COMPLETED", { detail: result.outputPath });
      return result;
    } catch (error) {
      finishBackgroundJob(backgroundJobId, error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "FAILED", { error: error instanceof Error ? error.message : String(error) });
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
    for (const [token, item] of subtitleOutputTokens) if (Date.now() - item.createdAt > 30 * 60 * 1000) subtitleOutputTokens.delete(token);
    const safeStem = path.basename(typeof suggestedName === "string" ? suggestedName : "").replace(/\.srt$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    const options: Electron.SaveDialogOptions = { title: "匯出 UTF-8 SRT 字幕", defaultPath: path.join(userPreferences.getLastDirectory("SUBTITLE_OUTPUT", app.getPath("documents")), `${safeStem || "SceneryWalker_subtitles"}.srt`), filters: [{ name: "SubRip 字幕", extensions: ["srt"] }], properties: ["showOverwriteConfirmation", "createDirectory"] };
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const outputPath = path.extname(result.filePath).toLowerCase() === ".srt" ? result.filePath : `${result.filePath}.srt`;
    await userPreferences.rememberDirectory("SUBTITLE_OUTPUT", outputPath);
    const token = randomUUID(); subtitleOutputTokens.set(token, { outputPath, createdAt: Date.now() });
    return { token, displayPath: outputPath };
  });
  ipcMain.handle("subtitle:export", async (_event, token: string, scopes?: SubtitleTimelineScope[]) => {
    const selected = subtitleOutputTokens.get(token); subtitleOutputTokens.delete(token);
    if (!selected || Date.now() - selected.createdAt > 30 * 60 * 1000) throw new Error("字幕輸出位置授權已失效，請重新選擇。");
    subtitleExportController?.abort(); subtitleExportController = new AbortController();
    const selectedScopes = new Set((Array.isArray(scopes) && scopes.length ? scopes : ["MAIN"]).filter((scope): scope is SubtitleTimelineScope => scope === "INTRO" || scope === "MAIN"));
    const confirmed = store.getProject().subtitleCues.filter((cue) => (cue.reviewStatus ?? "CONFIRMED") === "CONFIRMED" && selectedScopes.has(cue.timelineScope ?? "MAIN"));
    if (!confirmed.length) throw new Error("沒有已確認的字幕可匯出；AI 草稿必須逐項確認。");
    try { return await exportSrt(confirmed, selected.outputPath, subtitleExportController.signal); }
    finally { subtitleExportController = undefined; }
  });
  ipcMain.handle("subtitle:cancel-export", () => subtitleExportController?.abort());
  ipcMain.handle("youtube:get-settings", () => youtubeSettings.getSnapshot());
  ipcMain.handle("youtube:update-settings", (_event, update: YoutubeSettingsUpdate) => youtubeSettings.update(update));
  ipcMain.handle("youtube:choose-oauth-client", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { title: "選擇 Google Desktop app OAuth client JSON", defaultPath: userPreferences.getLastDirectory("OAUTH_CLIENT", app.getPath("documents")), properties: ["openFile"], filters: [{ name: "Google OAuth JSON", extensions: ["json"] }] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    await userPreferences.rememberDirectory("OAUTH_CLIENT", result.filePaths[0]);
    return youtubeSettings.importOAuthClient(result.filePaths[0]);
  });
  ipcMain.handle("youtube:connect", async (event) => {
    if (youtubeAuthController) throw new Error("YouTube 頻道連結正在進行中。");
    const controller = new AbortController(); youtubeAuthController = controller;
    const cancelIfRendererCloses = () => controller.abort(); event.sender.once("destroyed", cancelIfRendererCloses);
    try { return await youtubeUpload.connect(controller.signal); }
    finally { event.sender.removeListener("destroyed", cancelIfRendererCloses); if (youtubeAuthController === controller) youtubeAuthController = undefined; }
  });
  ipcMain.handle("youtube:cancel-connect", () => youtubeAuthController?.abort());
  ipcMain.handle("youtube:disconnect", () => youtubeUpload.disconnect());
  ipcMain.handle("youtube:upload", async (event, request: YoutubeUploadRequest) => {
    if (youtubeUploadController) throw new Error("已有 YouTube 上傳正在進行中。");
    const output = request && typeof request.jobId === "string" ? await outputHistory.get(request.jobId) : undefined;
    if (!output || output.purpose === "INTRO" || output.purpose === "CLIP") throw new Error("片頭／單一時間段預覽不可直接當正片上傳；請選擇正片或已確認的既有 MP4。");
    const controller = new AbortController(); youtubeUploadController = controller;
    const cancelIfRendererCloses = () => controller.abort(); event.sender.once("destroyed", cancelIfRendererCloses);
    try {
      return await youtubeUpload.upload(output.outputPath, request, controller.signal, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("youtube:upload-progress", progress);
      });
    } finally {
      event.sender.removeListener("destroyed", cancelIfRendererCloses);
      if (youtubeUploadController === controller) youtubeUploadController = undefined;
    }
  });
  ipcMain.handle("youtube:cancel-upload", () => youtubeUploadController?.abort());
  ipcMain.handle("youtube:open-video", (_event, videoId: string) => youtubeUpload.openVideo(videoId));
  ipcMain.handle("platform-upload:open", async (_event, jobId: string, platform: BrowserUploadPlatform) => {
    const output = typeof jobId === "string" ? await outputHistory.get(jobId) : undefined;
    if (!output || output.purpose === "INTRO" || output.purpose === "CLIP") throw new Error("片頭／單一時間段預覽不可直接當正片投稿；請選擇正片或已確認的既有 MP4。");
    return platformUploadHandoff.open(output.outputPath, platform);
  });
  ipcMain.handle("platform-upload:open-portal", (_event, platform: BrowserUploadPlatform) => platformUploadHandoff.openPortal(platform));
}
