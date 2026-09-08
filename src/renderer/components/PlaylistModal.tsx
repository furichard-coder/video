import { useEffect, useMemo, useRef, useState } from "react";
import { PHOTO_SOUND_PREVIEW_URL, type PreviewResult, type RenderClipSelection, type SourceAsset } from "../../shared/domain";
import { imageDurationMs } from "../../shared/editing-rules";
import { formatDuration } from "../format";

interface PlaylistModalProps {
  assets: SourceAsset[];
  clips: RenderClipSelection[];
  onClose(): void;
  onAssetUpdated(asset: SourceAsset): void;
}

export function PlaylistModal({ assets, clips, onClose, onAssetUpdated }: PlaylistModalProps) {
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<PreviewResult>();
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(true);
  const photoSoundRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const items = useMemo(() => clips.map((clip, clipIndex) => ({ clip, clipIndex, asset: assets.find((asset) => asset.id === clip.assetId) })).filter((item): item is typeof item & { asset: SourceAsset } => Boolean(item.asset)), [assets, clips]);
  const currentItem = items[index];
  const current = currentItem?.asset;
  const currentClip = currentItem?.clip;
  const progress = useMemo(() => `${index + 1} / ${items.length}`, [index, items.length]);

  const goNext = () => setIndex((value) => (value + 1 < items.length ? value + 1 : 0));
  const goPrevious = () => setIndex((value) => (value > 0 ? value - 1 : items.length - 1));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrevious();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!current) return;
    const variant = current.kind === "VIDEO" ? "VIDEO_PROXY" : "IMAGE_PREVIEW";
    let active = true;
    let completed = false;
    setPreview(undefined);
    setError(undefined);
    void window.sourceApp
      .ensureMetadata(current.id)
      .then((updated) => {
        if (active) onAssetUpdated(updated);
        return window.sourceApp.ensurePreview(current.id, variant);
      })
      .then((result) => {
        if (!active) return;
        completed = true;
        setPreview(result);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof Error && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      if (!completed) void window.sourceApp.cancelPreview(current.id, variant);
    };
  }, [current?.id, currentClip?.inMs, currentClip?.outMs]);

  useEffect(() => {
    if (!preview || !current || current.kind !== "IMAGE" || !playing) return;
    const timer = window.setTimeout(goNext, imageDurationMs(current));
    return () => window.clearTimeout(timer);
  }, [preview, current?.id, playing]);

  useEffect(() => {
    const player = photoSoundRef.current;
    if (!player || current?.kind !== "IMAGE" || current.photoSoundEnabled === false) return;
    try {
      if (playing) {
        const playback = player.play();
        if (playback && typeof playback.catch === "function") void playback.catch(() => undefined);
      } else {
        player.pause();
      }
    } catch {
      // A preview sound failure must never stop the visual playlist.
    }
  }, [current?.id, currentClip?.mediaInsertionId, current?.photoSoundEnabled, playing, preview]);

  useEffect(() => {
    const player = videoRef.current;
    if (!player || current?.kind !== "VIDEO") return;
    if (playing) void player.play().catch(() => setPlaying(false)); else player.pause();
  }, [playing, preview?.url, current?.id]);

  if (!current) return null;

  return (
    <div className="modal-backdrop playlist-backdrop">
      <section className="playlist-modal" role="dialog" aria-modal="true" aria-label="總體預覽">
        <header className="modal-header">
          <div>
            <span className="eyebrow">總體預覽 · 依目前排序連續播放</span>
            <h2>{current.fileName}</h2>
          </div>
          <div className="playlist-header-actions"><span>{progress}</span><button className="icon-button" type="button" onClick={onClose}>×</button></div>
        </header>

        <div className="playlist-layout">
          <aside className="playlist-items" aria-label="播放順序">
            {items.map((item, assetIndex) => (
              <button key={`${item.clip.assetId}:${item.clip.inMs}:${item.clip.outMs}:${item.clipIndex}`} className={assetIndex === index ? "is-current" : ""} type="button" onClick={() => setIndex(assetIndex)}>
                <span>{String(assetIndex + 1).padStart(2, "0")}</span>
                <span><strong>{item.asset.fileName}</strong><small>{item.asset.kind === "VIDEO" ? `${item.clip.mediaInsertionId ? "影片內安插影片 · " : ""}${formatDuration(item.clip.inMs)} → ${formatDuration(item.clip.outMs)}` : `${item.clip.mediaInsertionId ? "影片內安插照片" : "照片"} · ${imageDurationMs(item.asset) / 1000} 秒`}</small></span>
              </button>
            ))}
          </aside>

          <div className="playlist-player">
            <div className="preview-stage">
              {!preview && !error && <div className="large-loading"><span className="spinner" /><p>準備第 {index + 1} 項預覽…</p></div>}
              {error && <div className="preview-error"><strong>這一項無法預覽</strong><p>{error}</p><button type="button" onClick={goNext}>跳到下一項</button></div>}
              {preview && current.kind === "IMAGE" && <><img src={preview.url} alt={current.fileName} />{current.photoSoundEnabled !== false && <audio ref={photoSoundRef} key={`${current.id}:${currentClip?.mediaInsertionId ?? "main"}`} src={PHOTO_SOUND_PREVIEW_URL} autoPlay={playing} />}</>}
              {preview && current.kind === "VIDEO" && (
                <video ref={videoRef} key={`${preview.url}:${currentClip?.inMs}:${currentClip?.outMs}`} src={preview.url} autoPlay={playing} aria-label={`等比例播放 ${current.fileName}`} onClick={() => setPlaying((value) => !value)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = (currentClip?.inMs ?? 0) / 1000; }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => { if (currentClip && event.currentTarget.currentTime * 1000 >= currentClip.outMs) goNext(); }} onEnded={goNext} preload="auto" />
              )}
            </div>
            <div className="playlist-controls">
              <button type="button" onClick={goPrevious}>← 上一項</button>
              <button type="button" onClick={() => setPlaying((value) => !value)}>{playing ? (current.kind === "IMAGE" ? "暫停輪播" : "❚❚ 暫停") : (current.kind === "IMAGE" ? "繼續輪播" : "▶ 播放")}</button>
              <button type="button" onClick={goNext}>下一項 →</button>
            </div>
            <p>此功能逐項播放 App cache 中的預覽，不會合併、剪輯或輸出來源。</p>
          </div>
        </div>
      </section>
    </div>
  );
}
