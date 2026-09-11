import { useCallback, useEffect, useState } from "react";
import type { BrowserUploadPlatform, PreviewOutputPurpose, PreviewOutputRecord } from "../../shared/domain";
import { formatBytes } from "../format";

export interface OutputLibraryState {
  outputs: PreviewOutputRecord[];
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
  setOutputs(outputs: PreviewOutputRecord[]): void;
  setError(error?: string): void;
}

export function useOutputLibrary(refreshKey = 0): OutputLibraryState {
  const [outputs, setOutputs] = useState<PreviewOutputRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setOutputs((await window.sourceApp.getPreviewOutputHistory()).outputs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  return { outputs, loading, error, refresh, setOutputs, setError };
}

export function outputPurposeMatches(
  output: PreviewOutputRecord,
  purpose?: PreviewOutputPurpose | PreviewOutputPurpose[],
) {
  if (!purpose) return true;
  const allowed = Array.isArray(purpose) ? purpose : [purpose];
  return allowed.includes(output.purpose);
}

interface OutputRecordActionsProps {
  output: PreviewOutputRecord;
  onError?(message?: string): void;
  onCopySuccess?(): void;
  onYoutube?(): void;
  onYoutubeApi?(): void;
  onPlatform?(platform: BrowserUploadPlatform): Promise<void>;
  showPublish?: boolean;
}

/** One shared implementation of playback, reveal, copy and optional publish actions. */
export function OutputRecordActions({
  output,
  onError,
  onCopySuccess,
  onYoutube,
  onYoutubeApi,
  onPlatform,
  showPublish = false,
}: OutputRecordActionsProps) {
  const [busy, setBusy] = useState(false);
  const run = async (action: "PLAY" | "REVEAL" | "COPY" | BrowserUploadPlatform) => {
    setBusy(true);
    onError?.(undefined);
    try {
      if (action === "PLAY") await window.sourceApp.playConcatOutput(output.jobId);
      else if (action === "REVEAL") await window.sourceApp.revealConcatOutput(output.jobId);
      else if (action === "COPY") {
        await window.sourceApp.copyPreviewOutputPath(output.jobId);
        onCopySuccess?.();
      } else if (onPlatform) await onPlatform(action);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const disabled = !output.exists || busy;
  return (
    <div className="output-record-actions">
      <button type="button" disabled={disabled} onClick={() => void run("PLAY")}>
        ▶ 播放
      </button>
      <button type="button" disabled={disabled} onClick={() => void run("REVEAL")}>
        開啟位置
      </button>
      <button type="button" disabled={disabled} onClick={() => void run("COPY")}>
        複製路徑
      </button>
      {showPublish && onYoutube && (
        <button className="youtube-connect-button" type="button" disabled={disabled} onClick={onYoutube}>
          Chrome 拖放（預設）
        </button>
      )}
      {showPublish && onYoutubeApi && (
        <button type="button" disabled={disabled} onClick={onYoutubeApi}>
          YouTube API
        </button>
      )}
      {showPublish && onPlatform && (
        <>
          <button
            className="bilibili-upload-button"
            type="button"
            disabled={disabled}
            onClick={() => void run("BILIBILI")}
          >
            BiliBili
          </button>
          <button className="tiktok-upload-button" type="button" disabled={disabled} onClick={() => void run("TIKTOK")}>
            TikTok
          </button>
        </>
      )}
    </div>
  );
}

interface Props {
  purpose?: PreviewOutputPurpose | PreviewOutputPurpose[];
  title: string;
  refreshKey?: number;
  recentOnly?: boolean;
  emptyText?: string;
}

/** Shared compact output query/actions used by Intro, Subtitle, Concat and output pages. */
export function OutputLibrary({
  purpose,
  title,
  refreshKey = 0,
  recentOnly = true,
  emptyText = "尚無仍存在的預覽檔。",
}: Props) {
  const { outputs, error, setError } = useOutputLibrary(refreshKey);
  const visible = outputs
    .filter((item) => item.exists && outputPurposeMatches(item, purpose))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, recentOnly ? 3 : undefined);
  return (
    <section className="output-library-compact" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <small>播放、開啟位置與複製路徑使用同一成品庫。</small>
      </header>
      {!visible.length ? (
        <p className="inline-history-empty">{emptyText}</p>
      ) : (
        <ol>
          {visible.map((output) => (
            <li key={output.jobId}>
              <div>
                <button
                  type="button"
                  title={output.outputPath}
                  onClick={() =>
                    void window.sourceApp
                      .playConcatOutput(output.jobId)
                      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
                  }
                >
                  {output.fileName}
                </button>
                <small>
                  {new Date(output.createdAt).toLocaleString("zh-TW")} · {formatBytes(output.sizeBytes)}
                  {output.resolution ? ` · ${output.resolution}` : ""}
                </small>
              </div>
              <OutputRecordActions output={output} onError={setError} />
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
