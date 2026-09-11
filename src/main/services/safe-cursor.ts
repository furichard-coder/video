import { spawn } from "node:child_process";
import path from "node:path";

export interface UiRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiPoint {
  x: number;
  y: number;
}

/**
 * Converts a renderer button rectangle into a window-content DIP point while
 * refusing coordinates outside that renderer.  The caller converts the result
 * to a physical screen point before invoking the narrowly scoped Windows helper.
 */
export function safeActionCenter(
  contentBounds: UiRectangle,
  rendererSize: { width: number; height: number },
  actionRect: UiRectangle,
): UiPoint | undefined {
  const values = [
    contentBounds.x,
    contentBounds.y,
    contentBounds.width,
    contentBounds.height,
    rendererSize.width,
    rendererSize.height,
    actionRect.x,
    actionRect.y,
    actionRect.width,
    actionRect.height,
  ];
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  if (rendererSize.width <= 0 || rendererSize.height <= 0 || actionRect.width <= 1 || actionRect.height <= 1)
    return undefined;
  if (
    actionRect.x < 0 ||
    actionRect.y < 0 ||
    actionRect.x + actionRect.width > rendererSize.width + 1 ||
    actionRect.y + actionRect.height > rendererSize.height + 1
  )
    return undefined;
  return {
    x: Math.round(contentBounds.x + actionRect.x + actionRect.width / 2),
    y: Math.round(contentBounds.y + actionRect.y + actionRect.height / 2),
  };
}

const WINDOWS_CURSOR_SCRIPT = [
  "$x=[int]$env:SCENERYWALKER_CURSOR_X",
  "$y=[int]$env:SCENERYWALKER_CURSOR_Y",
  "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class SceneryWalkerCursor { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y); }'",
  "[void][SceneryWalkerCursor]::SetCursorPos($x,$y)",
].join("; ");

/** Move only to a validated App safe-action point; no shell string is composed. */
export function moveWindowsCursor(point: UiPoint): void {
  if (process.platform !== "win32" || !Number.isInteger(point.x) || !Number.isInteger(point.y)) return;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(
    executable,
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_CURSOR_SCRIPT],
    {
      env: { ...process.env, SCENERYWALKER_CURSOR_X: String(point.x), SCENERYWALKER_CURSOR_Y: String(point.y) },
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.once("error", () => undefined);
  child.unref();
}
