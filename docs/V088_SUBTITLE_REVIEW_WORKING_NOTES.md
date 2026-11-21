# v0.88 Subtitle Playback / AI Review — working notes

## Protected baseline (2026-10-03)

- Product entry: CURRENT_PRODUCT_SPEC.md; previous verification: V087_SUBTITLE_RECOVERY_REPORT.md.
- Actual current project: `C:\大雪山\我的素材專案.swproj`, ID `033e4b53-b4fa-4418-95d2-5f7bc4b6df86`, timelineRevision 613, 120 sources, 25 intro segments, 63 subtitle cues (62 DRAFT, 1 CONFIRMED).
- Project SHA-256: `A06D45FA7AD4E939DE1FF73724AFF4458D9B5733CD6317955FFB65AA71371BBC`; 301,294 bytes. This is newer user work than the v0.87 audit; do not restore the old all-DRAFT snapshot.
- Final master: `E:\大雪山 YT video\SceneryWalker_preview_20260926_0243.mp4`, 74,888,192,283 bytes, UTC mtime 2026-09-30 02:20:02.3566450, previously ffprobed 8,970,194 ms. Never re-encode it for this task.
- Existing legacy output lacks projectId; previous project duration 8,964,908 ms. Duration tolerance is not a pixel/timecode mapping proof. Do not silently combine this final with current project-relative cues.
- v0.87 EXE SHA-256: `2028E1D127431D42C002BF45D4A239C08217BFDD37FDA0216752F4947181507A`. Previous releases and all source/SRT/checkpoint data are protected.

## Confirmed old code issues

- Primary `SubtitleStudio.handleTimeUpdate`: clamps the main preview clock to selected.endMs; at sourceSelection.sourceEndMs explicitly pauses and rewinds. No next-segment handoff.
- Primary activeOverlayCue: non-intro branch returns selected cue irrespective of playback time. Selection is also coupled to seek.
- Standalone review: row selection seeks video, no unified playback/focus-follow contract.
- `subtitle:visual-cue:regenerate` only accepts project-compatible selected video; no independent per-cue proposal workflow, persisted review lifecycle or manual-edit conflict key.
- Previous real OpenAI image request: HTTP 429 / credit_balance_exhausted. Do not repeatedly retry billing failure or describe mock tests as live success.

## Ownership / implementation contract

- Sol lead: primary project playback integration, canonical clock, AI proposal service/IPC/parser, strict validation, draft-only decisions, review of Luna changes.
- Luna: bounded standalone UI/CSS/renderer tests; additional bounded tasks only when independent.
- Root: user communication, version 0.88 bump, isolated real Electron QA hooks/scripts, release packaging, read-only baseline verification and final report.
- Project proxies use trim/absolute timeline mapping. Overlap handoff at min(current.outputEnd,next.outputStart), next source seek includes the matching offset; this is cut-based proxy review, not full composed Final-transition QC.
- Selected row is separate from active playback cue. Text editing never seeks; explicit jump/double-click seeks and pauses. Cue range is start-inclusive / end-exclusive.
- AI check default OFF; interactive review default ON; KEEP/EDIT suggestions never directly overwrite formal SRT. Each human decision is persisted to draft; stale proposals cannot overwrite newer manual text.
- Only synthetic short-video fixtures / project copies may be written for tests. Any actual paid test must be bounded to a single review and report its real result.

## Next checks

- Primary and standalone actual DOM fixed-right/independent-left, continuous three-segment playback and boundary cues, 100-cue focus positioning, keyboard editor guards.
- Provider refusal/incomplete/invalid JSON, classified errors, latest-text conflicts, stop/pause/restart cursor, formal SRT unchanged.
- Typecheck, focused suites, full suite with bounded workers, fresh v0.88 package + packaged smoke; preserve v0.87 bytes.

## Evidence during integration

- First two real Electron playback attempts failed: next clip URL loaded but playback stayed paused at project clock 9,700 ms (fixture ProjectStore normalizes transition to 300 ms, actual end 29,400 ms). This is not a passing 3-segment test; metadata/native-ended continuation race is being fixed.
- One real bounded review request completed its transport attempt with current configured OpenAI model `gpt-6-luna`, one 171,473-byte read-only JPEG at master timestamp 600,000 ms. Provider returned billing/quota 429, classified `RATE_LIMIT`, retryable=false. No real KEEP/EDIT proposal was produced. See `artifacts/v088-ai-review-live/report.json`; no additional paid retries permitted.
- Root independent code review identified interactive-confirmation scheduling, abort wrapping, concurrent snapshot writes, and neighbor-context cache key risks; Sol is integrating corrections before final tests.
- Five-hour account usage reached 80% used (20% remaining); user stop floor is 3% remaining. Prefer bounded tests and packaging over broad scans.

## Final verification, 2026-10-03

- Full suite: 96 files / 585 tests PASS, 242.66 seconds. Final standalone handoff focused 10/10 and final AUTH/MODEL classification focused 9/9 PASS after the full run.
- Final real Electron fixtures: CONTINUITY 240 samples, 5,000→29,400 ms and 3 source URLs; MIXED 5,000→24,400 ms with video/image/video; FOCUS #50 center=0.449648 of viewport, scrollTop=6384, unchanged Preview Y=137.125. All three PASS.
- First v0.88 production package and packaged smoke PASS. Root final review is checking whether editing a cue in another scope changes the playback clock; a safe correction, if needed, must be repackaged before handoff.
- Read-only recheck: user project SHA256 A06D45FA7AD4E939DE1FF73724AFF4458D9B5733CD6317955FFB65AA71371BBC; v0.87 EXE 2028E1D127431D42C002BF45D4A239C08217BFDD37FDA0216752F4947181507A; master size 74888192283 and UTC mtime 2026-09-30T02:20:02.3566450Z unchanged.
- Final scope isolation passed second full 96/585 suite (241.47s), primary scope/label focused 1/1, and real Electron all three modes again (CONT sampleCount=244). Final package smoke PASS; EXE 72BB67C0F9DFB3C38E3849CDC505629B67BDB08EF21BAD5A475E80858602D7B9; ASAR 690B3EB92F26658E525A64E6DC7C580446CF355778AA39EE0B4CD83F15E433EA. No further production edits.
