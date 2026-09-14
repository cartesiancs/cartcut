import { describe, expect, it } from "vitest";

import { resolveWindowDrag, type DragHandle, type WindowDragInput } from "./windowDrag";
import {
  CONTENT_MIN,
  SPLITTER_PX,
  contains,
  layoutHost,
  type DockSide,
  type Rect,
  type Size,
  type WindowPlacement,
  type WindowState,
} from "./windowLayout";

const HOST: Size = { width: 680, height: 400 };
const MIN: Size = { width: 240, height: 160 };

/** A right-docked window at 40%, as laid out: 272px wide against a 680px host. */
function dockedInput(
  side: DockSide,
  handle: DragHandle,
  dx: number,
  dy: number,
  overrides: Partial<WindowDragInput> = {},
): WindowDragInput {
  const sizePct = 40;
  const state = dockedState(side, sizePct);
  const rect = layoutHost(HOST, [state]).windows[0].rect;

  return {
    origin: { mode: "docked", side, sizePct },
    originRect: rect,
    host: HOST,
    minSize: MIN,
    from: { x: 300, y: 200 },
    to: { x: 300 + dx, y: 200 + dy },
    handle,
    ...overrides,
  };
}

function dockedState(side: DockSide, sizePct: number): WindowState {
  return {
    id: "w",
    hostId: "preview",
    placement: { mode: "docked", side, sizePct },
    minSize: MIN,
    resizable: true,
    closable: true,
    z: 0,
  };
}

function floatingInput(
  rect: Rect,
  handle: DragHandle,
  dx: number,
  dy: number,
): WindowDragInput {
  return {
    origin: { mode: "floating", rect },
    originRect: rect,
    host: HOST,
    minSize: MIN,
    from: { x: 0, y: 0 },
    to: { x: dx, y: dy },
    handle,
  };
}

const placed = (plan: ReturnType<typeof resolveWindowDrag>): WindowPlacement => {
  expect(plan.kind).toBe("place");
  return (plan as { kind: "place"; placement: WindowPlacement }).placement;
};

/** The window's laid-out rect once a resolved placement is written back. */
function laidOut(placement: WindowPlacement): Rect {
  return layoutHost(HOST, [
    { ...dockedState("right", 0), placement },
  ]).windows[0].rect;
}

describe("resolveWindowDrag, docked", () => {
  it("grows a right-docked window when the splitter is dragged towards the content", () => {
    const plan = resolveWindowDrag(dockedInput("right", "w", -60, 0));
    const placement = placed(plan);

    expect(placement.mode).toBe("docked");
    expect(laidOut(placement).width).toBe(272 + 60);
  });

  it("shrinks it when the splitter is dragged the other way", () => {
    // 30 rather than 60: 272 - 60 is 212, under the 240 minimum, so a bigger
    // delta would be testing the clamp and not the direction. The clamp has its
    // own case below.
    const placement = placed(resolveWindowDrag(dockedInput("right", "w", 30, 0)));
    expect(laidOut(placement).width).toBe(272 - 30);
  });

  it.each<[DockSide, DragHandle, number, number]>([
    ["left", "e", 50, 0],
    ["right", "w", -50, 0],
    ["top", "s", 0, 50],
    ["bottom", "n", 0, -50],
  ])("grows a %s-docked window from its %s handle", (side, handle, dx, dy) => {
    const input = dockedInput(side, handle, dx, dy);
    const placement = placed(resolveWindowDrag(input));
    const after = layoutHost(HOST, [{ ...dockedState(side, 0), placement }]).windows[0].rect;
    const axis = side === "left" || side === "right" ? "width" : "height";

    expect(after[axis]).toBeGreaterThan(input.originRect[axis]);
  });

  it("declines every handle that is not the splitter", () => {
    const handles: DragHandle[] = ["move", "n", "s", "e", "ne", "nw", "se", "sw"];
    for (const handle of handles) {
      expect(resolveWindowDrag(dockedInput("right", handle, -60, -60)).kind).toBe("none");
    }
  });

  it("declines a gesture that has not moved", () => {
    expect(resolveWindowDrag(dockedInput("right", "w", 0, 0)).kind).toBe("none");
  });

  it("declines every further pixel once the splitter is against its limit", () => {
    // Far past the edge in one go, then further still from that same origin.
    const pinned = placed(resolveWindowDrag(dockedInput("right", "w", -5000, 0)));
    const pinnedRect = laidOut(pinned);

    const again = resolveWindowDrag({
      ...dockedInput("right", "w", -9000, 0),
      origin: pinned,
      originRect: pinnedRect,
    });
    expect(again.kind).toBe("none");
  });

  it("never resolves to a placement that would leave the host", () => {
    const bounds = { x: 0, y: 0, width: HOST.width, height: HOST.height };

    for (const side of ["left", "right", "top", "bottom"] as DockSide[]) {
      const handle = { left: "e", right: "w", top: "s", bottom: "n" }[side] as DragHandle;
      for (const travel of [-4000, -700, -137, -1, 1, 137, 700, 4000]) {
        const dx = side === "left" || side === "right" ? travel : 0;
        const dy = side === "top" || side === "bottom" ? travel : 0;
        const plan = resolveWindowDrag(dockedInput(side, handle, dx, dy));
        if (plan.kind === "none") {
          continue;
        }
        const layout = layoutHost(HOST, [{ ...dockedState(side, 0), placement: plan.placement }]);
        expect(contains(bounds, layout.windows[0].rect, 0), `${side} ${travel}`).toBe(true);
        expect(contains(bounds, layout.content, 0), `${side} ${travel} content`).toBe(true);
      }
    }
  });

  it("leaves the content its floor at the far end of the drag", () => {
    const placement = placed(resolveWindowDrag(dockedInput("right", "w", -5000, 0)));
    const layout = layoutHost(HOST, [{ ...dockedState("right", 0), placement }]);
    expect(layout.content.width).toBe(CONTENT_MIN.width);
    expect(layout.windows[0].rect.width).toBe(HOST.width - CONTENT_MIN.width - SPLITTER_PX);
  });

  it("stops at the window's own minimum at the near end", () => {
    const placement = placed(resolveWindowDrag(dockedInput("right", "w", 5000, 0)));
    expect(laidOut(placement).width).toBe(MIN.width);
  });
});

describe("resolveWindowDrag, floating", () => {
  const START: Rect = { x: 100, y: 60, width: 300, height: 200 };

  it("moves by the pointer delta", () => {
    const placement = placed(resolveWindowDrag(floatingInput(START, "move", 40, -25)));
    expect(placement).toEqual({
      mode: "floating",
      rect: { x: 140, y: 35, width: 300, height: 200 },
    });
  });

  it("pulls a window dragged past the edge back inside, without shrinking it", () => {
    const placement = placed(resolveWindowDrag(floatingInput(START, "move", 5000, 5000)));
    const rect = (placement as { rect: Rect }).rect;

    expect(rect.width).toBe(300);
    expect(rect.height).toBe(200);
    expect(rect.x + rect.width).toBe(HOST.width);
    expect(rect.y + rect.height).toBe(HOST.height);
  });

  it("declines once it is pinned against the edge and pushed further", () => {
    const pinned = placed(resolveWindowDrag(floatingInput(START, "move", 5000, 5000)));
    const rect = (pinned as { rect: Rect }).rect;
    expect(resolveWindowDrag(floatingInput(rect, "move", 5000, 5000)).kind).toBe("none");
  });

  it("declines a gesture that has not moved", () => {
    expect(resolveWindowDrag(floatingInput(START, "move", 0, 0)).kind).toBe("none");
  });

  it.each<[DragHandle, number, number, Partial<Rect>]>([
    ["e", 50, 0, { x: 100, width: 350 }],
    ["w", -50, 0, { x: 50, width: 350 }],
    ["s", 0, 50, { y: 60, height: 250 }],
    ["n", 0, -50, { y: 10, height: 250 }],
    ["se", 50, 50, { width: 350, height: 250 }],
    ["nw", -50, -50, { x: 50, y: 10, width: 350, height: 250 }],
  ])("resizes from the %s handle", (handle, dx, dy, expected) => {
    const placement = placed(resolveWindowDrag(floatingInput(START, handle, dx, dy)));
    expect((placement as { rect: Rect }).rect).toMatchObject(expected);
  });

  it("pins the near edge at the minimum rather than walking the window across the host", () => {
    // Drag the west handle far to the right. The east edge must not move.
    const placement = placed(resolveWindowDrag(floatingInput(START, "w", 5000, 0)));
    const rect = (placement as { rect: Rect }).rect;

    expect(rect.width).toBe(MIN.width);
    expect(rect.x + rect.width).toBe(START.x + START.width);
  });

  it("keeps every resolved rect inside the host", () => {
    const bounds = { x: 0, y: 0, width: HOST.width, height: HOST.height };
    const handles: DragHandle[] = ["move", "n", "s", "e", "w", "ne", "nw", "se", "sw"];

    for (const handle of handles) {
      for (const dx of [-3000, -211, 0, 211, 3000]) {
        for (const dy of [-3000, -211, 0, 211, 3000]) {
          const plan = resolveWindowDrag(floatingInput(START, handle, dx, dy));
          if (plan.kind === "none") {
            continue;
          }
          const rect = (plan.placement as { rect: Rect }).rect;
          expect(contains(bounds, rect, 0), `${handle} ${dx},${dy}`).toBe(true);
        }
      }
    }
  });
});
