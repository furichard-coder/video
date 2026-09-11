# ADR-0044 — Subtitle overlap review, render preflight and AI cue density

Status: Accepted  
Date: 2026-09-10

## Decision

Material image analysis must return its generated subtitle even when the proposed time intersects an existing subtitle. The UI shows the generated text and the exact conflicting text/time, and offers an explicit transition into Subtitle review. The new cue is persisted as `DRAFT`; both overlapping rows are outlined red until the user resolves the time conflict. Storage accepts overlap only while at least one cue is not confirmed. Two confirmed cues remain invalid for SRT and burn-in safety.

AI subtitle generation exposes a target count from 1 to 300, default 100. The analyzer may take multiple evenly distributed visual samples from longer retained clips instead of assuming one visual cue per source clip. The target is not a guarantee: confirmed time ranges, clip length and valid readable durations remain authoritative.

Before Main, Intro, Clip or Shorts FFmpeg output, the renderer displays an estimate of file size, elapsed time and disk space. Main process reads the actual destination filesystem again immediately before work starts. Estimated output must leave at least 1 GiB free; otherwise no encoder process is launched. Shorts explicitly uses Intel QSV H.265 so it cannot silently fall back to the legacy CPU default.

## Consequences

- AI work is no longer lost behind a generic overlap warning.
- Temporary subtitle conflicts are visible and editable without weakening confirmed-output validation.
- Users can request denser knowledge subtitles while seeing that higher density costs more time and AI usage.
- Low disk space is stopped before partial MP4 creation; estimates remain approximate and are labeled accordingly.
- Source media and prior outputs remain read-only.
