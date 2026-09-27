import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from "electron";
import { registerIpc } from "./ipc";
import { ConcatRenderService } from "./services/concat-render";
import { IntroAnalyzer } from "./services/intro-analyzer";
import { MediaProbe } from "./services/media-probe";
import { PreviewCache } from "./services/preview-cache";
import { registerPreviewProtocol } from "./services/preview-protocol";
import { ProjectStore } from "./services/project-store";
import { SourceService } from "./services/source-service";
import { ExternalPlayerService } from "./services/external-player";
import { PlayerSettingsStore } from "./services/player-settings";
import { BgmService } from "./services/bgm-service";
import { resolveDunesShutterSoundPath } from "./services/photo-sound";
import { AiSettingsStore } from "./services/ai-settings";
import { AiStoryAnalysisService } from "./services/ai-story-analysis";
import { WindowsYoutubeBrowserLauncher, YoutubeSettingsStore, YoutubeUploadService } from "./services/youtube-upload";
import { PlatformUploadHandoffService } from "./services/platform-upload-handoff";
import { OutputHistoryStore } from "./services/output-history";
import { UserPreferencesStore } from "./services/user-preferences";
import { TranslationSettingsStore } from "./services/translation-settings";
import { SubtitleTranslationService } from "./services/subtitle-translation";
import { SubtitlePreviewService } from "./services/subtitle-preview";
import { MusicSuggestionService } from "./services/music-suggestion";
import { AiPublishAssetsService } from "./services/ai-publish-assets";
import type { CredentialProtector } from "./services/ai-settings";
import { RenderPowerGuard } from "./services/render-power-guard";
import { RenderHardwareService } from "./services/render-hardware";
import { RenderBenchmarkService } from "./services/render-benchmark";
import { AudioPreviewService } from "./services/audio-preview";
import { moveWindowsCursor, safeActionCenter } from "./services/safe-cursor";
import { RenderCommandState } from "./services/render-command-state";
import { RemoteControlServer } from "./services/remote-control-server";
import { PostSuccessPowerScheduler } from "./services/post-success-power";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "preview-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: "source-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

if (process.env.APP_TEST_USER_DATA_PATH) {
  app.setPath("userData", path.resolve(process.env.APP_TEST_USER_DATA_PATH));
}

let mainWindow: BrowserWindow | undefined;
let applicationQuitting = false;
let remoteControlServer: RemoteControlServer | undefined;
const renderPowerGuard = new RenderPowerGuard(powerSaveBlocker);
const postSuccessPower = new PostSuccessPowerScheduler({ isBusy: () => renderPowerGuard.isActive });
const confirmedCloseWindowIds = new Set<number>();

app.on("before-quit", () => {
  applicationQuitting = true;
  void remoteControlServer?.stop();
  postSuccessPower.stop();
});

function createWindow(): BrowserWindow {
  const smoke = process.env.APP_SMOKE_TEST === "1";
  const smokeMarkerPath = process.env.APP_SMOKE_MARKER_PATH;
  const screenshotPath = process.env.APP_SCREENSHOT_PATH;
  const automated = smoke || Boolean(screenshotPath);
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 700,
    show: !automated,
    backgroundColor: "#0b1117",
    title: "SceneryWalker 素材整理",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.on("close", (event) => {
    if (automated || applicationQuitting || confirmedCloseWindowIds.delete(window.id)) return;
    event.preventDefault();
    window.webContents.send("app:close-requested");
  });
  window.on("query-session-end", (event) => {
    if (renderPowerGuard.isActive) event.preventDefault();
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(path.join(__dirname, "../../dist/index.html"));

  if (automated) {
    const timer = setTimeout(() => {
      console.error("AUTOMATION_TIMEOUT");
      app.exit(1);
    }, 20_000);
    window.webContents.once("did-finish-load", () => {
      setTimeout(
        async () => {
          try {
            if (screenshotPath) {
              const clickText = process.env.APP_SCREENSHOT_CLICK_TEXT?.trim();
              if (clickText) {
                const clicked = await window.webContents.executeJavaScript(`(() => {
                  const target = [...document.querySelectorAll('button')]
                    .find((button) => button.textContent?.includes(${JSON.stringify(clickText)}));
                  target?.click();
                  return Boolean(target);
                })()`);
                console.log(`SCREENSHOT_CLICK ${clicked ? "READY" : "NOT_FOUND"} ${clickText}`);
                await new Promise((resolve) => setTimeout(resolve, 700));
                const opened = await window.webContents.executeJavaScript(
                  `Boolean(document.querySelector('.intro-studio-backdrop'))`,
                );
                console.log(`SCREENSHOT_INTRO ${opened ? "OPEN" : "CLOSED"}`);
                // Allow the modal's first compositor frame to settle before capture.
                await new Promise((resolve) => setTimeout(resolve, 900));
                await window.webContents.executeJavaScript(`new Promise((resolve) => {
                  const started = Date.now();
                  const check = () => {
                    const rows = document.querySelectorAll('.suggestion-list li').length;
                    const thumbnails = document.querySelectorAll('.intro-segment-thumbnail img').length;
                    if ((rows > 0 && thumbnails >= rows) || Date.now() - started > 8000) resolve(true);
                    else setTimeout(check, 150);
                  };
                  check();
                })`);
              }
              await mkdir(path.dirname(screenshotPath), { recursive: true });
              const image = await window.capturePage();
              await writeFile(screenshotPath, image.toPNG());
              const rowsScreenshotPath = screenshotPath.replace(/\.png$/i, "-rows.png");
              const rowsReady = await window.webContents.executeJavaScript(`(() => {
                const pane = document.querySelector('.intro-suggestions');
                const lastRow = pane?.querySelector('.suggestion-list li:last-child');
                if (!pane || !lastRow) return false;
                pane.scrollTop = pane.scrollHeight;
                lastRow.scrollIntoView({ block: 'end', inline: 'nearest' });
                return true;
              })()`);
              if (rowsReady) {
                await new Promise((resolve) => setTimeout(resolve, 1200));
                const rowsImage = await window.capturePage();
                await writeFile(rowsScreenshotPath, rowsImage.toPNG());
                console.log(`SCREENSHOT_ROWS_READY ${rowsScreenshotPath}`);
              }
              console.log("SCREENSHOT_READY");
            } else {
              if (smokeMarkerPath) {
                await mkdir(path.dirname(smokeMarkerPath), { recursive: true });
                await writeFile(smokeMarkerPath, "SMOKE_READY\n", "utf8");
              }
              console.log("SMOKE_READY");
            }
            clearTimeout(timer);
            // Automated smoke/screenshot sessions must terminate deterministically.
            // Normal user closes still go through the second-confirmation flow below.
            app.exit(0);
          } catch (error) {
            clearTimeout(timer);
            console.error(error);
            app.exit(1);
          }
        },
        screenshotPath ? 1_800 : 450,
      );
    });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      clearTimeout(timer);
      console.error(`SMOKE_FAILED ${code} ${description}`);
      app.exit(1);
    });
  }
  return window;
}

void app.whenReady().then(async () => {
  const store = new ProjectStore(app.getPath("userData"));
  await store.initialize();
  const sources = new SourceService(store, new MediaProbe());
  const previews = new PreviewCache(path.join(app.getPath("userData"), "cache", "previews"), store, sources);
  await previews.initialize();
  const photoSoundPath = await resolveDunesShutterSoundPath(process.resourcesPath);
  const credentialProtector: CredentialProtector = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: (value) => safeStorage.encryptString(value).toString("base64"),
    unprotect: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  };
  const aiSettings = new AiSettingsStore(app.getPath("userData"), credentialProtector);
  await aiSettings.initialize();
  const translationSettings = new TranslationSettingsStore(app.getPath("userData"), credentialProtector);
  await translationSettings.initialize();
  const subtitleTranslation = new SubtitleTranslationService(
    path.join(app.getPath("userData"), "cache", "subtitle-translations"),
    aiSettings,
    translationSettings,
  );
  await subtitleTranslation.initialize();
  const renderHardware = new RenderHardwareService(app.getPath("userData"));
  const renderCommands = new RenderCommandState(store.getProject().name);
  const remoteControl = new RemoteControlServer(renderCommands);
  remoteControlServer = remoteControl;
  const concatRenderer = new ConcatRenderService(
    store,
    sources,
    undefined,
    undefined,
    photoSoundPath,
    subtitleTranslation,
    path.join(app.getPath("userData"), "cache", "subtitle-burnin"),
    undefined,
    undefined,
    renderHardware,
    renderCommands,
  );
  const subtitlePreviews = new SubtitlePreviewService(
    path.join(app.getPath("userData"), "cache", "subtitle-preview"),
    store,
    concatRenderer,
  );
  await subtitlePreviews.initialize();
  const outputHistory = new OutputHistoryStore(app.getPath("userData"));
  await outputHistory.initialize();
  const audioPreviews = new AudioPreviewService(path.join(app.getPath("userData"), "cache", "audio-preview"), store);
  await audioPreviews.initialize();
  registerPreviewProtocol(previews, store, photoSoundPath, subtitlePreviews, outputHistory, audioPreviews);
  const youtubeBrowsers = new WindowsYoutubeBrowserLauncher((url) => shell.openExternal(url));
  const youtubeSettings = new YoutubeSettingsStore(
    app.getPath("userData"),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      protect: (value) => safeStorage.encryptString(value).toString("base64"),
      unprotect: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
    youtubeBrowsers,
  );
  await youtubeSettings.initialize();
  const youtubeUpload = new YoutubeUploadService(youtubeSettings, youtubeBrowsers);
  const platformUploadHandoff = new PlatformUploadHandoffService({
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    copyText: (value) => clipboard.writeText(value),
    openYoutubeInChrome: async (url) => {
      await youtubeBrowsers.open("CHROME", url);
    },
  });
  const userPreferences = new UserPreferencesStore(app.getPath("userData"));
  await userPreferences.initialize();
  await store.setTimelineTransitionSeconds(userPreferences.snapshot().renderDefaults.transitionSeconds);
  const aiStory = new AiStoryAnalysisService(
    path.join(app.getPath("userData"), "cache", "ai-story"),
    store,
    sources,
    aiSettings,
  );
  await aiStory.initialize();
  const aiPublishAssets = new AiPublishAssetsService(store, sources, previews, aiStory, aiSettings);
  const musicSuggestions = new MusicSuggestionService(
    store,
    aiSettings,
    undefined,
    undefined,
    (url) => shell.openExternal(url),
    path.join(app.getPath("userData"), "cache", "music-suggestions"),
  );
  if (process.env.APP_AI_DIAGNOSTIC === "1") {
    const accountId = aiSettings.getSnapshot().activeAccountId;
    try {
      const diagnostic = await aiStory.testAccount(accountId);
      console.log(
        `AI_DIAGNOSTIC_OK ${JSON.stringify({ accountId, checks: diagnostic.checks, requestIds: diagnostic.requestIds })}`,
      );
      app.exit(0);
    } catch (error) {
      console.error(`AI_DIAGNOSTIC_ERROR ${error instanceof Error ? error.message : String(error)}`);
      app.exit(2);
    }
    return;
  }
  const introAnalyzer = new IntroAnalyzer(
    path.join(app.getPath("userData"), "cache", "intro-analysis"),
    store,
    sources,
    undefined,
    aiStory,
  );
  await introAnalyzer.initialize();
  const playerSettings = new PlayerSettingsStore(app.getPath("userData"));
  await playerSettings.initialize();
  const externalPlayers = new ExternalPlayerService(store, sources, previews, playerSettings, (targetPath) =>
    shell.openPath(targetPath),
  );
  const bgm = new BgmService(store, new MediaProbe());
  const renderBenchmark = new RenderBenchmarkService(
    app.getPath("userData"),
    app.isPackaged
      ? path.join(process.resourcesPath, "assets", "benchmark-render-modes.ps1")
      : path.join(app.getAppPath(), "scripts", "benchmark-render-modes.ps1"),
  );
  registerIpc(
    store,
    sources,
    previews,
    concatRenderer,
    introAnalyzer,
    playerSettings,
    externalPlayers,
    bgm,
    aiSettings,
    aiStory,
    translationSettings,
    subtitleTranslation,
    youtubeSettings,
    youtubeUpload,
    platformUploadHandoff,
    outputHistory,
    userPreferences,
    subtitlePreviews,
    musicSuggestions,
    aiPublishAssets,
    renderPowerGuard,
    renderHardware,
    renderBenchmark,
    audioPreviews,
    renderCommands,
    remoteControl,
    postSuccessPower,
  );
  postSuccessPower.subscribe((status) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send("power-action:status", status);
  });
  ipcMain.removeAllListeners("app:confirm-close");
  ipcMain.on("app:confirm-close", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return;
    if (renderPowerGuard.isActive) {
      target.webContents.send("app:close-requested");
      return;
    }
    if (postSuccessPower.isScheduled) {
      postSuccessPower.cancel("使用者确认关闭 App；已明确取消尚未执行的电源动作。");
    }
    confirmedCloseWindowIds.add(target.id);
    target.close();
  });
  ipcMain.removeAllListeners("app:move-cursor-to-safe-action");
  ipcMain.on(
    "app:move-cursor-to-safe-action",
    (event, rect: { x: number; y: number; width: number; height: number }) => {
      const target = BrowserWindow.fromWebContents(event.sender);
      if (!target || target.isDestroyed() || typeof rect !== "object" || rect === null) return;
      const [rendererWidth, rendererHeight] = target.getContentSize();
      const point = safeActionCenter(target.getContentBounds(), { width: rendererWidth, height: rendererHeight }, rect);
      if (!point) return;
      moveWindowsCursor(screen.dipToScreenPoint(point));
    },
  );
  mainWindow = createWindow();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestedMedia = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const microphoneOnly =
      permission === "media" && requestedMedia.includes("audio") && !requestedMedia.includes("video");
    callback(Boolean(mainWindow && webContents.id === mainWindow.webContents.id && microphoneOnly));
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
