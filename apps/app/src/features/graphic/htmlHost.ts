/**
 * The html-in-canvas host: the one file that calls html-in-canvas.
 *
 * The tree, its state and its settle are `graphicDom.ts`'s, shared with the
 * snapshot host. What is here is how this host hangs a graphic, waits for it
 * and draws it, and every rule is a measurement from
 * `tests/spikes/html-in-canvas/` (`tests/e2e/FINDINGS.md` section 10) that
 * prevents a specific failure:
 *
 *  - **One host canvas per graphic, its only child the graphic's root.**
 *    Direct children are what get painted; one canvas each keeps every root at
 *    the canvas origin, where nothing culls it.
 *  - **Both opt-ins, on every build.** Older Chromium, the desktop app's 152
 *    among them, knows the canvas attribute `layoutsubtree`. The shape Chrome
 *    turns on by default in 157 is `content="drawable"` on the canvas and
 *    `drawable` on each child it draws, and the old name is accepted only
 *    through 157. A build ignores the other shape's attributes, so one mount
 *    serves both.
 *  - **In a browser, support is a drawn pixel** (`htmlSupport`), never the
 *    presence of the calls: a build can expose them and paint nothing.
 *  - **Hidden with `clip-path: inset(50%)`.** `opacity: 0` on the canvas paints
 *    every child transparent, a canvas far off screen is culled to nothing, and
 *    `visibility: hidden` leaves no paint record to draw at all.
 *  - **A closed shadow root, never an iframe.** An iframe under a
 *    `layoutsubtree` canvas crashes the renderer outright.
 *  - **A change is drawable only after the next `paint` event.** So `apply`
 *    mutates, `settle` waits for the paint, and `rasterize` draws afterwards.
 */

import type { HtmlRasterPort } from "./htmlRasterPort";
import { LiveGraphicHost, type LiveMount } from "./graphicDom";
import { getLocationEnv } from "../../functions/getLocationEnv";

export { MAX_MOUNTS } from "./graphicDom";

/** How long a paint may take before `settle` gives up on it. */
const PAINT_TIMEOUT_MS = 500;

/**
 * Whether the two calls exist. Not whether they draw: see `htmlSupport`. The
 * opt-in is not tested, because its name is the part that changed.
 */
function supportedHere(): boolean {
  try {
    return (
      typeof (CanvasRenderingContext2D.prototype as any).drawElementImage === "function" &&
      typeof (HTMLCanvasElement.prototype as any).requestPaint === "function"
    );
  } catch {
    return false;
  }
}

function waitPaint(canvas: HTMLCanvasElement): Promise<boolean> {
  // A mount released since it was applied is out of the document and never
  // paints; waiting for it held every other graphic in the prepare for the
  // whole timeout.
  if (!canvas.isConnected) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        canvas.removeEventListener("paint", onPaint);
        resolve(ok);
      }
    };
    const onPaint = () => finish(true);
    canvas.addEventListener("paint", onPaint);
    setTimeout(() => finish(false), PAINT_TIMEOUT_MS);
    try {
      (canvas as any).requestPaint();
    } catch {
      finish(false);
    }
  });
}

export class HtmlHost extends LiveGraphicHost<null> implements HtmlRasterPort {
  private reported = new Set<string>();

  supported(): boolean {
    return known ?? (isDesktop() && supportedHere());
  }

  protected createHost(instanceId: string): { host: HTMLElement; outer: HTMLDivElement; x: null } {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("layoutsubtree", "");
    canvas.setAttribute("content", "drawable");
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.graphicHost = instanceId;
    canvas.style.cssText =
      "position:fixed;left:0;top:0;clip-path:inset(50%);pointer-events:none;z-index:-1;";
    const outer = document.createElement("div");
    outer.setAttribute("drawable", "");
    canvas.appendChild(outer);
    return { host: canvas, outer, x: null };
  }

  protected sizeHost(mount: LiveMount<null>, width: number, height: number): void {
    mount.host.style.width = width + "px";
    mount.host.style.height = height + "px";
  }

  async settle(): Promise<boolean> {
    const touched = await this.settleLive();
    const results = await Promise.all(
      touched.map((mount) => waitPaint(mount.host as HTMLCanvasElement)),
    );
    return results.every(Boolean);
  }

  rasterize(instanceId: string, width: number, height: number): CanvasImageSource | null {
    const mount = this.mounts.get(instanceId);
    if (mount == null) {
      return null;
    }
    const canvas = mount.host as HTMLCanvasElement;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return null;
    }
    try {
      ctx.clearRect(0, 0, width, height);
      (ctx as any).drawElementImage(mount.outer, 0, 0, width, height);
      return canvas;
    } catch (error) {
      if (!this.reported.has(instanceId)) {
        this.reported.add(instanceId);
        console.warn("graphic: could not rasterise " + instanceId, error);
      }
      return null;
    }
  }
}

/** What `htmlSupport` settled on; `null` until it has. */
let known: boolean | null = null;
let deciding: Promise<boolean> | null = null;

/** Paints a probe may miss before the answer is no. */
const PROBE_ATTEMPTS = 3;

function isDesktop(): boolean {
  return getLocationEnv() === "electron";
}

/** Resolves once the page is visible: a hidden tab paints nothing to probe with. */
function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== "hidden") {
        document.removeEventListener("visibilitychange", onChange);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/**
 * Whether html-in-canvas draws here, asked by drawing something: one solid red
 * square through the same host every graphic uses, read back a pixel at a time.
 * `"unknown"` when no paint came, which says nothing about support.
 */
async function probeHtmlInCanvas(): Promise<"yes" | "no" | "unknown"> {
  if (!supportedHere() || typeof document === "undefined") {
    return "no";
  }
  const host = new HtmlHost();
  const id = "html-in-canvas-probe";
  try {
    host.mount(id, {
      programKey: "probe",
      nodes: [
        {
          kind: "element",
          tag: "div",
          ns: "html",
          attrs: [["style", "position:absolute;inset:0;background:#ff0000;"]],
          children: [],
        },
      ],
      css: "",
      propertyRules: "",
      renames: {},
      assetUrls: {},
      programHash: "probe",
    });
    host.apply(id, {
      vars: {},
      texts: {},
      layoutBox: { width: 8, height: 8 },
      bleed: 0,
      timeMs: 0,
      seed: 0,
      fonts: [],
    });
    if (!(await host.settle())) {
      return "unknown";
    }
    const raster = host.rasterize(id, 8, 8) as HTMLCanvasElement | null;
    const pixel = raster?.getContext("2d")?.getImageData(4, 4, 1, 1).data;
    return pixel != null && pixel[0] > 200 && pixel[1] < 50 && pixel[3] > 200 ? "yes" : "no";
  } catch {
    return "no";
  } finally {
    host.release(new Set());
  }
}

/**
 * Whether html-in-canvas draws in this page. Asked once and remembered.
 *
 * The desktop app turns the API on for its own window
 * (`electron/lib/window.ts`), so there the calls existing is the answer, and a
 * probe could only fail for a reason that is not about support (a minimised
 * window paints nothing). In a browser the answer is a drawn pixel. A probe that
 * got no paint is retried, after the tab is visible again if it was hidden, and
 * the answer is no only after `PROBE_ATTEMPTS` of them.
 *
 * "No" is not the end of graphics in this page: `graphicBackend.ts` then asks
 * whether the snapshot host can draw them instead.
 */
export function htmlSupport(): Promise<boolean> {
  if (known != null) {
    return Promise.resolve(known);
  }
  if (deciding == null) {
    deciding = (async () => {
      if (!supportedHere()) {
        return false;
      }
      if (isDesktop()) {
        return true;
      }
      for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
        await whenVisible();
        const answer = await probeHtmlInCanvas();
        if (answer !== "unknown") {
          return answer === "yes";
        }
      }
      return false;
    })().then((answer) => {
      known = answer;
      return answer;
    });
  }
  return deciding;
}
