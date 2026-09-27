import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completedRenderQualifies,
  completedYoutubeUploadQualifies,
  PostSuccessPowerScheduler,
  windowsPowerCommand,
} from "../src/main/services/post-success-power";

describe("post-success power scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("maps each action to a fixed shell-free Windows command", () => {
    expect(windowsPowerCommand("SHUTDOWN")).toEqual({
      executable: "shutdown.exe",
      args: ["/s", "/t", "0", "/d", "p:0:0", "/c", "SceneryWalker completed successfully"],
    });
    expect(windowsPowerCommand("HIBERNATE")).toEqual({ executable: "shutdown.exe", args: ["/h"] });
    const sleep = windowsPowerCommand("SLEEP");
    expect(sleep.executable).toBe("powershell.exe");
    expect(sleep.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    expect(sleep.args.join(" ")).toContain("SetSuspendState");
  });

  it("is opt-in and requires the exact successful terminal event", () => {
    const executor = vi.fn(async () => undefined);
    const scheduler = new PostSuccessPowerScheduler({ executor });
    expect(
      scheduler.notifySuccess("RENDER_SUCCESS", {
        enabled: false,
        trigger: "RENDER_SUCCESS",
        action: "SHUTDOWN",
      }),
    ).toBe(false);
    expect(
      scheduler.notifySuccess("RENDER_SUCCESS", {
        enabled: true,
        trigger: "YOUTUBE_UPLOAD_SUCCESS",
        action: "SHUTDOWN",
      }),
    ).toBe(false);
    expect(scheduler.status()).toEqual({ state: "IDLE" });
  });

  it("accepts only fully successful render/upload terminal results", () => {
    expect(completedRenderQualifies({ cancelled: false })).toBe(true);
    expect(completedRenderQualifies({ cancelled: undefined })).toBe(true);
    expect(completedRenderQualifies({ cancelled: true })).toBe(false);
    expect(completedYoutubeUploadQualifies({ thumbnailStatus: "NOT_REQUESTED" })).toBe(true);
    expect(completedYoutubeUploadQualifies({ thumbnailStatus: "UPLOADED" })).toBe(true);
    expect(completedYoutubeUploadQualifies({ thumbnailStatus: "FAILED" })).toBe(false);
  });

  it("counts down 60 seconds, can be cancelled, and never calls the injected executor", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => undefined);
    const scheduler = new PostSuccessPowerScheduler({ executor });
    scheduler.notifySuccess("RENDER_SUCCESS", {
      enabled: true,
      trigger: "RENDER_SUCCESS",
      action: "SLEEP",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(scheduler.status()).toMatchObject({ state: "SCHEDULED", secondsRemaining: 45 });
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.status().state).toBe("CANCELLED");
    expect(executor).not.toHaveBeenCalled();
  });

  it("executes only after the full countdown and cancels if a new job is busy", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => undefined);
    let busy = false;
    const scheduler = new PostSuccessPowerScheduler({ executor, isBusy: () => busy });
    scheduler.notifySuccess("YOUTUBE_UPLOAD_SUCCESS", {
      enabled: true,
      trigger: "YOUTUBE_UPLOAD_SUCCESS",
      action: "HIBERNATE",
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(executor).not.toHaveBeenCalled();
    busy = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.status()).toMatchObject({ state: "CANCELLED", secondsRemaining: 0 });
    expect(executor).not.toHaveBeenCalled();
  });

  it("passes the fixed command to an injected executor after success", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => undefined);
    const scheduler = new PostSuccessPowerScheduler({ executor, countdownSeconds: 2 });
    scheduler.notifySuccess("RENDER_SUCCESS", {
      enabled: true,
      trigger: "RENDER_SUCCESS",
      action: "SHUTDOWN",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executor).toHaveBeenCalledWith(windowsPowerCommand("SHUTDOWN"));
    expect(scheduler.status().state).toBe("EXECUTING");
  });

  it("surfaces a Windows capability or policy error without retrying", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => {
      throw new Error("Windows policy blocked this power action");
    });
    const scheduler = new PostSuccessPowerScheduler({ executor, countdownSeconds: 1 });
    scheduler.notifySuccess("RENDER_SUCCESS", {
      enabled: true,
      trigger: "RENDER_SUCCESS",
      action: "HIBERNATE",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(scheduler.status()).toMatchObject({
      state: "FAILED",
      action: "HIBERNATE",
      message: "Windows policy blocked this power action",
    });
  });
});
