# v0.76 Render Performance / Disk Reliability Working Notes

## v0.87 subtitle handoff — 2026-10-02

- Root cause: controls before the only scroll panel collapsed its height; 63 DRAFT cues remain in `C:\大雪山\我的素材專案.swproj`. Flexible main scroll region and no-key settings entry verified with actual Electron DOM/screenshots.
- Read-only final `E:\大雪山 YT video\SceneryWalker_preview_20260926_0243.mp4`: 74,888,192,283 bytes, 8,970,194 ms. Current timeline 8,964,908 ms. Legacy output lacks projectId; safely use VIDEO_FIRST (no project write), not fatal analysis rejection.
- Dynamic `/v1/models` succeeds; actual JPEG/JSON request returns `429 / credit_balance_exhausted`. No successful paid AI draft; do not claim live E2E or retry long paid jobs until credits are available.
- Bounded actual 180-second FFmpeg extraction: 90 frames, 5 batches, peak batch JPEG 6,313,794 bytes, retained images 0, elapsed 605,325 ms under concurrent test load. No real dedup savings in this segment; not an isolated speed benchmark.
- v0.87 release built and packaged smoke passed. Latest complete-suite count/status, hashes, changes and remaining limitations: `V087_SUBTITLE_RECOVERY_REPORT.md` / `VERIFICATION.md`. Never overwrite historical release, master, existing SRT or render checkpoint to test subtitles.
- Next test after API credit repair: refresh account models, explicit minimal image probe, then bounded 3-minute real AI draft + content review; not full 149-minute master. Inspect slow extraction separately; do not confuse frame sample frequency with subtitle boundaries.

Updated: 2026-09-22 (Asia/Taipei)

## Confirmed hardware and software evidence

- Host: HP ZBook 15 G3, 24 GiB RAM, Intel HD Graphics 530, NVIDIA Quadro M2000M.
- FFmpeg exposes `h264_qsv`, `hevc_qsv`, `h264_nvenc`, and `hevc_nvenc` on this host.
- Runtime NVENC probe fails on the installed 573.71 driver because FFmpeg 8.1.2 requires NVENC API 13.1 while the driver exposes 13.0. v0.76 therefore uses H.264 QSV on this machine and must not claim NVENC is active merely because the encoder is listed.
- Failed v0.75 job used `H264_QSV`; runtime diagnostics report `encoderName=h264_qsv` and `decoderName=CPU software decode`.
- Failed job timeline: about 8,970 s (149.5 min), 1440p, 93 visual inputs, Normal mode, two parallel jobs, ten-input stage limit.

## Confirmed root causes from the 2026-09-18 failure

- This failure was ENOSPC (`-28`), not ENOMEM (`-12`).
- Output, resume intermediates, and Windows TEMP were all on `C:`.
- `C:` free fell from 93,881,827,328 bytes at render start to 0 bytes at failure.
- The resume root reached about 99.0 GB at failure and had been observed as high as about 127.1 GB while parallel partials existed.
- Six completed stage-one segments totaled about 80.14 GB decimal (74.63 GiB); two more stage-one jobs failed while writing.
- v0.75 estimated stage files from the delivery bitrate, but the QSV global-quality/CQ intermediates were much larger. It also did not gate new jobs on predicted per-volume peak usage.
- v0.75 segment stages render to QSV H.264 intermediates and the final picture/master stage decodes those intermediates through another filter graph and encodes again. This is at least two video encode/decode passes for segmented jobs.
- Runtime samples show CPU software decode, roughly 80-100% CPU, low reported GPU use, and per-job speeds around 0.17x-0.19x. CPU/filter work, not RAM allocation alone, is the primary observed throughput bottleneck.

## Resume status of the failed 05:57:13 job

- Checkpoint JSON remains, with six `COMPLETED` segments and two `FAILED` segments.
- The checkpoint work root no longer exists. The six completed media files therefore cannot pass validation and cannot currently be reused.
- The old 05:57:13 work cannot be resumed without rebuilding missing segment media. v0.76 must surface this as `checkpoint metadata present / segment cache missing`, not pretend it is resumable.

## Benchmarks retained for v0.76

- Controlled 30-second 4K→1440p test: CPU decode + CPU scale + QSV encode `0.967x`; QSV decode + one `hwdownload` + CPU scale + QSV encode `1.10x` (about 12.4% faster).
- Controlled 180-second 4K→1440p confirmation: baseline `171.72 s`, `31.45 fps`, `1.05x`; QSV decode path `162.33 s`, `33.35 fps`, `1.11x` (5.47% lower wall time). The longer result is the conservative planning value.
- Ten-input 1440p xfade: one job `0.647x`; two parallel jobs aggregate `0.673x`, only about 4% more throughput while materially increasing RAM and disk pressure. Normal/High Speed therefore start at one job and probe upward only after a completed wave demonstrates safe throughput gain.
- Intel `scale_qsv` zero-copy failed with the installed HD 530 driver (`Could not create texture 80070057`); OpenCL xfade also failed its hardware-frame context. v0.76 keeps CPU filters with one explicit QSV `hwdownload` instead of pretending an end-to-end GPU graph is available.
- QSV GQ22 reduced a controlled intermediate by about 38%, but quality fell from GQ18 VMAF/PSNR/SSIM `99.9638 / 42.28 / 0.9863` to `99.2268 / 38.05 / 0.9702`. It is not quality-equivalent, so the shipped default remains GQ18 (NVENC CQ18 / software CRF16).

## Implemented v0.76 reliability boundary

- Peak disk estimation separates selected Render TEMP and final output volumes and includes live/reusable intermediates, concurrent partials, audio TEMP, final output, mux overhead, and `max(20 GiB, remaining × 20%)` reserve.
- Render TEMP is user-selectable and write/free-space validated; preflight and runtime use the selected volume rather than assuming Windows TEMP or only `C:`.
- Runtime snapshots are saved every 30 seconds, both volumes are checked, new segment waves stop at a safe boundary under critical pressure, and the checkpoint records `PAUSED_DISK_SPACE` / ENOSPC path / required additional bytes.
- Resume offers first verify physical existence and recorded size. Full ffprobe/hash validation remains immediately before reuse. Missing old media is reported and rebuilt rather than advertised as completed.
- Segment containers use MKV so a process interruption does not depend on MP4 trailer finalization. Controlled H.264 QSV + AAC validation produced 5.021 s, video/audio time base `1/1000`, and about 42 ms tail difference (normal AAC encoder-delay range); the complete FFmpeg integration suite passes.
- Final universal `-c copy` is intentionally not claimed: cross-batch xfade plus final ASS subtitle/watermark composition still requires the picture-master pass. The existing final audio-only mux continues to stream-copy video.

## v0.80 recovery evidence — 2026-09-27

- Recovery source (kept read-only): the project's existing v0.79 resume directory on the selected Render TEMP volume.
- Project/checkpoint: `033e4b53-b4fa-4418-95d2-5f7bc4b6df86` / `d8d72501-a0c5-46df-af3e-4ba4c01c419f`.
- Ten level-1 MKV segments are physically present and ffprobe-readable. They total 72,527,956,978 bytes (67.547 GiB) and 8,976.718 seconds (02:29:36.718) of encoded media. All use H.264 3840×2160 30000/1001 plus AAC stereo.
- The recorded `.base.partial.mkv` no longer exists. v0.79 deleted it in both the error handler and `finally`, before taking its post-failure disk snapshot. Its duration, last timestamp, keyframe boundary, and A/V state therefore cannot be recovered or honestly claimed.
- All ten segment waves completed by about 15:52. The base-master stage then ran until about 18:27. The checkpoint records 85,323,907 ms (23:42:03) cumulative work.
- Runtime evidence confirms H.264 QSV encode and CPU software decode. Base throughput was about 0.10–0.115×. Ten-input waves used one job because observed FFmpeg private-memory peaks reached roughly 9.95–17.81 GiB; raising parallel jobs without shrinking graphs is unsafe on this 24 GiB host.
- v0.79 did not persist raw base-stage stderr or the exact FFmpeg command. Existing state proves that its ENOSPC classifier matched, but cannot independently prove the original FFmpeg `-28` text. A genuine ENOSPC remains a high-confidence inference, not preserved direct evidence.
- The last pre-base snapshot reported E: free 155,105,148,928 bytes (144.45 GiB), work root 72,527,960,339 bytes, remaining write 66,416,310,581 bytes, pressure `OK`, and required additional bytes `0`. The error snapshot repeated the same stale values after v0.79 had already deleted the partial. The UI then used `Math.max(20 GiB, 0)` and falsely reported “free another 20 GB.”

## v0.80 recovery boundary

- v0.79 JSON and work root are immutable recovery sources. v0.80 writes an independent `.v080.render-state.json` and a fresh `.v080.resume` work root; the source JSON is also copied once into `recovery-sources` and its original hash remains unchanged.
- Before import, every completed segment is checked for physical size, ffprobe readability/duration/format, and recorded SHA-256 when available. Valid segments remain reusable; only invalid segments are marked `FAILED` for rebuild.
- Segment references outside the v0.80 work root remain external and read-only. Resume uses the verified recorded path, never a newly derived nonexistent path. Dependency cleanup deletes only files owned by the new work root.
- Successful completion writes an atomic completion marker before deleting the active v0.80 checkpoint. This suppresses both the preserved old failed offer and any late telemetry save that races after publish.
- The current ten level-1 segments are not final-output-equivalent: the base stage still applies cross-group xfade, ASS subtitles, watermark, and neutral FLAC audio. v0.80 therefore resumes at the base-master stage and does not incorrectly `-c copy` those ten files as the final movie.
- Base-master output preserves the v0.79 quality-mode codec arguments. A same-source 30-second H.264 QSV test found that adding `-b:v 64.8M -maxrate 76.5M -bufsize 129.6M` reduced source-relative SSIM from `0.982671` to `0.979853` and took `20.73 s` instead of `20.55 s`; it is not shipped. The master-size estimate now uses a 1.25× headroom over the comparable intermediate estimate plus conservative FLAC, but quality-mode output remains an estimate, not a strict cap. The reusable master is stored on the selected Render TEMP volume instead of silently consuming C:.
- Base-master resource/disk snapshots are persisted every 15 seconds. A true `EMERGENCY` condition asks FFmpeg to stop at a cooperative Matroska boundary, preserves/probes the partial, records the raw bounded error, and pauses. `WARNING` and `CRITICAL` remain warnings; they no longer masquerade as fatal ENOSPC.
- The app no longer invents a 20 GiB required-additional value when the measured deficit is zero. Recommended reserve and hard inability-to-finish are separate decisions.
- Universal final `-c copy` is still intentionally disabled for this recovery because doing so would omit required transitions/subtitles/watermark. Video is stream-copied during the separate final audio mix/remux after the base picture master is complete.
