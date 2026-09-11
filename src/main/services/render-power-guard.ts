export interface PowerSaveBlockerAdapter {
  start(type: "prevent-app-suspension"): number;
  isStarted(id: number): boolean;
  stop(id: number): void;
}

/**
 * Keeps Windows awake while a media render owns an output partial. The guard is
 * reference-counted so a later parallel render path cannot release another
 * render's blocker. Each acquire must be paired with its returned release.
 */
export class RenderPowerGuard {
  private activeRenderCount = 0;
  private blockerId: number | undefined;

  constructor(private readonly blocker: PowerSaveBlockerAdapter) {}

  get isActive(): boolean {
    return this.activeRenderCount > 0;
  }

  acquire(): () => void {
    if (this.activeRenderCount === 0) {
      this.blockerId = this.blocker.start("prevent-app-suspension");
      if (!this.blocker.isStarted(this.blockerId)) {
        this.blockerId = undefined;
        throw new Error("無法啟用轉檔防睡眠保護，因此本次不會開始轉檔。請檢查 Windows 電源狀態後再試。");
      }
    }
    this.activeRenderCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRenderCount = Math.max(0, this.activeRenderCount - 1);
      if (this.activeRenderCount !== 0 || this.blockerId === undefined) return;
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
      this.blockerId = undefined;
    };
  }
}
