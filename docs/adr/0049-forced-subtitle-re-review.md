# ADR-0049 — Source-anchored subtitle remapping and forced re-review

Status: Accepted  
Date: 2026-09-11

## Context

Changing a Main or Intro clip duration, IN／OUT, insertion, order or transition moves the corresponding visible content. Subtitle times must follow the same visual source, and the user needs an explicit way to discard prior confirmation confidence and review every cue against the current picture.

## Decision

Keep the canonical source-anchored remapping path. Before every timing mutation, capture the old timeline plan; anchor each cue to a stable Intro segment ID, media insertion ID or source asset plus source-relative time; then map it into the new transition-aware plan. Preserve duration where the target clip permits and clamp only to the actual target clip. If no reliable target exists, retain the cue text and old time as `DRAFT` with a warning rather than deleting it or assigning it elsewhere.

Add `forceSubtitleReReview(scopes)` in Main. The operation validates a non-empty Intro／Main scope, preserves all text and timecodes, keeps `REJECTED` cues unchanged, changes selected active cues to `DRAFT`, and invalidates only the selected review revision. Renderer requires a confirmation dialog, rejects the action while local unsaved edits exist, selects the first affected cue and directs the user to play each cue and verify picture, text, start and end.

## Consequences

- Timing mutations remain deterministic and transition-aware.
- Forced review is a project-state edit and participates in the existing undo history; it does not edit media, proxies, MP4 or SRT files.
- A user must explicitly reconfirm cues individually or with the existing batch controls and save. Draft cues remain excluded from SRT and subtitle burn-in.
- The App does not claim computer vision has verified head/tail accuracy merely because remapping succeeded; human playback review remains available and explicit.
