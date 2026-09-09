import { useState } from "react";
import { OutputLibrary } from "./OutputLibrary";

interface Props {
  refreshKey?: number;
  title?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export function SharedIntroPreviewHistory({ refreshKey = 0, title = "共用片頭預覽檔", collapsible = false, defaultCollapsed = false }: Props) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  if (!collapsible) return <OutputLibrary purpose="INTRO" title={title} refreshKey={refreshKey} recentOnly />;

  return <section className={`shared-preview-history ${expanded ? "is-expanded" : "is-collapsed"}`}>
    <button type="button" className="shared-preview-history-toggle" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展開"}${title}`} onClick={() => setExpanded((current) => !current)}>
      <span><strong>{title}</strong><small>{expanded ? "收起以騰出字幕預覽空間" : "已收起，不會遮住上方字幕預覽"}</small></span>
      <em aria-hidden="true">{expanded ? "收起 ▲" : "展開 ▼"}</em>
    </button>
    {expanded && <OutputLibrary purpose="INTRO" title={title} refreshKey={refreshKey} recentOnly />}
  </section>;
}
