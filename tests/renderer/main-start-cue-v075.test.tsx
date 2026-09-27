// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainStartCardModal } from "../../src/renderer/components/MainStartCardModal";

const card = {
  durationSeconds: 4,
  line1: "漫步風光",
  line2: "正片即將開始",
  line1FontSize1080p: 114,
  line2FontSize1080p: 90,
  lineGap1080p: 122,
  overlayOpacityPercent: 62,
  transitionStyle: "DISSOLVE" as const,
};

afterEach(cleanup);

describe("v0.75 Main-start cue UI", () => {
  it("classifies the cue as Main Audio and saves independent enabled/duration settings", () => {
    const onSave = vi.fn();
    render(
      <MainStartCardModal
        value={card}
        cue={{ enabled: true, durationMs: 650 }}
        introClips={[]}
        assets={[]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    const group = screen.getByRole("group", { name: "正片 Audio" });
    const toggle = screen.getByRole("checkbox", { name: "SFX · 正片開始提示音" });
    expect(group).toContainElement(toggle);
    expect(toggle).toBeChecked();
    const duration = screen.getByRole("spinbutton", { name: "正片開始提示音長度（秒）" });
    expect(duration).toHaveValue(0.65);
    fireEvent.change(duration, { target: { value: "1.2" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存提示頁設定" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ line1: "漫步風光" }), {
      enabled: true,
      durationMs: 1_200,
    });
  });

  it("can turn the Main cue off without altering the visual card", () => {
    const onSave = vi.fn();
    render(
      <MainStartCardModal
        value={card}
        cue={{ enabled: true, durationMs: 650 }}
        introClips={[]}
        assets={[]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "SFX · 正片開始提示音" }));
    expect(screen.getByRole("spinbutton", { name: "正片開始提示音長度（秒）" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "儲存提示頁設定" }));
    expect(onSave).toHaveBeenCalledWith(card, { enabled: false, durationMs: 650 });
  });
});
