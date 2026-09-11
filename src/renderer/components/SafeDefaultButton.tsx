import { useEffect, useRef, type ButtonHTMLAttributes } from "react";

/**
 * Safe defaults get both keyboard focus and the Windows pointer when a compact
 * confirmation opens. Cursor movement is best-effort; focus remains the
 * accessible fallback when Windows blocks pointer positioning.
 */
export function SafeDefaultButton({ autoFocus = true, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const button = ref.current;
      if (!button || button.disabled) return;
      button.focus();
      const rect = button.getBoundingClientRect();
      if (rect.width > 1 && rect.height > 1) {
        window.sourceApp.moveCursorToSafeAction?.({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }, 40);
    return () => window.clearTimeout(timer);
  }, []);

  return <button ref={ref} autoFocus={autoFocus} {...props} />;
}
