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
  for (const entry of layout.frames) {
    expect(
      contains(bounds, entry.rect, 0),
      `${entry.key} ${JSON.stringify(entry.rect)} left ${JSON.stringify(bounds)}`,
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
    const window = layout.frames[0];

    expect(window.rect.x).toBeGreaterThan(layout.content.x);
    expect(window.rect.y).toBe(0);
    expect(window.rect.height).toBe(HOST.height);
    expect(overlaps(layout.content, window.rect)).toBe(false);
  });

  it.each<DockSide>(["left", "right", "top", "bottom"])(
    "tiles the host exactly when docked %s",
    (side) => {
      const layout = expectInsideHost(HOST, [docked("w", side, 40)]);
      const window = layout.frames[0];

      expect(window.splitter).not.toBeNull();
      expect(overlaps(layout.content, window.rect)).toBe(false);

      // The content and the window account for the whole host between them.
      // The grab strip is an overlay and takes none of it: a strip that carved
      // a gap left `SPLITTER_PX` of whatever is behind the host showing through
      // the seam, which reads as a coloured band rather than as two panes
      // meeting.
      expect(areaOf(layout.content) + areaOf(window.rect)).toBe(
        HOST.width * HOST.height,
      );
      expect(overlaps(layout.content, window.splitter!)).toBe(true);
      expect(overlaps(window.rect, window.splitter!)).toBe(false);
    },
  );

  it("puts two windows docked to the same side into one frame, as tabs", () => {
    const layout = expectInsideHost(HOST, [
      docked("captions", "right", 50, { z: 1, minSize: { width: 320, height: 240 } }),
      docked("speech", "right", 50, { z: 2, minSize: { width: 300, height: 280 } }),
    ]);

    expect(layout.frames).toHaveLength(1);
    const [frame] = layout.frames;
    expect(frame.key).toBe("dock:right");
    // Tabs in open order, and the one on show is the last focused.
    expect(frame.tabs).toEqual(["captions", "speech"]);
    expect(frame.active).toBe("speech");
    // Laid out against the largest minimum of either tab.
    expect(frame.minSize).toEqual({ width: 320, height: 280 });

    // One column beside the content, not two.
    expect(frame.rect.width).toBe(Math.round(0.5 * HOST.width));
    expect(areaOf(layout.content) + areaOf(frame.rect)).toBe(HOST.width * HOST.height);
  });

  it("keeps a frame's size when the tab on show changes", () => {
    // Both carry the same share, which `windowOps` guarantees. What changes
    // with focus is the tab and the minimum it brings, and the minimum is
    // already the larger of the two either way.
    const captions = docked("captions", "right", 20, {
      z: 1,
      minSize: { width: 320, height: 80 },
    });
    const speech = docked("speech", "right", 20, { z: 2, minSize: { width: 60, height: 80 } });

    const speechOnShow = layoutHost(HOST, [captions, speech]).frames[0];
    const captionsOnShow = layoutHost(HOST, [{ ...captions, z: 3 }, speech]).frames[0];

    expect(speechOnShow.active).toBe("speech");
    expect(captionsOnShow.active).toBe("captions");
    expect(captionsOnShow.tabs).toEqual(speechOnShow.tabs);
    expect(captionsOnShow.rect).toEqual(speechOnShow.rect);
    // 20% of 680 is 136, so the caption tab's 320 is what holds both.
    expect(speechOnShow.rect.width).toBe(320);
  });

  it("names a docked frame after its side, so it survives its first tab closing", () => {
    const both = layoutHost(HOST, [
      docked("captions", "right", 40, { z: 1 }),
      docked("speech", "right", 40, { z: 2 }),
    ]);
    const second = layoutHost(HOST, [docked("speech", "right", 40, { z: 2 })]);

    expect(both.frames[0].key).toBe(second.frames[0].key);
    expect(second.frames[0].tabs).toEqual(["speech"]);
  });

  it("gives a frame no splitter when any of its tabs cannot be resized", () => {
    const layout = layoutHost(HOST, [
      docked("free", "right", 40, { z: 1 }),
      docked("fixed", "right", 40, { z: 2, resizable: false }),
    ]);
    expect(layout.frames[0].splitter).toBeNull();
  });

  it("nests a top-docked frame inside what a right-docked one left", () => {
    const layout = expectInsideHost(HOST, [
      docked("side", "right", 40, { z: 0 }),
      docked("strip", "top", 20, { z: 1, minSize: { width: 80, height: 40 } }),
    ]);

    const [side, strip] = layout.frames;
    expect(overlaps(side.rect, strip.rect)).toBe(false);
    // The strip only spans what was left after the side frame took its share.
    expect(strip.rect.width).toBe(HOST.width - side.rect.width);
  });

  it("carves frames in open order, so focusing one never swaps two docks", () => {
    // `side` was opened first but is now focused, so its z is the higher. It
    // still sits outermost: carving by z made a click into one dock move it.
    const layout = expectInsideHost(HOST, [
      docked("side", "right", 40, { z: 9 }),
      docked("strip", "top", 20, { z: 1, minSize: { width: 80, height: 40 } }),
    ]);

    const [side, strip] = layout.frames;
    expect(side.rect.height).toBe(HOST.height);
    expect(strip.rect.width).toBe(HOST.width - side.rect.width);
  });

  it("keeps a floor under the content, and the window is what yields", () => {
    const layout = expectInsideHost(HOST, [
      docked("greedy", "right", 99, { minSize: { width: 10, height: 10 } }),
    ]);

    expect(layout.content.width).toBe(CONTENT_MIN.width);
    expect(layout.frames[0].rect.width).toBe(HOST.width - CONTENT_MIN.width);
  });

  it("lets the window's own minimum outrank the content's floor", () => {
    // 600 wide: a 560px minimum cannot coexist with a 120px content floor.
    const host = { width: 600, height: 300 };
    const layout = expectInsideHost(host, [
      docked("wide", "right", 10, { minSize: { width: 560, height: 100 } }),
    ]);

    expect(layout.frames[0].rect.width).toBe(560);
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

    expect(layout.frames[0].rect.width).toBeLessThanOrEqual(host.width);
    expect(layout.frames[0].rect.height).toBeLessThanOrEqual(host.height);
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

  it("hands the grab strip no layout space of its own", () => {
    const bare = layoutHost(HOST, [docked("w", "right", 40, { resizable: false })]);
    const withStrip = layoutHost(HOST, [docked("w", "right", 40)]);

    // Turning the splitter on must not move anything. It overlays the content
    // rather than pushing it, the way `.split-col-bar` does one level up.
    expect(withStrip.content).toEqual(bare.content);
    expect(withStrip.frames[0].rect).toEqual(bare.frames[0].rect);

    const strip = withStrip.frames[0].splitter!;
    expect(strip.width).toBe(SPLITTER_PX);
    // Immediately outside the window, on the content's side of the seam.
    expect(strip.x + strip.width).toBe(withStrip.frames[0].rect.x);
  });

  it("clips the grab strip into the host when the window has taken it all", () => {
    // Nothing on the content side to overlap, so the strip would otherwise
    // start at a negative coordinate and break the one contract this module has.
    const layout = expectInsideHost({ width: 2, height: 200 }, [
      docked("w", "right", 100, { minSize: { width: 1, height: 1 } }),
    ]);
    const strip = layout.frames[0].splitter!;
    expect(strip.x).toBeGreaterThanOrEqual(0);
    expect(strip.x + strip.width).toBeLessThanOrEqual(2);
  });

  it("gives an unresizable window no splitter", () => {
    const layout = layoutHost(HOST, [docked("fixed", "right", 40, { resizable: false })]);
    expect(layout.frames[0].splitter).toBeNull();
    expect(areaOf(layout.content) + areaOf(layout.frames[0].rect)).toBe(
      HOST.width * HOST.height,
    );
  });

  it("holds a docked window's share as the host grows", () => {
    const win = docked("w", "right", 40, { minSize: { width: 40, height: 40 } });
    const narrow = layoutHost({ width: 600, height: 300 }, [win]).frames[0].rect;
    const wide = layoutHost({ width: 1200, height: 300 }, [win]).frames[0].rect;

    expect(narrow.width).toBe(240);
    expect(wide.width).toBe(480);
  });

  it("returns frames in the order their first tab was opened", () => {
    const layout = layoutHost(HOST, [
      floating("f", { x: 20, y: 20, width: 300, height: 200 }, { z: 7 }),
      docked("b", "right", 20, { z: 5, minSize: { width: 60, height: 60 } }),
      docked("a", "left", 20, { z: 1, minSize: { width: 60, height: 60 } }),
      docked("c", "right", 20, { z: 2, minSize: { width: 60, height: 60 } }),
    ]);
    expect(layout.frames.map((frame) => frame.key)).toEqual([
      "float:f",
      "dock:right",
      "dock:left",
    ]);
    expect(layout.frames[1].tabs).toEqual(["b", "c"]);
  });

  it("takes no space for a floating window, and makes it a frame of its own", () => {
    const layout = layoutHost(HOST, [
      floating("f", { x: 20, y: 20, width: 300, height: 200 }),
      floating("g", { x: 40, y: 40, width: 300, height: 200 }),
    ]);
    expect(layout.content).toEqual({ x: 0, y: 0, ...HOST });
    expect(layout.frames.map((frame) => frame.tabs)).toEqual([["f"], ["g"]]);
    expect(layout.frames.every((frame) => frame.splitter == null)).toBe(true);
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

  it("keeps every rect inside the host with a shared frame and a second dock", () => {
    const sides: DockSide[] = ["left", "right", "top", "bottom"];
    let checked = 0;

    for (let width = 0; width <= 1400; width += 139) {
      for (let height = 0; height <= 900; height += 127) {
        for (const side of sides) {
          const other = sides[(sides.indexOf(side) + 1) % sides.length];
          for (const pct of [0, 33, 88, 140]) {
            const layout = expectInsideHost({ width, height }, [
              docked("a", side, pct, { z: 1, minSize: { width: 320, height: 240 } }),
              docked("b", side, pct, { z: 3, minSize: { width: 280, height: 280 } }),
              docked("c", other, pct, { z: 2 }),
            ]);
            expect(layout.frames).toHaveLength(2);
            checked += 1;
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(1000);
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
    expect(layout.frames[0].rect.width).toBe(target);
  });

  it("never answers outside 0..100", () => {
    expect(pctForSize(HOST, "right", -900)).toBe(0);
    expect(pctForSize(HOST, "right", 9000)).toBe(100);
    expect(pctForSize({ width: 0, height: 0 }, "right", 50)).toBe(100);
  });
});
