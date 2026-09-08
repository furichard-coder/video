import { useEffect } from "react";
import type { ProjectManifest, SourceAsset } from "../../shared/domain";

interface Props {
  asset: SourceAsset;
  project: ProjectManifest;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmMainRemovalModal({ asset, project, busy, onCancel, onConfirm }: Props) {
  const introCount = project.introSegments.filter((segment) => segment.assetId === asset.id).length;
  const placementCount = project.placementDecisions.filter((decision) => decision.assetId === asset.id || decision.anchorAssetId === asset.id).length;
  const mediaInsertionCount = project.mediaInsertions.filter((item) => item.anchorVideoAssetId === asset.id).length;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [busy, onCancel]);

  return <div className="modal-backdrop" role="presentation">
    <section className="confirm-remove-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-main-remove-title" aria-describedby="confirm-main-remove-description">
      <header><span className="eyebrow">NON-DESTRUCTIVE REMOVE</span><h2 id="confirm-main-remove-title">從正片移除「{asset.fileName}」？</h2></header>
      <div id="confirm-main-remove-description">
        <p><strong>磁碟來源檔、proxy cache 與原始 metadata 都不會刪除或修改。</strong></p>
        <p>確認後，這個素材會從正片順序、正片輸出選擇與待決定區排除；下列設定仍保存在 manifest，恢復時會回到原位置：</p>
        <ul><li>手動順序與素材安插決策：{placementCount} 筆相關紀錄</li><li>影片內照片／影片安插：{mediaInsertionCount} 項（會隨此影片暫停進入正片，恢復影片時一併恢復）</li><li>音量區段：{asset.volumeSegments?.length ?? 0} 段</li><li>正片排除區段：{asset.mainExclusionRanges?.length ?? 0} 段</li></ul>
        <p>Intro 引用與正片獨立：{introCount ? `現有 ${introCount} 個片頭區段會保留。` : "目前沒有片頭區段引用此來源。"}</p>
      </div>
      <footer><button className="secondary-button" type="button" autoFocus disabled={busy} onClick={onCancel}>取消，保留正片</button><button className="danger-button" type="button" disabled={busy} onClick={onConfirm} aria-label={`確認從正片移除 ${asset.fileName}`}>{busy ? "正在移除…" : "確認從正片移除"}</button></footer>
    </section>
  </div>;
}
