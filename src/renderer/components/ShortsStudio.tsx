import { useEffect, useMemo, useState } from "react";
import type {
  AudioProtectionOptions,
  ConcatRenderEstimate,
  IntroSuggestion,
  OutputSelection,
  PreviewResolution,
  ProjectManifest,
} from "../../shared/domain";
import { DEFAULT_AUDIO_PROTECTION_OPTIONS } from "../../shared/domain";
import { formatBytes, formatDuration } from "../format";
import { AudioProtectionSettings } from "./AudioProtectionSettings";

interface Props {
  project: ProjectManifest;
  onProjectUpdated(project: ProjectManifest): void;
  onClose(): void;
}

export function ShortsStudio({ project, onClose }: Props) {
  const [segments, setSegments] = useState<IntroSuggestion[]>(() => structuredClone(project.introSegments));
  const [limit, setLimit] = useState<60 | 180>(60);
  const [includeBgm, setIncludeBgm] = useState(true);
  const [resolution, setResolution] = useState<PreviewResolution>("1080P");
  const [lowMemorySegmented, setLowMemorySegmented] = useState(true);
  const [audioProtection, setAudioProtection] = useState<AudioProtectionOptions>(() => ({
    ...DEFAULT_AUDIO_PROTECTION_OPTIONS,
  }));
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const [output, setOutput] = useState<OutputSelection>();
  const [estimate, setEstimate] = useState<ConcatRenderEstimate>();
  const [result, setResult] = useState<{ jobId: string; outputPath: string; sizeBytes: number }>();
  const assets = useMemo(() => new Map(project.sources.map((asset) => [asset.id, asset])), [project.sources]);
  const durationMs = Math.max(
    0,
    segments.reduce((sum, item) => sum + item.outMs - item.inMs, 0) - Math.max(0, segments.length - 1) * 300,
  );

  const prepareOutput = async () => {
    setChecking(true);
    setError(undefined);
    try {
      setOutput(await window.sourceApp.prepareConcatOutput(`SceneryWalker_Shorts_${limit}s.mp4`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void prepareOutput();
  }, [limit]);

  useEffect(() => {
    void window.sourceApp
      .getUserPreferences()
      .then((preferences) => {
        setAudioProtection({
          ...DEFAULT_AUDIO_PROTECTION_OPTIONS,
          ...(preferences.renderDefaults.audioProtection ?? {}),
        });
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const updateAudioProtection = (next: AudioProtectionOptions) => {
    setAudioProtection(next);
    void window.sourceApp
      .updateUserPreferences({ renderDefaults: { audioProtection: next } })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  useEffect(() => {
    if (!output || !window.sourceApp.estimateConcatRender || durationMs <= 0) {
      setEstimate(undefined);
      return;
    }
    let active = true;
    setChecking(true);
    void window.sourceApp
      .estimateConcatRender({
        outputToken: output.token,
        expectedDurationMs: durationMs,
        resolution,
        videoCodec: "H265_QSV",
        lowMemorySegmented,
        orderedAssetIds: segments.map((item) => item.assetId),
        clipSelections: segments.map((item) => ({ assetId: item.assetId, inMs: item.inMs, outMs: item.outMs })),
        transitionSeconds: 0.3,
      })
      .then((value) => {
        if (active) {
          setEstimate(value);
          setError(value.canRender ? undefined : value.warning);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [durationMs, lowMemorySegmented, output?.token, resolution, segments]);

  const move = (index: number, delta: number) => {
    const next = [...segments];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSegments(next);
  };

  const start = async () => {
    if (!output) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      if (window.sourceApp.estimateConcatRender) {
        const latest = await window.sourceApp.estimateConcatRender({
          outputToken: output.token,
          expectedDurationMs: durationMs,
          resolution,
          videoCodec: "H265_QSV",
          lowMemorySegmented,
          orderedAssetIds: segments.map((item) => item.assetId),
          clipSelections: segments.map((item) => ({ assetId: item.assetId, inMs: item.inMs, outMs: item.outMs })),
          transitionSeconds: 0.3,
        });
        setEstimate(latest);
        if (!latest.canRender) {
          setError(latest.warning);
          return;
        }
        const selectedWarnings = lowMemorySegmented
          ? latest.modeEstimates?.lowMemory.warnings
          : latest.modeEstimates?.normal.warnings;
        if (selectedWarnings?.length && !window.confirm(`${selectedWarnings.join("\n")}\n\n仍要繼續轉檔嗎？`)) return;
      }
      const completed = await window.sourceApp.startConcatRender({
        outputToken: output.token,
        orderedAssetIds: segments.map((item) => item.assetId),
        clipSelections: segments.map((item) => ({ assetId: item.assetId, inMs: item.inMs, outMs: item.outMs })),
        transitionSeconds: 0.3,
        resolution,
        videoCodec: "H265_QSV",
        lowMemorySegmented,
        resourceWarningAcknowledged: true,
        purpose: "SHORTS",
        shortsSource: "INTRO",
        shortsPortrait: true,
        shortsMaxDurationSec: limit,
        prependIntro: false,
        includeBgm,
        audioProtection,
        estimatedDurationMs: durationMs,
        subtitleBurnIn: { enabled: false, tracks: [] },
      });
      setResult(completed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      void prepareOutput();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="editor-modal shorts-modal" role="dialog" aria-modal="true" aria-label="製作 Shorts">
        <header className="modal-header">
          <div>
            <span className="eyebrow">SHORTS · INTRO SEGMENTS</span>
            <h2>製作 Shorts</h2>
            <p>只複製目前已確認片頭片段的選擇與順序，不改動原本 Intro。直式輸出保留比例，橫式素材使用同源模糊背景。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="shorts-body">
          <div className="shorts-options">
            <label>
              長度上限
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value) as 60 | 180)}>
                <option value={60}>60 秒（專案預設）</option>
                <option value={180}>180 秒（明確選擇）</option>
              </select>
            </label>
            <fieldset className="render-choice-group compact-render-choice" aria-label="Shorts 輸出解析度">
              <legend>輸出解析度</legend>
              {(["1080P", "1440P"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={resolution === value ? "is-selected" : ""}
                  aria-pressed={resolution === value}
                  onClick={() => setResolution(value)}
                >
                  {value === "1440P" ? "1440p（2K）· 1440×2560" : "1080p · 1080×1920"}
                </button>
              ))}
            </fieldset>
            <fieldset className="render-choice-group compact-render-choice" aria-label="Shorts 轉檔模式">
              <legend>轉檔模式</legend>
              <button
                type="button"
                className={lowMemorySegmented ? "is-selected" : ""}
                aria-pressed={lowMemorySegmented}
                onClick={() => setLowMemorySegmented(true)}
              >
                低記憶體分段（預設）
              </button>
              <button
                type="button"
                className={!lowMemorySegmented ? "is-selected" : ""}
                aria-pressed={!lowMemorySegmented}
                onClick={() => setLowMemorySegmented(false)}
              >
                一般模式
              </button>
            </fieldset>
            <label>
              <input type="checkbox" checked={includeBgm} onChange={(e) => setIncludeBgm(e.target.checked)} />{" "}
              套用目前配樂／音量設定
            </label>
            <span className={durationMs > limit * 1000 ? "inline-warning" : "inline-notice"}>
              目前選定 {formatDuration(durationMs)}／{limit} 秒
            </span>
          </div>
          <AudioProtectionSettings compact value={audioProtection} disabled={busy} onChange={updateAudioProtection} />
          {segments.length ? (
            <div className="shorts-segment-list">
              {segments.map((segment, index) => {
                const asset = assets.get(segment.assetId);
                return (
                  <article key={segment.id}>
                    <div>
                      <strong>
                        {index + 1}. {asset?.fileName ?? segment.fileName}
                      </strong>
                      <span>
                        {formatDuration(segment.outMs - segment.inMs)} · {formatDuration(segment.inMs)}–
                        {formatDuration(segment.outMs)}
                      </span>
                    </div>
                    <button onClick={() => move(index, -1)} disabled={index === 0}>
                      ↑
                    </button>
                    <button onClick={() => move(index, 1)} disabled={index === segments.length - 1}>
                      ↓
                    </button>
                    <button
                      className="danger-text"
                      onClick={() => setSegments((current) => current.filter((item) => item.id !== segment.id))}
                    >
                      排除
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <h3>尚無已確認片頭片段</h3>
              <p>請先到片頭頁確認片段。</p>
            </div>
          )}
          {estimate && (
            <section className={`render-preflight ${estimate.canRender ? "" : "is-blocked"}`}>
              <header>
                <div>
                  <span className="eyebrow">RENDER PREFLIGHT</span>
                  <h3>Shorts 轉檔前預估</h3>
                </div>
              </header>
              <dl>
                <div>
                  <dt>預估大小</dt>
                  <dd>約 {formatBytes(estimate.estimatedOutputBytes)}</dd>
                </div>
                <div>
                  <dt>預估時間</dt>
                  <dd>約 {formatDuration(estimate.estimatedRenderTimeMs)}</dd>
                </div>
                <div>
                  <dt>磁碟剩餘</dt>
                  <dd>{formatBytes(estimate.currentFreeBytes)}</dd>
                </div>
                <div>
                  <dt>完成後預估</dt>
                  <dd>{formatBytes(estimate.estimatedFreeAfterBytes)}</dd>
                </div>
              </dl>
              <div className="render-mode-comparison" role="table" aria-label="Shorts 兩種轉檔模式資源比較">
                {(
                  [
                    ["lowMemory", "低記憶體分段"],
                    ["normal", "一般轉檔"],
                  ] as const
                ).map(([key, label]) => {
                  const mode = estimate.modeEstimates[key];
                  const selected = mode.lowMemorySegmented === lowMemorySegmented;
                  return (
                    <article
                      key={key}
                      className={`render-mode-estimate is-${mode.warningLevel.toLowerCase()} ${selected ? "is-selected" : ""}`}
                    >
                      <header>
                        <strong>{label}</strong>
                        {selected && <span>目前選擇</span>}
                      </header>
                      <dl>
                        <div><dt>SSD 工作空間</dt><dd>約 {formatBytes(mode.estimatedTemporaryBytes)}</dd></div>
                        <div><dt>RAM 峰值</dt><dd>約 {formatBytes(mode.estimatedPeakRamBytes)}</dd></div>
                        <div><dt>處理時間</dt><dd>約 {formatDuration(mode.estimatedRenderTimeMs)}</dd></div>
                        <div><dt>處理差異</dt><dd>{key === "lowMemory" ? "較省 RAM／較慢" : "較快／較吃 RAM"}</dd></div>
                      </dl>
                    </article>
                  );
                })}
              </div>
              {estimate.warning && <p className="render-preflight-warning">⚠ {estimate.warning}</p>}
              <small>預設使用 H.265 Intel QSV GPU；開始前會再次檢查並保留至少 1 GB。</small>
            </section>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {result && (
            <div className="concat-complete">
              <h3>Shorts 預覽已完成</h3>
              <p>{result.outputPath}</p>
              <button className="secondary-button" onClick={() => void window.sourceApp.playConcatOutput(result.jobId)}>
                ▶ 播放
              </button>
              <button
                className="secondary-button"
                onClick={() => void window.sourceApp.revealConcatOutput(result.jobId)}
              >
                在檔案總管顯示
              </button>
            </div>
          )}
          <div className="concat-footer-actions">
            <button
              className="primary-button"
              aria-busy={busy || checking}
              disabled={
                busy ||
                checking ||
                !segments.length ||
                durationMs > limit * 1000 ||
                !output ||
                estimate?.canRender === false
              }
              onClick={() => void start()}
            >
              {busy
                ? "產出中…"
                : checking
                  ? "正在檢查資源…"
                  : `產出 Shorts ${resolution === "1440P" ? "1440×2560" : "1080×1920"}`}
            </button>
            <button className="secondary-button" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
        <footer className="settings-footer">
          <small>Shorts 使用 purpose=SHORTS 並進入共用輸出歷史；本版不自動上傳、不改寫來源。</small>
        </footer>
      </section>
    </div>
  );
}
