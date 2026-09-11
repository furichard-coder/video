# ADR-0047 — Intro-only preview delivery and subtitle parity

Status: accepted for v0.53.0.

## Decision

The existing preview-output surface owns an explicit Main versus Intro-only choice. Intro-only output reuses the current safe render pipeline but contains only selected Intro ranges and writes an `INTRO` output-history record. The same Intro render can opt into confirmed Intro subtitle burn-in and can be handed to YouTube through Chrome drag/drop or the existing official API review flow.

The primary subtitle style is a single 854×480 review-canvas profile shared by Subtitle review and render output. FFmpeg ASS font size, outline and primary-track position scale from that 480p reference to the selected frame size. A second translated track remains independently positioned and uses its existing 1080p font-size reference.

## Safety and publishing boundaries

- Intro-only output never includes Main clips and never overwrites source media or a previous output.
- Intro burn-in reads only confirmed, current `INTRO` cues. Main-only cues and stale Intro cues cannot be burned by mistake.
- Intro YouTube tests do not inherit Main AI titles, thumbnails or chapters automatically. Users review exact video and metadata before the official API call; Chrome handoff still requires the user to drag and publish.
- Intro remains ineligible for BiliBili/TikTok Main-post handoff.
- YouTube processing, copyright and community checks remain authoritative in YouTube Studio.
