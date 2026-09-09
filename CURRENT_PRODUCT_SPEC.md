# Current Product Spec — v0.46.0

## Scope

Windows-first read-only source organizer. The first visible workflow remains source selection, thumbnail/proxy preview, ordering, IN/OUT, Intro and preview MP4 output. Sources, SOP files and previous releases are never overwritten.

## Canonical project state

- `ProjectManifest` is the persisted source of truth; schema 14 migrates older manifests without dropping fields.
- Main and Intro timeline revisions and subtitle review revisions are tracked independently.
- `ProjectStore` emits `project:changed` after every persisted mutation. Renderer state replaces only the canonical snapshot; changing project while a background job is running is blocked with an owning-project message.
- Background jobs carry `projectId`, project name and timeline revision for auditability.

## Subtitle and AI rules

- AI knowledge subtitles use Codex/ChatGPT login fallback when OpenAI API billing is unavailable; speech transcription remains opt-in.
- AI regeneration modes: fill blanks, preserve human edits, or replace AI cues in the selected scope. Manual/imported/user-edited cues are protected.
- Subtitle burn-in is per-output and opt-in. The checkbox can always be cancelled before render; enabling still requires confirmed, current Main cues.
- AI-generated subtitle cues are persisted as `CONFIRMED` immediately. The subtitle review page offers a visible all-scope confirm/unconfirm toggle, selected-cue confirm/unconfirm/delete actions, and a per-cue delete button. Shift selects a contiguous range for batch actions; deleting a cue only removes it from the manifest.

## Timeline and output

`src/shared/timeline-plan.ts` is the deterministic plan layer used for output position, overlap duration, subtitle mapping and BGM clipping. Proxy files remain derived cache and never become formal sources.

## Editing UX

All millisecond fields use the shared minute/second/millisecond editor. The renderer exposes autosave state and protects dirty Subtitle/BGM drafts when a canonical project snapshot arrives from another window or background job.

The main screen exposes seven primary workspaces: sources/order, Intro, BGM, subtitles, preview/output library, publishing settings, and AI publishing assets. Per-material edits enter a single Material Editor workspace before opening the detailed safe editor. Output pages use the shared compact OutputLibrary provider for recent files and actions. As of v0.41.0, `useOutputLibrary` and `OutputRecordActions` are the shared query/action layer for Concat, Intro, subtitle and global output views; global registration/removal and platform handoff remain owned by OutputHistoryModal.

## v0.42.0 incremental fix

The permanent-subtitle checkbox is explicitly reversible before rendering. A saved enabled preference remains visually and functionally actionable even when the current project has no confirmed cues or requires subtitle review; turning it off is always allowed and persists `enabled: false`. Enabling still requires confirmed, current subtitles. The source files and existing output are never modified by this setting change.

## v0.43.0 publishing vertical slice

v0.42.0 contained partial domain/IPC scaffolding only. v0.43 adds the visible seventh `AI 發布素材` workspace, editable topic snapshot, title/description/hashtags/chapter review, external-AI prompt copy/paste validation, traceable thumbnail candidate editing and local 1280×720 render/import path, plus a visible Intro-to-Shorts flow. Shorts explicitly validates selected Intro segments and writes `purpose=SHORTS` output history records. YouTube upload accepts a selected thumbnail only after final user confirmation; `videos.insert` success and `thumbnails.set` failure are reported separately with retry.

Remote publishing-material generation remains honest: the current service uses a traceable local fallback/template after an account diagnostic and does not claim an unimplemented model response as Structured Output. AI image generation is not claimed; only source-frame composition or user-imported JPG/PNG is used.

## v0.44.0 true AI generation contract

OpenAI Responses (`store:false`, active vision model, strict `json_schema`) now receives only the topic/context, canonical transition-aware timeline summary and three low-resolution cached candidate frames. If the active API account fails, the service attempts the Codex/ChatGPT CLI provider with `--ephemeral --ignore-user-config --sandbox read-only --output-schema`; only when both providers fail is the result labeled `LOCAL_FALLBACK`. Provider/model and complete failure reasons are persisted in warnings. External AI paste-back uses the same full schema and validates candidate IDs and chapter rules. AI image generation remains disabled; thumbnail generation is local composition or user JPG/PNG import.

## v0.45.0 YouTube final review gate

The upload payload is composed once from the selected title, Chinese description, English summary, chapter time codes and hashtags. Chapter text and hashtags are reserved ahead of prose when enforcing YouTube's 5,000-character description limit. The upload workflow has a separate final-review step that streams only the selected OutputHistory MP4 and the current manifest's selected thumbnail. It displays the exact text payload, channel, privacy, audience setting and chapter status, and requires an explicit human review checkbox before `youtube:upload` can be invoked. YouTube transcoding, copyright and community checks remain authoritative in YouTube Studio.

## Verification baseline

Run `npm run typecheck`, `npm test`, `npm run build`, `npm audit --audit-level=high`, `npm run package:win`, and `npm run smoke:packaged`. See `docs/VERIFICATION.md` for the release record.
