import { describe, expect, it } from "vitest";
import { TaskPool } from "../src/main/services/task-pool";

describe("TaskPool", () => {
  it("cancels queued work before it starts", async () => {
    const pool = new TaskPool(1);
    let release!: () => void;
    const blocker = pool.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const cancelled = pool.run(async () => "should-not-run", controller.signal);
    controller.abort();
    release();
    await blocker;
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });
});

