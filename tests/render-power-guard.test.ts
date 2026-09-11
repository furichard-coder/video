import { describe, expect, it, vi } from "vitest";
import { RenderPowerGuard, type PowerSaveBlockerAdapter } from "../src/main/services/render-power-guard";

function fakeBlocker(started = true) {
  const adapter: PowerSaveBlockerAdapter = {
    start: vi.fn(() => 17),
    isStarted: vi.fn(() => started),
    stop: vi.fn(),
  };
  return adapter;
}

describe("render power guard", () => {
  it("blocks suspension until the final active render releases", () => {
    const blocker = fakeBlocker();
    const guard = new RenderPowerGuard(blocker);
    const releaseFirst = guard.acquire();
    const releaseSecond = guard.acquire();
    expect(guard.isActive).toBe(true);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    releaseFirst();
    expect(blocker.stop).not.toHaveBeenCalled();
    releaseSecond();
    expect(guard.isActive).toBe(false);
    expect(blocker.stop).toHaveBeenCalledWith(17);
    releaseSecond();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it("refuses to start rendering when Windows did not activate the blocker", () => {
    const guard = new RenderPowerGuard(fakeBlocker(false));
    expect(() => guard.acquire()).toThrow(/不會開始轉檔/);
    expect(guard.isActive).toBe(false);
  });
});
