# ADR-0046 — Render power and close guard

Status: accepted for v0.52.0.

## Decision

Every Main, Intro, Clip and Shorts render that enters `concat:start` must acquire a reference-counted Windows `prevent-app-suspension` blocker before FFmpeg starts. If Windows does not report that the blocker started, the render is refused rather than continuing without protection. The render releases the blocker only in `finally`, after successful finalization, failure cleanup or cancellation cleanup.

While the guard is active, the Renderer visibly reports that sleep protection is on and disables normal App close confirmation. The Main process independently rejects a confirmed close and prevents the Windows `query-session-end` event so an ordinary sleep, sign-out or shutdown request cannot silently abandon the partial output.

## Boundaries

- This does not permanently change the user's Windows power plan.
- The display may turn off; the computer and App remain active for rendering.
- Forced shutdown, loss of power, hardware reset, operating-system crash and process termination cannot be prevented by an App and remain outside this guarantee.
- The blocker is scoped to actual media rendering, not AI analysis, thumbnails, metadata probing or idle time.
