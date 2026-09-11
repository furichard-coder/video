import {
  DEFAULT_BGM_VOLUME_PERCENT,
  DEFAULT_IMAGE_DURATION_MS,
  DEFAULT_ZOOM_ENHANCEMENT_PRESET,
  MAX_IMAGE_DURATION_MS,
  MAX_MIX_VOLUME_PERCENT,
  MAX_ZOOM_PERCENT,
  MIN_IMAGE_DURATION_MS,
  MIN_ZOOM_PERCENT,
  PHOTO_INSERTION_EDGE_MARGIN_MS,
  type BgmTrack,
  type MainExclusionRange,
  type MediaInsertion,
  type PreviewRange,
  type ProjectManifest,
  type RenderClipSelection,
  type SourceAsset,
  type SubtitleCue,
  type VolumeSegment,
  type ZoomEnhancementPreset,
  type ZoomSegment,
} from "./domain";

const ZOOM_ENHANCEMENT_PRESETS = new Set<ZoomEnhancementPreset>(["OFF", "BALANCED", "DETAIL", "DENOISE"]);

export function validateImageDurationMs(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(value) || rounded < MIN_IMAGE_DURATION_MS || rounded > MAX_IMAGE_DURATION_MS) {
    throw new Error("照片顯示時間必須介於 3 秒到 7 秒之間。");
  }
  return rounded;
}

export function imageDurationMs(asset: SourceAsset): number {
  if (asset.kind !== "IMAGE") return 0;
  try {
    return validateImageDurationMs(asset.imageDurationMs ?? DEFAULT_IMAGE_DURATION_MS);
  } catch {
    return DEFAULT_IMAGE_DURATION_MS;
  }
}

export function validatePercent(value: number, label = "音量"): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_MIX_VOLUME_PERCENT)
    throw new Error(`${label}必須介於 0% 到 ${MAX_MIX_VOLUME_PERCENT}%。`);
  return Math.round(value * 10) / 10;
}

export function validateVolumeSegments(segments: VolumeSegment[], range: PreviewRange): VolumeSegment[] {
  if (!Array.isArray(segments)) throw new Error("音量區段格式無效。");
  const normalized = segments
    .map((segment) => {
      if (!segment || typeof segment.id !== "string" || !segment.id) throw new Error("音量區段 ID 無效。");
      const startMs = Math.round(segment.startMs);
      const endMs = Math.round(segment.endMs);
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        startMs < range.inMs ||
        endMs > range.outMs ||
        endMs - startMs < 10
      ) {
        throw new Error("每個音量區段必須位於目前 IN／OUT 內，且結束時間晚於開始時間。");
      }
      return { ...segment, startMs, endMs, volumePercent: validatePercent(segment.volumePercent) };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startMs < normalized[index - 1].endMs)
      throw new Error("音量區段不可重疊；請調整開始或結束時間。");
  }
  return normalized;
}

export function clipVolumeSegments(
  segments: VolumeSegment[],
  range: PreviewRange,
): { segments: VolumeSegment[]; adjustedCount: number } {
  let adjustedCount = 0;
  const clipped: VolumeSegment[] = [];
  for (const segment of segments) {
    const startMs = Math.max(segment.startMs, range.inMs);
    const endMs = Math.min(segment.endMs, range.outMs);
    if (startMs !== segment.startMs || endMs !== segment.endMs) adjustedCount += 1;
    if (endMs - startMs >= 10) clipped.push({ ...segment, startMs, endMs });
    else if (endMs <= startMs) adjustedCount += startMs === segment.startMs && endMs === segment.endMs ? 1 : 0;
  }
  return { segments: clipped, adjustedCount };
}

export function normalizeMainExclusionRanges(
  ranges: MainExclusionRange[],
  allowed: PreviewRange,
): MainExclusionRange[] {
  if (!Array.isArray(ranges)) throw new Error("正片排除區段格式無效。");
  const normalized = ranges
    .map((range) => {
      if (!range || typeof range.id !== "string" || !range.id) throw new Error("正片排除區段 ID 無效。");
      const startMs = Math.round(range.startMs);
      const endMs = Math.round(range.endMs);
      if (
        !Number.isFinite(range.startMs) ||
        !Number.isFinite(range.endMs) ||
        startMs < allowed.inMs ||
        endMs > allowed.outMs ||
        endMs <= startMs
      ) {
        throw new Error("每個正片排除區段必須位於目前 IN／OUT 內，且結束時間晚於開始時間。");
      }
      return { ...range, startMs, endMs };
    })
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: MainExclusionRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

export function clipMainExclusionRanges(
  ranges: MainExclusionRange[],
  allowed: PreviewRange,
): { ranges: MainExclusionRange[]; adjustedCount: number } {
  const clipped: MainExclusionRange[] = [];
  let adjustedCount = 0;
  for (const range of ranges) {
    const startMs = Math.max(range.startMs, allowed.inMs);
    const endMs = Math.min(range.endMs, allowed.outMs);
    if (startMs !== range.startMs || endMs !== range.endMs) adjustedCount += 1;
    if (endMs > startMs) clipped.push({ ...range, startMs, endMs });
    else if (startMs === range.startMs && endMs === range.endMs) adjustedCount += 1;
  }
  const normalized = normalizeMainExclusionRanges(clipped, allowed);
  adjustedCount += Math.max(0, clipped.length - normalized.length);
  return { ranges: normalized, adjustedCount };
}

export function validateZoomSegments(segments: ZoomSegment[], allowed: PreviewRange): ZoomSegment[] {
  if (!Array.isArray(segments)) throw new Error("局部放大區段格式無效。");
  const normalized = segments
    .map((segment) => {
      if (!segment || typeof segment.id !== "string" || !segment.id) throw new Error("局部放大區段 ID 無效。");
      const startMs = Math.round(segment.startMs);
      const endMs = Math.round(segment.endMs);
      const zoomPercent = Math.round(Number(segment.zoomPercent) * 10) / 10;
      const centerXPercent = Math.round(Number(segment.centerXPercent) * 10) / 10;
      const centerYPercent = Math.round(Number(segment.centerYPercent) * 10) / 10;
      const enhancementPreset = segment.enhancementPreset ?? DEFAULT_ZOOM_ENHANCEMENT_PRESET;
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        startMs < allowed.inMs ||
        endMs > allowed.outMs ||
        endMs - startMs < 100
      ) {
        throw new Error("每個局部放大區段必須位於目前 IN／OUT 內，且至少 0.1 秒。");
      }
      if (!Number.isFinite(zoomPercent) || zoomPercent < MIN_ZOOM_PERCENT || zoomPercent > MAX_ZOOM_PERCENT) {
        throw new Error(`局部放大倍數必須介於 ${MIN_ZOOM_PERCENT}% 到 ${MAX_ZOOM_PERCENT}%。`);
      }
      if (
        !Number.isFinite(centerXPercent) ||
        centerXPercent < 0 ||
        centerXPercent > 100 ||
        !Number.isFinite(centerYPercent) ||
        centerYPercent < 0 ||
        centerYPercent > 100
      ) {
        throw new Error("局部放大中心點 X／Y 必須介於 0% 到 100%。");
      }
      if (!ZOOM_ENHANCEMENT_PRESETS.has(enhancementPreset)) throw new Error("局部放大畫質優化選項無效。");
      return { ...segment, startMs, endMs, zoomPercent, centerXPercent, centerYPercent, enhancementPreset };
    })
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startMs < normalized[index - 1].endMs)
      throw new Error("局部放大區段不可重疊；請調整開始或結束時間。");
  }
  return normalized;
}

export function clipZoomSegments(
  segments: ZoomSegment[],
  allowed: PreviewRange,
): { segments: ZoomSegment[]; adjustedCount: number } {
  const clipped: ZoomSegment[] = [];
  let adjustedCount = 0;
  for (const segment of segments) {
    const startMs = Math.max(segment.startMs, allowed.inMs);
    const endMs = Math.min(segment.endMs, allowed.outMs);
    if (startMs !== segment.startMs || endMs !== segment.endMs) adjustedCount += 1;
    if (endMs - startMs >= 100) clipped.push({ ...segment, startMs, endMs });
    else if (startMs === segment.startMs && endMs === segment.endMs) adjustedCount += 1;
  }
  return { segments: validateZoomSegments(clipped, allowed), adjustedCount };
}

export function retainedRangesForAsset(asset: SourceAsset): PreviewRange[] {
  if (asset.kind === "IMAGE") return [{ inMs: 0, outMs: imageDurationMs(asset) }];
  if (!asset.mediaInfo?.durationMs) return [];
  const allowed = asset.previewRange ?? { inMs: 0, outMs: asset.mediaInfo.durationMs };
  const exclusions = normalizeMainExclusionRanges(asset.mainExclusionRanges ?? [], allowed);
  const retained: PreviewRange[] = [];
  let cursor = allowed.inMs;
  for (const exclusion of exclusions) {
    if (exclusion.startMs > cursor) retained.push({ inMs: cursor, outMs: exclusion.startMs });
    cursor = Math.max(cursor, exclusion.endMs);
  }
  if (cursor < allowed.outMs) retained.push({ inMs: cursor, outMs: allowed.outMs });
  return retained;
}

export function retainedDurationMs(asset: SourceAsset): number {
  return retainedRangesForAsset(asset).reduce((sum, range) => sum + range.outMs - range.inMs, 0);
}

export function validateMediaInsertion(
  insertion: Pick<MediaInsertion, "anchorVideoAssetId" | "insertedAssetId" | "atMs" | "sourceInMs" | "sourceOutMs">,
  sources: SourceAsset[],
  existing: MediaInsertion[] = [],
  ignoreInsertionId?: string,
): Pick<MediaInsertion, "atMs" | "sourceInMs" | "sourceOutMs"> {
  const video = sources.find((asset) => asset.id === insertion.anchorVideoAssetId);
  const inserted = sources.find((asset) => asset.id === insertion.insertedAssetId);
  if (!video || video.kind !== "VIDEO" || !video.mediaInfo?.durationMs)
    throw new Error("素材安插的主影片尚未取得有效時長。");
  if (!inserted) throw new Error("請選擇專案內的照片或影片素材。");
  if (inserted.id === video.id) throw new Error("影片不可安插自己。");
  const atMs = Math.round(insertion.atMs);
  if (!Number.isFinite(insertion.atMs)) throw new Error("素材安插時間格式無效。");
  const retainedRange = retainedRangesForAsset(video).find(
    (range) =>
      atMs - range.inMs >= PHOTO_INSERTION_EDGE_MARGIN_MS && range.outMs - atMs >= PHOTO_INSERTION_EDGE_MARGIN_MS,
  );
  if (!retainedRange)
    throw new Error("素材安插點必須位於主影片保留範圍內，並距離該段起點與終點至少 0.75 秒，以保留 0.7 秒疊化空間。");
  for (const item of existing) {
    if (item.id === ignoreInsertionId || item.anchorVideoAssetId !== video.id) continue;
    if (item.insertedAssetId === inserted.id) throw new Error("這個素材已安插在此影片中。");
  }
  if (existing.some((item) => item.id !== ignoreInsertionId && item.insertedAssetId === inserted.id))
    throw new Error("這個素材已安插到其他影片時段中。");
  if (existing.some((item) => item.id !== ignoreInsertionId && item.anchorVideoAssetId === inserted.id))
    throw new Error("此影片本身已有安插內容，為避免巢狀時間線，請先取消其安插內容。");
  if (inserted.kind === "IMAGE") return { atMs, sourceInMs: 0, sourceOutMs: imageDurationMs(inserted) };
  const durationMs = inserted.mediaInfo?.durationMs;
  if (!durationMs) throw new Error("要安插的影片尚未取得有效時長。");
  const sourceInMs = Math.round(insertion.sourceInMs);
  const sourceOutMs = Math.round(insertion.sourceOutMs);
  if (
    !Number.isFinite(insertion.sourceInMs) ||
    !Number.isFinite(insertion.sourceOutMs) ||
    sourceInMs < 0 ||
    sourceOutMs > durationMs ||
    sourceOutMs - sourceInMs < PHOTO_INSERTION_EDGE_MARGIN_MS
  ) {
    throw new Error("安插影片的 IN／OUT 必須位於來源影片內，且至少保留 0.75 秒，以支援最長疊化選項。");
  }
  return { atMs, sourceInMs, sourceOutMs };
}

export function mainRenderSelections(project: ProjectManifest): RenderClipSelection[] {
  const sourceById = new Map(project.sources.map((asset) => [asset.id, asset]));
  return project.timelineOrder.flatMap((assetId) => {
    const asset = sourceById.get(assetId);
    if (!asset) return [];
    if (asset.kind === "IMAGE") return retainedRangesForAsset(asset).map((range) => ({ assetId, ...range }));
    const insertions = (project.mediaInsertions ?? [])
      .filter((item) => item.anchorVideoAssetId === asset.id)
      .sort(
        (left, right) =>
          left.atMs - right.atMs ||
          left.sequenceIndex - right.sequenceIndex ||
          left.createdAt.localeCompare(right.createdAt),
      );
    const clips: RenderClipSelection[] = [];
    for (const retained of retainedRangesForAsset(asset)) {
      const within = insertions.filter((item) => item.atMs > retained.inMs && item.atMs < retained.outMs);
      let cursor = retained.inMs;
      for (const insertion of within) {
        if (insertion.atMs > cursor) clips.push({ assetId, inMs: cursor, outMs: insertion.atMs });
        const inserted = sourceById.get(insertion.insertedAssetId);
        if (inserted)
          clips.push({
            assetId: inserted.id,
            inMs: insertion.sourceInMs,
            outMs: insertion.sourceOutMs,
            mediaInsertionId: insertion.id,
          });
        cursor = insertion.atMs;
      }
      if (cursor < retained.outMs) clips.push({ assetId, inMs: cursor, outMs: retained.outMs });
    }
    return clips;
  });
}

export function validateBgmTrack(track: BgmTrack): BgmTrack {
  if (
    (track.resolutionStatus === "NEEDS_LOCAL_FILE" || track.sourceKind === "YOUTUBE_REFERENCE") &&
    !track.sourcePath
  ) {
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(track.sourceUrl ?? "");
    } catch {
      throw new Error("YouTube 配樂參考連結無效。");
    }
    const host = sourceUrl.hostname.toLowerCase().replace(/^www\./, "");
    if (
      sourceUrl.protocol !== "https:" ||
      !["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)
    )
      throw new Error("只接受 HTTPS YouTube／youtu.be 配樂參考連結。");
    return {
      ...track,
      sourceKind: "YOUTUBE_REFERENCE",
      resolutionStatus: "NEEDS_LOCAL_FILE",
      sourcePath: "",
      sizeBytes: 0,
      durationMs: 0,
      sourceInMs: 0,
      sourceOutMs: 0,
      timelineOutMs: track.timelineInMs,
      fadeInMs: 0,
      fadeOutMs: 0,
      volumePercent: validatePercent(track.volumePercent ?? DEFAULT_BGM_VOLUME_PERCENT, "配樂音量"),
    };
  }
  const fields = [
    track.durationMs,
    track.sourceInMs,
    track.sourceOutMs,
    track.timelineInMs,
    track.timelineOutMs,
    track.fadeInMs,
    track.fadeOutMs,
  ];
  if (fields.some((value) => !Number.isFinite(value))) throw new Error("配樂時間格式無效。");
  if (track.sourceInMs < 0 || track.sourceOutMs > track.durationMs || track.sourceOutMs <= track.sourceInMs)
    throw new Error("配樂 source IN／OUT 超出音樂長度。");
  if (track.timelineInMs < 0 || track.timelineOutMs <= track.timelineInMs) throw new Error("配樂時間範圍無效。");
  const sourceSpan = track.sourceOutMs - track.sourceInMs;
  const timelineSpan = track.timelineOutMs - track.timelineInMs;
  if (Math.abs(sourceSpan - timelineSpan) > 50)
    throw new Error("配樂 timeline 長度必須與 source IN／OUT 長度相同；本版不做音樂變速。");
  if (track.fadeInMs < 0 || track.fadeOutMs < 0 || track.fadeInMs + track.fadeOutMs > timelineSpan)
    throw new Error("淡入與淡出總長不可超過配樂區段。");
  return {
    ...track,
    sourceKind: track.sourceKind ?? "LOCAL_FILE",
    resolutionStatus: "READY",
    volumePercent: validatePercent(track.volumePercent, "配樂音量"),
  };
}

export function validateSubtitleCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (!Array.isArray(cues)) throw new Error("字幕格式無效。");
  const normalized = cues
    .map((cue) => {
      if (!cue || typeof cue.id !== "string" || !cue.id) throw new Error("字幕 ID 無效。");
      const startMs = Math.round(cue.startMs);
      const endMs = Math.round(cue.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs)
        throw new Error("字幕結束時間必須晚於開始時間。");
      if (typeof cue.text !== "string" || !cue.text.trim()) throw new Error("字幕文字不可空白。");
      const origins = new Set(["MANUAL", "IMPORTED_SRT", "AI_SPEECH", "AI_VISUAL"]);
      const statuses = new Set(["DRAFT", "CONFIRMED", "REJECTED"]);
      if (cue.origin !== undefined && !origins.has(cue.origin)) throw new Error("字幕來源類型無效。");
      if (cue.reviewStatus !== undefined && !statuses.has(cue.reviewStatus)) throw new Error("字幕審核狀態無效。");
      const timelineScope = cue.timelineScope ?? "MAIN";
      if (timelineScope !== "INTRO" && timelineScope !== "MAIN") throw new Error("字幕時間線範圍無效。");
      const numericScore = (value: number | undefined, label: string) => {
        if (value === undefined) return undefined;
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${label}必須介於 0 到 100。`);
        return Math.round(value);
      };
      const list = (value: string[] | undefined) =>
        value === undefined
          ? undefined
          : value
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 20);
      return {
        ...cue,
        startMs,
        endMs,
        text: cue.text.replace(/\r\n?/g, "\n").trim(),
        timelineScope,
        sourceInMs: cue.sourceInMs === undefined ? undefined : Math.max(0, Math.round(cue.sourceInMs)),
        sourceOutMs: cue.sourceOutMs === undefined ? undefined : Math.max(0, Math.round(cue.sourceOutMs)),
        topicRelevanceScore: numericScore(cue.topicRelevanceScore, "主題相關分數"),
        transcriptVisualMatchScore: numericScore(cue.transcriptVisualMatchScore, "聲畫符合分數"),
        aiConfidence: numericScore(cue.aiConfidence, "AI 信心分數"),
        peopleSummary: list(cue.peopleSummary),
        locationSummary: list(cue.locationSummary),
        animalSpecies: list(cue.animalSpecies),
        speciesExplanation:
          typeof cue.speciesExplanation === "string" ? cue.speciesExplanation.trim().slice(0, 1_000) : undefined,
        aiWarnings: list(cue.aiWarnings),
      };
    })
    .sort(
      (a, b) =>
        (a.timelineScope === "INTRO" ? 0 : 1) - (b.timelineScope === "INTRO" ? 0 : 1) ||
        a.startMs - b.startMs ||
        a.endMs - b.endMs,
    );
  for (const timelineScope of ["INTRO", "MAIN"] as const) {
    const scoped = normalized.filter((cue) => cue.timelineScope === timelineScope && cue.reviewStatus !== "REJECTED");
    for (let index = 0; index < scoped.length; index += 1) {
      for (
        let following = index + 1;
        following < scoped.length && scoped[following].startMs < scoped[index].endMs;
        following += 1
      ) {
        const bothConfirmed =
          (scoped[index].reviewStatus ?? "CONFIRMED") === "CONFIRMED" &&
          (scoped[following].reviewStatus ?? "CONFIRMED") === "CONFIRMED";
        if (bothConfirmed)
          throw new Error(
            `${timelineScope === "INTRO" ? "片頭" : "正片"}已確認字幕不可重疊；請先將其中一筆改為待確認並調整時間。`,
          );
      }
    }
  }
  return normalized;
}
