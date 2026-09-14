/**
 * The caption editor, as a window docked beside the preview.
 *
 * It used to be a `modal-fullscreen`, so it had one width and covered the app.
 * It is a window inside `#split_col_2` now, which changes what can go wrong:
 * that column already carries `overflow-x-hidden overflow-y-hidden`, so a
 * window that overruns it is **silently cut off**. There is no scrollbar, no
 * console error, and nothing a unit test can see.
 *
 * `features/window/windowLayout.test.ts` pins the arithmetic, and it passes
 * whether or not the numbers ever reach the screen. What only the running app
 * can answer is whether the CSS applies them, whether the panel inside survives
 * a few hundred pixels of width, and whether the thing is actually visible.
 *
 * ## Why this reads pixels and not just rects
 *
 * **`getBoundingClientRect()` cannot see clipping.** An element cut off by an
 * ancestor's `overflow: hidden` reports exactly the rect it would have had, so
 * every containment assertion below would pass on a window nobody can see. The
 * border check is the one that actually looks, and its negative control is
 * what stops it passing by measuring nothing.
 *
 * Deliberately cheap, in the shape of `adjust-panel.spec.ts`: no fixtures, no
 * media, no export, and no transcription. The transcript is seeded straight
 * onto the panel, which is the same idiom that spec uses to hand a clip to an
 * inspector.
 */

import path from "node:path";

import { test, expect } from "../harness/test";
import { openTab } from "../harness/ui";
import { decodePng, crop, writePng, writeJson } from "../harness/artifacts";
import { inkBounds, pixel, type FrameBuffer } from "../harness/compare";

const WINDOW_ID = "automaticCaption";

type Box = { x: number; y: number; width: number; height: number };

/** Five lines of transcript, enough that the list scrolls in a docked window. */
const LINES = Array.from({ length: 9 }, (_, index) => {
  const start = index * 1.5;
  const words = ["this", "is", "caption", "line", String(index + 1)].map((word, w) => ({
    word,
    start: start + w * 0.2,
    end: start + w * 0.2 + 0.18,
  }));
  return { words, start, end: start + 1.4, text: words.map((w) => w.word).join(" ") };
});

/** Whether `inner` sits wholly inside `outer`, to a pixel of sub-pixel slack. */
function containment(outer: Box, inner: Box) {
  return {
    left: inner.x - outer.x,
    top: inner.y - outer.y,
    right: outer.x + outer.width - (inner.x + inner.width),
    bottom: outer.y + outer.height - (inner.y + inner.height),
  };
}

function expectInside(outer: Box, inner: Box, label: string) {
  const slack = containment(outer, inner);
  for (const [side, value] of Object.entries(slack)) {
    expect(value, `${label} overruns its host on the ${side} by ${-value}px`).toBeGreaterThan(-1.5);
  }
}

/**
 * Horizontal containment only.
 *
 * For anything inside the caption list, vertical overflow is the list
 * scrolling and is the point of it: a transcript longer than the window is the
 * normal case. Sideways is different. There is nothing to scroll horizontally
 * with, so a row wider than the window is simply cut off, which is the failure
 * a docked window makes possible and a full-screen modal never could.
 */
function expectInsideHorizontally(outer: Box, inner: Box, label: string) {
  const slack = containment(outer, inner);
  expect(slack.left, `${label} is cut off on the left by ${-slack.left}px`).toBeGreaterThan(-1.5);
  expect(slack.right, `${label} is cut off on the right by ${-slack.right}px`).toBeGreaterThan(-1.5);
}

const parseRgb = (value: string): [number, number, number] => {
  const found = value.match(/-?\d+(\.\d+)?/g) ?? [];
  return [Number(found[0] ?? 0), Number(found[1] ?? 0), Number(found[2] ?? 0)];
};

const near = (a: number[], b: number[], tolerance: number) =>
  a.every((channel, i) => Math.abs(channel - b[i]) <= tolerance);

/**
 * The fraction of each of a rect's four edges that is actually the given colour.
 *
 * `rect` is in the screenshot's own coordinates. The outermost row and column
 * are sampled, and the ends are skipped: a corner is two edges at once and,
 * whatever the radius, is not a clean sample of either.
 *
 * An edge clipped away by an ancestor is not "a slightly different colour", it
 * is whatever was behind the window, so a coarse tolerance is enough and a hard
 * threshold is honest.
 */
function borderCoverage(
  frame: FrameBuffer,
  rect: Box,
  colour: [number, number, number],
  tolerance = 26,
): { top: number; bottom: number; left: number; right: number } {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  // Clamped into the image. A rect that ends exactly on the last row rounds to
  // one past it, and an index nobody sampled reads as an edge that is missing:
  // a first draft reported the bottom border 0% present on a window that was
  // entirely on screen.
  const x1 = Math.min(frame.width - 1, Math.round(rect.x + rect.width) - 1);
  const y1 = Math.min(frame.height - 1, Math.round(rect.y + rect.height) - 1);
  const inset = 6;

  const run = (points: Array<[number, number]>) => {
    const inside = points.filter(
      ([x, y]) => x >= 0 && y >= 0 && x < frame.width && y < frame.height,
    );
    if (inside.length === 0) {
      return 0;
    }
    const hits = inside.filter(([x, y]) => {
      const p = pixel(frame, x, y);
      return near([p.r, p.g, p.b], colour, tolerance);
    });
    return hits.length / inside.length;
  };

  const xs: Array<[number, number]> = [];
  const xsBottom: Array<[number, number]> = [];
  for (let x = x0 + inset; x <= x1 - inset; x++) {
    xs.push([x, y0]);
    xsBottom.push([x, y1]);
  }
  const ys: Array<[number, number]> = [];
  const ysRight: Array<[number, number]> = [];
  for (let y = y0 + inset; y <= y1 - inset; y++) {
    ys.push([x0, y]);
    ysRight.push([x1, y]);
  }

  return { top: run(xs), bottom: run(xsBottom), left: run(ys), right: run(ysRight) };
}

test("the caption window docks beside the preview and is never clipped", async ({
  session,
  artifactDir,
}) => {
  test.setTimeout(180_000);
  const { page } = session;

  await test.step("close DevTools, which the dev build opens inside the content area", async () => {
    // Not cosmetic. `electron/lib/window.ts` opens DevTools when `isDev`, docked
    // inside the window, so the page gets 845 of a 1400px content width on this
    // machine. That is not a width any user has, and it leaves the preview
    // column too narrow for the caption window to have any travel at all: the
    // window comes up already clamped against the host and every splitter drag
    // correctly declines. Closing it is what makes the rest of this spec measure
    // the layout rather than the debugger.
    await session.app.evaluate(({ BrowserWindow }) => {
      const editor = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      );
      editor?.webContents.closeDevTools();
      editor?.setContentSize(1400, 860);
    });

    await expect
      .poll(() => page.evaluate(() => window.innerWidth), { timeout: 15_000 })
      .toBeGreaterThan(1100);
  });

  /** Two frames: one for the ResizeObserver, one for the re-layout it causes. */
  const settle = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );

  const hostWidth = () =>
    page.evaluate(
      () => document.querySelector("#split_col_2")!.getBoundingClientRect().width,
    );

  /**
   * Change the host's width by dragging the app's own preview/option divider.
   *
   * The realistic way the region changes size, and the one the window has to
   * survive: a user drags this far more often than they resize the app. It is
   * also the only reliable lever here. `page.setViewportSize` computes an
   * Electron content size from hardcoded Chromium browser-chrome insets and
   * lands on the wrong number, and resizing the `BrowserWindow` itself does not
   * move `innerWidth` predictably because the dev build opens DevTools inside
   * the content area: measured on this machine, a 1400px content width leaves
   * the page 845px.
   */
  const dragMainSplitter = async (toClientX: number) => dragBar("#split_col_2", toClientX);

  /** The panel/preview divider. Dragging it left is how the column gets wide. */
  const dragPanelSplitter = async (toClientX: number) => dragBar("#split_col_1", toClientX);

  const dragBar = async (column: string, toClientX: number) => {
    const bar = await page.evaluate((selector) => {
      const el = document.querySelector(`${selector} .split-col-bar`) as HTMLElement;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, column);

    await page.mouse.move(bar.x, bar.y);
    await page.mouse.down();
    await page.mouse.move(toClientX, bar.y, { steps: 14 });
    await page.mouse.up();
    await settle();
  };

  /** Drag the window's own splitter by a pixel delta, and settle. */
  const dragWindowSplitter = async (dx: number) => {
    const splitter = (await measure()).splitter!;
    const y = splitter.y + splitter.height / 2;
    await page.mouse.move(splitter.x + splitter.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(splitter.x + splitter.width / 2 + dx, y, { steps: 14 });
    await page.mouse.up();
    await settle();
  };

  const editorColumns = () =>
    page.evaluate(() =>
      document.querySelector("app-window .caption-editor")?.classList.contains("is-stacked")
        ? "one"
        : "two",
    );

  /** Every rect this spec measures, read in one pass so they cannot disagree. */
  const measure = () =>
    page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (el == null) {
          return null;
        }
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };

      const win = document.querySelector("app-window") as HTMLElement | null;
      const body = document.querySelector("app-window .app-window-body") as HTMLElement | null;
      // The window system's own region, not the column. `#split_col_2` always
      // reports about 3px of horizontal overflow because `.split-col-bar` sits
      // at `right: -0.2rem` on purpose, so asking the column would be measuring
      // a splitter that has been there all along.
      const region = document.querySelector("window-host") as HTMLElement | null;

      return {
        host: box("#split_col_2"),
        region: box("window-host"),
        hostScroll:
          region == null
            ? null
            : {
                overflowX: region.scrollWidth - region.clientWidth,
                overflowY: region.scrollHeight - region.clientHeight,
              },
        window: box("app-window"),
        titlebar: box("app-window .app-window-titlebar"),
        body: box("app-window .app-window-body"),
        bodyOverflowX: body == null ? null : body.scrollWidth - body.clientWidth,
        content: box("window-host > .window-host-content"),
        splitter: box(".window-splitter"),
        previewCanvas: box("preview-canvas"),
        apply: box("app-window .caption-apply"),
        firstCaption: box("app-window .caption"),
        silence: box("app-window .caption-silence"),
        // The *used* colour, not the custom property. `getPropertyValue` hands
        // back the token exactly as authored, which is the hex string
        // `#3a3f44`; `borderTopColor` is what the compositor actually painted,
        // already resolved to `rgb(...)`. A first draft read the property and
        // parsed three numbers out of the hex digits, which made the check look
        // for a colour that is nowhere on screen and report every edge missing.
        borderColour: win == null ? null : getComputedStyle(win).borderTopColor,
        // Every control the user could reach inside the window.
        controls: [
          ...document.querySelectorAll(
            "app-window button, app-window input, app-window select, app-window canvas",
          ),
        ]
          .map((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            const visible =
              r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).display !== "none";
            return {
              tag: (el as HTMLElement).className || el.tagName,
              visible,
              rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            };
          })
          .filter((entry) => entry.visible),
      };
    });

  const openState = () =>
    page.evaluate(
      (id) => {
        const store = (globalThis as any).CARTCUT.windowStore.getState();
        const win = store.windows.find((w: any) => w.id === id) ?? null;
        return {
          open: win != null,
          placement: win?.placement ?? null,
          hostSizes: store.hostSizes,
        };
      },
      WINDOW_ID,
    );

  await test.step("the Utilities tile opens a window, and the preview stays put", async () => {
    const previewBefore = (await measure()).previewCanvas!;
    expect(previewBefore.width).toBeGreaterThan(0);

    await openTab(page, "#nav-util");
    await page
      .locator("control-ui-util .asset", { hasText: "Automatic Caption" })
      .click();

    await expect(page.locator("app-window")).toHaveCount(1, { timeout: 15_000 });

    const state = await openState();
    expect(state.open).toBe(true);
    expect(state.placement).toMatchObject({ mode: "docked", side: "right" });

    // The panel it replaced put itself over the preview. This one must not: the
    // whole point of the change is captioning while watching the footage.
    const after = await measure();
    expect(after.previewCanvas!.width).toBeGreaterThan(0);
    expect(after.previewCanvas!.width).toBeLessThan(previewBefore.width);

    const win = after.window!;
    const canvas = after.previewCanvas!;
    const overlapping =
      canvas.x < win.x + win.width &&
      win.x < canvas.x + canvas.width &&
      canvas.y < win.y + win.height &&
      win.y < canvas.y + canvas.height;
    expect(overlapping, "the window is drawn over the preview canvas").toBe(false);
  });

  await test.step("the transcript and the footer appear", async () => {
    await page.evaluate((lines) => {
      const panel = document.querySelector("automatic-caption") as any;
      panel.lines = lines;
      panel.mediaType = "video";
      panel.mediaDuration = 14;
      panel.openEditor();
    }, LINES);

    await expect(page.locator("app-window .caption-apply")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("app-window .caption")).toHaveCount(LINES.length);
  });

  await test.step("the silence button is icon only, named, and sits beside Apply", async () => {
    const button = await page.evaluate(() => {
      const el = document.querySelector("app-window .caption-silence") as HTMLElement | null;
      if (el == null) {
        return null;
      }
      const next = el.nextElementSibling as HTMLElement | null;
      return {
        text: (el.textContent ?? "").trim(),
        title: el.getAttribute("title") ?? "",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        nextIsApply: next?.classList.contains("caption-apply") ?? false,
        // Anything that is not the icon span would be a stray text node.
        childTags: [...el.children].map((child) => child.tagName.toLowerCase()),
      };
    });

    expect(button, "no silence button rendered").not.toBeNull();
    // One material-symbols ligature and nothing else. A label here would make
    // the button wider than the footer at the narrow end of the splitter.
    expect(button!.text).toBe("volume_off");
    expect(button!.childTags).toEqual(["span"]);
    // An icon-only button has no other name, so these are not optional.
    expect(button!.title.length).toBeGreaterThan(0);
    expect(button!.ariaLabel).toBe(button!.title);
    expect(button!.nextIsApply, "the silence button is not next to Apply").toBe(true);
  });

  /** The containment checks, run at whatever size the window is now. */
  const expectNothingClipped = async (label: string) => {
    const m = await measure();
    const host = m.host!;
    const win = m.window!;

    expectInside(host, win, `${label}: the window`);
    expectInside(host, m.region!, `${label}: the window host`);
    expect(m.hostScroll!.overflowX, `${label}: the host region scrolls sideways`).toBeLessThanOrEqual(1);
    expect(m.hostScroll!.overflowY, `${label}: the host region scrolls vertically`).toBeLessThanOrEqual(1);

    // Vertical scrolling inside the body is expected and wanted. Horizontal is
    // the caption row having outgrown the window.
    expect(m.bodyOverflowX!, `${label}: the caption list overflows sideways`).toBeLessThanOrEqual(1);

    // The footer is the half that goes missing first: a body that refuses to
    // shrink pushes it straight out of the bottom of the window.
    expectInside(win, m.apply!, `${label}: Apply`);
    expectInside(win, m.silence!, `${label}: the silence button`);
    expectInside(win, m.titlebar!, `${label}: the title bar`);

    for (const control of m.controls) {
      expectInsideHorizontally(win, control.rect, `${label}: ${control.tag}`);
    }

    // The first caption row is at the top of a list scrolled to the top, so
    // unlike the rest of them it has to be wholly on screen. Without this the
    // horizontal-only rule above would accept a list clipped away entirely.
    expectInside(win, m.firstCaption!, `${label}: the first caption row`);

    expect(m.controls.length, `${label}: nothing rendered inside the window`).toBeGreaterThan(5);
    return m;
  };

  const widthsSeen: number[] = [];

  for (const fraction of [0.92, 0.72, 0.56]) {
    await test.step(`nothing is clipped with the column at ${fraction} of the app`, async () => {
      await dragMainSplitter(Math.round((await page.evaluate(() => window.innerWidth)) * fraction));
      widthsSeen.push(await hostWidth());
      await expectNothingClipped(`column at ${fraction}`);
    });
  }

  await test.step("the three passes were actually three different widths", async () => {
    // Without this the loop above could have run three times at one size and
    // proved nothing about the window surviving a narrow column.
    const spread = Math.max(...widthsSeen) - Math.min(...widthsSeen);
    expect(spread, `host widths were ${widthsSeen.join(", ")}`).toBeGreaterThan(120);
  });

  await test.step("nothing is clipped after the app window itself is resized", async () => {
    const before = await hostWidth();
    await session.app.evaluate(({ BrowserWindow }) => {
      const editor = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      );
      const [width, height] = editor?.getContentSize() ?? [1400, 800];
      editor?.setContentSize(Math.round(width * 0.8), height);
    });

    // Tolerant: the point is that the layout survives a resize, not that the
    // window reached any particular number, which DevTools makes unknowable.
    await expect.poll(() => hostWidth(), { timeout: 15_000 }).not.toBe(before);
    await settle();
    await expectNothingClipped("after the app was resized");
  });

  await test.step("the splitter resizes the window and the preview refits", async () => {
    await dragMainSplitter(Math.round((await page.evaluate(() => window.innerWidth)) * 0.86));
    const before = await measure();
    const splitter = before.splitter!;

    await page.mouse.move(
      splitter.x + splitter.width / 2,
      splitter.y + splitter.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(splitter.x + splitter.width / 2 - 90, splitter.y + splitter.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    const after = await expectNothingClipped("after a splitter drag");
    expect(after.window!.width).toBeGreaterThan(before.window!.width + 60);
    expect(after.previewCanvas!.width).toBeLessThan(before.previewCanvas!.width - 60);
  });

  await test.step("dragging the splitter off the edge clamps rather than clipping", async () => {
    const splitter = (await measure()).splitter!;
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
    await page.mouse.down();
    await page.mouse.move(-4000, splitter.y + splitter.height / 2, { steps: 10 });
    await page.mouse.up();

    const wide = await expectNothingClipped("clamped wide");

    await page.mouse.move(
      wide.splitter!.x + wide.splitter!.width / 2,
      wide.splitter!.y + wide.splitter!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(4000, wide.splitter!.y + wide.splitter!.height / 2, { steps: 10 });
    await page.mouse.up();

    await expectNothingClipped("clamped narrow");
  });

  await test.step("a wide window lays the editor out in two columns, a narrow one stacks", async () => {
    // Only reachable in the app: `editorLayout.test.ts` pins the breakpoint as
    // arithmetic, and says nothing about whether the class reaches the CSS.
    const innerWidth = await page.evaluate(() => window.innerWidth);

    // Give the column as much of the app as its own limits allow.
    await dragPanelSplitter(Math.round(innerWidth * 0.05));
    await dragMainSplitter(innerWidth - 4);
    await dragWindowSplitter(-4000);

    const wide = await expectNothingClipped("two columns");
    expect(wide.window!.width).toBeGreaterThan(540);
    expect(await editorColumns()).toBe("two");
    // Side by side means the canvas and the list share a row.
    const sideBySide = await page.evaluate(() => {
      const canvas = document
        .querySelector("app-window .caption-editor-canvas")!
        .getBoundingClientRect();
      const lines = document
        .querySelector("app-window .caption-editor-lines")!
        .getBoundingClientRect();
      return lines.x >= canvas.x + canvas.width - 2;
    });
    expect(sideBySide, "the two columns overlap instead of sitting beside each other").toBe(true);

    await dragWindowSplitter(4000);
    const narrow = await expectNothingClipped("stacked");
    expect(narrow.window!.width).toBeLessThan(540);
    expect(await editorColumns()).toBe("one");
  });

  await test.step("all four of the window's borders are on screen", async () => {
    await dragMainSplitter(Math.round((await page.evaluate(() => window.innerWidth)) * 0.86));
    const m = await measure();
    const host = m.host!;
    const win = m.window!;
    const colour = parseRgb(m.borderColour!);
    expect(colour.some((channel) => channel > 0), "no border colour to look for").toBe(true);

    // The whole viewport, not a clip of the host. `scale: "css"` is what makes
    // the image's pixels the page's own CSS pixels, so a `getBoundingClientRect`
    // reading indexes it directly; the default "device" would return a 2x image
    // on this display and put every index out by a factor of two. Not clipping
    // removes the other rounding: a clip's width is rounded to whole pixels, so
    // a region 500.515625 tall becomes a 500-row image whose last row is half a
    // pixel short of where the window's bottom border actually is.
    const shot = await page.screenshot({ scale: "css" });
    const frame = decodePng(shot);

    // The page does not scroll, so viewport coordinates are the image's.
    const rect = { x: win.x, y: win.y, width: win.width, height: win.height };

    writePng(path.join(artifactDir, "caption-window.png"), frame);
    writePng(
      path.join(artifactDir, "caption-window-cropped.png"),
      crop(frame, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }),
    );

    const drawn = inkBounds(frame, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
    expect(drawn.count, "the window region is blank").toBeGreaterThan(0);

    const coverage = borderCoverage(frame, rect, colour);
    writeJson(path.join(artifactDir, "border-coverage.json"), {
      colour,
      host: { x: host.x, y: host.y, width: host.width, height: host.height },
      frame: { width: frame.width, height: frame.height },
      windowRectInShot: rect,
      coverage,
      ink: drawn,
    });

    // If this is out, every index below is out with it.
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(frame.width).toBe(viewport.width);
    expect(frame.height).toBe(viewport.height);
    for (const [side, fraction] of Object.entries(coverage)) {
      expect(
        fraction,
        `the window's ${side} border is only ${(fraction * 100).toFixed(0)}% on screen, so it is clipped there`,
      ).toBeGreaterThan(0.8);
    }

    // The check has to be able to fail, or it is measuring nothing. 12px inside
    // the window there is no border, only the body, so at least one edge of
    // that rect must come back well under the threshold.
    const inset = {
      x: rect.x + 12,
      y: rect.y + 12,
      width: rect.width - 24,
      height: rect.height - 24,
    };
    const control = borderCoverage(frame, inset, colour);
    expect(
      Math.min(...Object.values(control)),
      `the border check passes on a rect with no border on it: ${JSON.stringify(control)}`,
    ).toBeLessThan(0.5);
  });

  await test.step("the title bar close gives the column back to the preview", async () => {
    const before = await measure();

    await page.locator("app-window .app-window-close").click();
    await expect(page.locator("app-window")).toHaveCount(0, { timeout: 15_000 });

    expect((await openState()).open).toBe(false);

    const after = await measure();
    expect(after.previewCanvas!.width).toBeGreaterThan(before.previewCanvas!.width + 60);
    // The content region is the whole host again.
    expectInside(after.host!, after.content!, "the content region");
    expect(after.content!.width).toBeGreaterThan(after.host!.width - 2);

    // Closing the window unmounts the panel, so the release of the editor's
    // keyboard lock cannot come from the panel itself.
    const cursorType = await page.evaluate(
      () => (globalThis as any).CARTCUT.useTimelineStore.getState().control.cursorType,
    );
    expect(cursorType).toBe("pointer");
  });
});
