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
 * The longest unbroken run of pixels matching `colour` along one row.
 *
 * This is the instrument the whole pixel check is built on, and it measures
 * **how much of a horizontal rule actually got painted**. A window clipped on
 * the right has its rules cut short; one clipped on the left has them start
 * late; one clipped off the top or bottom loses a rule entirely. All four cases
 * come out as a run whose ends are not the window's ends.
 *
 * What counts as a hit is a predicate rather than a colour, and the call site
 * passes "this pixel is not the window's own background". Matching the rule's
 * authored colour was the first draft and it does not survive contact with the
 * real thing: the app's dividers are `0.05rem`, which is 0.8px, and a 0.8px
 * line downsampled from a 2x display is a blend whose value depends on where
 * the boundary fell. Measured, the title bar's rule matched 2px of 320 that
 * way. "Not the background" is the claim that actually matters anyway, and it
 * is one the renderer cannot round away.
 *
 * The scan is bounded to the window's own columns, and that is not tidiness
 * either: `preview-top-bar` carries its own `0.05rem` rule at exactly the
 * height the title bar's sits at, so an unbounded row reads as one unbroken
 * line across the whole column. Measured, 786px of a 320px window.
 */
function longestRun(
  frame: FrameBuffer,
  y: number,
  matches: (channels: [number, number, number]) => boolean,
  bounds: { from: number; to: number },
): { start: number; end: number; length: number } {
  let best = { start: -1, end: -1, length: 0 };
  let runStart = -1;
  const from = Math.max(0, Math.round(bounds.from));
  const to = Math.min(frame.width - 1, Math.round(bounds.to));

  for (let x = from; x <= to + 1; x++) {
    let hit = false;
    if (x <= to && y >= 0 && y < frame.height) {
      const p = pixel(frame, x, y);
      hit = matches([p.r, p.g, p.b]);
    }

    if (hit) {
      if (runStart < 0) {
        runStart = x;
      }
      continue;
    }

    if (runStart >= 0) {
      const length = x - runStart;
      if (length > best.length) {
        best = { start: runStart, end: x - 1, length };
      }
      runStart = -1;
    }
  }

  return best;
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
      const titlebarEl = document.querySelector(
        "app-window .app-window-titlebar",
      ) as HTMLElement | null;
      const footerEl = document.querySelector(
        "app-window .caption-panel-footer",
      ) as HTMLElement | null;

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
        footer: box("app-window .caption-panel-footer"),
        windowBackground: win == null ? null : getComputedStyle(win).backgroundColor,
        // The two horizontal rules the window is actually built from. There is
        // no border around `app-window` itself, by design: a docked window
        // meets its splitter on one side and the region's edges on the other
        // three, so an outline would draw a box around the whole column.
        rules:
          titlebarEl == null || footerEl == null
            ? null
            : {
                titlebar: {
                  colour: getComputedStyle(titlebarEl).borderBottomColor,
                  width: getComputedStyle(titlebarEl).borderBottomWidth,
                },
                footer: {
                  colour: getComputedStyle(footerEl).borderTopColor,
                  width: getComputedStyle(footerEl).borderTopWidth,
                },
              },
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
    writeJson(path.join(artifactDir, "two-column-step.json"), {
      innerWidth,
      host: wide.host,
      region: wide.region,
      window: wide.window,
      splitter: wide.splitter,
      placement: (await openState()).placement,
      hostSizes: (await openState()).hostSizes,
      columns: await editorColumns(),
    });
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

  await test.step("the splitter draws one pixel, not a bar", async () => {
    const line = await page.evaluate(() => {
      const el = document.querySelector(".window-splitter") as HTMLElement;
      const drawn = getComputedStyle(el, "::after");
      const titlebar = document.querySelector(
        "app-window .app-window-titlebar",
      ) as HTMLElement;
      return {
        stripWidth: el.getBoundingClientRect().width,
        stripBackground: getComputedStyle(el).backgroundColor,
        lineWidth: drawn.width,
        lineColour: drawn.backgroundColor,
        ruleColour: getComputedStyle(titlebar).borderBottomColor,
        ruleWidth: getComputedStyle(titlebar).borderBottomWidth,
      };
    });

    // The strip is a hit area and has to stay invisible. Filling it on hover
    // put a six pixel bar on screen where a border belongs, next to the
    // window's own 1px rules, and it read as the layout having broken.
    expect(line.stripBackground).toBe("rgba(0, 0, 0, 0)");
    // A hairline, the same weight and colour as every other divider in the app.
    // Asserted as a property rather than as a number: all of them are authored
    // `0.05rem`, but Chromium resolves that to 0.5px for a border and
    // 0.796875px for a box width, so comparing the two computed strings would
    // be testing the engine's rounding rather than the design.
    expect(parseFloat(line.lineWidth)).toBeGreaterThan(0);
    expect(parseFloat(line.lineWidth)).toBeLessThan(1);
    expect(parseFloat(line.ruleWidth)).toBeLessThan(1);
    // The area the pointer has to hit is several times the line, or the
    // splitter cannot be grabbed. A relation rather than a number, so changing
    // SPLITTER_PX does not make this go stale.
    expect(line.stripWidth).toBeGreaterThan(parseFloat(line.lineWidth) * 2);
    expect(line.lineColour).toBe(line.ruleColour);
  });

  await test.step("the window's rules are painted across its whole width", async () => {
    await dragMainSplitter(Math.round((await page.evaluate(() => window.innerWidth)) * 0.86));
    const m = await measure();
    const win = m.window!;
    const rules = m.rules!;

    // There is no border around `app-window`, so the two horizontal rules are
    // what is drawn at the window's own extents: the title bar's bottom edge
    // and the footer's top edge, each spanning the full width. Asserting the
    // *width they reach* is what catches a clip, and it catches all four sides
    // at once. Cut off on the right and a rule stops early; on the left and it
    // starts late; off the top or the bottom and the rule is not there at all.
    // Greater than zero, not at least one. The app's dividers are authored as
    // `0.05rem`, which computes to 0.8px, and the point of this assertion is
    // only that there is a rule at all: `borderBottomColor` resolves to
    // Bootstrap's default on an element with no border, and that grey is within
    // any useful tolerance of the window's own body.
    expect(parseFloat(rules.titlebar.width), "the title bar has no rule to find").toBeGreaterThan(0);
    expect(parseFloat(rules.footer.width), "the footer has no rule to find").toBeGreaterThan(0);

    const shot = await page.screenshot({ scale: "css" });
    const frame = decodePng(shot);

    // If this is out, every index below is out with it. The page does not
    // scroll, so viewport coordinates are the image's.
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(frame.width).toBe(viewport.width);
    expect(frame.height).toBe(viewport.height);

    const region = {
      x: Math.round(win.x),
      y: Math.round(win.y),
      w: Math.round(win.width),
      h: Math.round(win.height),
    };
    writePng(path.join(artifactDir, "caption-window.png"), frame);
    writePng(path.join(artifactDir, "caption-window-cropped.png"), crop(frame, region));

    const drawn = inkBounds(frame, region);
    expect(drawn.count, "the window region is blank").toBeGreaterThan(0);

    // Anything that is not the window's own background. Six steps is well clear
    // of PNG-exact flat fill and well under the 21 the fainter of the two rules
    // sits at.
    const within = { from: win.x, to: win.x + win.width - 1 };
    const background = parseRgb(m.windowBackground!);
    const notBackground = (channels: [number, number, number]) =>
      Math.max(...channels.map((c, i) => Math.abs(c - background[i]))) >= 6;

    const measured = [
      {
        name: "the title bar's rule",
        y: Math.round(m.titlebar!.y + m.titlebar!.height) - 1,
      },
      {
        name: "the footer's rule",
        y: Math.round(m.footer!.y),
      },
    ].map((rule) => {
      // A 0.8px rule straddles two device rows and, downsampled to CSS pixels,
      // can end up on either side of the boundary. Take whichever row carries
      // more of it rather than guessing which way the rounding went.
      const here = longestRun(frame, rule.y, notBackground, within);
      const below = longestRun(frame, rule.y + 1, notBackground, within);
      return { ...rule, run: here.length >= below.length ? here : below };
    });

    // A row inside the body's own padding, where there is no rule at all. The
    // check has to be able to come back short, or it is measuring nothing.
    const control = longestRun(
      frame,
      Math.round(m.titlebar!.y + m.titlebar!.height) + 4,
      notBackground,
      within,
    );

    writeJson(path.join(artifactDir, "window-rules.json"), {
      window: win,
      frame: { width: frame.width, height: frame.height },
      background,
      rules: measured,
      control,
      ink: drawn,
    });

    for (const rule of measured) {
      expect(
        rule.run.length,
        `${rule.name} is only ${rule.run.length}px of the window's ${Math.round(win.width)}px, so the window is cut off`,
      ).toBeGreaterThan(win.width * 0.9);
      expect(
        Math.abs(rule.run.start - win.x),
        `${rule.name} starts at ${rule.run.start}, ${Math.abs(rule.run.start - win.x)}px from the window's left edge`,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(rule.run.end - (win.x + win.width - 1)),
        `${rule.name} ends at ${rule.run.end}, ${Math.abs(rule.run.end - (win.x + win.width - 1))}px from the window's right edge`,
      ).toBeLessThanOrEqual(2);
    }

    expect(
      control.length,
      `a row with no rule on it matched ${control.length}px, so the scan is not reading the rules`,
    ).toBeLessThan(win.width * 0.5);
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
