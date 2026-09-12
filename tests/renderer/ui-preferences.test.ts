import { describe, expect, it } from "vitest";
import {
  applyGridOutputIncludeIntro,
  applyGridOutputTimesVisible,
  readGridOutputIncludeIntro,
  readGridOutputTimesVisible,
} from "../../src/renderer/ui-preferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("grid output time display flags", () => {
  it("defaults both flags on when nothing is stored", () => {
    const storage = memoryStorage();
    expect(readGridOutputTimesVisible(storage)).toBe(true);
    expect(readGridOutputIncludeIntro(storage)).toBe(true);
  });

  it("round-trips off and back on", () => {
    const storage = memoryStorage();
    applyGridOutputTimesVisible(false, storage);
    applyGridOutputIncludeIntro(false, storage);
    expect(readGridOutputTimesVisible(storage)).toBe(false);
    expect(readGridOutputIncludeIntro(storage)).toBe(false);
    applyGridOutputTimesVisible(true, storage);
    applyGridOutputIncludeIntro(true, storage);
    expect(readGridOutputTimesVisible(storage)).toBe(true);
    expect(readGridOutputIncludeIntro(storage)).toBe(true);
  });
});
