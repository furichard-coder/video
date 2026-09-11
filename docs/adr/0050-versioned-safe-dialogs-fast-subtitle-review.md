# ADR-0050 — Versioned binaries, safe dialog pointer and short subtitle review proxies

Status: Accepted  
Date: 2026-09-11

## Context

Portable executables lost their version identity when copied outside the release folder. Compact confirmation overlays focused a safe choice but left the mouse elsewhere. Subtitle cue review could trigger a complete source-video proxy, and manual Intro additions reused an equalization function that could resize existing ranges or increase the target without a separate user decision.

## Decision

- Package `SceneryWalkerSourceOrganizer-v<package version>.exe`; the smoke test resolves the same name from `package.json`.
- Use a shared `SafeDefaultButton` for compact confirmations. It focuses the safe action, sends only its viewport rectangle, and Main rejects non-finite, zero-sized or out-of-window coordinates. Main converts the bounded DIP center to a Windows physical point and invokes a fixed `SetCursorPos` helper with numeric environment variables and `shell:false`. Pointer movement is best-effort; focus is authoritative for accessibility.
- Subtitle cue review uses `ensureClipPreview(assetId, sourceInMs, sourceOutMs)` and cancels the exact range when selection changes. Images use `IMAGE_PREVIEW`. Verified clip-cache output size/mtime avoids a second ffprobe process on unchanged cache hits; a mismatch still validates and rebuilds if necessary.
- Forced review self-maps cues through the canonical transition-aware plan, refreshes both source boundaries, marks active cues draft, and starts a visible one-by-one human decision queue. No automatic semantic match claim is made.
- Manual Intro additions are append/insert-only state changes. They do not call `setIntroSegmentMaxDuration` and do not change `introTargetDurationMs`. Capacity overflow is an explicit error.

## Consequences

Source media and existing release folders remain untouched. First-time short proxies still require FFmpeg decoding, but work is proportional to the cue range rather than full source duration. Explicit changes to the global per-segment limit may still rebalance segments because that button is itself a user-requested duration-plan operation; ordinary additions never do so.
