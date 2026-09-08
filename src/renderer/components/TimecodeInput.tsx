import { useEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";

interface Props {
  valueMs: number;
  maxMs?: number;
  onChange: (valueMs: number) => void;
  label: string;
  disabled?: boolean;
}

/** Accessible minute/second/millisecond editor. Enter advances to the next field. */
export function TimecodeInput({ valueMs, maxMs, onChange, label, disabled }: Props) {
  const minuteRef = useRef<HTMLInputElement>(null);
  const secondRef = useRef<HTMLInputElement>(null);
  const milliRef = useRef<HTMLInputElement>(null);
  const safe = Math.max(0, Math.min(maxMs ?? Number.MAX_SAFE_INTEGER, Math.round(valueMs)));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  const update = (part: "m" | "s" | "ms", raw: string) => {
    const number = Math.max(0, Number.parseInt(raw || "0", 10) || 0);
    const next = part === "m" ? number * 60_000 + seconds * 1_000 + millis : part === "s" ? minutes * 60_000 + Math.min(59, number) * 1_000 + millis : minutes * 60_000 + seconds * 1_000 + Math.min(999, number);
    onChange(Math.min(maxMs ?? Number.MAX_SAFE_INTEGER, next));
  };
  useEffect(() => {
    if (minuteRef.current) minuteRef.current.value = String(minutes);
    if (secondRef.current) secondRef.current.value = String(seconds).padStart(2, "0");
    if (milliRef.current) milliRef.current.value = String(millis).padStart(3, "0");
  }, [minutes, seconds, millis]);
  const advance = (event: KeyboardEvent<HTMLInputElement>, next: RefObject<HTMLInputElement | null>) => {
    if (event.key === "Enter") { event.preventDefault(); next.current?.focus(); next.current?.select(); }
  };
  return <span className="timecode-input" aria-label={label}>
    <input ref={minuteRef} aria-label={`${label} 分`} type="number" min="0" max="999" defaultValue={minutes} disabled={disabled} onChange={(event) => update("m", event.target.value)} onKeyDown={(event) => advance(event, secondRef)} />
    <span>:</span><input ref={secondRef} aria-label={`${label} 秒`} type="number" min="0" max="59" defaultValue={seconds} disabled={disabled} onChange={(event) => update("s", event.target.value)} onKeyDown={(event) => advance(event, milliRef)} />
    <span>.</span><input ref={milliRef} aria-label={`${label} 毫秒`} type="number" min="0" max="999" defaultValue={millis} disabled={disabled} onChange={(event) => update("ms", event.target.value)} />
  </span>;
}
