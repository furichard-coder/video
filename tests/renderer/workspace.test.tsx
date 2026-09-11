// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MaterialEditorModal } from "../../src/renderer/components/MaterialEditorModal";

const asset = {
  id: "a",
  kind: "VIDEO",
  fileName: "測試.mp4",
  sourcePath: "C:/測試.mp4",
  sourcePolicy: "READ_ONLY",
  sizeBytes: 1,
} as never;

describe("workspace components", () => {
  it("exposes one material editor with section tabs and initial selection", () => {
    const open = vi.fn();
    render(<MaterialEditorModal asset={asset} initialSection="VOLUME" onClose={vi.fn()} onOpenSection={open} />);
    expect(screen.getByRole("dialog", { name: /素材編輯工作區/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "音量區段" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "安插素材" }));
    expect(open).toHaveBeenCalledWith("INSERT");
  });
});
