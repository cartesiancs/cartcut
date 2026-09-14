import { describe, expect, it } from "vitest";

import {
  CONTENT_MIN,
  SPLITTER_PX,
  clampRect,
  contains,
  layoutHost,
  overlaps,
  pctForSize,
  type DockSide,
  type Rect,
  type Size,
  type WindowState,
} from "./windowLayout";

const HOST: Size = { width: 680, height: 400 };

function docked(
  id: string,
  side: DockSide,
  sizePct: number,
  overrides: Partial<WindowState> = {},
): WindowState {
  return {
    id,
    hostId: "preview",
    placement: { mode: "docked", side, sizePct },
    minSize: { width: 240, height: 160 },
    resizable: true,
    closable: true,
    z: 0,
    ...overrides,
  };
}

function floating(id: string, rect: Rect, overrides: Partial<WindowState> = {}): WindowState {
  return {
    id,
    hostId: "preview",
    placement: { mode: "floating", rect },
    minSize: { width: 240, height: 160 },
    resizable: true,
    closable: true,
    z: 0,
    ...overrides,
  };
}

/**
 * The host's own bounds.
 *
 * Clamped at zero, because a negative size is not a smaller box, it is not a
 * box: `layoutHost` normalises the host on the way in, so comparing against a
 * negative rect would be comparing the module's answer to a shape nothing can
 * be inside.
 */
const hostRect = (host: Size): Rect => ({
  x: 0,
  y: 0,
  width: Math.max(0, host.width),
  height: Math.max(0, host.height),
});

const areaOf = (rect: Rect) => rect.width * rect.height;

/**
 * The claim the whole feature rests on, as one function.
 *
 * Asserted from a sweep rather than from chosen cases: the ways a rect leaves
 * its host are arithmetic accidents, not scenarios anyone sits down and writes.
 */
function expectInsideHost(host: Size, windows: WindowState[]) {
  const layout = layoutHost(host, windows);
  const bounds = hostRect(host);

  expect(contains(bounds, layout.content, 0)).toBe(true);
  for (const entry of layout.windows) {
    expect(
      contains(bounds, entry.rect, 0),
      `${entry.id} ${JSON.stringify(entry.rect)} left ${JSON.stringify(bounds)}`,
    ).toBe(true);
    expect(entry.rect.width).toBeGreaterThanOrEqual(0);
    expect(entry.rect.height).toBeGreaterThanOrEqual(0);
    if (entry.splitter != null) {
      expect(contains(bounds, entry.splitter, 0)).toBe(true);
    }
  }
  return layout;
}

describe("layoutHost", () => {
  it("puts a right-docked window beside the content, not over it", () => {
    const layout = expectInsideHost(HOST, [docked("captions", "right", 47)]);
    const window = layout.windows[0];

    expect(window.rect.x).toBeGreaterThan(layout.content.x);
    expect(window.rect.y).toBe(0);
    expect(window.rect.height).toBe(HOST.height);
    expect(overlaps(layout.content, window.rect)).toBe(false);
  });

  it.each<DockSide>(["left", "right", "top", "bottom"])(
    "tiles the host exactly when docked %s",
    (side) => {
      const layout = expectInsideHost(HOST, [docked("w", side, 40)]);
      const window = layout.windows[0];

      expect(window.splitter).not.toBeNull();
      expect(overlaps(layout.content, window.rect)).toBe(false);
      expect(overlaps(layout.content, window.splitter!)).toBe(false);
      expect(overlaps(window.rect, window.splitter!)).toBe(false);

      // Exact tiling: no gap, no overlap, nothing unaccounted for.
      expect(
        areaOf(layout.content) + areaOf(window.rect) + areaOf(window.splitter!),
      ).toBe(HOST.width * HOST.height);
    },
  );

  it("stacks two windows on the same side and still tiles exactly", () => {
    const layout = expectInsideHost(HOST, [
      docked("first", "right", 30, { z: 0, minSize: { width: 120, height: 80 } }),
      docked("second", "right", 25, { z: 1, minSize: { width: 120, height: 80 } }),
    ]);

    const [first, second] = layout.windows;
    expect(overlaps(first.rect, second.rect)).toBe(false);
    // Opened first sits outermost, so the second is to its left.
    expect(second.rect.x).toBeLessThan(first.rect.x);

    const total =
      areaOf(layout.content) +
      layout.windows.reduce(
        (sum, entry) => sum + areaOf(entry.rect) + areaOf(entry.splitter ?? { x: 0, y: 0, width: 0, height: 0 }),
        0,
      );
    expect(total).toBe(HOST.width * HOST.height);
  });

  it("nests a top-docked window inside what a right-docked one left", () => {
    const layout = expectInsideHost(HOST, [
      docked("side", "right", 40, { z: 0 }),
      docked("strip", "top", 20, { z: 1, minSize: { width: 80, height: 40 } }),
    ]);

    const [side, strip] = layout.windows;
    expect(overlaps(side.rect, strip.rect)).toBe(false);
    // The strip only spans what was left after the side window took its share.
    expect(strip.rect.width).toBe(HOST.width - side.rect.width - SPLITTER_PX);
  });

  it("keeps a floor under the content, and the window is what yields", () => {
    const layout = expectInsideHost(HOST, [
      docked("greedy", "right", 99, { minSize: { width: 10, height: 10 } }),
    ]);

    expect(layout.content.width).toBe(CONTENT_MIN.width);
    expect(layout.windows[0].rect.width).toBe(
      HOST.width - CONTENT_MIN.width - SPLITTER_PX,
    );
  });

  it("lets the window's own minimum outrank the content's floor", () => {
    // 600 wide: a 560px minimum cannot coexist with a 120px content floor.
    const host = { width: 600, height: 300 };
    const layout = expectInsideHost(host, [
      docked("wide", "right", 10, { minSize: { width: 560, height: 100 } }),
    ]);

    expect(layout.windows[0].rect.width).toBe(560);
    expect(layout.content.width).toBeLessThan(CONTENT_MIN.width);
  });

  it("lets the host outrank the window's minimum, which is the case that would clip", () => {
    // The whole region is narrower than the window says it needs. Honouring the
    // minimum here is exactly how a window ends up past the edge of a parent
    // carrying `overflow: hidden`, where nothing can scroll to it.
    const host = { width: 200, height: 120 };
    const layout = expectInsideHost(host, [
      docked("wide", "right", 90, { minSize: { width: 560, height: 400 } }),
    ]);

    expect(layout.windows[0].rect.width).toBeLessThanOrEqual(host.width);
    expect(layout.windows[0].rect.height).toBeLessThanOrEqual(host.height);
  });

  it("survives a host with no area at all", () => {
    for (const host of [
      { width: 0, height: 0 },
      { width: 0, height: 400 },
      { width: 680, height: 0 },
      { width: -40, height: -10 },
    ]) {
      const layout = expectInsideHost(host, [docked("w", "right", 50)]);
      expect(layout.content.width).toBeGreaterThanOrEqual(0);
      expect(layout.content.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("drops the splitter rather than letting it outgrow the space it divides", () => {
    // Sized from the constant, not from a literal: the first draft hardcoded a
    // host of 4 against a 6px splitter, and silently stopped testing anything
    // the day the strip got narrower than that.
    const layout = expectInsideHost({ width: SPLITTER_PX, height: 200 }, [
      docked("w", "right", 50, { minSize: { width: 1, height: 1 } }),
    ]);
    expect(layout.windows[0].splitter).toBeNull();
  });

  it("gives an unresizable window no splitter", () => {
    const layout = layoutHost(HOST, [docked("fixed", "right", 40, { resizable: false })]);
    expect(layout.windows[0].splitter).toBeNull();
    expect(areaOf(layout.content) + areaOf(layout.windows[0].rect)).toBe(
      HOST.width * HOST.height,
    );
  });

  it("holds a docked window's share as the host grows", () => {
    const win = docked("w", "right", 40, { minSize: { width: 40, height: 40 } });
    const narrow = layoutHost({ width: 600, height: 300 }, [win]).windows[0].rect;
    const wide = layoutHost({ width: 1200, height: 300 }, [win]).windows[0].rect;

    expect(narrow.width).toBe(240);
    expect(wide.width).toBe(480);
  });

  it("returns windows in the order they were given, not in dock order", () => {
    const layout = layoutHost(HOST, [
      docked("b", "right", 20, { z: 5, minSize: { width: 60, height: 60 } }),
      docked("a", "left", 20, { z: 1, minSize: { width: 60, height: 60 } }),
    ]);
    expect(layout.windows.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("takes no space for a floating window", () => {
    const layout = layoutHost(HOST, [floating("f", { x: 20, y: 20, width: 300, height: 200 })]);
    expect(layout.content).toEqual({ x: 0, y: 0, ...HOST });
  });

  it("keeps every rect inside the host across a sweep of hosts and placements", () => {
    const sides: DockSide[] = ["left", "right", "top", "bottom"];
    let checked = 0;

    for (let width = 0; width <= 1400; width += 97) {
      for (let height = 0; height <= 900; height += 83) {
        for (const side of sides) {
          for (const pct of [-20, 0, 5, 33, 50, 88, 100, 140]) {
            expectInsideHost({ width, height }, [
              docked("w", side, pct, { minSize: { width: 240, height: 160 } }),
            ]);
            checked += 1;
          }
        }
      }
    }

    // The sweep is worth nothing if it swept nothing.
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("clampRect", () => {
  it("pulls a floating window back in from every side", () => {
    const min = { width: 100, height: 80 };
    const cases: Array<[Rect, string]> = [
      [{ x: -500, y: 10, width: 200, height: 120 }, "left"],
      [{ x: 900, y: 10, width: 200, height: 120 }, "right"],
      [{ x: 10, y: -500, width: 200, height: 120 }, "top"],
      [{ x: 10, y: 900, width: 200, height: 120 }, "bottom"],
    ];

    for (const [rect, label] of cases) {
      const clamped = clampRect(rect, HOST, min);
      expect(contains(hostRect(HOST), clamped, 0), label).toBe(true);
      // Dragged out and pulled back, not shrunk on the way.
      expect(clamped.width).toBe(200);
      expect(clamped.height).toBe(120);
    }
  });

  it("caps a floating window at the host rather than at its own minimum", () => {
    const clamped = clampRect(
      { x: 0, y: 0, width: 5000, height: 5000 },
      { width: 300, height: 200 },
      { width: 400, height: 400 },
    );
    expect(clamped).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it("grows a window that was written below its minimum", () => {
    const clamped = clampRect({ x: 0, y: 0, width: 10, height: 10 }, HOST, {
      width: 240,
      height: 160,
    });
    expect(clamped.width).toBe(240);
    expect(clamped.height).toBe(160);
  });
});

describe("pctForSize", () => {
  it("round-trips through layoutHost", () => {
    const target = 320;
    const pct = pctForSize(HOST, "right", target);
    const layout = layoutHost(HOST, [
      docked("w", "right", pct, { minSize: { width: 40, height: 40 } }),
    ]);
    expect(layout.windows[0].rect.width).toBe(target);
  });

  it("never answers outside 0..100", () => {
    expect(pctForSize(HOST, "right", -900)).toBe(0);
    expect(pctForSize(HOST, "right", 9000)).toBe(100);
    expect(pctForSize({ width: 0, height: 0 }, "right", 50)).toBe(100);
  });
});
