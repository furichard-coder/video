import { useEffect, useState } from "react";
import { DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT, MAX_MIX_VOLUME_PERCENT, type BgmTrack, type MusicSuggestion, type MusicSuggestionResult, type ProjectManifest } from "../../shared/domain";
import { formatDuration } from "../format";
import { TimecodeInput } from "./TimecodeInput";

interface Props { project: ProjectManifest; timelineDurationMs: number; onProjectUpdated(project: ProjectManifest): void; onClose(): void; }

export function BgmStudio({ project, timelineDurationMs, onProjectUpdated, onClose }: Props) {
  const [drafts, setDrafts] = useState<BgmTrack[]>(() => structuredClone(project.bgmTracks));
  const [sourceVolume, setSourceVolume] = useState(project.sourceAudioVolumePercent ?? DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT);
  const [youtubeUrls, setYoutubeUrls] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState<Record<string, boolean>>({});
  const [includeTikTokTrending, setIncludeTikTokTrending] = useState(false);
  const [royaltyFreeOnly, setRoyaltyFreeOnly] = useState(false);
  const [suggestionResult, setSuggestionResult] = useState<MusicSuggestionResult | undefined>(() => project.musicSuggestionResult ? structuredClone(project.musicSuggestionResult) : undefined);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [localDirty, setLocalDirty] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);

  useEffect(() => {
    if (!localDirty) setDrafts(structuredClone(project.bgmTracks));
    else setNotice("專案在背景更新；目前未保存的配樂編輯仍保留，請保存目前曲目或重新載入。");
    setSourceVolume(project.sourceAudioVolumePercent ?? DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT);
    setSuggestionResult(project.musicSuggestionResult ? structuredClone(project.musicSuggestionResult) : undefined);
  }, [project.bgmTracks, project.sourceAudioVolumePercent, project.musicSuggestionResult, project.updatedAt]);
  useEffect(() => {
    void window.sourceApp.getUserPreferences().then((preferences) => { setIncludeTikTokTrending(preferences.musicSuggestionDefaults.includeTikTokTrending); setRoyaltyFreeOnly(preferences.musicSuggestionDefaults.royaltyFreeOnly); }).catch(() => undefined);
  }, []);
  const patchTrack = (id: string, field: keyof BgmTrack, value: number) => { setLocalDirty(true); setDrafts((current) => current.map((track) => track.id === id ? { ...track, [field]: Math.round(value * 1000) } : track)); };
  const patchPercent = (id: string, value: number) => { setLocalDirty(true); setDrafts((current) => current.map((track) => track.id === id ? { ...track, volumePercent: value } : track)); };
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));

  const add = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await window.sourceApp.chooseBgmFiles(); onProjectUpdated(result.project);
      if (!result.cancelled) setNotice(`已加入 ${result.addedCount} 首 MP3；新配樂預設 35%。`);
      if (result.errors.length) setError(result.errors.join("\n"));
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const addYoutube = async () => {
    const urls = youtubeUrls.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    if (!urls.length) { setError("請貼上一個或多個 YouTube 連結。"); return; }
    setBusy(true); setError(undefined);
    try {
      const result = await window.sourceApp.addBgmYoutubeReferences(urls); onProjectUpdated(result.project); setYoutubeUrls("");
      setNotice(`已依輸入順序加入 ${result.addedCount} 個 YouTube 參考；需逐首指定自有或已授權 MP3 才能輸出。`);
      if (result.errors.length) setError(result.errors.join("\n"));
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const resolve = async (track: BgmTrack) => {
    setBusy(true); setError(undefined);
    try {
      const result = await window.sourceApp.resolveBgmReference(track.id, rightsConfirmed[track.id] === true);
      if (result) { onProjectUpdated(result.project); setNotice(`已將授權 MP3 連結到「${track.fileName}」，並依清單順序重新串聯。`); }
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const save = async (track: BgmTrack) => { setBusy(true); setError(undefined); try { onProjectUpdated(await window.sourceApp.updateBgmTrack(track)); setLocalDirty(false); setNotice(`已保存 ${track.fileName} 的混音設定。`); } catch (reason) { report(reason); } finally { setBusy(false); } };
  const saveSourceVolume = async () => { setBusy(true); setError(undefined); try { onProjectUpdated(await window.sourceApp.setSourceAudioVolume(sourceVolume)); setLocalDirty(false); setNotice(`素材原音預設已設為 ${sourceVolume}%。`); } catch (reason) { report(reason); } finally { setBusy(false); } };
  const sequence = async () => { setBusy(true); setError(undefined); try { onProjectUpdated(await window.sourceApp.sequenceBgmTracks()); setLocalDirty(false); setNotice("已依目前清單順序，從影片開頭連續排列所有配樂。"); } catch (reason) { report(reason); } finally { setBusy(false); } };
  const remove = async (track: BgmTrack) => { if (!confirm(`只從專案移除配樂「${track.fileName}」？\n本機 MP3 不會刪除。`)) return; onProjectUpdated(await window.sourceApp.removeBgmTrack(track.id)); };
  const move = async (track: BgmTrack, index: number, delta: number) => { try { onProjectUpdated(await window.sourceApp.moveBgmTrack(track.id, index + delta)); } catch (reason) { report(reason); } };
  const requestClose = () => { if (localDirty) setClosePrompt(true); else onClose(); };
  const saveAndClose = async () => { setBusy(true); setError(undefined); try { for (const track of drafts) onProjectUpdated(await window.sourceApp.updateBgmTrack(track)); setLocalDirty(false); setClosePrompt(false); onClose(); } catch (reason) { report(reason); } finally { setBusy(false); } };
  const runFileAction = async (track: BgmTrack, action: "PLAY" | "REVEAL" | "COPY") => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (action === "PLAY") await window.sourceApp.playBgmTrack(track.id);
      else if (action === "REVEAL") await window.sourceApp.revealBgmTrack(track.id);
      else { await window.sourceApp.copyBgmTrackPath(track.id); setNotice("已複製 MP3 完整路徑。"); }
    } catch (reason) { report(reason); }
    finally { setBusy(false); }
  };
  const setTikTokSearch = (checked: boolean) => {
    setIncludeTikTokTrending(checked);
    void window.sourceApp.updateUserPreferences({ musicSuggestionDefaults: { includeTikTokTrending: checked } }).catch(report);
  };
  const setRoyaltyFreeSearch = (checked: boolean) => {
    setRoyaltyFreeOnly(checked);
    void window.sourceApp.updateUserPreferences({ musicSuggestionDefaults: { royaltyFreeOnly: checked } }).catch(report);
  };
  const suggestMusic = async () => {
    setSuggesting(true); setError(undefined); setNotice(undefined); setSuggestionResult(undefined);
    try {
      const result = await window.sourceApp.generateMusicSuggestions({ includeTikTokTrending, royaltyFreeOnly });
      onProjectUpdated(await window.sourceApp.getProject());
      setSuggestionResult(result);
      const yt = result.suggestions.filter((item) => item.platform === "YOUTUBE").length;
      const tiktok = result.suggestions.filter((item) => item.platform === "TIKTOK").length;
      setNotice(`已由「${result.accountName}」找到 ${yt} 個 YouTube 試聽建議${includeTikTokTrending ? `、${tiktok} 個 TikTok／抖音趨勢項目` : ""}${royaltyFreeOnly ? "（已套用授權線索篩選）" : ""}。`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("取消") || (reason instanceof Error && reason.name === "AbortError") ? "已取消 AI 配樂搜尋；沒有保存未完成結果。" : message);
    } finally { setSuggesting(false); }
  };
  const addSuggestedReference = async (suggestion: MusicSuggestion) => {
    setBusy(true); setError(undefined);
    try {
      const result = await window.sourceApp.addBgmYoutubeReferences([suggestion.auditionUrl]); onProjectUpdated(result.project);
      setNotice(`已把「${suggestion.title}」加入 YouTube 參考；正式輸出前仍需指定自有或已授權 MP3。`);
      if (result.errors.length) setError(result.errors.join("\n"));
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };

  return <div className="modal-backdrop studio-backdrop" role="presentation"><section className="editor-modal bgm-modal" role="dialog" aria-modal="true" aria-label="配樂與混音">
    <header className="modal-header"><div><span className="eyebrow">BGM · READ-ONLY SOURCES</span><h2>配樂與混音</h2></div><button className="icon-button" onClick={requestClose} aria-label="關閉">×</button></header>
    <div className="editor-modal-body">
        <div className="studio-summary bgm-summary"><div><span>目前影片時間基準</span><strong>{formatDuration(timelineDurationMs)}</strong></div><div className="source-volume-control"><label>素材原音預設<input aria-label="素材原音音量" type="number" min="0" max={MAX_MIX_VOLUME_PERCENT} value={sourceVolume} onChange={(event) => setSourceVolume(Number(event.target.value))} /><span>%</span></label><button className="secondary-button" disabled={busy} onClick={() => void saveSourceVolume()}>保存原音</button></div><p>新專案素材原音預設 100%、新配樂預設 35%；兩者可在 0–300% 調整。舊專案有效的 80% 等設定會保留。混合後仍套用 0.95 peak limiter，因此 300% 是數位增益上限，不保證聽感三倍。</p></div>
      <section className="music-suggestion-panel" aria-label="AI 配樂建議">
        <div className="music-suggestion-heading"><div><span className="eyebrow">AI MUSIC DISCOVERY</span><h3>依影片主題找配樂</h3><p>目前主題：{project.aiStoryContext.topic || project.aiStoryContext.storySummary || project.aiStoryContext.locations.join("、") || "尚未填寫；請先到 AI 帳號／故事設定補充主題。"}</p></div><div className="music-suggestion-controls"><label><input type="checkbox" checked={royaltyFreeOnly} onChange={(event) => setRoyaltyFreeSearch(event.target.checked)} />只搜尋有 royalty-free／授權線索的音樂</label><label><input type="checkbox" checked={includeTikTokTrending} onChange={(event) => setTikTokSearch(event.target.checked)} />AI 同時搜尋 TikTok／抖音近期熱門音樂</label><div><button className="primary-button" disabled={suggesting || busy} onClick={() => void suggestMusic()}>{suggesting ? "搜尋中…" : "產生多個試聽建議"}</button>{suggesting && <button className="secondary-button" onClick={() => void window.sourceApp.cancelMusicSuggestions()}>取消</button>}</div></div></div>
        <p className="music-rights-note">即時結果只供試聽與選曲，不代表已取得 YouTube、TikTok、商用或影音同步授權；正式輸出仍須連結自有或已授權 MP3。</p>
        {suggestionResult && <div className="music-suggestion-results">
          <header><span>{suggestionResult.provider === "OPENAI_API" ? "OpenAI 即時 Web Search" : "Codex／ChatGPT 登入搜尋"}</span><time>{new Date(suggestionResult.generatedAt).toLocaleString("zh-TW")}</time></header>
          <div>{suggestionResult.suggestions.map((suggestion) => <article key={suggestion.id} className={`music-suggestion-card platform-${suggestion.platform.toLowerCase()}`}>
            <div><span className="music-platform">{suggestion.platform === "YOUTUBE" ? "YouTube" : "TikTok／抖音趨勢"}</span><strong>{suggestion.title}{suggestion.artist ? ` · ${suggestion.artist}` : ""}</strong><p>{suggestion.reason}</p>{suggestion.rightsEvidence && <small>授權線索：{suggestion.rightsEvidence}</small>}{suggestion.trendEvidence && <small>{suggestion.trendEvidence}{suggestion.observedAt ? `（${suggestion.observedAt}）` : ""}</small>}</div>
            <nav aria-label={`${suggestion.title} 操作`}><button className="secondary-button" onClick={() => void window.sourceApp.openMusicSuggestion(suggestion.auditionUrl).catch(report)}>▶ 開啟試聽</button>{suggestion.evidenceUrl !== suggestion.auditionUrl && <button onClick={() => void window.sourceApp.openMusicSuggestion(suggestion.evidenceUrl).catch(report)}>查看來源</button>}{suggestion.platform === "YOUTUBE" && <button disabled={busy} onClick={() => void addSuggestedReference(suggestion)}>加入參考</button>}</nav>
          </article>)}</div>
          {suggestionResult.warnings.length > 0 && <details><summary>授權／搜尋提醒（{suggestionResult.warnings.length}）</summary><ul>{suggestionResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
        </div>}
      </section>
      <section className="bgm-import-panel"><div><h3>加入本機 MP3</h3><p>可一次選擇多首；依選取順序接在目前配樂後方。來源唯讀。</p><button className="primary-button" disabled={busy} onClick={() => void add()}>＋ 加入 MP3</button></div><div><h3>YouTube 連結參考</h3><p>每行一個或用空格分隔。App 不會操控第三方轉檔站、關閉廣告或擷取未授權音訊；請指定自有／已授權 MP3，或從 YouTube Audio Library 正式下載。</p><textarea aria-label="YouTube 配樂參考連結" value={youtubeUrls} onChange={(event) => setYoutubeUrls(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" /><div className="bgm-reference-actions"><button className="secondary-button" disabled={busy || !youtubeUrls.trim()} onClick={() => void addYoutube()}>加入連結參考</button><button type="button" disabled={busy} onClick={() => void window.sourceApp.openYoutubeAudioLibrary().catch(report)}>開啟 YouTube Audio Library</button></div></div></section>
      <div className="bgm-list-toolbar"><span>{drafts.length} 首／筆，輸出會依清單與 Timeline 設定混入正片及片頭</span><button className="secondary-button" disabled={busy || !drafts.length} onClick={() => void sequence()}>依清單連續排列</button></div>
      {!drafts.length ? <div className="empty-mini">尚未加入配樂。影片原音預設以 100% 輸出，仍可由每個素材的音量區段覆寫。</div> : <div className="bgm-list">{drafts.map((track,index) => <article className={`bgm-track ${track.resolutionStatus === "NEEDS_LOCAL_FILE" ? "is-pending" : ""}`} key={track.id}>
        <header><div><strong>{String(index + 1).padStart(2, "0")} · {track.fileName}</strong><small title={track.sourcePath || track.sourceUrl}>{track.sourcePath || track.sourceUrl}</small><span>{track.resolutionStatus === "NEEDS_LOCAL_FILE" ? "待指定授權 MP3 · 尚不可輸出" : `曲長 ${formatDuration(track.durationMs)} · 來源唯讀 · 音量 ${track.volumePercent}%`}</span>{track.resolutionStatus !== "NEEDS_LOCAL_FILE" && <nav className="bgm-file-actions" aria-label={`${track.fileName} 檔案操作`}><button type="button" disabled={busy} onClick={() => void runFileAction(track, "PLAY")}>▶ 播放</button><button type="button" disabled={busy} onClick={() => void runFileAction(track, "REVEAL")}>開啟位置</button><button type="button" disabled={busy} onClick={() => void runFileAction(track, "COPY")}>複製路徑</button></nav>}</div><div><button disabled={index===0} onClick={() => void move(track,index,-1)}>上移</button><button disabled={index===drafts.length-1} onClick={() => void move(track,index,1)}>下移</button><button onClick={() => void remove(track)}>移除</button></div></header>
        {track.resolutionStatus === "NEEDS_LOCAL_FILE" ? <div className="bgm-rights-resolution"><label><input type="checkbox" checked={rightsConfirmed[track.id] === true} onChange={(event) => setRightsConfirmed((current) => ({ ...current, [track.id]: event.target.checked }))} />我確認將指定的 MP3 是自有、已授權，或由 YouTube Audio Library 正式下載</label><button className="primary-button" disabled={busy || rightsConfirmed[track.id] !== true} onClick={() => void resolve(track)}>指定本機授權 MP3…</button></div> : <div className="bgm-fields"><label>Timeline 開始<TimecodeInput label={`${track.fileName} Timeline 開始`} valueMs={track.timelineInMs} maxMs={timelineDurationMs} onChange={(value) => patchTrack(track.id,"timelineInMs",value / 1000)} /></label><label>Timeline 結束<TimecodeInput label={`${track.fileName} Timeline 結束`} valueMs={track.timelineOutMs} maxMs={timelineDurationMs} onChange={(value) => patchTrack(track.id,"timelineOutMs",value / 1000)} /></label><label>Source IN<TimecodeInput label={`${track.fileName} Source IN`} valueMs={track.sourceInMs} maxMs={track.durationMs} onChange={(value) => patchTrack(track.id,"sourceInMs",value / 1000)} /></label><label>Source OUT<TimecodeInput label={`${track.fileName} Source OUT`} valueMs={track.sourceOutMs} maxMs={track.durationMs} onChange={(value) => patchTrack(track.id,"sourceOutMs",value / 1000)} /></label><label>淡入<TimecodeInput label={`${track.fileName} 淡入`} valueMs={track.fadeInMs} maxMs={track.durationMs} onChange={(value) => patchTrack(track.id,"fadeInMs",value / 1000)} /></label><label>淡出<TimecodeInput label={`${track.fileName} 淡出`} valueMs={track.fadeOutMs} maxMs={track.durationMs} onChange={(value) => patchTrack(track.id,"fadeOutMs",value / 1000)} /></label><label>音量<input type="number" min="0" max={MAX_MIX_VOLUME_PERCENT} value={track.volumePercent} onChange={(e)=>patchPercent(track.id,Number(e.target.value))}/><span>%</span></label><button className="save-track-button" disabled={busy} onClick={() => void save(track)}>保存此曲</button></div>}
      </article>)}</div>}
      {notice && <div className="notice success">{notice}</div>}{error && <div className="notice error" role="alert">{error}</div>}
    </div><footer className="settings-footer"><p>本機 MP3 不會被修改；待補、離線或不存在會阻擋影片輸出並指出曲名。YouTube 連結只作來源與授權紀錄。</p><button className="primary-button" onClick={requestClose}>完成</button></footer>{closePrompt && <div className="inline-close-guard" role="alertdialog" aria-label="配樂未保存"><strong>配樂有未保存修改</strong><p>要先保存所有曲目再離開，還是放棄這次修改？</p><button className="primary-button" disabled={busy} onClick={() => void saveAndClose()}>保存並離開</button><button className="danger-secondary-button" disabled={busy} onClick={() => { setLocalDirty(false); setClosePrompt(false); onClose(); }}>放棄並離開</button><button className="secondary-button" disabled={busy} onClick={() => setClosePrompt(false)}>返回編輯</button></div>}
  </section></div>;
}
