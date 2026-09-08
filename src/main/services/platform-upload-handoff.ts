import { stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserUploadPlatform, PlatformPortalResult, PlatformUploadHandoffResult } from "../../shared/domain";

const PLATFORM_URLS: Record<BrowserUploadPlatform, string> = {
  BILIBILI: "https://member.bilibili.com/platform/upload/video/frame",
  TIKTOK: "https://www.tiktok.com/tiktokstudio/upload?from=creator_center",
};

export interface PlatformHandoffAdapter {
  openExternal(url: string): Promise<void>;
  showItemInFolder(filePath: string): void;
  copyText(text: string): void;
}

export class PlatformUploadHandoffService {
  constructor(private readonly adapter: PlatformHandoffAdapter) {}

  async openPortal(platform: BrowserUploadPlatform): Promise<PlatformPortalResult> {
    if (platform !== "BILIBILI" && platform !== "TIKTOK") throw new Error("不支援的投稿平台。");
    const uploadUrl = PLATFORM_URLS[platform];
    await this.adapter.openExternal(uploadUrl);
    const label = platform === "BILIBILI" ? "BiliBili" : "TikTok";
    return { platform, uploadUrl, message: `已開啟 ${label} 官方登入／投稿頁；帳號、密碼與登入狀態由官方網站和瀏覽器管理，本 App 不會讀取或保存。` };
  }

  async open(outputPath: string, platform: BrowserUploadPlatform): Promise<PlatformUploadHandoffResult> {
    if (platform !== "BILIBILI" && platform !== "TIKTOK") throw new Error("不支援的投稿平台。");
    const resolved = path.resolve(outputPath);
    if (path.extname(resolved).toLowerCase() !== ".mp4") throw new Error("平台投稿只接受本次完成的 MP4 預覽。");
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isFile() || info.size < 1) throw new Error("找不到可投稿的完成檔，請重新產出正片預覽。");
    const uploadUrl = PLATFORM_URLS[platform];
    this.adapter.copyText(resolved);
    this.adapter.showItemInFolder(resolved);
    await this.adapter.openExternal(uploadUrl);
    const label = platform === "BILIBILI" ? "BiliBili" : "TikTok";
    return {
      platform,
      outputPath: resolved,
      uploadUrl,
      message: `已開啟 ${label} 官方投稿頁、在檔案總管選取成品，並將完整路徑複製到剪貼簿。請在平台頁面自行確認標題、版權、隱私及最後發布。`,
    };
  }
}
