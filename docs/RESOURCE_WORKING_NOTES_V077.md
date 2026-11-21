# v0.77 Render Resource Working Notes

## Locked baseline

- v0.76 release and running userData are read-only for this audit.
- Real project: `033e4b53-b4fa-4418-95d2-5f7bc4b6df86`, 92 selected clips plus one generated main-start card.
- Timeline duration: 8,970.208 seconds; profile used to reproduce the report: 4K H.264 QSV, High Speed, 10 inputs per stage, up to 4 jobs.

## Reproduced 656.1 GiB estimate

| Contributor                              | v0.76 estimate |
| ---------------------------------------- | -------------: |
| Retained 4K intermediates                |    444.978 GiB |
| Concurrent partial estimate              |    124.594 GiB |
| Reusable picture/base-audio video master |     41.294 GiB |
| Audio temporary                          |      2.104 GiB |
| Final output                             |     39.690 GiB |
| Mux overhead                             |      3.425 GiB |
| Peak working estimate                    |    656.085 GiB |
| Separate 20% safety reserve              |    131.217 GiB |
| Required free                            |    787.302 GiB |

The value is reproducible from the real request. It is not a stale UI value. The primary causes are:

1. `simulateSegmentStages` adds every intermediate to `liveBytes` and never models a last consumer or early collection.
2. Every 4K intermediate is budgeted at 380 Mbps even though the delivery profile is 35 Mbps H.264.
3. The concurrent-partial formula is 28% of the already cumulative retained-intermediate peak.
4. The reusable master is a complete video plus base-audio MKV, not an audio-only master.

## Confirmed render/storage boundaries

- Sources are read-only and must never be moved, modified, or deleted.
- Resume work is kept in the app-owned `.<output>.<checkpoint>.resume` root.
- A completed final-ready segment plus checkpoint metadata is the minimum durable resume set.
- Normalized/transition partials can be deleted after their validated final-ready consumer exists.
- The persistent picture/base-audio master enables audio-only changes to use `-c:v copy`; only the latest validated master is retained.
- Picture stream copy is legal only when the complete picture signature and uniform stream parameters match and no remaining visual transition/subtitle/watermark/filter is required.

## Audit priorities

1. Per-volume peak-concurrency lifetime estimator and explicit contributors.
2. Storage/RAM budgets and scheduler admission control.
3. Dependency-aware cleanup without weakening checkpoint/resume.
4. Measured mode differentiation: Low Disk, Balanced, High Speed.
5. Lazy first-valid-frame intro thumbnails and compact controls.

## Benchmark rule

Use bounded 30–60 second samples before any 3–5 minute comparison. Prefer null/scratch outputs with explicit size/time limits. Never run a full-project benchmark as part of development verification.

## 30-second 4K intermediate bitrate benchmark (2026-09-22)

- Source: `VID_20260718_133852_00_225.mp4` (3840x2160 HEVC); source remained read-only.
- Common path: CPU decode/scale to 3840x2160 NV12, `h264_qsv`, `global_quality=20`, 30000/1001 fps.
- v0.76-style 380 Mbps cap: 24.73 s, 697,708,922 bytes.
- v0.77 Low Disk 45 Mbps cap: 24.43 s, 174,489,696 bytes.
- Result: 75.0% lower intermediate size with no speed regression on this sample.
- Downscaled 960x540 PSNR spot-check: legacy average 20.581 dB; v0.77 average 20.644 dB. The absolute value is affected by phone-source timing/reorder alignment, so only the like-for-like delta is used; it did not show a quality regression.
- This validates the bitrate/storage change only. Full subtitle/transition/A-V quality remains covered by integration tests and a future authorized 3–5 minute project benchmark.

## Bounded 180-second 4K intermediate matrix (2026-09-22)

- Scope: intermediate-stage validation only. The selected read-only source is a 29.433039-second, 3840x2160 H.264 video-only cache file, looped with `-stream_loop -1` to 180 seconds. This sample does not contain audio and therefore does not exercise subtitle, transition, overlay/photo, or audio-mix stages. It must not be presented as a complete project render benchmark.
- Source: a local, read-only 4K benchmark fixture; SHA-256 before/after matched (unchanged). The private source path and fingerprint are omitted from this public note.
- All runs used one job, the same source, isolated app-owned TEMP, a 20 GiB output hard cap, 3840x2160 NV12 scale/normalization, and `h264_qsv`. The recorded command template was: `ffmpeg -hide_banner -loglevel error -y -stream_loop -1 -i <source> -t 180 -vf fps=30000/1001,scale=3840:2160:flags=bicubic,format=nv12,setsar=1,settb=AVTB,setpts=PTS-STARTPTS -an -c:v h264_qsv -preset medium -global_quality 20 -b:v <rate> -maxrate <max> -bufsize <buf> -profile:v high -pix_fmt yuv420p -r 30000/1001 -map_metadata -1 -metadata:s:v:0 rotate=0 -progress <progress> -nostats <output>`.

| Profile                    |      Wall |   fps / speed |          Output |        RAM peak | CPU mean | GPU decode counter | Result |
| -------------------------- | --------: | ------------: | --------------: | --------------: | -------: | -----------------: | ------ |
| v0.76 legacy 380 Mbps      | 151.189 s | 36.07 / 1.20x | 8,076,448,958 B | 1,366,061,056 B |   18.50% |             65.78% | PASS   |
| v0.77 LOW_DISK 45 Mbps     | 104.073 s | 52.42 / 1.75x | 1,033,237,450 B |   765,464,576 B |   26.88% |             44.42% | PASS   |
| v0.77 BALANCED 54.9 Mbps   | 105.416 s | 51.59 / 1.72x | 1,203,410,311 B |   812,519,424 B |   26.30% |             42.87% | PASS   |
| v0.77 HIGH_SPEED 64.8 Mbps | 108.389 s | 50.01 / 1.67x | 1,258,498,150 B |   799,076,352 B |   25.11% |             42.03% | PASS   |

- Relative to the legacy run, LOW_DISK reduced wall time 31.16% (throughput +45.27%), BALANCED reduced wall time 30.28% (throughput +43.42%), and HIGH_SPEED reduced wall time 28.31% (throughput +39.49%). Output size fell 87.21%, 85.10%, and 84.42%, respectively. All outputs probed as H.264/yuv420p/3840x2160/30000/1001 with 180.013 s duration.
- GPU encode, GPU compute, and VRAM are recorded as unavailable: this Windows counter path did not expose reliable per-engine encode/compute or dedicated-memory values. SSD figures were total physical-disk samples rather than source/output-isolated counters and are not used as a causal claim. No output hit the 20 GiB cap.
- The command confirms this environment's tested path is `h264_qsv`, not `h264_nvenc`; this bounded result does not establish NVENC availability. The matrix validates the v0.77 bitrate/profile storage trade-off and intermediate throughput only; complete project stage performance remains an open verification item.
