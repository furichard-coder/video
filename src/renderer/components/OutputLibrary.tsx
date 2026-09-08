import { useEffect, useState } from "react";
import type { PreviewOutputPurpose, PreviewOutputRecord } from "../../shared/domain";
import { formatBytes } from "../format";

interface Props { purpose?: PreviewOutputPurpose; title: string; refreshKey?: number; recentOnly?: boolean; }

/** Shared compact output query/actions used by Intro, Subtitle and output pages. */
export function OutputLibrary({ purpose, title, refreshKey = 0, recentOnly = true }: Props) {
  const [outputs, setOutputs] = useState<PreviewOutputRecord[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => { let active = true; void window.sourceApp.getPreviewOutputHistory().then((snapshot) => { if (!active) return; setOutputs(snapshot.outputs.filter((item) => item.exists && (!purpose || item.purpose === purpose)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, recentOnly ? 3 : undefined)); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); return () => { active = false; }; }, [purpose, refreshKey, recentOnly]);
  return <section className="output-library-compact" aria-label={title}><header><h3>{title}</h3><small>播放、開啟位置與複製路徑使用同一成品庫。</small></header>{!outputs.length ? <p className="inline-history-empty">尚無仍存在的片頭預覽檔。</p> : <ol>{outputs.map((output) => <li key={output.jobId}><div><strong title={output.outputPath}>{output.fileName}</strong><small>{new Date(output.createdAt).toLocaleString("zh-TW")} · {formatBytes(output.sizeBytes)}</small></div><nav><button type="button" onClick={() => void window.sourceApp.playConcatOutput(output.jobId)}>▶ 播放</button><button type="button" onClick={() => void window.sourceApp.revealConcatOutput(output.jobId)}>開啟位置</button><button type="button" onClick={() => void window.sourceApp.copyPreviewOutputPath(output.jobId)}>複製路徑</button></nav></li>)}</ol>}{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}
