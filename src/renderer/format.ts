export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatDuration(durationMs?: number): string {
  if (!durationMs) return "—";
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Editable time format: total minutes:seconds, with optional hundredths. */
export function formatMinuteSecondInput(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
  const totalHundredths = Math.round(safeMs / 10);
  const minutes = Math.floor(totalHundredths / 6_000);
  const secondsHundredths = totalHundredths % 6_000;
  const seconds = Math.floor(secondsHundredths / 100);
  const hundredths = secondsHundredths % 100;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

/** Accepts M:SS, M:SS.xx or H:MM:SS.xx and returns milliseconds. */
export function parseMinuteSecondInput(value: string): number | undefined {
  const normalized = value.trim();
  const match = /^(?:(\d+):)?(\d+):([0-5]\d)(?:[.,](\d{1,3}))?$/.exec(normalized);
  if (!match) return undefined;
  const hasHours = match[1] !== undefined;
  const hours = hasHours ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes) || minutes < 0 || (hasHours && minutes > 59)) return undefined;
  const fraction = (match[4] ?? "").padEnd(3, "0");
  const milliseconds = fraction ? Number(fraction) : 0;
  const result = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function formatDate(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function formatResolution(width?: number, height?: number): string {
  return width && height ? `${width} × ${height}` : "—";
}
