import { useEffect, useRef, useState } from "react";
import type { VoiceInputLanguage } from "../../shared/domain";

interface Props {
  language: VoiceInputLanguage;
  disabled?: boolean;
  onTranscript(text: string): void;
  onError(message: string): void;
}

const MAX_RECORDING_MS = 120_000;

function preferredMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find((value) => MediaRecorder.isTypeSupported(value)) ?? "";
}

export function VoiceInputButton({ language, disabled, onTranscript, onError }: Props) {
  const [recording, setRecording] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cleanup = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    recorderRef.current = undefined;
  };

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    cleanup();
  }, []);

  const stop = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("這個 Windows 環境無法啟用 App 麥克風；可先按 Win+H 使用 Windows 語音輸入。");
      return;
    }
    try {
      onError("");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunksRef.current.push(event.data); });
      recorder.addEventListener("error", () => {
        setRecording(false); setRecognizing(false); cleanup();
        onError("麥克風錄音失敗，請檢查 Windows 麥克風權限與輸入裝置。");
      }, { once: true });
      recorder.addEventListener("stop", async () => {
        setRecording(false); setRecognizing(true);
        const actualType = recorder.mimeType || chunksRef.current[0]?.type || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: actualType });
        cleanup();
        try {
          if (!blob.size) throw new Error("沒有收到麥克風聲音，請再錄一次。");
          const result = await window.sourceApp.transcribeVoiceInput({ audioBytes: new Uint8Array(await blob.arrayBuffer()), mimeType: actualType, language });
          onTranscript(result.text);
        } catch (reason) {
          onError(reason instanceof Error ? reason.message : String(reason));
        } finally { setRecognizing(false); }
      }, { once: true });
      recorder.start(250);
      setRecording(true);
      timerRef.current = setTimeout(stop, MAX_RECORDING_MS);
    } catch (reason) {
      cleanup(); setRecording(false); setRecognizing(false);
      const name = reason instanceof DOMException ? reason.name : "";
      onError(name === "NotAllowedError" ? "Windows 或 App 尚未允許使用麥克風；請在隱私權設定開啟權限後重試。" : reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <button
    className={`voice-input-button ${recording ? "is-recording" : ""}`}
    type="button"
    disabled={disabled || recognizing}
    aria-pressed={recording}
    aria-label={recording ? "停止錄音並辨識文字" : `${language === "zh-TW" ? "繁體中文" : "英文"}語音輸入`}
    onClick={() => recording ? stop() : void start()}
  >{recognizing ? "辨識中…" : recording ? "■ 停止並轉文字" : "🎙 語音輸入"}</button>;
}
