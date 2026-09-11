import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  YoutubeBrowser,
  YoutubeBrowserOption,
  YoutubePrivacyStatus,
  YoutubeSettingsSnapshot,
  YoutubeSettingsUpdate,
  YoutubeUploadProgress,
  YoutubeUploadRequest,
  YoutubeUploadResult,
} from "../../shared/domain";
import type { CredentialProtector } from "./ai-settings";
import { finalizePartialOutput } from "./atomic-output";
import { validateYoutubeTitle } from "../../shared/publish-rules";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CHANNEL_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels?part=id%2Csnippet&mine=true&maxResults=50";
const UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false";
const THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

interface YoutubeSettingsFile {
  schemaVersion: 1;
  preferredBrowser: YoutubeBrowser;
  targetChannelName: string;
  clientId?: string;
  channelId?: string;
  channelTitle?: string;
  connectedAt?: string;
}

interface YoutubeCredentialFile {
  schemaVersion: 1;
  encryptedClientSecret?: string;
  encryptedRefreshToken?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface UploadedVideoResponse {
  id?: string;
  snippet?: { title?: string; channelId?: string; channelTitle?: string };
  status?: { privacyStatus?: string };
  error?: { message?: string };
}

export interface BrowserLauncher {
  discover(): Promise<YoutubeBrowserOption[]>;
  open(preferredBrowser: YoutubeBrowser, url: string): Promise<{ browserLabel: string; usedFallback: boolean }>;
}

type FetchLike = typeof fetch;
type DelayLike = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

function defaultSettings(): YoutubeSettingsFile {
  return { schemaVersion: 1, preferredBrowser: "CHROME", targetChannelName: "漫步風光" };
}

function defaultCredentials(): YoutubeCredentialFile {
  return { schemaVersion: 1 };
}

function normalizeTargetChannelName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new Error("YouTube 目標頻道名稱必須介於 1 到 100 個字元。");
  return normalized;
}

function isBrowser(value: unknown): value is YoutubeBrowser {
  return value === "CHROME" || value === "EDGE";
}

function looksLikeSettings(value: unknown): value is YoutubeSettingsFile {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<YoutubeSettingsFile>;
  return item.schemaVersion === 1 && isBrowser(item.preferredBrowser) && typeof item.targetChannelName === "string";
}

function looksLikeCredentials(value: unknown): value is YoutubeCredentialFile {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<YoutubeCredentialFile>;
  return (
    item.schemaVersion === 1 &&
    (item.encryptedClientSecret === undefined || typeof item.encryptedClientSecret === "string") &&
    (item.encryptedRefreshToken === undefined || typeof item.encryptedRefreshToken === "string")
  );
}

function abortError(message = "操作已取消。"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function browserCandidates(browser: YoutubeBrowser): string[] {
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES;
  const programFilesX86 = process.env["ProgramFiles(x86)"] || process.env["PROGRAMFILES(X86)"];
  const localAppData = process.env.LOCALAPPDATA;
  const relative =
    browser === "CHROME"
      ? path.join("Google", "Chrome", "Application", "chrome.exe")
      : path.join("Microsoft", "Edge", "Application", "msedge.exe");
  return [
    ...new Set(
      [programFiles, programFilesX86, localAppData]
        .filter((root): root is string => Boolean(root))
        .map((root) => path.join(root, relative)),
    ),
  ];
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try the next standard install location */
    }
  }
  return undefined;
}

export class WindowsYoutubeBrowserLauncher implements BrowserLauncher {
  constructor(private readonly systemOpen: (url: string) => Promise<void>) {}

  async discover(): Promise<YoutubeBrowserOption[]> {
    const [chrome, edge] = await Promise.all([
      firstExisting(browserCandidates("CHROME")),
      firstExisting(browserCandidates("EDGE")),
    ]);
    return [
      { id: "CHROME", label: "Google Chrome（預設）", available: Boolean(chrome), executablePath: chrome },
      { id: "EDGE", label: "Microsoft Edge（第二選項）", available: Boolean(edge), executablePath: edge },
    ];
  }

  async open(preferredBrowser: YoutubeBrowser, url: string): Promise<{ browserLabel: string; usedFallback: boolean }> {
    if (!/^https:\/\//i.test(url)) throw new Error("只允許以瀏覽器開啟 HTTPS 網址。");
    const options = await this.discover();
    const ordered = [
      options.find((item) => item.id === preferredBrowser),
      ...options.filter((item) => item.id !== preferredBrowser),
    ].filter((item): item is YoutubeBrowserOption => Boolean(item));
    for (const option of ordered) {
      if (!option.executablePath) continue;
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(option.executablePath!, [url], {
            shell: false,
            detached: true,
            stdio: "ignore",
            windowsHide: false,
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
        return { browserLabel: option.label, usedFallback: option.id !== preferredBrowser };
      } catch {
        /* try the second browser */
      }
    }
    await this.systemOpen(url);
    return { browserLabel: "Windows 系統預設瀏覽器", usedFallback: true };
  }
}

export class YoutubeSettingsStore {
  readonly settingsPath: string;
  readonly credentialsPath: string;
  private settings = defaultSettings();
  private credentials = defaultCredentials();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dataRoot: string,
    private readonly protector: CredentialProtector,
    private readonly browsers: BrowserLauncher,
  ) {
    this.settingsPath = path.join(dataRoot, "settings", "youtube-upload.json");
    this.credentialsPath = path.join(dataRoot, "settings", "youtube-credentials.encrypted.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.settingsPath, "utf8"));
      if (!looksLikeSettings(parsed)) throw new Error("YouTube 設定格式不相容");
      this.settings = { ...parsed, targetChannelName: normalizeTargetChannelName(parsed.targetChannelName) };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !String(error).includes("不相容")
      )
        throw error;
      this.settings = defaultSettings();
      await this.writeJson(this.settingsPath, this.settings);
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.credentialsPath, "utf8"));
      if (!looksLikeCredentials(parsed)) throw new Error("YouTube 憑證格式不相容");
      this.credentials = parsed;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        !String(error).includes("不相容")
      )
        throw error;
      this.credentials = defaultCredentials();
      await this.writeJson(this.credentialsPath, this.credentials);
    }
  }

  async getSnapshot(): Promise<YoutubeSettingsSnapshot> {
    const browserOptions = await this.browsers.discover();
    return {
      schemaVersion: 1,
      preferredBrowser: this.settings.preferredBrowser,
      targetChannelName: this.settings.targetChannelName,
      clientConfigured: Boolean(this.settings.clientId && this.credentials.encryptedClientSecret),
      connected: Boolean(this.credentials.encryptedRefreshToken && this.settings.channelId),
      clientIdHint: this.settings.clientId
        ? `${this.settings.clientId.slice(0, 8)}…${this.settings.clientId.slice(-12)}`
        : undefined,
      channelId: this.settings.channelId,
      channelTitle: this.settings.channelTitle,
      connectedAt: this.settings.connectedAt,
      encryptionAvailable: this.protector.isAvailable(),
      browsers: browserOptions,
    };
  }

  async update(update: YoutubeSettingsUpdate): Promise<YoutubeSettingsSnapshot> {
    if (!update || !isBrowser(update.preferredBrowser)) throw new Error("YouTube 瀏覽器選項無效。");
    const targetChannelName = normalizeTargetChannelName(update.targetChannelName);
    await this.mutate(() => {
      this.settings.preferredBrowser = update.preferredBrowser;
      this.settings.targetChannelName = targetChannelName;
    });
    return this.getSnapshot();
  }

  async importOAuthClient(filePath: string): Promise<YoutubeSettingsSnapshot> {
    if (!this.protector.isAvailable())
      throw new Error("Windows 安全儲存目前不可用；為避免明文憑證落盤，無法匯入 Google OAuth client。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new Error(`無法讀取 OAuth client JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    const installed =
      parsed && typeof parsed === "object" ? (parsed as { installed?: Record<string, unknown> }).installed : undefined;
    const clientId = typeof installed?.client_id === "string" ? installed.client_id.trim() : "";
    const clientSecret = typeof installed?.client_secret === "string" ? installed.client_secret.trim() : "";
    if (
      !clientId.endsWith(".apps.googleusercontent.com") ||
      clientId.length > 300 ||
      clientSecret.length < 6 ||
      clientSecret.length > 500
    ) {
      throw new Error("請選擇 Google Cloud 建立的「Desktop app」OAuth client JSON；Web／Chrome app 憑證不適用。");
    }
    await this.mutate(() => {
      this.settings.clientId = clientId;
      delete this.settings.channelId;
      delete this.settings.channelTitle;
      delete this.settings.connectedAt;
      this.credentials.encryptedClientSecret = this.protector.protect(clientSecret);
      delete this.credentials.encryptedRefreshToken;
    });
    return this.getSnapshot();
  }

  getRuntimeClient(): { clientId: string; clientSecret: string; refreshToken?: string; settings: YoutubeSettingsFile } {
    if (!this.settings.clientId || !this.credentials.encryptedClientSecret)
      throw new Error("尚未匯入 Google Desktop app OAuth client JSON。");
    if (!this.protector.isAvailable()) throw new Error("Windows 安全儲存目前不可用，無法解密 YouTube 憑證。");
    try {
      return {
        clientId: this.settings.clientId,
        clientSecret: this.protector.unprotect(this.credentials.encryptedClientSecret),
        refreshToken: this.credentials.encryptedRefreshToken
          ? this.protector.unprotect(this.credentials.encryptedRefreshToken)
          : undefined,
        settings: structuredClone(this.settings),
      };
    } catch {
      throw new Error("YouTube 憑證無法解密，請重新匯入 OAuth client 並連結頻道。");
    }
  }

  async saveConnection(
    refreshToken: string,
    channelId: string,
    channelTitle: string,
  ): Promise<YoutubeSettingsSnapshot> {
    if (!refreshToken || !channelId || !channelTitle) throw new Error("YouTube 連結結果不完整。");
    await this.mutate(() => {
      this.credentials.encryptedRefreshToken = this.protector.protect(refreshToken);
      this.settings.channelId = channelId;
      this.settings.channelTitle = channelTitle;
      this.settings.connectedAt = new Date().toISOString();
    });
    return this.getSnapshot();
  }

  async clearConnection(): Promise<YoutubeSettingsSnapshot> {
    await this.mutate(() => {
      delete this.credentials.encryptedRefreshToken;
      delete this.settings.channelId;
      delete this.settings.channelTitle;
      delete this.settings.connectedAt;
    });
    return this.getSnapshot();
  }

  private async mutate(mutator: () => void): Promise<void> {
    const operation = this.writeChain.then(async () => {
      mutator();
      await this.writeJson(this.settingsPath, this.settings);
      await this.writeJson(this.credentialsPath, this.credentials);
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const partial = `${filePath}.${process.pid}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await finalizePartialOutput(partial, filePath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
}

export class YoutubeUploadService {
  constructor(
    private readonly settingsStore: YoutubeSettingsStore,
    private readonly browsers: BrowserLauncher,
    private readonly fetcher: FetchLike = fetch,
    private readonly delay: DelayLike = defaultDelay,
  ) {}

  async connect(signal?: AbortSignal): Promise<YoutubeSettingsSnapshot> {
    const runtime = this.settingsStore.getRuntimeClient();
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    const { server, redirectUri, code, dispose } = await this.createAuthorizationReceiver(state, signal);
    try {
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        client_id: runtime.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READ_SCOPE}`,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      await this.browsers.open(runtime.settings.preferredBrowser, authUrl.toString());
      const authorizationCode = await code;
      assertNotAborted(signal);
      const token = await this.exchangeAuthorizationCode(
        runtime.clientId,
        runtime.clientSecret,
        redirectUri,
        authorizationCode,
        verifier,
        signal,
      );
      if (!token.refresh_token) throw new Error("Google 未回傳 refresh token；請撤銷舊授權後重新連結。");
      const scopes = new Set((token.scope ?? "").split(/\s+/).filter(Boolean));
      if (token.scope && (!scopes.has(YOUTUBE_UPLOAD_SCOPE) || !scopes.has(YOUTUBE_READ_SCOPE)))
        throw new Error("Google 未授予完整的 YouTube 上傳與頻道確認權限。");
      const channel = await this.fetchChannel(token.access_token!, signal, runtime.settings.targetChannelName);
      return this.settingsStore.saveConnection(token.refresh_token, channel.id, channel.title);
    } finally {
      void code.catch(() => undefined);
      dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async disconnect(signal?: AbortSignal): Promise<YoutubeSettingsSnapshot> {
    let refreshToken: string | undefined;
    try {
      refreshToken = this.settingsStore.getRuntimeClient().refreshToken;
    } catch {
      /* local cleanup remains available */
    }
    if (refreshToken) {
      try {
        await this.fetcher(REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
          signal,
        });
      } catch {
        /* revoke is best effort; encrypted local token is always removed */
      }
    }
    return this.settingsStore.clearConnection();
  }

  async upload(
    outputPath: string,
    request: YoutubeUploadRequest,
    signal?: AbortSignal,
    onProgress: (progress: YoutubeUploadProgress) => void = () => undefined,
  ): Promise<YoutubeUploadResult> {
    assertNotAborted(signal);
    const title = validateYoutubeTitle(request?.title ?? "").value;
    const description = request?.description?.trim() ?? "";
    if (description.length > 5_000) throw new Error("YouTube 說明不可超過 5,000 個字元。");
    if (request.privacyStatus !== "unlisted" && request.privacyStatus !== "private")
      throw new Error("為避免意外公開，本版只允許不公開或私人影片。");
    if (typeof request.madeForKids !== "boolean") throw new Error("請確認這支影片是否為兒童內容。");
    const runtime = this.settingsStore.getRuntimeClient();
    if (!runtime.refreshToken || !runtime.settings.channelId || !runtime.settings.channelTitle)
      throw new Error("尚未連結 YouTube 頻道，請先完成 Google 授權。");
    if (
      runtime.settings.channelTitle.trim().toLocaleLowerCase() !==
      runtime.settings.targetChannelName.trim().toLocaleLowerCase()
    ) {
      throw new Error(
        `目前連結頻道是「${runtime.settings.channelTitle}」，不是目標「${runtime.settings.targetChannelName}」；已阻擋上傳。`,
      );
    }
    const file = await stat(outputPath);
    if (!file.isFile() || path.extname(outputPath).toLowerCase() !== ".mp4")
      throw new Error("只允許上傳本次 App 完成的 MP4 預覽檔。");
    const totalBytes = file.size;
    if (totalBytes <= 0) throw new Error("輸出影片是空檔案，無法上傳。");
    onProgress({ phase: "AUTHORIZING", bytesUploaded: 0, totalBytes, percent: 0 });
    const accessToken = await this.refreshAccessToken(
      runtime.clientId,
      runtime.clientSecret,
      runtime.refreshToken,
      signal,
    );
    onProgress({ phase: "STARTING", bytesUploaded: 0, totalBytes, percent: 0 });
    const sessionResponse = await this.fetcher(UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(totalBytes),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId: "22" },
        status: { privacyStatus: request.privacyStatus, selfDeclaredMadeForKids: request.madeForKids },
      }),
      signal,
    });
    if (!sessionResponse.ok) throw new Error(`YouTube 無法建立上傳工作：${await this.responseError(sessionResponse)}`);
    const uploadUrl = sessionResponse.headers.get("location");
    if (!uploadUrl?.startsWith("https://www.googleapis.com/")) throw new Error("YouTube 未回傳有效的可續傳上傳位置。");

    const handle = await open(outputPath, "r");
    let offset = 0;
    let uploaded: UploadedVideoResponse | undefined;
    try {
      while (offset < totalBytes) {
        assertNotAborted(signal);
        const length = Math.min(UPLOAD_CHUNK_BYTES, totalBytes - offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, offset);
        if (bytesRead !== length) throw new Error("讀取上傳影片時提早結束。");
        let response: Response | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            response = await this.fetcher(uploadUrl, {
              method: "PUT",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "video/mp4",
                "content-length": String(length),
                "content-range": `bytes ${offset}-${offset + length - 1}/${totalBytes}`,
              },
              body: chunk,
              redirect: "manual",
              signal,
            });
            if (![500, 502, 503, 504].includes(response.status)) break;
            lastError = new Error(`YouTube 暫時錯誤 ${response.status}`);
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
              throw abortError("已取消 YouTube 上傳。");
            lastError = error;
          }
          const retryAfter = Number(response?.headers.get("retry-after"));
          await this.delay(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : Math.min(8_000, 500 * 2 ** attempt),
            signal,
          );
        }
        if (!response)
          throw new Error(
            `YouTube 上傳連線失敗：${lastError instanceof Error ? lastError.message : String(lastError)}`,
          );
        if (response.status === 308) {
          const range = response.headers.get("range")?.match(/bytes=0-(\d+)/i);
          offset = range ? Number(range[1]) + 1 : offset + length;
          onProgress({
            phase: "UPLOADING",
            bytesUploaded: offset,
            totalBytes,
            percent: Math.min(99, (offset / totalBytes) * 100),
          });
          continue;
        }
        if (!response.ok) throw new Error(`YouTube 上傳失敗：${await this.responseError(response)}`);
        uploaded = (await response.json()) as UploadedVideoResponse;
        offset = totalBytes;
        onProgress({ phase: "FINALIZING", bytesUploaded: totalBytes, totalBytes, percent: 100 });
      }
    } finally {
      await handle.close();
    }

    if (!uploaded?.id || !/^[A-Za-z0-9_-]{6,20}$/.test(uploaded.id))
      throw new Error("YouTube 已接收檔案，但未回傳有效的影片 ID；請到 YouTube Studio 檢查。");
    let thumbnailStatus: YoutubeUploadResult["thumbnailStatus"] = "NOT_REQUESTED";
    let thumbnailError: string | undefined;
    if (request.thumbnailPath) {
      try {
        await this.uploadThumbnail(uploaded.id, request.thumbnailPath, signal);
        thumbnailStatus = "UPLOADED";
      } catch (error) {
        thumbnailStatus = "FAILED";
        thumbnailError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      videoId: uploaded.id,
      videoUrl: `https://youtu.be/${uploaded.id}`,
      title: uploaded.snippet?.title ?? title,
      requestedPrivacyStatus: request.privacyStatus,
      channelId: uploaded.snippet?.channelId ?? runtime.settings.channelId,
      channelTitle: uploaded.snippet?.channelTitle ?? runtime.settings.channelTitle,
      thumbnailStatus,
      thumbnailError,
    };
  }

  async retryThumbnail(videoId: string, thumbnailPath: string, signal?: AbortSignal): Promise<{ status: "UPLOADED" }> {
    const runtime = this.settingsStore.getRuntimeClient();
    if (!runtime.refreshToken) throw new Error("YouTube 尚未連結頻道。");
    const accessToken = await this.refreshAccessToken(
      runtime.clientId,
      runtime.clientSecret,
      runtime.refreshToken,
      signal,
    );
    await this.uploadThumbnailWithToken(videoId, thumbnailPath, accessToken, signal);
    return { status: "UPLOADED" };
  }

  private async uploadThumbnail(videoId: string, thumbnailPath: string, signal?: AbortSignal): Promise<void> {
    const runtime = this.settingsStore.getRuntimeClient();
    if (!runtime.refreshToken) throw new Error("YouTube 尚未連結頻道。");
    const accessToken = await this.refreshAccessToken(
      runtime.clientId,
      runtime.clientSecret,
      runtime.refreshToken,
      signal,
    );
    await this.uploadThumbnailWithToken(videoId, thumbnailPath, accessToken, signal);
  }

  private async uploadThumbnailWithToken(
    videoId: string,
    thumbnailPath: string,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("YouTube 影片 ID 無效。");
    const extension = path.extname(thumbnailPath).toLowerCase();
    if (extension !== ".jpg" && extension !== ".jpeg" && extension !== ".png")
      throw new Error("YouTube 縮圖只支援 JPG 或 PNG。");
    const file = await stat(thumbnailPath);
    if (!file.isFile() || file.size <= 0) throw new Error("縮圖檔案不存在或為空。");
    if (file.size > 2 * 1024 * 1024) throw new Error("縮圖超過 YouTube 2 MB 上限。");
    const response = await this.fetcher(`${THUMBNAIL_ENDPOINT}?videoId=${encodeURIComponent(videoId)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": extension === ".png" ? "image/png" : "image/jpeg",
        "content-length": String(file.size),
      },
      body: await readFile(thumbnailPath),
      signal,
    });
    if (!response.ok) throw new Error(`YouTube 縮圖上傳失敗：${await this.responseError(response)}`);
  }

  async openVideo(videoId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("YouTube 影片 ID 無效。");
    const snapshot = await this.settingsStore.getSnapshot();
    await this.browsers.open(snapshot.preferredBrowser, `https://youtu.be/${videoId}`);
  }

  private async exchangeAuthorizationCode(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    code: string,
    verifier: string,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      signal,
    });
    const token = (await response.json()) as TokenResponse;
    if (!response.ok || !token.access_token)
      throw new Error(`Google 授權交換失敗：${token.error_description ?? token.error ?? response.status}`);
    return token;
  }

  private async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal,
    });
    const token = (await response.json()) as TokenResponse;
    if (!response.ok || !token.access_token)
      throw new Error(
        `YouTube 授權已失效：${token.error_description ?? token.error ?? response.status}。請重新連結頻道。`,
      );
    return token.access_token;
  }

  private async fetchChannel(
    accessToken: string,
    signal?: AbortSignal,
    preferredTitle?: string,
  ): Promise<{ id: string; title: string }> {
    const response = await this.fetcher(CHANNEL_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    const body = (await response.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(`無法確認 YouTube 頻道：${body.error?.message ?? response.status}`);
    const channels = (body.items ?? []).filter((item): item is { id: string; snippet: { title: string } } =>
      Boolean(item.id && item.snippet?.title),
    );
    const selected =
      channels.find(
        (item) => item.snippet.title.trim().toLocaleLowerCase() === preferredTitle?.trim().toLocaleLowerCase(),
      ) ?? channels[0];
    if (!selected) throw new Error("這個 Google 帳號沒有可用的 YouTube 頻道。");
    return { id: selected.id, title: selected.snippet.title };
  }

  private async responseError(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      return body.error?.message ?? `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  private async createAuthorizationReceiver(
    expectedState: string,
    signal?: AbortSignal,
  ): Promise<{ server: Server; redirectUri: string; code: Promise<string>; dispose(): void }> {
    assertNotAborted(signal);
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (value instanceof Error) rejectCode(value);
      else resolveCode(value);
    };
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (requestUrl.pathname !== "/oauth2callback" || requestUrl.searchParams.get("state") !== expectedState) {
        response.statusCode = 400;
        response.end(
          "<!doctype html><meta charset=utf-8><title>授權失敗</title><h1>授權回應無效</h1><p>請關閉此頁並回到 SceneryWalker。</p>",
        );
        finish(new Error("Google 授權回應 state 不符，已停止連結。"));
        return;
      }
      const oauthError = requestUrl.searchParams.get("error");
      const authorizationCode = requestUrl.searchParams.get("code");
      if (oauthError || !authorizationCode) {
        response.end(
          "<!doctype html><meta charset=utf-8><title>已取消</title><h1>未完成授權</h1><p>可以關閉此頁並回到 SceneryWalker。</p>",
        );
        finish(
          new Error(
            oauthError === "access_denied"
              ? "使用者取消 Google 授權。"
              : `Google 授權失敗：${oauthError ?? "沒有授權碼"}`,
          ),
        );
        return;
      }
      response.end(
        "<!doctype html><meta charset=utf-8><title>授權完成</title><h1>已連結 SceneryWalker</h1><p>可以關閉此頁並回到 App。</p>",
      );
      finish(authorizationCode);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("無法建立 Google OAuth 本機回呼。");
    }
    abortListener = () => finish(abortError("已取消 YouTube 頻道連結。"));
    timeout = setTimeout(() => finish(new Error("Google 授權等待逾時，請重新連結。")), 5 * 60 * 1000);
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();
    return {
      server,
      redirectUri: `http://127.0.0.1:${address.port}/oauth2callback`,
      code,
      dispose: () => finish(abortError("YouTube 頻道連結已結束。")),
    };
  }
}
