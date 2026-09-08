import { OutputLibrary } from "./OutputLibrary";

interface Props { refreshKey?: number; title?: string; }

export function SharedIntroPreviewHistory({ refreshKey = 0, title = "共用片頭預覽檔" }: Props) {
  return <OutputLibrary purpose="INTRO" title={title} refreshKey={refreshKey} recentOnly />;
}
