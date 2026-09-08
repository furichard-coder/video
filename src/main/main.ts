import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard, ipcMain, protocol, safeStorage, session, shell } from "electron";
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
import type { CredentialProtector } from "./services/ai-settings";

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
const confirmedCloseWindowIds = new Set<number>();

app.on("before-quit", () => { applicationQuitting = true; });

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

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(path.join(__dirname, "../../dist/index.html"));

  if (automated) {
    const timer = setTimeout(() => {
      console.error("AUTOMATION_TIMEOUT");
      app.exit(1);
    }, 20_000);
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (screenshotPath) {
            await mkdir(path.dirname(screenshotPath), { recursive: true });
            const image = await window.capturePage();
            await writeFile(screenshotPath, image.toPNG());
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
      }, screenshotPath ? 1_800 : 450);
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
  const subtitleTranslation = new SubtitleTranslationService(path.join(app.getPath("userData"), "cache", "subtitle-translations"), aiSettings, translationSettings);
  await subtitleTranslation.initialize();
  const concatRenderer = new ConcatRenderService(store, sources, undefined, undefined, photoSoundPath, subtitleTranslation, path.join(app.getPath("userData"), "cache", "subtitle-burnin"));
  const subtitlePreviews = new SubtitlePreviewService(path.join(app.getPath("userData"), "cache", "subtitle-preview"), store, concatRenderer);
  await subtitlePreviews.initialize();
  registerPreviewProtocol(previews, store, photoSoundPath, subtitlePreviews);
  const youtubeBrowsers = new WindowsYoutubeBrowserLauncher((url) => shell.openExternal(url));
  const youtubeSettings = new YoutubeSettingsStore(app.getPath("userData"), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: (value) => safeStorage.encryptString(value).toString("base64"),
    unprotect: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  }, youtubeBrowsers);
  await youtubeSettings.initialize();
  const youtubeUpload = new YoutubeUploadService(youtubeSettings, youtubeBrowsers);
  const platformUploadHandoff = new PlatformUploadHandoffService({ openExternal: (url) => shell.openExternal(url), showItemInFolder: (filePath) => shell.showItemInFolder(filePath), copyText: (value) => clipboard.writeText(value) });
  const outputHistory = new OutputHistoryStore(app.getPath("userData"));
  await outputHistory.initialize();
  const userPreferences = new UserPreferencesStore(app.getPath("userData"));
  await userPreferences.initialize();
  const aiStory = new AiStoryAnalysisService(path.join(app.getPath("userData"), "cache", "ai-story"), store, sources, aiSettings);
  await aiStory.initialize();
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
      console.log(`AI_DIAGNOSTIC_OK ${JSON.stringify({ accountId, checks: diagnostic.checks, requestIds: diagnostic.requestIds })}`);
      app.exit(0);
    } catch (error) {
      console.error(`AI_DIAGNOSTIC_ERROR ${error instanceof Error ? error.message : String(error)}`);
      app.exit(2);
    }
    return;
  }
  const introAnalyzer = new IntroAnalyzer(path.join(app.getPath("userData"), "cache", "intro-analysis"), store, sources, undefined, aiStory);
  await introAnalyzer.initialize();
  const playerSettings = new PlayerSettingsStore(app.getPath("userData"));
  await playerSettings.initialize();
  const externalPlayers = new ExternalPlayerService(store, sources, previews, playerSettings, (targetPath) => shell.openPath(targetPath));
  const bgm = new BgmService(store, new MediaProbe());
  registerIpc(store, sources, previews, concatRenderer, introAnalyzer, playerSettings, externalPlayers, bgm, aiSettings, aiStory, translationSettings, subtitleTranslation, youtubeSettings, youtubeUpload, platformUploadHandoff, outputHistory, userPreferences, subtitlePreviews, musicSuggestions);
  ipcMain.removeAllListeners("app:confirm-close");
  ipcMain.on("app:confirm-close", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return;
    confirmedCloseWindowIds.add(target.id);
    target.close();
  });
  mainWindow = createWindow();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestedMedia = "mediaTypes" in details ? details.mediaTypes ?? [] : [];
    const microphoneOnly = permission === "media" && requestedMedia.includes("audio") && !requestedMedia.includes("video");
    callback(Boolean(mainWindow && webContents.id === mainWindow.webContents.id && microphoneOnly));
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
