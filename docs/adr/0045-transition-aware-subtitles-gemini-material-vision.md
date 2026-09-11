# ADR-0045 — Transition-aware subtitle anchoring and Gemini material vision

Status: accepted for v0.52.0.

## Decision

Persist the selected 0.3/0.5/0.7-second dissolve as project timeline state. Before any Main or Intro ordering/range mutation, capture each subtitle's content anchor from the old canonical plan. After the mutation, resolve the stable Intro segment, media insertion or source-relative asset position in the new plan and move the subtitle with it. Keep unmappable cues as drafts rather than deleting them or assigning an unrelated source.

Replace the manual Google Lens paste-back path with a structured Gemini provider. It receives one App-derived low-resolution JPEG per requested photo/frame, uses the encrypted Gemini API key already managed by AI settings, and returns evidence-bound species/object/location fields plus a short editable subtitle. ChatGPT/Codex remains an alternate material-analysis provider.

## Consequences

- Subtitle order and times remain aligned after source drag/drop, insertion, Intro reordering and transition-duration changes.
- All relevant pages consume one transition-aware timebase; the subtitle review revision advances automatically only when every cue maps safely.
- Crossfade collisions are deterministically shortened where safe; ambiguous cases remain visible drafts for human review.
- Gemini calls require an API key. Browser automation and Google Lens uploads are no longer part of this workflow; full source video is never sent.
- Manifest schema 17 adds `timelineTransitionSeconds`; schemas 1–16 migrate to the historical 0.3-second default without dropping edits.
