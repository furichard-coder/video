import { useEffect, useMemo, useState } from "react";
import type {
  AiAccountProfile,
  AiSettingsSnapshot,
  AiStoryContext,
  ProjectManifest,
  TranslationSettingsSnapshot,
  VoiceInputLanguage,
} from "../../shared/domain";
import { VoiceInputButton } from "./VoiceInputButton";

interface Props {
  project: ProjectManifest;
  onProjectUpdated(project: ProjectManifest): void;
  onClose(): void;
}

const NEW_ACCOUNT = "__NEW__";
const VISION_MODELS = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"];
const TRANSCRIPTION_MODELS = ["gpt-4o-transcribe-diarize", "gpt-4o-transcribe", "whisper-1"];

function splitList(value: string): string[] {
  return value
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileForm(account?: AiAccountProfile) {
  return {
    name: account?.name ?? "新的 OpenAI API 帳號",
    visionModel: account?.visionModel ?? "gpt-5.6-terra",
    transcriptionModel: account?.transcriptionModel ?? "gpt-4o-transcribe-diarize",
    apiKey: "",
  };
}

export function AiSettingsModal({ project, onProjectUpdated, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<AiSettingsSnapshot>();
  const [selectedId, setSelectedId] = useState(NEW_ACCOUNT);
  const [form, setForm] = useState(profileForm());
  const [context, setContext] = useState<AiStoryContext>(() => structuredClone(project.aiStoryContext));
  const [locationsText, setLocationsText] = useState(project.aiStoryContext.locations.join("、"));
  const [peopleText, setPeopleText] = useState(project.aiStoryContext.people.join("、"));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [voiceLanguage, setVoiceLanguage] = useState<VoiceInputLanguage>("zh-TW");
  const [translationSnapshot, setTranslationSnapshot] = useState<TranslationSettingsSnapshot>();
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [translationBusy, setTranslationBusy] = useState(false);
  const [translationTesting, setTranslationTesting] = useState(false);
  const [geminiEnabled, setGeminiEnabled] = useState(false);
  const [geminiModel, setGeminiModel] = useState("gemini-2.5-flash");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiBusy, setGeminiBusy] = useState(false);

  const selected = useMemo(
    () => snapshot?.accounts.find((account) => account.id === selectedId),
    [snapshot, selectedId],
  );

  useEffect(() => {
    void window.sourceApp
      .getAiSettings()
      .then((next) => {
        setSnapshot(next);
        setSelectedId(next.activeAccountId);
        setForm(profileForm(next.accounts.find((account) => account.id === next.activeAccountId)));
        setGeminiEnabled(next.geminiReview?.enabled === true);
        setGeminiModel(next.geminiReview?.model ?? "gemini-2.5-flash");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    void window.sourceApp
      .getUserPreferences()
      .then((preferences) => setVoiceLanguage(preferences.voiceInputLanguage))
      .catch(() => undefined);
    void window.sourceApp
      .getTranslationSettings()
      .then(setTranslationSnapshot)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const appendText = (current: string, transcript: string, separator = " ") =>
    current.trim() ? `${current.trimEnd()}${separator}${transcript}` : transcript;
  const voiceError = (message: string) => setError(message || undefined);
  const changeVoiceLanguage = (language: VoiceInputLanguage) => {
    setVoiceLanguage(language);
    void window.sourceApp
      .updateUserPreferences({ voiceInputLanguage: language })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const chooseAccount = (id: string) => {
    setSelectedId(id);
    setForm(profileForm(snapshot?.accounts.find((account) => account.id === id)));
    setError(undefined);
    setNotice(undefined);
  };

  const saveAccount = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await window.sourceApp.saveAiAccount({
        id: selected?.id,
        name: form.name,
        provider: "OPENAI",
        visionModel: form.visionModel,
        transcriptionModel: form.transcriptionModel,
        apiKey: form.apiKey || undefined,
        makeActive: true,
      });
      const active = next.accounts.find((account) => account.id === next.activeAccountId)!;
      setSnapshot(next);
      setSelectedId(active.id);
      setForm(profileForm(active));
      setNotice("AI 帳號已保存並設為目前使用；API Key 不會寫進專案檔。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.sourceApp.setActiveAiAccount(selected.id);
      setSnapshot(next);
      setNotice(`已改用「${selected.name}」。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!selected) {
      setError("請先保存這個帳號，再測試連線。");
      return;
    }
    setTesting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await window.sourceApp.testAiAccount(selected.id);
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  };

  const clearCredential = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.sourceApp.saveAiAccount({
        id: selected.id,
        name: form.name,
        provider: "OPENAI",
        visionModel: form.visionModel,
        transcriptionModel: form.transcriptionModel,
        clearApiKey: true,
      });
      setSnapshot(next);
      setNotice("已清除這個帳號在 App 內保存的 API Key。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || !snapshot || snapshot.accounts.length <= 1) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await window.sourceApp.removeAiAccount(selected.id);
      const active = next.accounts.find((account) => account.id === next.activeAccountId)!;
      setSnapshot(next);
      setSelectedId(active.id);
      setForm(profileForm(active));
      setNotice("帳號設定與其加密憑證已移除。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveContext = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await window.sourceApp.setAiStoryContext({
        ...context,
        locations: splitList(locationsText),
        people: splitList(peopleText),
      });
      onProjectUpdated(updated);
      setContext(structuredClone(updated.aiStoryContext));
      setLocationsText(updated.aiStoryContext.locations.join("、"));
      setPeopleText(updated.aiStoryContext.people.join("、"));
      setNotice("專案故事背景已保存；後續片頭與字幕 AI 會以此作為比對基準。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveGoogleKey = async () => {
    setTranslationBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await window.sourceApp.updateTranslationSettings({
        googleCloudApiKey: googleApiKey,
      });
      setTranslationSnapshot(next);
      setGoogleApiKey("");
      setNotice("Google Cloud Translation API Key 已使用 Windows 安全儲存加密；只在 OpenAI 翻譯不可用時啟用。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTranslationBusy(false);
    }
  };

  const testGoogle = async () => {
    setTranslationTesting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setNotice((await window.sourceApp.testGoogleTranslation()).message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTranslationTesting(false);
    }
  };

  const clearGoogle = async () => {
    setTranslationBusy(true);
    setError(undefined);
    try {
      setTranslationSnapshot(
        await window.sourceApp.updateTranslationSettings({
          clearGoogleCloudApiKey: true,
        }),
      );
      setGoogleApiKey("");
      setNotice("已清除 App 內加密保存的 Google Cloud Translation API Key。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTranslationBusy(false);
    }
  };

  const saveGeminiReview = async (clearApiKey = false) => {
    if (!window.sourceApp.saveGeminiReviewSettings) {
      setError("此版本尚未載入 Gemini 輔助設定服務，請重新啟動新版 App。");
      return;
    }
    setGeminiBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await window.sourceApp.saveGeminiReviewSettings({
        enabled: geminiEnabled,
        model: geminiModel,
        apiKey: geminiApiKey || undefined,
        clearApiKey,
      });
      setSnapshot(next);
      setGeminiApiKey("");
      setNotice(
        clearApiKey
          ? "已清除 Gemini 輔助復核金鑰。"
          : "Gemini 已設為發布素材的可選第二位審稿者；ChatGPT 仍是主要生成者。",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGeminiBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="ai-settings-modal" role="dialog" aria-modal="true" aria-label="AI 帳號與故事設定">
        <header className="modal-header">
          <div>
            <span className="eyebrow">AI SETTINGS · REVIEW FIRST</span>
            <h2>AI 帳號與故事判斷設定</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="ai-settings-body">
          <div className="ai-account-warning">
            <strong>發布素材由 Codex／ChatGPT 主生成</strong>
            <p>
              標題、縮圖與說明會先交給這台電腦已登入的 Codex／ChatGPT；不可用時才改用 OpenAI API。Gemini
              只做可選的第二次復核，不會取代或暗中改寫主要結果。
            </p>
            <p>
              知識型字幕可自動改用這台電腦的 Codex／ChatGPT 登入；App 不讀取、不複製登入 token，只使用唯讀暫存工作。
            </p>
            {snapshot && (
              <small role="status">
                {snapshot.codexLoginReusable
                  ? "✓ 已偵測到 Codex／ChatGPT 登入。"
                  : "尚未偵測到 Codex；發布素材會改用已設定的 OpenAI API。"}
              </small>
            )}
          </div>

          {!snapshot ? (
            <div className="settings-loading">
              <span className="spinner" />
              <p>正在讀取 AI 設定…</p>
            </div>
          ) : (
            <>
              <section className="ai-settings-section">
                <div className="ai-section-heading">
                  <div>
                    <span>01</span>
                    <h3>執行帳號</h3>
                  </div>
                  <p>
                    可保存多個 OpenAI API 設定；知識型字幕另有本機 Codex／ChatGPT 登入備援。語音轉錄目前仍使用 OpenAI
                    API。
                  </p>
                </div>
                <div className="ai-account-layout">
                  <nav className="ai-account-list" aria-label="AI 帳號清單">
                    {snapshot.accounts.map((account) => (
                      <button
                        key={account.id}
                        type="button"
                        className={selectedId === account.id ? "is-selected" : ""}
                        onClick={() => chooseAccount(account.id)}
                      >
                        <span className={`credential-dot ${account.credentialStatus.toLowerCase()}`} />{" "}
                        <strong>{account.name}</strong>
                        <small>
                          {account.id === snapshot.activeAccountId ? "目前使用 · " : ""}
                          {account.credentialStatus === "MISSING"
                            ? "缺少金鑰"
                            : account.credentialStatus === "ENVIRONMENT"
                              ? "環境變數"
                              : "已加密保存"}
                        </small>
                      </button>
                    ))}
                    <button
                      className={selectedId === NEW_ACCOUNT ? "is-selected add-account" : "add-account"}
                      type="button"
                      onClick={() => chooseAccount(NEW_ACCOUNT)}
                    >
                      ＋ 新增帳號
                    </button>
                  </nav>
                  <div className="ai-account-form">
                    <label>
                      設定名稱
                      <input
                        value={form.name}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      畫面／故事模型
                      <select
                        value={form.visionModel}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            visionModel: event.target.value,
                          }))
                        }
                      >
                        {VISION_MODELS.map((model) => (
                          <option key={model}>{model}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      語音轉錄模型
                      <select
                        value={form.transcriptionModel}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            transcriptionModel: event.target.value,
                          }))
                        }
                      >
                        {TRANSCRIPTION_MODELS.map((model) => (
                          <option key={model}>{model}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      OpenAI API Key
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={
                          selected?.credentialStatus === "MISSING" ? "尚未設定" : "保留現有金鑰（如要更換再輸入）"
                        }
                        value={form.apiKey}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            apiKey: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="ai-form-actions">
                      <button type="button" disabled={busy || testing} onClick={() => void saveAccount()}>
                        儲存並使用
                      </button>
                      <button type="button" disabled={!selected || busy || testing} onClick={() => void activate()}>
                        設為目前帳號
                      </button>
                      <button type="button" disabled={!selected || busy || testing} onClick={() => void test()}>
                        {testing ? "實際測試中…" : "測試 API／Codex 備援"}
                      </button>
                      {selected?.credentialStatus === "SAVED_ENCRYPTED" && (
                        <button
                          className="danger-text"
                          type="button"
                          disabled={busy || testing}
                          onClick={() => void clearCredential()}
                        >
                          清除金鑰
                        </button>
                      )}
                      {selected && snapshot.accounts.length > 1 && (
                        <button
                          className="danger-text"
                          type="button"
                          disabled={busy || testing}
                          onClick={() => void remove()}
                        >
                          移除帳號
                        </button>
                      )}
                    </div>
                    <small className="ai-live-test-note">
                      若 OpenAI API 可用，測試會送出極小的故事與語音請求；若 API 不可用，則只確認 Codex 的 ChatGPT
                      登入可供知識型字幕使用。
                    </small>
                  </div>
                </div>
              </section>

              <section className="ai-settings-section">
                <div className="ai-section-heading">
                  <div>
                    <span>02</span>
                    <h3>Gemini 圖片辨識與發布復核</h3>
                  </div>
                  <p>
                    Gemini 會逐張分析照片或指定影片影格的物種、名稱與場景，並簡化成字幕；也可在 ChatGPT
                    完成發布草稿後復核標題與縮圖。沒有金鑰時不會啟動。
                  </p>
                </div>
                <div className="ai-account-form translation-provider-form">
                  <label className="subtitle-burn-toggle">
                    <input
                      type="checkbox"
                      checked={geminiEnabled}
                      onChange={(event) => setGeminiEnabled(event.target.checked)}
                    />
                    <span>
                      <strong>啟用 Gemini 第二次復核</strong>
                      <small>只送出低解析候選影格與 ChatGPT 草稿，不送出完整原始影片。</small>
                    </span>
                  </label>
                  <label>
                    Gemini 模型
                    <input value={geminiModel} onChange={(event) => setGeminiModel(event.target.value)} />
                  </label>
                  <label>
                    Gemini API Key
                    <input
                      type="password"
                      autoComplete="off"
                      value={geminiApiKey}
                      placeholder={
                        snapshot.geminiReview?.credentialStatus === "MISSING"
                          ? "尚未設定；Gemini 圖片分析無法啟動"
                          : "已安全保存（如要更換再輸入）"
                      }
                      onChange={(event) => setGeminiApiKey(event.target.value)}
                    />
                  </label>
                  <div className="ai-form-actions">
                    <button
                      type="button"
                      disabled={
                        geminiBusy ||
                        (geminiEnabled && snapshot.geminiReview?.credentialStatus === "MISSING" && !geminiApiKey.trim())
                      }
                      onClick={() => void saveGeminiReview()}
                    >
                      {geminiBusy ? "保存中…" : "保存 Gemini 設定"}
                    </button>
                    {snapshot.geminiReview?.credentialStatus === "SAVED_ENCRYPTED" && (
                      <button
                        className="danger-text"
                        type="button"
                        disabled={geminiBusy}
                        onClick={() => void saveGeminiReview(true)}
                      >
                        清除 Gemini 金鑰
                      </button>
                    )}
                  </div>
                  <small className="ai-live-test-note">
                    素材頁明確選擇 Gemini
                    時，只送出該張低解析影格；不送完整原始影片。上方核取方塊只控制發布素材的第二次復核，不會停用你手動選擇的照片／影格分析。
                  </small>
                </div>
              </section>

              <section className="ai-settings-section">
                <div className="ai-section-heading">
                  <div>
                    <span>03</span>
                    <h3>字幕翻譯後援</h3>
                  </div>
                  <p>
                    雙語字幕先用目前 OpenAI API 帳號發出新的無狀態翻譯請求；若金鑰缺失、額度不足或請求失敗，再使用
                    Google Cloud Translation。
                  </p>
                </div>
                <div className="ai-account-warning">
                  <strong>ChatGPT／Codex 登入與 API 額度是分開的</strong>
                  <p>
                    這裡無法代替您操作 ChatGPT 網頁的新對話；App 會以 OpenAI Responses API
                    的新請求達到相同的獨立翻譯效果，並要求自然、口語且忠實。Google 後援需另外啟用 Cloud Translation API
                    與帳務，不能沿用 YouTube OAuth。
                  </p>
                </div>
                <div className="ai-account-form translation-provider-form">
                  <label>
                    Google Cloud Translation API Key
                    <input
                      type="password"
                      autoComplete="off"
                      value={googleApiKey}
                      placeholder={
                        translationSnapshot?.googleCloudConfigured
                          ? "已加密保存（如要更換再輸入）"
                          : "OpenAI 無法翻譯時的後援金鑰"
                      }
                      onChange={(event) => setGoogleApiKey(event.target.value)}
                    />
                  </label>
                  <div className="ai-form-actions">
                    <button
                      type="button"
                      disabled={translationBusy || translationTesting || !googleApiKey.trim()}
                      onClick={() => void saveGoogleKey()}
                    >
                      保存 Google 後援
                    </button>
                    <button
                      type="button"
                      disabled={translationBusy || translationTesting || !translationSnapshot?.googleCloudConfigured}
                      onClick={() => void testGoogle()}
                    >
                      {translationTesting ? "實際測試中…" : "測試 Google 翻譯"}
                    </button>
                    {translationSnapshot?.googleCloudConfigured && (
                      <button
                        className="danger-text"
                        type="button"
                        disabled={translationBusy || translationTesting}
                        onClick={() => void clearGoogle()}
                      >
                        清除 Google 金鑰
                      </button>
                    )}
                  </div>
                  <small className="ai-live-test-note">
                    金鑰只保存在 App 的加密憑證檔，不寫入專案、輸出影片或字幕 cache。翻譯結果會存入可重建的 App
                    cache，避免重複付費。
                  </small>
                </div>
              </section>

              <section className="ai-settings-section">
                <div className="ai-section-heading">
                  <div>
                    <span>04</span>
                    <h3>本專案故事背景</h3>
                  </div>
                  <p>
                    AI
                    會把語音、低解析畫面取樣與這些已知資訊互相核對；不確定的人物、地點或動物物種必須標示警告，仍需人工確認。
                  </p>
                </div>
                <div className="voice-language-row">
                  <div>
                    <strong>麥克風輸入語言</strong>
                    <small>預設繁體中文；內容可夾用英文，需要純英文辨識時再切換。</small>
                  </div>
                  <select
                    aria-label="麥克風輸入語言"
                    value={voiceLanguage}
                    disabled={busy}
                    onChange={(event) => changeVoiceLanguage(event.target.value as VoiceInputLanguage)}
                  >
                    <option value="zh-TW">繁體中文（主要）</option>
                    <option value="en-US">English（輔助）</option>
                  </select>
                </div>
                <div className="story-context-grid">
                  <div className="voice-field">
                    <label>
                      影片主題
                      <input
                        placeholder="例如：河內四日步行旅行"
                        value={context.topic}
                        onChange={(event) =>
                          setContext((current) => ({
                            ...current,
                            topic: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <VoiceInputButton
                      language={voiceLanguage}
                      disabled={busy}
                      onError={voiceError}
                      onTranscript={(text) =>
                        setContext((current) => ({
                          ...current,
                          topic: appendText(current.topic, text),
                        }))
                      }
                    />
                  </div>
                  <div className="voice-field">
                    <label>
                      已知地點（逗號或換行）
                      <textarea
                        placeholder="河內老城、還劍湖…"
                        value={locationsText}
                        onChange={(event) => setLocationsText(event.target.value)}
                      />
                    </label>
                    <VoiceInputButton
                      language={voiceLanguage}
                      disabled={busy}
                      onError={voiceError}
                      onTranscript={(text) => setLocationsText((current) => appendText(current, text, "、"))}
                    />
                  </div>
                  <div className="voice-field">
                    <label>
                      已知人物（逗號或換行）
                      <textarea
                        placeholder="只填已確認的人物或角色稱呼"
                        value={peopleText}
                        onChange={(event) => setPeopleText(event.target.value)}
                      />
                    </label>
                    <VoiceInputButton
                      language={voiceLanguage}
                      disabled={busy}
                      onError={voiceError}
                      onTranscript={(text) => setPeopleText((current) => appendText(current, text, "、"))}
                    />
                  </div>
                  <div className="voice-field story-wide">
                    <label>
                      故事／劇本／特色說明
                      <textarea
                        placeholder="描述本片實際發生的事件、人物互動、特色與重要轉折；不要填入未拍攝的內容。"
                        value={context.storySummary}
                        onChange={(event) =>
                          setContext((current) => ({
                            ...current,
                            storySummary: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <VoiceInputButton
                      language={voiceLanguage}
                      disabled={busy}
                      onError={voiceError}
                      onTranscript={(text) =>
                        setContext((current) => ({
                          ...current,
                          storySummary: appendText(current.storySummary, text, "\n"),
                        }))
                      }
                    />
                  </div>
                  <div className="voice-field story-wide">
                    <label>
                      希望觀眾得到什麼
                      <input
                        placeholder="例如：快速理解這趟旅程的核心體驗"
                        value={context.audiencePromise}
                        onChange={(event) =>
                          setContext((current) => ({
                            ...current,
                            audiencePromise: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <VoiceInputButton
                      language={voiceLanguage}
                      disabled={busy}
                      onError={voiceError}
                      onTranscript={(text) =>
                        setContext((current) => ({
                          ...current,
                          audiencePromise: appendText(current.audiencePromise, text),
                        }))
                      }
                    />
                  </div>
                  <label>
                    字幕語言
                    <select
                      value={context.subtitleLanguage}
                      onChange={(event) =>
                        setContext((current) => ({
                          ...current,
                          subtitleLanguage: event.target.value,
                        }))
                      }
                    >
                      <option value="zh">繁體中文／華語</option>
                      <option value="en">英文</option>
                      <option value="ja">日文</option>
                      <option value="ko">韓文</option>
                      <option value="vi">越南文</option>
                    </select>
                  </label>
                  <div className="story-save">
                    <button className="primary-button" type="button" disabled={busy} onClick={() => void saveContext()}>
                      儲存故事背景
                    </button>
                  </div>
                </div>
              </section>

              <section className="ai-data-note">
                <strong>送出的資料</strong>
                <p>
                  只在您按下 AI 分析時，送出 App cache
                  內的低解析故事板與上方故事背景；勾選語音分析時才會另送短音訊。發布素材由 ChatGPT 主生成；啟用 Gemini
                  後才會把三張低解析候選與草稿交給 Gemini 復核。不送出完整原始影片。
                </p>
              </section>
            </>
          )}
          {notice && (
            <div className="notice success" role="status">
              {notice}
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="settings-footer">
          <p>AI 建議可能出錯；人物、事件、地點、時間與字幕文字都要由您確認。</p>
          <button className="secondary-button" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
