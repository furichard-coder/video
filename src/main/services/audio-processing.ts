import type {
  AudioMeterReading,
  AudioProcessingOptions,
  BasicMediaInfo,
  SurroundAudioCodec,
} from "../../shared/domain";
import { DEFAULT_AUDIO_PROCESSING_OPTIONS } from "../../shared/domain";

const AUDIO_CODECS = new Set<SurroundAudioCodec>(["AAC", "AC3", "EAC3"]);
const AUDIO_MODES = new Set(["ORIGINAL_STEREO", "ENHANCED_STEREO", "VIRTUAL_SURROUND_5_1", "PRESERVE_MULTICHANNEL"]);
const PRESETS = new Set(["NATURAL", "CINEMA", "WIDE"]);

function bounded(value: unknown, minimum: number, maximum: number, fallback: number, step = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed / step) * step));
}

export function sanitizeAudioProcessingOptions(value: unknown): AudioProcessingOptions {
  const fallback = DEFAULT_AUDIO_PROCESSING_OPTIONS;
  const candidate = value && typeof value === "object" ? (value as Partial<AudioProcessingOptions>) : {};
  const codec = AUDIO_CODECS.has(candidate.codec as SurroundAudioCodec) ? (candidate.codec as SurroundAudioCodec) : fallback.codec;
  const defaultBitrate = codec === "AAC" ? 384 : codec === "AC3" ? 448 : 640;
  return {
    mode: AUDIO_MODES.has(candidate.mode ?? "") ? (candidate.mode as AudioProcessingOptions["mode"]) : fallback.mode,
    preset: PRESETS.has(candidate.preset ?? "") ? (candidate.preset as AudioProcessingOptions["preset"]) : fallback.preset,
    codec,
    bitrateKbps: bounded(candidate.bitrateKbps, 128, codec === "EAC3" ? 1024 : 640, defaultBitrate, 8),
    sampleRate: 48_000,
    surroundStrengthPercent: bounded(candidate.surroundStrengthPercent, 0, 120, fallback.surroundStrengthPercent, 5),
    lfeStrengthPercent: bounded(candidate.lfeStrengthPercent, 0, 100, fallback.lfeStrengthPercent, 5),
    lfeCutoffHz: bounded(candidate.lfeCutoffHz, 80, 120, fallback.lfeCutoffHz, 5),
    loudnessTargetLufs: bounded(candidate.loudnessTargetLufs, -24, -14, fallback.loudnessTargetLufs, 1),
    truePeakCeilingDb: bounded(candidate.truePeakCeilingDb, -3, -1, fallback.truePeakCeilingDb, 0.5),
    stereoWidthPercent: bounded(candidate.stereoWidthPercent, 50, 160, fallback.stereoWidthPercent ?? 100, 5),
    eqLowDb: bounded(candidate.eqLowDb, -6, 6, fallback.eqLowDb ?? 0, 0.5),
    eqPresenceDb: bounded(candidate.eqPresenceDb, -6, 6, fallback.eqPresenceDb ?? 0, 0.5),
  };
}

export function audioCodecArgs(options: AudioProcessingOptions, channels: 2 | 6): string[] {
  const codec = channels === 2 || options.codec === "AAC" ? "aac" : options.codec === "AC3" ? "ac3" : "eac3";
  const bitrate = channels === 2 ? Math.min(256, options.bitrateKbps) : options.bitrateKbps;
  return ["-c:a", codec, "-b:a", `${bitrate}k`, "-ar", "48000", "-ac", String(channels)];
}

function limiter(options: AudioProcessingOptions): string {
  const peak = 10 ** (options.truePeakCeilingDb / 20);
  return `loudnorm=I=${options.loudnessTargetLufs}:TP=${options.truePeakCeilingDb}:LRA=11,alimiter=limit=${peak.toFixed(6)}:attack=5:release=100`;
}

/**
 * Post-master filter. It consumes the already timeline-correct stereo mix, so
 * video frames remain stream-copyable and subtitle/timeline timing cannot move.
 */
export function buildAudioProcessingFilter(optionsInput: AudioProcessingOptions): {
  filter: string | undefined;
  channels: 2 | 6;
  layout: "stereo" | "5.1(side)";
  monitoringFilter?: string;
} {
  const options = sanitizeAudioProcessingOptions(optionsInput);
  if (options.mode === "ORIGINAL_STEREO" || options.mode === "PRESERVE_MULTICHANNEL") {
    return { filter: undefined, channels: 2, layout: "stereo" };
  }
  if (options.mode === "ENHANCED_STEREO") {
    const sideLevel = (options.preset === "WIDE" ? 1.22 : options.preset === "CINEMA" ? 1.16 : 1.1) * ((options.stereoWidthPercent ?? 100) / 100);
    const bass = options.preset === "CINEMA" ? 1.2 : 0.8;
    return {
      channels: 2,
      layout: "stereo",
      filter: [
        "aformat=sample_rates=48000:channel_layouts=stereo",
        `stereotools=mlev=1:slev=${sideLevel}:balance_out=0`,
        `equalizer=f=90:t=q:w=0.8:g=${bass}`,
        `equalizer=f=180:t=q:w=0.8:g=${options.eqLowDb ?? 0}`,
        `equalizer=f=2800:t=q:w=1.1:g=${0.6 + (options.eqPresenceDb ?? 0)}`,
        limiter(options),
      ].join(","),
    };
  }

  const surround = (options.surroundStrengthPercent / 100) * ((options.stereoWidthPercent ?? 100) / 100);
  const lfe = options.lfeStrengthPercent / 100;
  const surroundGain = Math.min(0.34, 0.26 * surround);
  const lfeGain = Math.min(0.28, 0.24 * lfe);
  const delayMs = options.preset === "WIDE" ? 18 : options.preset === "CINEMA" ? 14 : 11;
  const filter = [
    `aformat=sample_rates=48000:channel_layouts=stereo,equalizer=f=180:t=q:w=0.8:g=${options.eqLowDb ?? 0},equalizer=f=2800:t=q:w=1.1:g=${options.eqPresenceDb ?? 0},asplit=6[fls][frs][fcs][lfes][sls][srs]`,
    "[fls]pan=mono|c0=0.76*c0+0.06*c1[fl]",
    "[frs]pan=mono|c0=0.06*c0+0.76*c1[fr]",
    "[fcs]pan=mono|c0=0.46*c0+0.46*c1,equalizer=f=2500:t=q:w=1:g=0.8[fc]",
    `[lfes]pan=mono|c0=${lfeGain.toFixed(4)}*c0+${lfeGain.toFixed(4)}*c1,lowpass=f=${options.lfeCutoffHz}:p=2[lfe]`,
    `[sls]pan=mono|c0=${surroundGain.toFixed(4)}*c0-${surroundGain.toFixed(4)}*c1,highpass=f=180,lowpass=f=9000,adelay=${delayMs}[sl]`,
    `[srs]pan=mono|c0=${surroundGain.toFixed(4)}*c1-${surroundGain.toFixed(4)}*c0,highpass=f=180,lowpass=f=9000,adelay=${delayMs + 3}[sr]`,
    "[fl][fr][fc][lfe][sl][sr]join=inputs=6:channel_layout=5.1(side):map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-SL|5.0-SR[a51]",
    `[a51]${limiter(options)}[aout]`,
  ].join(";");
  return {
    filter,
    channels: 6,
    layout: "5.1(side)",
    // This is a conservative compatibility audition, not HRTF/binaural rendering.
    monitoringFilter: "pan=stereo|c0=0.70*FL+0.50*FC+0.35*SL+0.20*LFE|c1=0.70*FR+0.50*FC+0.35*SR+0.20*LFE,alimiter=limit=0.891251",
  };
}

export function buildAudioRemuxArguments(
  inputPath: string,
  outputPath: string,
  rawOptions: AudioProcessingOptions,
  filterScriptPath?: string,
): { args: string[]; filterScript?: string; channels: 2 | 6; layout: "stereo" | "5.1(side)" } {
  const options = sanitizeAudioProcessingOptions(rawOptions);
  const plan = buildAudioProcessingFilter(options);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-map", "0:v:0", "-c:v", "copy"];
  if (options.mode === "PRESERVE_MULTICHANNEL") {
    args.push("-map", "0:a:0", "-c:a", "copy");
  } else if (options.mode === "ORIGINAL_STEREO") {
    args.push("-map", "0:a:0", "-c:a", "copy");
  } else if (plan.channels === 6) {
    if (!filterScriptPath) throw new Error("Virtual 5.1 需要安全的 FFmpeg filter script 路徑。");
    args.push("-/filter_complex", filterScriptPath, "-map", "[aout]", ...audioCodecArgs(options, 6));
  } else {
    args.push("-map", "0:a:0", "-af", plan.filter ?? "anull", ...audioCodecArgs(options, 2));
  }
  args.push("-metadata:s:a:0", `title=${options.mode}`, "-movflags", "+faststart", "-shortest", outputPath);
  return { args, filterScript: plan.channels === 6 ? plan.filter : undefined, channels: plan.channels, layout: plan.layout };
}

export function canPreserveNativeMultichannel(info: BasicMediaInfo | undefined): boolean {
  return Boolean((info?.audioChannels ?? 0) > 2 && info?.audioChannelLayout);
}

export function parseEbur128Summary(stderr: string): AudioMeterReading {
  const integratedMatches = [...stderr.matchAll(/\bI:\s*(-?[\d.]+)\s*LUFS/g)];
  const peakMatches = [...stderr.matchAll(/\bPeak:\s*(-?[\d.]+)\s*dBFS/g)];
  const integratedLufs = integratedMatches.length ? Number(integratedMatches.at(-1)?.[1]) : undefined;
  const truePeakDb = peakMatches.length ? Number(peakMatches.at(-1)?.[1]) : undefined;
  // astats writes one `Channel: N` section per channel and then an overall
  // section. Pair each numbered section with its first peak so the UI can
  // render an actual 2.0/5.1 meter instead of mistaking the overall peak for
  // a one-channel result.
  const channelPeaksDb = [...stderr.matchAll(/Channel:\s*\d+[\s\S]*?Peak level dB:\s*(-?[\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const clipping = (truePeakDb ?? Math.max(...channelPeaksDb, -Infinity)) > -0.1;
  const warnings: string[] = [];
  if (clipping) warnings.push("偵測到接近或超過 0 dBFS 的峰值，正式輸出將套用 Peak Protection。");
  if (integratedLufs !== undefined && integratedLufs > -13) warnings.push("整體響度偏高，可能造成平台正規化或聽感疲勞。");
  if (integratedLufs !== undefined && integratedLufs < -24) warnings.push("整體響度偏低，請確認來源或配樂音量。");
  return { integratedLufs, truePeakDb, channelPeaksDb, clipping, warnings };
}
