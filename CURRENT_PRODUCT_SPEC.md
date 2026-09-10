# Current Product Spec — v0.49.0

## Scope

Windows-first read-only source organizer. The first visible workflow remains source selection, thumbnail/proxy preview, ordering, IN/OUT, Intro and preview MP4 output. Sources, SOP files and previous releases are never overwritten.

## Canonical project state

- `ProjectManifest` is the persisted source of truth; schema 16 migrates older manifests without dropping fields.
- Main and Intro timeline revisions and subtitle review revisions are tracked independently.
- `ProjectStore` emits `project:changed` after every persisted mutation. Renderer state replaces only the canonical snapshot; changing project while a background job is running is blocked with an owning-project message.
- Background jobs carry `projectId`, project name and timeline revision for auditability.

## Subtitle and AI rules

- AI knowledge subtitles use Codex/ChatGPT login fallback when OpenAI API billing is unavailable; speech transcription remains opt-in.
- AI regeneration modes: fill blanks, preserve human edits, or replace AI cues in the selected scope. Manual/imported/user-edited cues are protected.
- Subtitle burn-in is per-output and opt-in. The checkbox can always be cancelled before render; enabling still requires confirmed, current Main cues.
- Burned-in subtitles are video pixels and are never edited in place. Subtitle-only corrections create a new output from a clean no-subtitle video or the read-only sources; old MP4 outputs are not overwritten. SRT or a future soft-subtitle track may be replaced without video re-encoding.
- AI-generated subtitle cues are persisted as `CONFIRMED` immediately. The subtitle review page offers a visible all-scope confirm/unconfirm toggle, selected-cue confirm/unconfirm/delete actions, and a per-cue delete button. Shift selects a contiguous range for batch actions; deleting a cue only removes it from the manifest.

## Timeline and output

`src/shared/timeline-plan.ts` is the deterministic plan layer used for output position, overlap duration, subtitle mapping and BGM clipping. Proxy files remain derived cache and never become formal sources.

## Editing UX

All millisecond fields use the shared minute/second/millisecond editor. The renderer exposes autosave state and protects dirty Subtitle/BGM drafts when a canonical project snapshot arrives from another window or background job.

The main screen exposes eight primary workspaces: sources/order, Intro, BGM, subtitles, project watermark, preview/output library, publishing settings, and AI publishing assets. Per-material edits enter a single Material Editor workspace before opening the detailed safe editor. Output pages use the shared compact OutputLibrary provider for recent files and actions. As of v0.41.0, `useOutputLibrary` and `OutputRecordActions` are the shared query/action layer for Concat, Intro, subtitle and global output views; global registration/removal and platform handoff remain owned by OutputHistoryModal.

On the Subtitle workspace, the shared Intro preview history is collapsible and defaults to collapsed so it cannot consume the synchronized video review area. The Intro workspace keeps the history expanded as before. Expanding the Subtitle history mounts the same shared `OutputLibrary`, so playback, reveal and copy actions remain canonical.

## v0.42.0 incremental fix

The permanent-subtitle checkbox is explicitly reversible before rendering. A saved enabled preference remains visually and functionally actionable even when the current project has no confirmed cues or requires subtitle review; turning it off is always allowed and persists `enabled: false`. Enabling still requires confirmed, current subtitles. The source files and existing output are never modified by this setting change.

## v0.43.0 publishing vertical slice

v0.42.0 contained partial domain/IPC scaffolding only. v0.43 adds the visible seventh `AI 發布素材` workspace, editable topic snapshot, title/description/hashtags/chapter review, external-AI prompt copy/paste validation, traceable thumbnail candidate editing and local 1280×720 render/import path, plus a visible Intro-to-Shorts flow. Shorts explicitly validates selected Intro segments and writes `purpose=SHORTS` output history records. YouTube upload accepts a selected thumbnail only after final user confirmation; `videos.insert` success and `thumbnails.set` failure are reported separately with retry.

Remote publishing-material generation remains honest: the current service uses a traceable local fallback/template after an account diagnostic and does not claim an unimplemented model response as Structured Output. AI image generation is not claimed; only source-frame composition or user-imported JPG/PNG is used.

## v0.44.0 true AI generation contract

OpenAI Responses (`store:false`, active vision model, strict `json_schema`) now receives only the topic/context, canonical transition-aware timeline summary and three low-resolution cached candidate frames. If the active API account fails, the service attempts the Codex/ChatGPT CLI provider with `--ephemeral --ignore-user-config --sandbox read-only --output-schema`; only when both providers fail is the result labeled `LOCAL_FALLBACK`. Provider/model and complete failure reasons are persisted in warnings. External AI paste-back uses the same full schema and validates candidate IDs and chapter rules. AI image generation remains disabled; thumbnail generation is local composition or user JPG/PNG import.

## v0.45.0 YouTube final review gate

The upload payload is composed once from the selected title, Chinese description, English summary, chapter time codes and hashtags. Chapter text and hashtags are reserved ahead of prose when enforcing YouTube's 5,000-character description limit. The upload workflow has a separate final-review step that streams only the selected OutputHistory MP4 and the current manifest's selected thumbnail. It displays the exact text payload, channel, privacy, audience setting and chapter status, and requires an explicit human review checkbox before `youtube:upload` can be invoked. YouTube transcoding, copyright and community checks remain authoritative in YouTube Studio.

## v0.48.0 project watermark and visible AI publishing results

Watermark settings are canonical project state in schema 16. The verified Caota Sand Dunes default is Chinese `漫步\n風光` at lower-left and `SceneryWalker` at lower-right, scaled from a 1080p baseline of 51/41 px and 63 px safe margins. The default cadence starts at 0 seconds, repeats every 360 seconds, stays visible for 15 seconds and fades in/out for 1 second. Text and box opacity default to 82% and 24%. Main-complete output and standalone Intro are enabled by default; Shorts is explicit opt-in. Main-process normalization requires distinct lower corners and validates every timing/opacity/size limit. The final drawtext pass is applied only to new output after optional subtitle composition.

AI publishing visual candidates now prioritize the exact midpoint of selected Intro ranges, then fill from the canonical Main timeline. Candidate extraction creates three traceable, low-resolution analysis frames at their declared source time codes. OpenAI/Codex prompts include the topic, story promise, Intro order, Main timeline and candidate origin, and explicitly ask titles and thumbnail concepts to reflect the opening visuals. After any provider result—including honest local fallback—the App builds three local 1280×720 thumbnail previews from the referenced source frames. The scrolling result summary immediately shows provider, selected title and selected thumbnail; remote AI image fabrication remains out of scope.

## v0.49.0 upload handoff, codec, publishing review and species evidence

- The default YouTube handoff opens the official upload page in Chrome, copies the indexed latest Main MP4 path and asks Windows File Explorer to select that exact file. The human performs the actual cross-application drag and final YouTube publish action. The existing OAuth/API flow remains an explicit secondary choice and retains its final-review gate.
- New render preferences default to H.265/HEVC (`libx265`, `hvc1`) with H.264/AVC as the compatibility option. The chosen codec and the per-render watermark choice are validated in Main, persisted in user preferences/output history, and sent explicitly by the Renderer. Watermark is checked by default; opting out affects only the new output.
- Watermark settings use responsive auto-fit grids, width containment and wrapping footer actions so narrow windows do not overlap or cover controls.
- Codex/ChatGPT is the primary publishing-material generator. OpenAI API is a fallback on the same OpenAI path; optional Gemini 2.5 Flash is a second reviewer that can recommend only an existing generated title ID and thumbnail ID. Gemini failure never discards or relabels the ChatGPT result.
- The publishing workbench presents selected output, titles and visible thumbnails before description/chapters/advanced paste-back. Title prompts require distinct, scene-specific candidates within 100 characters; thumbnail copy is brief and composition-aware while remaining tied to traceable source frames.
- Subtitle story-frame evidence may include `animalSpecies` and `speciesExplanation`. Empty means no animal detected. Uncertain sightings must use a broader class or `疑似`, reduce confidence and add a warning; no species fact may be invented from topic text alone.

## Verification baseline

Run `npm run typecheck`, `npm test`, `npm run build`, `npm audit --audit-level=high`, `npm run package:win`, and `npm run smoke:packaged`. See `docs/VERIFICATION.md` for the release record.
