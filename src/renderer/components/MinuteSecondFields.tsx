import { useRef, type Ref } from "react";

interface MinuteSecondFieldsProps {
  label: string;
  valueMs: number;
  onChange(valueMs: number): void;
  minuteInputRef?: Ref<HTMLInputElement>;
  onComplete?: () => void;
  disabled?: boolean;
  maxMs?: number;
}

interface TimeRangeFieldsProps {
  startLabel: string;
  endLabel: string;
  startMs: number;
  endMs: number;
  onStartChange(valueMs: number): void;
  onEndChange(valueMs: number): void;
  disabled?: boolean;
  maxMs?: number;
  className?: string;
  onComplete?: () => void;
}

function clampTime(valueMs: number, maxMs?: number): number {
  const upper = Number.isFinite(maxMs) ? Math.max(0, Math.round(maxMs!)) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(upper, Math.round(Number.isFinite(valueMs) ? valueMs : 0)));
}

export function MinuteSecondFields({
  label,
  valueMs,
  onChange,
  minuteInputRef,
  onComplete,
  disabled = false,
  maxMs,
}: MinuteSecondFieldsProps) {
  const secondsRef = useRef<HTMLInputElement>(null);
  const safeMs = clampTime(valueMs, maxMs);
  const minutes = Math.floor(safeMs / 60_000);
  const seconds = Number(((safeMs % 60_000) / 1_000).toFixed(2));

  const changeMinutes = (raw: string) => {
    const nextMinutes = Math.max(0, Math.floor(Number(raw) || 0));
    onChange(clampTime(nextMinutes * 60_000 + seconds * 1_000, maxMs));
  };
  const changeSeconds = (raw: string) => {
    const nextSeconds = Math.max(0, Math.min(59.99, Number(raw) || 0));
    onChange(clampTime(minutes * 60_000 + nextSeconds * 1_000, maxMs));
  };

  return (
    <div className="minute-second-fields" role="group" aria-label={`${label}（分鐘與秒數）`}>
      <span className="minute-second-label">{label}</span>
      <label>
        <input
          ref={minuteInputRef}
          aria-label={`${label}－分鐘`}
          type="number"
          min="0"
          step="1"
          value={minutes}
          disabled={disabled}
          onChange={(event) => changeMinutes(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              secondsRef.current?.focus();
              secondsRef.current?.select();
            }
          }}
        />
        <span>分</span>
      </label>
      <label>
        <input
          ref={secondsRef}
          aria-label={`${label}－秒數`}
          type="number"
          min="0"
          max="59.99"
          step="0.01"
          value={seconds}
          disabled={disabled}
          onChange={(event) => changeSeconds(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onComplete) {
              event.preventDefault();
              onComplete();
            }
          }}
        />
        <span>秒</span>
      </label>
    </div>
  );
}

export function TimeRangeFields({
  startLabel,
  endLabel,
  startMs,
  endMs,
  onStartChange,
  onEndChange,
  disabled = false,
  maxMs,
  className = "",
  onComplete,
}: TimeRangeFieldsProps) {
  const endMinuteRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`time-range-fields ${className}`.trim()}>
      <MinuteSecondFields
        label={startLabel}
        valueMs={startMs}
        maxMs={maxMs}
        disabled={disabled}
        onChange={onStartChange}
        onComplete={() => {
          endMinuteRef.current?.focus();
          endMinuteRef.current?.select();
        }}
      />
      <MinuteSecondFields
        label={endLabel}
        valueMs={endMs}
        maxMs={maxMs}
        disabled={disabled}
        onChange={onEndChange}
        minuteInputRef={endMinuteRef}
        onComplete={onComplete}
      />
    </div>
  );
}
