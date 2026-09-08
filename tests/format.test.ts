import { describe, expect, it } from "vitest";
import { formatMinuteSecondInput, parseMinuteSecondInput } from "../src/renderer/format";

describe("minute:second editing format", () => {
  it("parses total minutes, fractions, decimal commas, and optional hours", () => {
    expect(parseMinuteSecondInput("0:04.00")).toBe(4_000);
    expect(parseMinuteSecondInput("12:34.56")).toBe(754_560);
    expect(parseMinuteSecondInput("2:03,125")).toBe(123_125);
    expect(parseMinuteSecondInput("1:02:03.25")).toBe(3_723_250);
  });

  it("rejects ambiguous seconds-only, negative, and out-of-range seconds", () => {
    expect(parseMinuteSecondInput("75")).toBeUndefined();
    expect(parseMinuteSecondInput("-1:05")).toBeUndefined();
    expect(parseMinuteSecondInput("1:60")).toBeUndefined();
    expect(parseMinuteSecondInput("1:60:00")).toBeUndefined();
  });

  it("formats milliseconds as total minutes and hundredths without losing normal UI precision", () => {
    expect(formatMinuteSecondInput(0)).toBe("0:00.00");
    expect(formatMinuteSecondInput(65_430)).toBe("1:05.43");
    expect(formatMinuteSecondInput(3_723_250)).toBe("62:03.25");
    expect(parseMinuteSecondInput(formatMinuteSecondInput(65_430))).toBe(65_430);
  });
});
