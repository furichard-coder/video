# ADR 0032：提示頁背景與片頭拖曳順位

日期：2026-09-08

## 背景

正片開始提示頁原本固定使用第一個正片片段的開場畫面。使用者希望能從已確認的片頭精選片段選背景，並要求片頭片段可用滑鼠直接調整先後順序。

## 決定

- `MainStartCardOptions` 只保存可選的 `backgroundIntroSegmentId`，不保存或接受 Renderer 提交的磁碟路徑。
- 未指定背景時維持第一個正片片段；指定時，Main process 必須確認該 ID 仍屬目前已確認的 Intro 清單，否則阻擋輸出並要求重選。
- 提示頁從 Project Store 解析到 `SourceAsset.sourcePath`，再由 FFmpeg 直接讀取唯讀原始素材。Proxy 只用於檢看，永不成為提示頁輸出來源。
- 選定影片背景只使用該 Intro 的 IN 起點與有效片段長度；提示頁較長時允許在明示的標題卡內延展末格，不用於偽造旅程連續性。
- 片頭拖曳期間只更新 Renderer 的暫時排列；放開後一次呼叫既有 `setIntroSegments` 原子保存。這會沿用既有 Timeline revision 與字幕複核規則。
- 往前／往後按鈕繼續提供鍵盤可達與精確調整；拖曳不是唯一排序方式。

## 相容性與安全

欄位為 optional，舊偏好會自動回到正片開場，不需要升級 Project manifest schema。來源檔、proxy cache 與既有 release 均不改寫。
