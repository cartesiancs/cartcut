import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCK_PCT,
  closeWindow,
  dockWindow,
  findWindow,
  floatWindow,
  focusWindow,
  isOpen,
  openWindow,
  setPlacement,
  windowsOfHost,
  type WindowSpec,
} from "./windowOps";
import type { WindowState } from "./windowLayout";

const spec = (id: string, hostId = "preview"): WindowSpec => ({
  id,
  hostId,
  placement: { mode: "docked", side: "right", sizePct: 46 },
});

const open = (...ids: string[]): WindowState[] =>
  ids.reduce<WindowState[]>((windows, id) => openWindow(windows, spec(id)), []);

describe("openWindow", () => {
  it("adds a window with the caller's placement and the defaults", () => {
    const windows = openWindow([], spec("captions"));
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: "captions",
      hostId: "preview",
      resizable: true,
      closable: true,
      z: 1,
    });
    expect(windows[0].minSize.width).toBeGreaterThan(0);
  });

  it("honours every override the spec carries", () => {
    const windows = openWindow([], {
      ...spec("fixed"),
      minSize: { width: 111, height: 222 },
      resizable: false,
      closable: false,
    });
    expect(windows[0]).toMatchObject({
      minSize: { width: 111, height: 222 },
      resizable: false,
      closable: false,
    });
  });

  it("focuses an open window instead of opening a second under the same id", () => {
    const windows = open("a", "b");
    const again = openWindow(windows, spec("a"));

    expect(again).toHaveLength(2);
    expect(findWindow(again, "a")!.z).toBeGreaterThan(findWindow(again, "b")!.z);
  });

  it("declines by identity when the window is open and already on top", () => {
    const windows = open("a", "b");
    expect(openWindow(windows, spec("b"))).toBe(windows);
  });

  it("stacks z in the order windows were opened", () => {
    const windows = open("a", "b", "c");
    expect(windows.map((win) => win.z)).toEqual([1, 2, 3]);
  });

  it("opens a window beside an open one at that frame's share, not the spec's", () => {
    // The caption tab was dragged wide. Opening speech makes it the tab on
    // show, and at the spec's 46 the whole frame would snap back narrow.
    const wide = setPlacement(open("captions"), "captions", {
      mode: "docked",
      side: "right",
      sizePct: 60,
    });
    const windows = openWindow(wide, spec("speech"));

    expect(findWindow(windows, "speech")!.placement).toEqual({
      mode: "docked",
      side: "right",
      sizePct: 60,
    });
  });

  it("keeps the spec's share when nothing else is docked on that side or host", () => {
    const wide = setPlacement(open("captions"), "captions", {
      mode: "docked",
      side: "left",
      sizePct: 60,
    });
    const elsewhere = openWindow(wide, spec("speech"));
    const otherHost = openWindow(open("captions"), {
      ...spec("timelineThing", "timeline"),
      placement: { mode: "docked", side: "right", sizePct: 30 },
    });

    expect(findWindow(elsewhere, "speech")!.placement).toMatchObject({ sizePct: 46 });
    expect(findWindow(otherHost, "timelineThing")!.placement).toMatchObject({ sizePct: 30 });
  });
});

describe("closeWindow", () => {
  it("removes the window", () => {
    const windows = closeWindow(open("a", "b"), "a");
    expect(windows.map((win) => win.id)).toEqual(["b"]);
  });

  it("declines by identity for a window that is not open", () => {
    const windows = open("a");
    expect(closeWindow(windows, "nobody")).toBe(windows);
    expect(closeWindow([], "a")).toEqual([]);
  });
});

describe("focusWindow", () => {
  it("raises a background window above its siblings", () => {
    const windows = focusWindow(open("a", "b", "c"), "a");
    const top = Math.max(...windows.map((win) => win.z));
    expect(findWindow(windows, "a")!.z).toBe(top);
  });

  it("declines by identity when it is already on top", () => {
    const windows = open("a", "b");
    expect(focusWindow(windows, "b")).toBe(windows);
  });

  it("declines by identity for an unknown id", () => {
    const windows = open("a");
    expect(focusWindow(windows, "nobody")).toBe(windows);
  });

  it("measures focus per host, so a window on top of its own region is already on top", () => {
    // `other` was opened last and so has the highest z overall, but it lives in
    // a different region: `a` is already the top of `preview` and focusing it
    // must not renumber anything.
    const windows = openWindow(open("a"), spec("other", "timeline"));
    expect(focusWindow(windows, "a")).toBe(windows);
  });
});

describe("setPlacement", () => {
  it("writes a new placement", () => {
    const windows = setPlacement(open("a"), "a", {
      mode: "docked",
      side: "bottom",
      sizePct: 30,
    });
    expect(windows[0].placement).toEqual({ mode: "docked", side: "bottom", sizePct: 30 });
  });

  it("declines by identity when the placement is the one it already has", () => {
    const windows = open("a");
    expect(
      setPlacement(windows, "a", { mode: "docked", side: "right", sizePct: 46 }),
    ).toBe(windows);
  });

  it("declines by identity for an identical floating rect", () => {
    const windows = floatWindow(open("a"), "a", { x: 1, y: 2, width: 300, height: 200 });
    expect(
      setPlacement(windows, "a", {
        mode: "floating",
        rect: { x: 1, y: 2, width: 300, height: 200 },
      }),
    ).toBe(windows);
  });

  it("does not confuse the two modes", () => {
    const windows = open("a");
    const floated = floatWindow(windows, "a", { x: 0, y: 0, width: 300, height: 200 });
    expect(floated).not.toBe(windows);
    expect(floated[0].placement.mode).toBe("floating");
  });

  it("declines by identity for an unknown id", () => {
    const windows = open("a");
    expect(
      setPlacement(windows, "nobody", { mode: "docked", side: "left", sizePct: 10 }),
    ).toBe(windows);
  });

  it("resizes every tab of the frame, and nothing outside it", () => {
    let windows = openWindow(open("a", "b"), spec("elsewhere", "timeline"));
    windows = openWindow(windows, {
      ...spec("bottom"),
      placement: { mode: "docked", side: "bottom", sizePct: 20 },
    });

    const resized = setPlacement(windows, "b", { mode: "docked", side: "right", sizePct: 30 });

    expect(findWindow(resized, "a")!.placement).toMatchObject({ side: "right", sizePct: 30 });
    expect(findWindow(resized, "b")!.placement).toMatchObject({ side: "right", sizePct: 30 });
    // Another host, and another side of this one, are other frames.
    expect(findWindow(resized, "elsewhere")).toBe(findWindow(windows, "elsewhere"));
    expect(findWindow(resized, "bottom")).toBe(findWindow(windows, "bottom"));
  });

  it("declines by identity when every tab of the frame already has that share", () => {
    const windows = open("a", "b");
    expect(
      setPlacement(windows, "a", { mode: "docked", side: "right", sizePct: 46 }),
    ).toBe(windows);
  });

  it("still writes a tab whose frame-mates already match", () => {
    // `a` alone is out of step, as a list built by hand could be. Its mate
    // matching must not be read as "nothing to do".
    const windows = open("a", "b").map((win) =>
      win.id === "a"
        ? { ...win, placement: { mode: "docked" as const, side: "right" as const, sizePct: 10 } }
        : win,
    );
    const fixed = setPlacement(windows, "a", { mode: "docked", side: "right", sizePct: 46 });

    expect(fixed).not.toBe(windows);
    expect(findWindow(fixed, "a")!.placement).toMatchObject({ sizePct: 46 });
    expect(findWindow(fixed, "b")).toBe(findWindow(windows, "b"));
  });

  it("leaves the frame a window moves out of at its own size", () => {
    const windows = open("a", "b");
    const moved = setPlacement(windows, "b", { mode: "docked", side: "left", sizePct: 20 });

    expect(findWindow(moved, "a")).toBe(findWindow(windows, "a"));
    expect(findWindow(moved, "b")!.placement).toEqual({
      mode: "docked",
      side: "left",
      sizePct: 20,
    });
  });
});

describe("dockWindow", () => {
  it("carries the share across when a docked window changes side", () => {
    const windows = setPlacement(open("a"), "a", {
      mode: "docked",
      side: "right",
      sizePct: 33,
    });
    const docked = dockWindow(windows, "a", "bottom");
    expect(docked[0].placement).toEqual({ mode: "docked", side: "bottom", sizePct: 33 });
  });

  it("gives a window arriving from floating the default share", () => {
    const windows = floatWindow(open("a"), "a", { x: 0, y: 0, width: 300, height: 200 });
    const docked = dockWindow(windows, "a", "left");
    expect(docked[0].placement).toEqual({
      mode: "docked",
      side: "left",
      sizePct: DEFAULT_DOCK_PCT,
    });
  });

  it("declines by identity when it is already docked there", () => {
    const windows = open("a");
    expect(dockWindow(windows, "a", "right")).toBe(windows);
  });

  it("takes the share of a frame already on the side it joins", () => {
    let windows = openWindow(open("a"), {
      ...spec("b"),
      placement: { mode: "docked", side: "bottom", sizePct: 25 },
    });
    windows = floatWindow(windows, "a", { x: 0, y: 0, width: 300, height: 200 });

    const docked = dockWindow(windows, "a", "bottom");
    expect(findWindow(docked, "a")!.placement).toEqual({
      mode: "docked",
      side: "bottom",
      sizePct: 25,
    });
    // Joining did not resize the frame it joined.
    expect(findWindow(docked, "b")).toBe(findWindow(windows, "b"));
  });
});

describe("windowsOfHost", () => {
  it("returns only that host's windows", () => {
    const windows = openWindow(open("a", "b"), spec("elsewhere", "timeline"));
    expect(windowsOfHost(windows, "preview").map((win) => win.id)).toEqual(["a", "b"]);
    expect(windowsOfHost(windows, "timeline").map((win) => win.id)).toEqual(["elsewhere"]);
    expect(windowsOfHost(windows, "nowhere")).toEqual([]);
  });
});

describe("isOpen", () => {
  it("answers for both cases", () => {
    const windows = open("a");
    expect(isOpen(windows, "a")).toBe(true);
    expect(isOpen(windows, "b")).toBe(false);
  });
});
