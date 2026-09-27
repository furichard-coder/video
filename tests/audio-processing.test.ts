import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIO_PROCESSING_OPTIONS } from "../src/shared/domain";
import {
  audioCodecArgs,
  buildAudioProcessingFilter,
  buildAudioRemuxArguments,
  parseEbur128Summary,
  sanitizeAudioProcessingOptions,
} from "../src/main/services/audio-processing";

describe("audio processing profiles", () => {
  it("keeps a conservative neutral default and clamps unsafe values", () => {
    expect(sanitizeAudioProcessingOptions({ surroundStrengthPercent: 999, lfeCutoffHz: 10, truePeakCeilingDb: 0 })).toMatchObject({
      mode: "ORIGINAL_STEREO",
      codec: "AAC",
      sampleRate: 48_000,
      surroundStrengthPercent: 120,
      lfeCutoffHz: 80,
      truePeakCeilingDb: -1,
    });
  });

  it("builds enhanced stereo without delay-based phase widening", () => {
    const plan = buildAudioProcessingFilter({ ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "ENHANCED_STEREO" });
    expect(plan.channels).toBe(2);
    expect(plan.filter).toContain("stereotools=mlev=1:slev=1.1");
    expect(plan.filter).toContain("loudnorm=I=-16");
    expect(plan.filter).not.toContain("adelay");
  });

  it("maps virtual surround to standard side-channel order using common/difference content", () => {
    const plan = buildAudioProcessingFilter({ ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "VIRTUAL_SURROUND_5_1" });
    expect(plan.channels).toBe(6);
    expect(plan.layout).toBe("5.1(side)");
    expect(plan.filter).toContain("0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-SL|5.0-SR");
    expect(plan.filter).toContain("0.46*c0+0.46*c1");
    expect(plan.filter).toMatch(/c0-[\d.]+\*c1/);
    expect(plan.filter).toContain("lowpass=f=100");
    expect(plan.monitoringFilter).toContain("pan=stereo");
  });

  it.each([
    ["AAC", "aac", "384k"],
    ["AC3", "ac3", "448k"],
    ["EAC3", "eac3", "640k"],
  ] as const)("selects real %s 5.1 codec arguments", (codec, encoder, bitrate) => {
    const options = sanitizeAudioProcessingOptions({ ...DEFAULT_AUDIO_PROCESSING_OPTIONS, codec, bitrateKbps: Number.parseInt(bitrate) });
    expect(audioCodecArgs(options, 6)).toEqual(["-c:a", encoder, "-b:a", bitrate, "-ar", "48000", "-ac", "6"]);
  });

  it("remuxes processed audio while copying video frames", () => {
    const plan = buildAudioRemuxArguments("in.mp4", "out.mp4", { ...DEFAULT_AUDIO_PROCESSING_OPTIONS, mode: "VIRTUAL_SURROUND_5_1" }, "audio.txt");
    expect(plan.args).toContain("copy");
    expect(plan.args).toContain("-/filter_complex");
    expect(plan.args).toContain("[aout]");
  });

  it("parses measured loudness and clipping rather than estimating it", () => {
    expect(parseEbur128Summary("I: -12.5 LUFS\nPeak: -0.0 dBFS\nChannel: 1\nPeak level dB: -0.01\nChannel: 2\nPeak level dB: -2.0\nPeak level dB: -0.01")).toMatchObject({
      integratedLufs: -12.5,
      truePeakDb: -0,
      channelPeaksDb: [-0.01, -2],
      clipping: true,
    });
  });
});
