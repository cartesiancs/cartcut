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
