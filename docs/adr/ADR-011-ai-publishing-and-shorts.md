# ADR-011 — AI 發布素材與 Intro-to-Shorts 邊界

## Status

Accepted for v0.43.0; remote AI generation remains explicitly partial.

## Decisions

- `AI 發布素材` 是第七個可見工作區，保存 topic snapshot、候選與 userEdited 狀態；任何 AI 草稿都需人工修改／選定後才可帶入 YouTube 確認頁。
- 縮圖只允許可追溯來源影格的本機 1280×720 合成，或使用者選取的 JPG／PNG；本版不宣稱 AI 圖片生成。
- Shorts 以 `purpose=SHORTS` 保存，且 Renderer 必須明確指定 `shortsSource=INTRO|MAIN`；Intro 選段與排序不會改變原 Intro 時間線。
- YouTube 先完成 `videos.insert`，再以同一 videoId 呼叫 `thumbnails.set`；縮圖失敗是 partial success，可重試，不回滾影片。
- 帳號診斷不等於內容生成。尚未接上嚴格 Structured Outputs 的流程一律標示 `LOCAL_FALLBACK`，不可誤稱 OpenAI／Codex 已生成。

## v0.44 correction

OpenAI and Codex generation are now real provider adapters with mocked contract coverage. Account diagnostics are no longer used as a substitute for generation. The service only persists `OPENAI_API` or `CODEX_CHATGPT` after that provider returns a schema-valid draft; otherwise it persists `LOCAL_FALLBACK` with both failure reasons.
