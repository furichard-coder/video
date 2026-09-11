# Current Product Spec — v0.58.0

## Scope

Windows-first read-only source organizer. The first visible workflow remains source selection, thumbnail/proxy preview, ordering, IN/OUT, Intro and preview MP4 output. Sources, SOP files and previous releases are never overwritten.

## v0.58.0 adjustable subtitle width with true preview, transparent master bus

- Subtitle display format gains 每行字數: 6–40 manual override, blank means automatic width-derived wrap as before. The setting persists with the existing style preset and flows into ASS burn-in.
- The subtitle-page preview overlay wraps with the identical shared helper, so line breaks match the finished MP4 at any output resolution (wrap ratio is resolution-invariant by construction).
- Master bus no longer rides the program: acompressor threshold -6 dB ratio 4 → -1 dB ratio 2, so it only catches true peaks under the ceiling and preserves the contrast created by per-clip ducking. Measured on synthetic material: detector-band bursts still duck ≈4 dB, beds untouched, non-detector loud passages keep ≈1.9 dB more contrast than before, peaks still capped.
- Audio panel documents the most audible combination (6 dB + crowd preservation off) and states EQ/ceiling are subtle by design.

## v0.57.0 background render with concurrent subtitle work

- Concat/Intro render runs as a background job: pressing × closes the render window and returns to the main screen while encoding continues; the main-screen background-jobs banner keeps showing live percent.
- Reopening the render page while a render runs adopts it in monitoring mode (live progress, cancel still available, no second render can start); completion or failure is reported in place and the finished file appears in the output library.
- Subtitle review and SRT export stay fully usable during a render. The running render uses the project snapshot taken at start (store `getProject()` deep-clones), so later subtitle edits never alter the in-flight output; the UI states that the finished file reflects the content at render start.
- Explicit 取消產出 still aborts through the single-flight controller with the existing safe-finalize contract; closing the window never cancels.

## v0.56.0 immediate per-cue subtitle persistence

- Every visible subtitle row owns a native textarea and adjacent per-row actions: confirm, delete, move up and move down. Focusing or clicking the textarea must preserve normal native caret placement, selection, arrow navigation and text entry; row selection remains isolated on the numbered selector.
- Individual confirmation persists the current complete cue snapshot immediately through the canonical Main-process `setSubtitleCues` validation path. The UI reports success only after the manifest write returns successfully; a write failure leaves the edit dirty and visible with an error.
- Forced review does not advance to the next cue until the current confirmation write succeeds. Global confirmation toggles and Shift-selected confirm/unconfirm actions use the same immediate persistence contract. Deletion retains its explicit safety prompt and source-media isolation.
- Up/down is defined as moving subtitle content to the adjacent chronological slot within the same Intro/Main scope. The two cues exchange output time and source anchor fields, are both marked `DRAFT`, and are immediately persisted. This preserves deterministic timeline order while requiring a fresh picture/text review after the content position changes.
- The footer save action is retained only for unconfirmed free-form text/time edits. It is disabled when there is no dirty local edit and is not a prerequisite for any confirmation action.

## v0.55.0 versioned delivery, safe confirmations and subtitle review

- Every newly packaged Windows executable includes the semantic version in its filename: `SceneryWalkerSourceOrganizer-v<version>.exe`. The release folder remains versioned separately, so a user can identify the binary even after copying it elsewhere.
- Compact App confirmation overlays identify a non-destructive safe default. When they open, that button receives keyboard focus and the Windows pointer is moved to its center on a best-effort basis. Renderer coordinates are bounded to the owning window before Main converts them to a physical screen point; the helper runs without shell interpolation. Close confirmation defaults to `繼續剪輯`, never `確定關閉`.
- Per-cue Subtitle review requests only the selected source range as a low-resolution H.264 clip proxy instead of transcoding the complete 4K／HEVC source. Cache keys remain bound to source fingerprint and exact IN／OUT. A verified output fingerprint avoids repeated ffprobe startup on later cache hits; mismatch still triggers codec validation and rebuild.
- `強制重新校對` first re-derives selected cues against the canonical current Intro/Main plan, including order, IN／OUT and the selected 0.3／0.5／0.7-second transition. It then opens a per-cue human review queue with `一致，確認並下一筆`, `不一致，修改文字／時間`, skip and finish actions. This is an explicit visual check and does not falsely claim AI verified picture semantics.
- Timeline remapping refreshes `sourceOutMs` together with output time and `sourceInMs`, so the short review proxy always reflects the remapped cue duration. Images use their cached still preview.
- Manually adding an Intro video/photo or a saved zoom range preserves every existing segment IN／OUT and the configured Intro target duration. It no longer invokes equalized redistribution and no longer auto-increases the target. If the new range does not fit the remaining target capacity, the App stops and asks the user to explicitly shorten/remove a segment or change the target.

## v0.54.0 local audio protection and scoped BGM

- `AudioProtectionOptions` is a per-render, persisted preference contract. Current defaults enable the master switch, smooth voice/sudden-event ducking, distant-crowd preservation, scene-sound preservation, a gentle speech-band EQ, 6 dB maximum ducking, 1.5 dB EQ attenuation and a -1 dB peak ceiling. Accepted ranges are 3–6 dB ducking, 0.5–4 dB EQ and -1／-2 dB ceiling.
- The detector is strictly local and acoustic. Each source-audio stream is split into dry, wet and detector paths; the detector is high-pass/low-pass constrained to 1–4 kHz and drives `sidechaincompress`. A dry-floor plus compressed-wet blend bounds the deepest automatic reduction to the chosen 3–6 dB. Preserve-ambience mode raises the threshold; preserve-scene-sound mode uses 45 ms attack and 500 ms release for smooth recovery.
- Optional 2.5 kHz equalization gently reduces speech intelligibility across the requested 1–4 kHz region. Final program audio passes through a compressor and `alimiter` at the selected -1 or -2 dB ceiling, covering broad-band sudden shouts, impacts and clipping risk as well as speech-band events.
- The App must not label acoustic inference as semantic privacy classification. It cannot understand speech content or reliably distinguish all screams, child cries, laughter, market calls, footsteps and other overlapping spectra. The UI exposes this limitation and requires a post-render listening pass. No audio is uploaded for this feature and no editable detector keyframe list is fabricated.
- `BgmScopeSelection` independently enables Intro and Main music for `CONCAT`. Both selected preserves the continuous existing mix. Intro-only truncates the MP3 plan at the actual start-card boundary and enforces up to a 1.5-second fade ending before the card. Main-only shifts the saved BGM timeline to the actual first-Main start after the card. Boundaries consume the selected 0.3／0.5／0.7-second transition style, including hard-cut behavior.
- All validation runs in Main. Renderer submits numeric settings and scopes only; FFmpeg values are bounded before filter construction. Sources and MP3 files remain read-only, output keeps the existing unique-partial／atomic-finalize contract, and render sleep protection remains active until cleanup completes.
- Main and Intro timing mutations continue through `syncSubtitlesToTimeline`: each cue anchors to a stable Intro segment, media insertion or source asset plus source-relative time, then remaps against the new clip duration, order and selected transition overlap. Unmappable cues retain text/time as `DRAFT`; no cue is silently deleted or reassigned to unrelated footage.
- Subtitle review exposes a confirmed `forceSubtitleReReview(scopes)` Main-process operation. It preserves cue text/times, leaves `REJECTED` cues untouched, marks selected non-rejected cues `DRAFT`, invalidates only the selected scope review revision and records a human-QC warning. Reconfirmation remains per cue or explicit batch, followed by normal save.

## v0.53.0 scoped preview output and subtitle visual parity

- The shared concat-output page has an explicit `CONCAT`／`INTRO` selector. `INTRO` emits only the selected Intro ranges, reuses the same codec, resolution, watermark, BGM, preflight, partial-file and cancellation safety contracts, and never silently includes Main clips.
- A completed Intro preview is an eligible YouTube test artifact. Chrome＋Explorer drag/drop remains the default handoff and the official YouTube API remains the secondary route. Both retain human confirmation and unlisted/private defaults. Intro is still blocked from BiliBili/TikTok Main-post handoff.
- Intro YouTube QA uploads start with an Intro-specific local title/description and do not silently attach the saved Main video's AI title, thumbnail or chapters. This prevents a short test clip from inheriting invalid Main chapter times or misleading publish copy.
- Standalone Intro output and the shared Intro selector expose the same opt-in subtitle burn control. Enabling requires confirmed, current `INTRO` cues; Main cues are excluded. Output history records remain `purpose=INTRO`.
- `SubtitlePreviewStyle.fontSizePx` is defined against the 854×480 subtitle-review canvas. The primary burn-in track consumes this exact profile and scales by output height (`fontSizePx × height ÷ 480`); the UI writes the same preference from either Subtitle review or the render page. Optional translated tracks keep their independent 1080p sizing and position.
- ASS cue placement uses transition-aware logical clip starts for Main and Intro, matching the canonical render plan. Subtitle-page text, render-page settings and output filters therefore no longer use conflicting size or overlap time bases.

## v0.52.0 transition-aware subtitle anchoring, large text and Gemini material vision

- Manifest schema 17 persists one canonical `timelineTransitionSeconds` value limited to 0.3, 0.5 or 0.7 seconds. Renderer preferences synchronize this value before output. Main/Intro timeline plans, AI subtitle placement, visual-material placement, subtitle duration gates, Intro subtitle proxy and publishing chapter duration consume the canonical transition-aware plan.
- Every Main/Intro timeline mutation captures the prior plan, anchors each cue to a stable Intro segment ID, media-insertion ID or source asset plus source-relative time, then maps it into the new plan. Moving or inserting a photo/video therefore moves its cue and shifts following cues. Changing the transition duration itself also remaps cues.
- Confirmed cue collisions introduced by a crossfade shorten the earlier cue when at least 100 ms remains. A cue that cannot be mapped or safely separated is retained as `DRAFT` with a review warning; text is never silently deleted and unrelated footage is never guessed as its source. Successfully mapped scopes advance their subtitle-review revision with the timeline revision.
- Every subtitle-list row exposes a native inline textarea. Focusing it selects that cue without taking over the caret; pointer caret placement, arrows, text selection and typing remain native, while the separate numbered button owns single selection and Shift contiguous multi-selection. Delete shortcuts ignore focused text inputs.
- UI text-size choices are 16, 18, 20, 22, 24 and 26 px. The last two are explicitly labeled 超大 and 特大 and persist through the existing local display preference.
- `GEMINI` replaces `GOOGLE_LENS_ASSISTED` in the material-analysis contract. Photos default to Gemini, while video accepts explicitly selected frames. The service sends only the derived JPEG frame to the configured Gemini model using the encrypted Gemini API key, requests strict JSON, and normalizes a short Traditional-Chinese subtitle, visual/object/location evidence, animal species/common name, species explanation, confidence and warnings.
- Gemini identification must remain evidence-bound: uncertain species use a broader group or `疑似`; no location or species may be inferred from a filename/topic alone. Missing credentials or provider errors are surfaced before any subtitle is inserted. ChatGPT/Codex visual analysis remains selectable as the alternate route.
- Every media render acquires a reference-counted Windows `prevent-app-suspension` blocker before creating output. Failure to activate the blocker prevents render start. The blocker is released only from the render `finally` path after success, failure or cancellation cleanup. While active, normal App close is disabled and the Windows session-end request is prevented; forced shutdown or power loss cannot be guaranteed by an application.

## v0.51.0 overlap review, render preflight and configurable AI density

- A material visual analysis result is never discarded solely because its proposed cue overlaps an existing cue. The result contract includes the editable draft plus the exact overlapping cue IDs, text and time ranges. Non-overlapping drafts may be confirmed immediately; overlapping drafts enter the manifest as `DRAFT` only after the user chooses to open Subtitle review.
- Subtitle review computes overlap pairs live within each Main/Intro scope. Both sides of every active overlap receive a red outline until their ranges no longer intersect. A still-overlapping cue cannot be confirmed individually or by batch; draft overlap is allowed as a temporary editing state, while two confirmed cues remain invalid.
- AI subtitle generation accepts a user-selected target of 1–300 cues, default 100. Sampling density is distributed within retained clips with a minimum readable slot; confirmed existing cues, short clips and unavailable timeline space may reduce the result. Higher values explicitly cost more analysis time and AI usage.
- Every user-facing Main, Intro, Clip and Shorts render requests a preflight estimate for output bytes, render time, current free bytes and estimated free bytes after completion. Main process repeats the disk-space check immediately before launching FFmpeg. A render is denied when its estimated output would leave less than the mandatory 1 GiB reserve.
- Shorts explicitly requests `H265_QSV` and uses the same preflight contract. Estimate numbers are guidance rather than promises because scene complexity, filters, subtitles, BGM, watermarking and system load affect actual output.

## Canonical project state

- `ProjectManifest` is the persisted source of truth; schema 17 migrates older manifests without dropping fields.
- Main and Intro timeline revisions and subtitle review revisions are tracked independently.
- `ProjectStore` emits `project:changed` after every persisted mutation. Renderer state replaces only the canonical snapshot; changing project while a background job is running is blocked with an owning-project message.
- Background jobs carry `projectId`, project name and timeline revision for auditability.

## Subtitle and AI rules

- AI knowledge subtitles use Codex/ChatGPT login fallback when OpenAI API billing is unavailable; speech transcription remains opt-in.
- AI regeneration modes: fill blanks, preserve human edits, or replace AI cues in the selected scope. Manual/imported/user-edited cues are protected.
- Subtitle burn-in is per-output and opt-in. The checkbox can always be cancelled before render; enabling requires confirmed, current cues for the selected Main or Intro scope.
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

## v0.50.0 GPU render and material visual-subtitle workflow

- New renders default to Intel Quick Sync Video (QSV) H.265/HEVC (`hevc_qsv`, MP4-friendly `hvc1`). GPU H.264 (`h264_qsv`) is also available; CPU H.265/H.264 remain explicit fallbacks. The selected encoder is persisted and recorded in output history. Existing legacy preferences are preserved until the user changes them.
- The render UI labels GPU versus CPU choices clearly. The current Windows machine was verified with one-second synthetic H.265 QSV and H.264 QSV encodes; actual project renders still require normal media, filter, transition, subtitle, BGM and watermark QC.
- Each photo card has a checked-by-default visual-analysis option. The user opens the material analysis panel, chooses Main or Intro, and receives an editable subtitle draft containing visual summary, location, visible objects, animal species when supportable, species explanation and source time evidence.
- Each video card can open the same panel and accept one or more source-relative frame times (`mm:ss`, `hh:mm:ss` or decimal seconds). Exact selected frames are extracted into a derived storyboard and analyzed without modifying the source. The current IN/OUT/Intro range is enforced before analysis.
- ChatGPT/OpenAI is the default analysis route with Codex/ChatGPT login fallback. Google Lens is an explicit manual-assisted route: the App opens Lens, the user performs the external selection and pastes the observation back, and ChatGPT/Codex simplifies it. The App never silently uploads local files to Lens.
- Analysis results remain `DRAFT` until the user edits text/time and presses “確認並加入字幕頁”. Only then are cues saved as `CONFIRMED`; all existing subtitles remain untouched. Overlap, out-of-range times and provider failures are surfaced instead of silently inserting content.
- Visual-analysis cache, frame evidence and provider warnings are stored under App Data. Source media, SOP files and existing MP4/SRT outputs remain read-only and are never overwritten.
