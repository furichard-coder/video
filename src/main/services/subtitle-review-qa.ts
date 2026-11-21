import type { BrowserWindow } from "electron";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/** Explicit test-only seam: all writes must use the caller's isolated profile. */
export async function runSubtitleReviewQa(window: BrowserWindow): Promise<void> {
  if (!process.env.APP_TEST_USER_DATA_PATH) throw new Error("Review QA requires an isolated profile");
  const mode = process.env.APP_SUBTITLE_REVIEW_QA;
  const evaluate = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source, true);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async <T>(source: string, accept: (value: T) => boolean, timeoutMs = 25000): Promise<T> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await evaluate<T>(source);
      if (accept(value)) return value;
      await wait(120);
    }
    throw new Error(`Review QA timed out: ${source.slice(0, 100)}`);
  };
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('CC 字幕'));
    if (!button) throw new Error('Subtitle button not found'); button.click();
  })()`);
  await poll<number>(
    `document.querySelectorAll('[data-testid="project-subtitle-cue-list"] [data-cue-id]').length`,
    (count) => count === (mode === "FOCUS" ? 100 : 3),
  );
  // Align the outer page before a cue starts its smooth inner-list scroll.
  // Moving an ancestor during that animation cancels Chromium's scroll chain.
  await evaluate(`(() => {
    const body = document.querySelector('.subtitle-review-body'), layout = document.querySelector('.subtitle-review-layout');
    body.scrollTop += layout.getBoundingClientRect().top - body.getBoundingClientRect().top;
  })()`);
  const firstIndex = mode === "FOCUS" ? 50 : 1;
  await evaluate(`(() => {
    window.__reviewVideoTrace = [];
    window.__reviewScrollTrace = [];
    const originalScroll = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function(...args) {
      window.__reviewScrollTrace.push({ target: this.className, args, scrollHeight: this.scrollHeight, height: this.clientHeight });
      return originalScroll.apply(this, args);
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      const src = this.currentSrc || this.src;
      window.__reviewVideoTrace.push({ event: 'play-called', src, time: this.currentTime, paused: this.paused });
      return originalPlay.call(this).then(() => { window.__reviewVideoTrace.push({ event: 'play-ok', src }); }, error => {
        window.__reviewVideoTrace.push({ event: 'play-rejected', src, name: error.name, message: error.message }); throw error;
      });
    };
    for (const event of ['loadedmetadata', 'canplay', 'play', 'pause', 'ended', 'error']) document.addEventListener(event, e => {
      if (e.target instanceof HTMLVideoElement) window.__reviewVideoTrace.push({ event, src: e.target.src, time: e.target.currentTime });
    }, true);
  })()`);
  await evaluate(`document.querySelector('[aria-label="跳到第 ${firstIndex} 筆字幕"]').click()`);
  await poll<boolean>(
    `(() => { const v = document.querySelector('video[aria-label="字幕快速區段 Proxy 預覽"]'); return Boolean(v && v.readyState >= 2); })()`,
    Boolean,
  );
  const snapshot = `(() => {
    const v = document.querySelector('video[aria-label="字幕快速區段 Proxy 預覽"]');
    const photo = document.querySelector('.subtitle-source-image');
    const clock = document.querySelector('[aria-label="字幕預覽時間"]');
    const pane = document.querySelector('.subtitle-review-main');
    const list = document.querySelector('[data-testid="project-subtitle-cue-list"]');
    const rect = pane?.getBoundingClientRect();
    const photoPlaying = [...document.querySelectorAll('.subtitle-time-scrubber button')].some(item => item.textContent?.includes('暫停'));
    return { clock: Number(clock?.value || 0), paused: v?.paused ?? !photoPlaying, src: v?.src ?? photo?.src,
      overlay: document.querySelector('.subtitle-overlay-preview')?.textContent ?? '',
      scrollTop: list?.scrollTop, previewY: rect?.y, previewHeight: rect?.height };
  })()`;
  const before = await evaluate<{ clock: number; paused: boolean; previewY: number }>(snapshot);
  const actualEnd = await evaluate<number>(`Number(document.querySelector('[aria-label="字幕預覽時間"]').max)`);
  const metrics: Record<string, unknown> = { mode, before, actualEnd, actualVideoPlayback: true, paidAiRequests: 0 };
  if (mode === "FOCUS") {
    const focus = await poll<{ fraction: number; scrollTop: number; previewY: number }>(
      `(() => {
      const list = document.querySelector('[data-testid="project-subtitle-cue-list"]');
      const row = list.querySelector('[data-cue-id="qa-50"]');
      const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
      return { fraction: (r.y + r.height / 2 - l.y) / l.height, scrollTop: list.scrollTop,
        clock: Number(document.querySelector('[aria-label="字幕預覽時間"]').value),
        overlay: document.querySelector('.subtitle-overlay-preview')?.textContent,
        offsetParent: row.offsetParent?.className,
        scrollTrace: window.__reviewScrollTrace,
        previewY: document.querySelector('.subtitle-review-main').getBoundingClientRect().y };
    })()`,
      (value) => Math.abs(value.fraction - 0.45) <= 0.12,
      5000,
    );
    if (Math.abs(focus.fraction - 0.45) > 0.18 || Math.abs(focus.previewY - before.previewY) > 2)
      throw new Error(`Focus position failed ${JSON.stringify(focus)}`);
    metrics.focus = focus;
  } else {
    await evaluate(`(() => {
      const video = document.querySelector('video[aria-label="字幕快速區段 Proxy 預覽"]'); video.muted = true;
      const button = [...document.querySelectorAll('.subtitle-time-scrubber button')].find(item => item.textContent?.includes('播放'));
      if (!button) throw new Error('Play button unavailable'); button.click();
    })()`);
    await poll<{ paused: boolean }>(snapshot, (value) => !value.paused);
    await evaluate(`document.querySelector('.subtitle-review-body').focus({preventScroll:true})`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    const paused = await poll<{ clock: number; paused: boolean }>(snapshot, (value) => value.paused);
    await evaluate(
      `(() => { const editor = document.querySelector('[aria-label="直接編輯第 1 筆字幕"]'); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); })()`,
    );
    window.webContents.sendInputEvent({ type: "char", keyCode: " " });
    await wait(300);
    const edit = await evaluate<{ clock: number; paused: boolean; text: string }>(
      `(() => { const v = document.querySelector('video'); return { clock: Number(document.querySelector('[aria-label="字幕預覽時間"]').value), paused: v.paused, text: document.querySelector('[aria-label="直接編輯第 1 筆字幕"]').value }; })()`,
    );
    if (!edit.paused || !edit.text.endsWith(" ") || Math.abs(edit.clock - paused.clock) > 100)
      throw new Error(`Textarea Space/clock failed ${JSON.stringify(edit)}`);
    metrics.spacePauseAndTextSpace = true;
    await evaluate(`document.querySelector('.subtitle-review-body').focus({preventScroll:true})`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    const samples: Array<{ clock: number; paused: boolean; src: string; overlay: string }> = [];
    const started = Date.now();
    let lastChanged = Date.now();
    while (Date.now() - started < 70000) {
      const value = await evaluate<(typeof samples)[number]>(snapshot);
      const previous = samples.at(-1);
      if (previous && value.clock < previous.clock - 100)
        throw new Error(`Playback clock moved backwards ${previous.clock} -> ${value.clock}`);
      samples.push(value);
      if (!previous || value.clock !== previous.clock) lastChanged = Date.now();
      if (value.clock >= actualEnd - 100 && value.paused) break;
      if (value.paused && Date.now() - lastChanged > 8000) break;
      await wait(100);
    }
    const last = samples.at(-1);
    const sources = [...new Set(samples.map((sample) => sample.src).filter(Boolean))];
    if (!last || last.clock < actualEnd - 100 || sources.length !== 3) {
      const trace = await evaluate<unknown>(`window.__reviewVideoTrace`);
      throw new Error(`Continuous playback failed ${JSON.stringify({ last, actualEnd, sources, trace })}`);
    }
    const crossing = samples.filter((sample) => sample.clock >= 19500 && sample.clock <= 23500);
    if (!crossing.length || crossing.some((sample) => !sample.overlay.includes("測試字幕 3")))
      throw new Error("Cross-segment subtitle disappeared");
    metrics.final = last;
    metrics.segmentSources = sources;
    metrics.sampleCount = samples.length;
    metrics.crossBoundarySubtitle = true;
    metrics.samples = samples;
  }
  const output = process.env.APP_SUBTITLE_REVIEW_QA_OUTPUT;
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, `${mode}.json`), JSON.stringify(metrics, null, 2), "utf8");
    await writeFile(path.join(output, `${mode}.png`), (await window.capturePage()).toPNG());
  }
  console.log(`SUBTITLE_REVIEW_QA_RESULT ${JSON.stringify(metrics)}`);
}
