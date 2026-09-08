import { useEffect, useMemo, useState } from "react";
import type { PreviewOutputRecord } from "../../shared/domain";
import { formatBytes } from "../format";

interface Props {
  refreshKey?: number;
  title?: string;
}

export function SharedIntroPreviewHistory({ refreshKey = 0, title = "共用片頭預覽檔" }: Props) {
  const [outputs, setOutputs] = useState<PreviewOutputRecord[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const matching = useMemo(() => outputs
    .filter((item) => item.exists && item.purpose === "INTRO")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [outputs]);

  useEffect(() => {
    let active = true;
    void window.sourceApp.getPreviewOutputHistory()
      .then((snapshot) => { if (active) setOutputs(snapshot.outputs); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [refreshKey]);

  const run = async (output: PreviewOutputRecord, action: "PLAY" | "REVEAL" | "COPY") => {
    setBusyId(output.jobId); setError(undefined); setNotice(undefined);
    try {
      if (action === "PLAY") await window.sourceApp.playConcatOutput(output.jobId);
      else if (action === "REVEAL") await window.sourceApp.revealConcatOutput(output.jobId);
      else { await window.sourceApp.copyPreviewOutputPath(output.jobId); setNotice("已複製完整檔案路徑。"); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(undefined); }
  };

  return <section className="shared-intro-preview-history" aria-label={title}>
    <header><div><span className="eyebrow">SHARED PREVIEW FILES</span><h3>{title}</h3></div><small>字幕頁與片頭頁共用；代理只供檢看，不會成為正式 Master。</small></header>
    {!matching.length ? <p className="inline-history-empty">尚無仍存在的片頭預覽檔。</p> : <ol>{matching.map((output) => <li key={output.jobId}>
      <div><strong title={output.outputPath}>{output.fileName}</strong><small title={output.outputPath}>{output.outputPath}</small><span>{new Date(output.createdAt).toLocaleString("zh-TW")} · {formatBytes(output.sizeBytes)}{output.resolution ? ` · ${output.resolution}` : ""}</span></div>
      <nav aria-label={`${output.fileName} 檔案操作`}><button type="button" disabled={busyId === output.jobId} onClick={() => void run(output, "PLAY")}>▶ 播放</button><button type="button" disabled={busyId === output.jobId} onClick={() => void run(output, "REVEAL")}>開啟位置</button><button type="button" disabled={busyId === output.jobId} onClick={() => void run(output, "COPY")}>複製路徑</button></nav>
    </li>)}</ol>}
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
