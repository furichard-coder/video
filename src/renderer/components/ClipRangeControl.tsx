import type { PreviewRange } from "../../shared/domain";
import { formatDuration } from "../format";
import { TimeRangeFields } from "./MinuteSecondFields";

interface ClipRangeControlProps {
  durationMs: number;
  range: PreviewRange;
  compact?: boolean;
  showTimeFields?: boolean;
  onChange: (range: PreviewRange, changed: "IN" | "OUT") => void;
  onCommit?: (range: PreviewRange) => void;
}

export function ClipRangeControl({
  durationMs,
  range,
  compact = false,
  showTimeFields = false,
  onChange,
  onCommit,
}: ClipRangeControlProps) {
  const minGap = Math.min(1_000, Math.max(100, durationMs / 10));
  const safeDuration = Math.max(durationMs, minGap);
  const inPercent = (range.inMs / safeDuration) * 100;
  const outPercent = (range.outMs / safeDuration) * 100;

  const changeIn = (value: number) => {
    onChange({ inMs: Math.min(value, range.outMs - minGap), outMs: range.outMs }, "IN");
  };
  const changeOut = (value: number) => {
    onChange({ inMs: range.inMs, outMs: Math.max(value, range.inMs + minGap) }, "OUT");
  };

  return (
    <div className={`clip-range ${compact ? "is-compact" : ""}`}>
      <div className="clip-range-heading">
        <span><b>IN</b>{formatDuration(range.inMs)}</span>
        <strong>{formatDuration(range.outMs - range.inMs)}</strong>
        <span><b>OUT</b>{formatDuration(range.outMs)}</span>
      </div>
      {showTimeFields && <TimeRangeFields className="clip-range-time-fields" startLabel="片段起點" endLabel="片段終點" startMs={range.inMs} endMs={range.outMs} maxMs={durationMs} onStartChange={(value) => changeIn(value)} onEndChange={(value) => changeOut(value)} onComplete={() => onCommit?.(range)} />}
      <div className="dual-range" style={{ "--range-in": `${inPercent}%`, "--range-out": `${outPercent}%` } as React.CSSProperties}>
        <div className="range-track" />
        <div className="range-selection" />
        <input aria-label="片段起點" type="range" min={0} max={safeDuration} step={100} value={range.inMs} onChange={(event) => changeIn(Number(event.target.value))} onPointerUp={() => onCommit?.(range)} onKeyUp={() => onCommit?.(range)} onBlur={() => onCommit?.(range)} />
        <input aria-label="片段停止點" type="range" min={0} max={safeDuration} step={100} value={range.outMs} onChange={(event) => changeOut(Number(event.target.value))} onPointerUp={() => onCommit?.(range)} onKeyUp={() => onCommit?.(range)} onBlur={() => onCommit?.(range)} />
      </div>
      {!compact && <small>拖曳左右把手設定這支影片的使用起點與停止點</small>}
    </div>
  );
}
