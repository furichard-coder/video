# ADR 0054 — Per-cue subtitle wrap and selected-range silence

## Status

Accepted for v0.60.0.

## Decision

`SubtitleCue.lineWidthChars` is an optional manual override. Undefined means a deterministic text default: Chinese-only 12, English or mixed Chinese/English 20. A cue override wins over the existing optional global bulk override. Preview, SRT and ASS burn-in use the same resolver, so the saved manifest remains the single source of truth.

The renderer exposes the setting as a per-row dialog with a native number input (6–40), preserving keyboard Up/Down and direct typing. Saving calls the existing Main-process `setSubtitleCues` validation and atomic manifest write; Renderer never writes the project file directly.

Silent auto-BGM is evaluated on the exact VIDEO source range selected for Intro/Main output. No-audio streams are silent immediately; audio streams are measured locally with FFmpeg `volumedetect`, conservatively classifying only maximum volume at or below -50 dB as silent. Photos are excluded. At most two FFmpeg analyzers run concurrently, and results are cached in memory by source fingerprint, IN/duration, analyzer version and threshold.

The first BGM-page item is the only automatic source. It must be a resolved local track. The existing render-level BGM switch and per-video opt-out both take precedence. Source media and MP3 remain read-only, and the existing unique-partial/atomic-finalize output boundary is unchanged.

## Rejected alternatives

- Metadata-only `audioCodec` detection misses audio tracks containing digital silence.
- Filename or codec guesses are not acoustic evidence.
- Automatically choosing the first _available_ later track would silently violate the user's visible BGM order.
- Persisting derived 12/20 into every old cue would turn an automatic default into a stale manual value after the cue language changes.
