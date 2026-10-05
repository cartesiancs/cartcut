/**
 * Watching HTML graphics in the live preview without changing what it does.
 *
 * The host's shadow roots are closed and `document.getAnimations()` returns
 * none of their animations, so which moment a raster holds is not readable
 * directly. It is inferred instead: the `Animation.prototype.currentTime`
 * setter records what each host canvas was seeked to, `drawElementImage`
 * stamps that onto the canvas it draws into, and every preview repaint
 * (`preview-canvas.drawCanvas`) records which host canvases it drew and with
 * which stamps. Nothing here reads the app's own modules, so the same probe
 * judges a build with or without any given fix.
 *
 * Install it before the first graphic exists, or the first rasters are never
 * stamped.
 *
 * A stamp says which moment a raster was seeked to, not that the seek reached
 * everything in it. A **sentinel** covers that: a graphic visible only while a
 * no-fill animation runs, judged by its pixels. The host once lost every such
 * animation the first time a seek passed its end (`getAnimations()` leaves a
 * finished one out), so on any later pass the graphic stayed blank while its
 * stamp read correct.
 */

import type { Page } from "@playwright/test";
import type { AppSession } from "./launch";

/**
 * The sentinel's program: a white box shown only between 200 and 600 ms of its
 * own time. The clock beside it is filled, so it is always reachable and the
 * stamp stays right even when `show` is lost: losing it then reads as a blank
 * box, which only the pixels can tell.
 */
export const SENTINEL_PROGRAM = {
  kind: "graphic",
  name: "Seek sentinel",
  render: {
    type: "html",
    html: '<div class="box"></div><i class="clock"></i>',
    css:
      ".box{position:absolute;inset:0;background:#fff;opacity:0;animation:show .4s linear .2s}@keyframes show{0%,100%{opacity:1}}" +
      ".clock{position:absolute;left:0;top:0;width:1px;height:1px;animation:tick 100s linear both}@keyframes tick{to{opacity:.99}}",
  },
};
export const SENTINEL_WINDOW = { from: 200, to: 600 };

/**
 * Mute every window and take it off screen, still painting. A verification run
 * must not play sound or flash windows at whoever is at the machine; an export
 * restores throttling when it ends, so call this again after one.
 */
export async function quietWindows(session: AppSession): Promise<void> {
  await session.app.evaluate(({ app, BrowserWindow, webContents }) => {
    const g = globalThis as any;
    if (!g.__cartcutQuiet) {
      g.__cartcutQuiet = true;
      app.on("web-contents-created", (_event, contents) => contents.setAudioMuted(true));
    }
    for (const contents of webContents.getAllWebContents()) contents.setAudioMuted(true);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      window.hide();
      // The app shows its editor when it is ready; keep it from coming back.
      window.show = () => undefined;
      window.showInactive = () => undefined;
    }
  });
}

export type GraphicDraw = { id: string; t: number | null; w: number; h: number };
export type GraphicFrame = { at: number; cursor: number; playing: boolean; draws: GraphicDraw[] };
export type GraphicFailure = {
  kind: "missing" | "wrong-time" | "sentinel-blank" | "sentinel-shown";
  id: string;
  cursor: number;
  want: number;
  drew?: number | null;
  playing: boolean;
};
export type InnerTemplate = { key: string; start: number; duration: number };

export async function installGraphicProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__graphicProbe != null) return;
    const G: any = (w.__graphicProbe = {
      frames: [],
      paints: [],
      throws: [],
      seekOf: new WeakMap(),
      rasterOf: new WeakMap(),
      templates: {},
      sentinel: null as null | { id: string; from: number; to: number },
      sentinelChecks: { inside: 0, outside: 0 },
    });
    const hostCanvasOf = (el: any) => el?.getRootNode?.()?.host?.parentElement ?? null;

    const desc = Object.getOwnPropertyDescriptor(Animation.prototype, "currentTime")!;
    Object.defineProperty(Animation.prototype, "currentTime", {
      configurable: true,
      get: desc.get,
      set(v) {
        const canvas = hostCanvasOf((this as any).effect?.target);
        if (canvas?.dataset?.graphicHost != null) G.seekOf.set(canvas, v);
        desc.set!.call(this, v);
      },
    });

    const proto: any = CanvasRenderingContext2D.prototype;
    const drawElementImage = proto.drawElementImage;
    proto.drawElementImage = function (el: any, ...rest: any[]) {
      const canvas = this.canvas;
      try {
        const out = drawElementImage.call(this, el, ...rest);
        if (canvas?.dataset?.graphicHost != null) G.rasterOf.set(canvas, G.seekOf.get(canvas));
        return out;
      } catch (error) {
        G.throws.push({ id: canvas?.dataset?.graphicHost, error: String(error).slice(0, 160) });
        throw error;
      }
    };

    const requestPaint = (HTMLCanvasElement.prototype as any).requestPaint;
    (HTMLCanvasElement.prototype as any).requestPaint = function () {
      const record = { at: performance.now(), lat: null as number | null };
      G.paints.push(record);
      if (G.paints.length > 5000) G.paints.splice(0, 2500);
      this.addEventListener("paint", () => (record.lat = performance.now() - record.at), { once: true });
      return requestPaint.call(this);
    };

    let current: any = null;
    const drawImage = proto.drawImage;
    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = 8;
    inkCanvas.height = 8;
    const inkContext = inkCanvas.getContext("2d", { willReadFrequently: true })!;
    // Share of opaque pixels, for the sentinel only: reading pixels back is not free.
    const inkOf = (src: HTMLCanvasElement) => {
      inkContext.clearRect(0, 0, 8, 8);
      drawImage.call(inkContext, src, 0, 0, 8, 8);
      const data = inkContext.getImageData(0, 0, 8, 8).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque += 1;
      return opaque / 64;
    };
    proto.drawImage = function (src: any, ...rest: any[]) {
      if (current != null && src instanceof HTMLCanvasElement && src.dataset.graphicHost != null) {
        const id = src.dataset.graphicHost;
        const draw: any = { id, t: G.rasterOf.get(src) ?? null, w: src.width, h: src.height };
        if (G.sentinel != null && id === G.sentinel.id) draw.ink = inkOf(src);
        current.draws.push(draw);
      }
      return drawImage.apply(this, [src, ...rest]);
    };
    const preview: any = document.querySelector("preview-canvas");
    const drawCanvas = preview.drawCanvas;
    preview.drawCanvas = function (canvas: any) {
      const frame = { at: performance.now(), cursor: this.timelineCursor, playing: !!this.timelineControl?.isPlay, draws: [] };
      current = frame;
      try {
        return drawCanvas.call(this, canvas);
      } finally {
        current = null;
        G.frames.push(frame);
        if (G.frames.length > 20000) G.frames.splice(0, 10000);
      }
    };
    G.redraw = () => preview.scheduleDraw();
    G.take = () => {
      const frames = G.frames;
      G.frames = [];
      return frames;
    };

    // The program time every visible HTML graphic should show at `cursor`:
    // `graphicTime.ts` restated (frame-snapped, clock head added), plus the one
    // graphic a registered template holds.
    G.expected = (cursor: number) => {
      const C = w.CARTCUT;
      const fps = C.renderOptionStore.getState().options.fps;
      const frameStart = (ms: number) => (Math.floor((ms * fps) / 1000 + 1e-6) * 1000) / fps;
      const out: Array<{ id: string; t: number }> = [];
      for (const [id, e] of Object.entries<any>(C.useTimelineStore.getState().timeline)) {
        if (e.trackHidden || cursor < e.startTime || cursor >= e.startTime + e.duration) continue;
        if (e.filetype === "graphic") {
          out.push({ id, t: (e.clockHead ?? 0) + Math.min(e.duration, Math.max(0, frameStart(cursor) - e.startTime)) });
        } else if (e.filetype === "template" && G.templates[e.templateId] != null) {
          const spec = G.templates[e.templateId];
          const inner = Math.min(Math.max(cursor - e.startTime, 0), e.duration);
          if (inner >= spec.start && inner < spec.start + spec.duration) {
            out.push({ id: `${id}::${spec.key}`, t: Math.min(spec.duration, Math.max(0, frameStart(inner) - spec.start)) });
          }
        }
      }
      return out;
    };

    G.judge = (frames: any[], tolMs: number) => {
      const bad: any[] = [];
      let checked = 0;
      for (const f of frames) {
        for (const want of G.expected(f.cursor)) {
          checked += 1;
          const got = f.draws.filter((d: any) => d.id === want.id);
          const base = { id: want.id, cursor: Math.round(f.cursor), want: Math.round(want.t), playing: f.playing };
          if (got.length === 0) {
            bad.push({ kind: "missing", ...base });
            continue;
          }
          const d = got[got.length - 1];
          if (d.t == null || Math.abs(d.t - want.t) > tolMs) {
            bad.push({ kind: "wrong-time", ...base, drew: d.t == null ? null : Math.round(d.t) });
            continue;
          }
          // The sentinel's content, judged clear of its window's edges by the
          // tolerance plus a frame, so a raster that trails slightly is not
          // mistaken for one that lost its animation.
          const s = G.sentinel;
          if (s != null && want.id === s.id && d.ink != null) {
            const margin = tolMs + 20;
            const inside = want.t >= s.from + margin && want.t <= s.to - margin;
            const outside = want.t <= s.from - margin || want.t >= s.to + margin;
            if (inside) G.sentinelChecks.inside += 1;
            if (outside) G.sentinelChecks.outside += 1;
            if ((inside && d.ink < 0.5) || (outside && d.ink > 0.5)) {
              bad.push({ kind: inside ? "sentinel-blank" : "sentinel-shown", ...base, drew: Math.round(d.t) });
            }
          }
        }
      }
      return { checked, bad };
    };

    G.lag = (frames: any[]) => {
      const lags: number[] = [];
      for (const f of frames) {
        for (const want of G.expected(f.cursor)) {
          const d = f.draws.filter((x: any) => x.id === want.id).pop();
          if (d != null && d.t != null) lags.push(Math.abs(d.t - want.t));
        }
      }
      lags.sort((a, b) => a - b);
      const q = (p: number) => (lags.length ? Math.round(lags[Math.min(lags.length - 1, Math.floor(p * lags.length))]) : null);
      return { n: lags.length, p50: q(0.5), p95: q(0.95), max: q(1) };
    };

    G.quiet = async (maxMs = 5000) => {
      const t0 = performance.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 50));
        const now = performance.now();
        const lastPaint = G.paints.length ? G.paints[G.paints.length - 1].at : 0;
        const lastFrame = G.frames.length ? G.frames[G.frames.length - 1].at : 0;
        if ((now - lastPaint > 300 && now - lastFrame > 150) || now - t0 > maxMs) return;
      }
    };
  });
}

/** Tell the probe which clip is the sentinel. */
export async function registerSentinel(page: Page, id: string): Promise<void> {
  await page.evaluate(([clip, from, to]) => ((window as any).__graphicProbe.sentinel = { id: clip, from, to }), [id, SENTINEL_WINDOW.from, SENTINEL_WINDOW.to] as const);
}

/** Tell the probe which graphic a template holds, so it can expect it. */
export async function registerTemplate(page: Page, templateId: string, inner: InnerTemplate): Promise<void> {
  await page.evaluate(([id, spec]) => ((window as any).__graphicProbe.templates[id as string] = spec), [templateId, inner] as const);
}

export async function frameMs(page: Page): Promise<number> {
  return page.evaluate(() => 1000 / (window as any).CARTCUT.renderOptionStore.getState().options.fps);
}

/** Drop everything recorded so far. */
export async function discardFrames(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__graphicProbe.take());
}

/** Judge every playing frame recorded since the last take, at `tolMs`. */
export async function judgePlayback(
  page: Page,
  tolMs: number,
): Promise<{ checked: number; bad: GraphicFailure[]; lag: { n: number; p50: number | null; p95: number | null; max: number | null } }> {
  return page.evaluate((tol) => {
    const G = (window as any).__graphicProbe;
    const frames = G.take().filter((f: any) => f.playing);
    return { ...G.judge(frames, tol), lag: G.lag(frames) };
  }, tolMs);
}

/**
 * Let the preview go quiet, repaint it once as any interaction would, let it go
 * quiet again, and judge the last frame exactly: every visible graphic drawn,
 * at its own frame.
 */
export async function judgeSettled(page: Page): Promise<{ checked: number; bad: GraphicFailure[] }> {
  return page.evaluate(async () => {
    const G = (window as any).__graphicProbe;
    await G.quiet();
    G.take();
    G.redraw();
    await new Promise((r) => setTimeout(r, 60));
    await G.quiet();
    const frames = G.take();
    const last = frames[frames.length - 1];
    const fps = (window as any).CARTCUT.renderOptionStore.getState().options.fps;
    if (last == null) return { checked: 0, bad: [{ kind: "missing", id: "(no frame)", cursor: -1, want: -1, playing: false }] };
    return G.judge([last], 500 / fps);
  });
}

export async function probeHealth(
  page: Page,
): Promise<{ drawElementImageThrows: number; paintsNeverCame: number; hostCanvases: number; sentinelChecks: { inside: number; outside: number } }> {
  return page.evaluate(() => {
    const G = (window as any).__graphicProbe;
    return {
      sentinelChecks: { ...G.sentinelChecks },
      drawElementImageThrows: G.throws.length,
      paintsNeverCame: G.paints.filter((p: any) => p.lat == null && performance.now() - p.at > 1000).length,
      hostCanvases: document.querySelectorAll("canvas[data-graphic-host]").length,
    };
  });
}
