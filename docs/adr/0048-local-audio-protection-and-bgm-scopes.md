# ADR-0048 — Local acoustic audio protection and Intro/Main BGM scopes

Status: Accepted  
Date: 2026-09-11

## Context

Travel footage can contain nearby private conversation, sudden shouting, screams, child cries, harsh laughter or other peaks that should recede from the final mix. At the same time, distant crowd texture, market calls, footsteps and faint scene-matched greetings should not be erased. The concat page also needs independent Intro and Main music choices, with Intro-only music ending before the Main-start prompt.

## Decision

Use a streaming local FFmpeg filter graph instead of cloud speech classification or a separate destructive analysis pass. Split each real source-audio stream into dry, wet and 1–4 kHz detector paths. Drive `sidechaincompress` from the detector, then blend a calculated dry floor with the compressed wet path so the maximum automatic attenuation is exactly bounded by the selected 3–6 dB. Default preserve modes use a 0.09 detector threshold, 45 ms attack and 500 ms release. Apply optional -1.5 dB EQ centered at 2.5 kHz, followed by program compression and a selectable -1／-2 dB limiter ceiling.

Add `BgmScopeSelection { intro, main }`. For an Intro＋Main render, calculate actual input starts from the same crossfade／hard-cut rules as the video graph. Intro-only BGM is clipped at the Main-start-card boundary with a forced fade of up to 1.5 seconds. Main-only BGM shifts its saved timeline by the actual Main start. Both scopes keep the previous continuous mix.

## Consequences

- No source video, source audio or MP3 is changed; protection exists only in the new MP4.
- No audio leaves the computer for this function, no transcription is created and no detector cache is required.
- The approach reacts to energy and frequency, not meaning. It cannot prove that speech is private or perfectly classify laughter, cries, calls and natural sounds. Human listening QC remains mandatory.
- The dynamic envelope is generated at render time and is not presented as a fabricated editable keyframe list. Existing user-authored 0–300% clip automation remains authoritative before the automatic protection stage.
- Main-process range validation prevents Renderer-controlled arbitrary FFmpeg parameters.
