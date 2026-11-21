import { describe, expect, it } from "vitest";
import { GIB } from "../src/main/services/render-disk-space";
import {
  describeRenderTempLocation,
  evaluateRenderTempPreflight,
  selectRenderTempForNextJob,
} from "../src/main/services/render-temp-scheduler";

describe("multi-volume render TEMP scheduler", () => {
  it("defaults C to a 2 GiB soft reserve without treating 10 GiB free as fatal", () => {
    const status = describeRenderTempLocation({
      config: { id: "secondary", path: "C:\\Render TEMP", role: "FALLBACK", enabled: true },
      freeBytes: 10 * GIB,
      capacityBytes: 512 * GIB,
      writable: true,
    });
    expect(status.allowFallback).toBe(true);
    expect(status.reserveBytes).toBe(2 * GIB);
    expect(status.available).toBe(true);
    expect(status.schedulableBytes).toBe(8 * GIB);
    expect(status.unavailableReason).toBeUndefined();
  });

  it("makes about 164/73 GiB schedulable for the requested E/C defaults", () => {
    const e = describeRenderTempLocation({
      config: { id: "primary", path: "E:\\Temp", role: "PRIMARY", enabled: true },
      freeBytes: 165 * GIB,
      capacityBytes: 500 * GIB,
    });
    const c = describeRenderTempLocation({
      config: { id: "fallback", path: "C:\\Temp", role: "FALLBACK", enabled: true },
      freeBytes: 75 * GIB,
      capacityBytes: 500 * GIB,
    });
    expect(e.schedulableBytes).toBe(164 * GIB);
    expect(c.schedulableBytes).toBe(73 * GIB);
  });

  it("selects fallback only for the next job and accounts for committed bytes", () => {
    const selected = selectRenderTempForNextJob(
      [
        {
          config: { id: "primary", path: "E:\\Render TEMP", role: "PRIMARY", enabled: true },
          freeBytes: 24 * GIB,
          capacityBytes: 500 * GIB,
          committedBytes: 3 * GIB,
        },
        {
          config: { id: "secondary", path: "D:\\Render TEMP", role: "FALLBACK", enabled: true },
          freeBytes: 80 * GIB,
          capacityBytes: 500 * GIB,
          committedBytes: 10 * GIB,
        },
      ],
      30 * GIB,
    );
    expect(selected).toMatchObject({ locationId: "secondary", volume: "D:\\" });
  });

  it("keeps E primary when it has room and safe-pauses when neither volume can fit the next job", () => {
    const primaryReady = [
      {
        config: { id: "primary", path: "E:\\Render TEMP", role: "PRIMARY" as const, enabled: true },
        freeBytes: 153 * GIB,
        capacityBytes: 500 * GIB,
      },
      {
        config: { id: "secondary", path: "C:\\Render TEMP", role: "FALLBACK" as const, enabled: true },
        freeBytes: 75 * GIB,
        capacityBytes: 500 * GIB,
      },
    ];
    expect(selectRenderTempForNextJob(primaryReady, 40 * GIB)?.locationId).toBe("primary");
    expect(selectRenderTempForNextJob(primaryReady, 153 * GIB)).toBeUndefined();
  });

  it("never uses an explicitly disabled fallback", () => {
    const probes = [
      {
        config: {
          id: "secondary",
          path: "D:\\Render TEMP",
          role: "FALLBACK",
          enabled: true,
          allowFallback: false,
        },
        freeBytes: 100 * GIB,
        capacityBytes: 500 * GIB,
      },
    ];
    expect(selectRenderTempForNextJob(probes, GIB)).toBeUndefined();
    expect(selectRenderTempForNextJob(probes, GIB, "FALLBACK")?.locationId).toBe("secondary");
  });

  it("honors manual PRIMARY/FALLBACK selection without silently crossing volumes", () => {
    const probes = [
      {
        config: { id: "primary", path: "E:\\Render TEMP", role: "PRIMARY" as const, enabled: true },
        freeBytes: 80 * GIB,
        capacityBytes: 500 * GIB,
      },
      {
        config: { id: "secondary", path: "D:\\Render TEMP", role: "FALLBACK" as const, enabled: true },
        freeBytes: 80 * GIB,
        capacityBytes: 500 * GIB,
      },
    ];
    expect(selectRenderTempForNextJob(probes, GIB, "PRIMARY")?.locationId).toBe("primary");
    expect(selectRenderTempForNextJob(probes, GIB, "FALLBACK")?.locationId).toBe("secondary");
  });

  it("allows start when E cannot fit one job but C can, without summing their free space", () => {
    const statuses = [
      describeRenderTempLocation({
        config: { id: "primary", path: "E:\\Temp", role: "PRIMARY", enabled: true },
        freeBytes: 25 * GIB,
        capacityBytes: 500 * GIB,
      }),
      describeRenderTempLocation({
        config: { id: "secondary", path: "C:\\Temp", role: "FALLBACK", enabled: true },
        freeBytes: 75 * GIB,
        capacityBytes: 500 * GIB,
      }),
    ];
    expect(evaluateRenderTempPreflight(statuses, 40 * GIB, "AUTO", 100 * GIB, 50 * GIB)).toMatchObject({
      canRender: true,
      outputVolumeCanRender: true,
      selectedTemp: { locationId: "secondary" },
    });
    // 15 + 35 GiB schedulable must not be summed to fit a 40 GiB job.
    const split = statuses.map((item) => ({
      ...item,
      freeBytes: 35 * GIB,
      schedulableBytes: 34 * GIB,
    }));
    expect(evaluateRenderTempPreflight(split, 40 * GIB, "AUTO", 100 * GIB, 50 * GIB).canRender).toBe(false);
  });

  it("keeps Final Output as an independent hard gate", () => {
    const status = describeRenderTempLocation({
      config: { id: "primary", path: "E:\\Temp", role: "PRIMARY", enabled: true },
      freeBytes: 150 * GIB,
      capacityBytes: 500 * GIB,
    });
    expect(evaluateRenderTempPreflight([status], 20 * GIB, "AUTO", 49 * GIB, 50 * GIB)).toMatchObject({
      canRender: false,
      outputVolumeCanRender: false,
      selectedTemp: { locationId: "primary" },
    });
  });

  it("does not double-spend free space when TEMP and final output share C", () => {
    const status = describeRenderTempLocation({
      config: { id: "secondary", path: "C:\\Temp", role: "FALLBACK", enabled: true },
      freeBytes: 75 * GIB,
      capacityBytes: 500 * GIB,
    });
    expect(evaluateRenderTempPreflight([status], 40 * GIB, "AUTO", 75 * GIB, 50 * GIB, "C:\\", 30 * GIB, 20 * GIB)).toMatchObject({
      canRender: false,
      outputVolumeCanRender: true,
      sharedVolumeConflict: true,
    });
  });
});
