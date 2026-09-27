import { spawn } from "node:child_process";
import type {
  ConcatRenderResult,
  PostSuccessPowerAction,
  PostSuccessPowerPreference,
  PostSuccessPowerStatus,
  PostSuccessPowerTrigger,
  YoutubeUploadResult,
} from "../../shared/domain";

export interface PowerCommand {
  executable: string;
  args: readonly string[];
}

export type PowerExecutor = (command: PowerCommand) => Promise<void>;

export function completedRenderQualifies(result: Pick<ConcatRenderResult, "cancelled">): boolean {
  return result.cancelled !== true;
}

export function completedYoutubeUploadQualifies(result: Pick<YoutubeUploadResult, "thumbnailStatus">): boolean {
  // NOT_REQUESTED means all requested operations succeeded. A requested but
  // failed thumbnail keeps the workflow incomplete until retry succeeds.
  return result.thumbnailStatus !== "FAILED";
}

const SLEEP_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "[System.Windows.Forms.Application]::SetSuspendState(",
  "[System.Windows.Forms.PowerState]::Suspend, $false, $false)",
].join("");

/** Fixed Windows commands only; no renderer value is ever interpolated. */
export function windowsPowerCommand(action: PostSuccessPowerAction): PowerCommand {
  if (action === "SHUTDOWN") {
    return {
      executable: "shutdown.exe",
      args: ["/s", "/t", "0", "/d", "p:0:0", "/c", "SceneryWalker completed successfully"],
    };
  }
  if (action === "HIBERNATE") return { executable: "shutdown.exe", args: ["/h"] };
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SLEEP_SCRIPT],
  };
}

export const executeWindowsPowerAction: PowerExecutor = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows 电源动作无法执行（exit code ${code ?? "unknown"}）。`));
    });
  });

export interface PostSuccessPowerSchedulerOptions {
  executor?: PowerExecutor;
  isBusy?: () => boolean;
  now?: () => number;
  countdownSeconds?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class PostSuccessPowerScheduler {
  private readonly executor: PowerExecutor;
  private readonly isBusy: () => boolean;
  private readonly now: () => number;
  private readonly countdownSeconds: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private interval: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(status: PostSuccessPowerStatus) => void>();
  private current: PostSuccessPowerStatus = { state: "IDLE" };

  constructor(options: PostSuccessPowerSchedulerOptions = {}) {
    this.executor = options.executor ?? executeWindowsPowerAction;
    this.isBusy = options.isBusy ?? (() => false);
    this.now = options.now ?? Date.now;
    this.countdownSeconds = Math.max(1, Math.round(options.countdownSeconds ?? 60));
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  get isScheduled(): boolean {
    return this.current.state === "SCHEDULED";
  }

  status(): PostSuccessPowerStatus {
    return { ...this.current };
  }

  subscribe(listener: (status: PostSuccessPowerStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  notifySuccess(trigger: PostSuccessPowerTrigger, preference: PostSuccessPowerPreference): boolean {
    if (!preference.enabled || preference.trigger !== trigger) return false;
    if (this.isBusy()) {
      this.setStatus({ state: "CANCELLED", message: "侦测到仍在执行的转档或上传，因此未安排电源动作。" });
      return false;
    }
    this.clearTimer();
    const now = this.now();
    this.setStatus({
      state: "SCHEDULED",
      action: preference.action,
      trigger,
      scheduledAt: new Date(now).toISOString(),
      executeAt: new Date(now + this.countdownSeconds * 1_000).toISOString(),
      secondsRemaining: this.countdownSeconds,
      message: "成功条件已满足；可在倒数结束前取消。",
    });
    this.interval = this.setIntervalFn(() => void this.tick(), 1_000);
    return true;
  }

  cancel(message = "使用者已取消自动电源动作。"): PostSuccessPowerStatus {
    if (this.current.state !== "SCHEDULED") return this.status();
    const { action, trigger } = this.current;
    this.clearTimer();
    this.setStatus({ state: "CANCELLED", action, trigger, secondsRemaining: 0, message });
    return this.status();
  }

  stop(): void {
    this.clearTimer();
  }

  private async tick(): Promise<void> {
    if (this.current.state !== "SCHEDULED" || !this.current.executeAt || !this.current.action) return;
    const remaining = Math.max(0, Math.ceil((Date.parse(this.current.executeAt) - this.now()) / 1_000));
    if (remaining > 0) {
      this.setStatus({ ...this.current, secondsRemaining: remaining });
      return;
    }
    const { action, trigger } = this.current;
    this.clearTimer();
    if (this.isBusy()) {
      this.setStatus({
        state: "CANCELLED",
        action,
        trigger,
        secondsRemaining: 0,
        message: "倒数期间开始了新的转档或上传；已安全取消电源动作。",
      });
      return;
    }
    this.setStatus({
      state: "EXECUTING",
      action,
      trigger,
      secondsRemaining: 0,
      message: "正在执行 Windows 电源动作。",
    });
    try {
      await this.executor(windowsPowerCommand(action));
    } catch (error) {
      this.setStatus({
        state: "FAILED",
        action,
        trigger,
        secondsRemaining: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearTimer(): void {
    if (this.interval !== undefined) this.clearIntervalFn(this.interval);
    this.interval = undefined;
  }

  private setStatus(status: PostSuccessPowerStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(this.status());
  }
}
