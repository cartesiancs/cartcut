import type { TouchSurface } from "./touchBridge";
import { previewPinchDeltaY, timelinePinchDeltaY } from "./timelineTouch";

/**
 * The editor's mouse-only surfaces, as the touch bridge sees them.
 *
 * The one file that knows the editor's tag names on the bridge's behalf. Each
 * pan or pinch is delivered as the wheel event that surface already handles,
 * so a finger scrolls and zooms by exactly the arithmetic a trackpad does.
 * Two of the surfaces listen for the legacy `mousewheel` type, which a
 * dispatched `wheel` never reaches, so the type is per surface.
 */

function wheel(
  target: Element | null,
  type: "wheel" | "mousewheel",
  init: WheelEventInit,
) {
  target?.dispatchEvent(
    new WheelEvent(type, {
      bubbles: true,
      cancelable: true,
      deltaMode: 0,
      ...init,
    }),
  );
}

/** Controls inside a surface that keep their own native touch behaviour. */
const NATIVE = "input, select, textarea, [contenteditable], .track-resize-grip";

/** `closest`, continuing out through any shadow roots on the way up. */
function closestComposed(start: Element, selector: string): Element | null {
  let node: Element | null = start;
  while (node != null) {
    const hit = node.closest(selector);
    if (hit != null) {
      return hit;
    }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

const within = (selector: string) => (target: Element) =>
  closestComposed(target, NATIVE) == null
    ? closestComposed(target, selector)
    : null;

/** The nearest ancestor that scrolls vertically, crossing shadow roots. */
function scrollerOf(start: Element): Element | null {
  let node: Element | null = start.parentElement ?? null;
  while (node != null) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    const parent: Element | null = node.parentElement;
    if (parent != null) {
      node = parent;
    } else {
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
  }
  return null;
}

type TimelineCanvasHost = Element & {
  touchModeAt?: (x: number, y: number) => "mouse" | "pan";
};

const timelineCanvas: TouchSurface = {
  match: within("element-timeline-canvas"),
  mode: (surface, _target, x, y) =>
    (surface as TimelineCanvasHost).touchModeAt?.(x, y) ?? "mouse",
  pan: (surface, dx, dy, x, y) =>
    wheel(surface.querySelector("canvas"), "mousewheel", {
      deltaX: -dx,
      deltaY: -dy,
      clientX: x,
      clientY: y,
    }),
  pinch: (surface, scale, x, y) =>
    wheel(surface.querySelector("canvas"), "mousewheel", {
      ctrlKey: true,
      deltaY: timelinePinchDeltaY(scale),
      clientX: x,
      clientY: y,
    }),
};

/**
 * The track headers scroll with the rows, as they do under a wheel, and a tap
 * on one of their buttons is replayed as that button's click.
 */
const trackHeaders: TouchSurface = {
  match: within("element-timeline-left-option"),
  mode: () => "pan",
  pan: (surface, _dx, dy, x, y) =>
    wheel(surface, "wheel", { deltaY: -dy, clientX: x, clientY: y }),
};

/** Scrub, drag the playhead, drag the scrollbar: the finger is the mouse. */
const timelineChrome: TouchSurface = {
  match: within(
    "element-timeline-ruler, element-timeline-cursor, element-timeline-bottom-scroll",
  ),
  mode: () => "mouse",
};

const preview: TouchSurface = {
  match: within("preview-canvas"),
  mode: () => "mouse",
  pan: (surface, dx, dy, x, y) =>
    wheel(surface.querySelector("canvas"), "wheel", {
      deltaX: -dx,
      deltaY: -dy,
      clientX: x,
      clientY: y,
    }),
  pinch: (surface, scale, x, y) =>
    wheel(surface.querySelector("canvas"), "wheel", {
      ctrlKey: true,
      deltaY: previewPinchDeltaY(scale),
      clientX: x,
      clientY: y,
    }),
};

const keyframeEditor: TouchSurface = {
  match: within("keyframe-editor canvas"),
  mode: () => "mouse",
  pinch: (surface, scale, x, y) =>
    wheel(surface, "mousewheel", {
      ctrlKey: true,
      deltaY: timelinePinchDeltaY(scale),
      clientX: x,
      clientY: y,
    }),
};

/**
 * The inspector's number fields. Dragged sideways they scrub, exactly as a
 * mouse drag does; dragged up or down they scroll the sheet they sit in, since
 * claiming the touch took the native scroll away; tapped, they open for typing.
 * While a field is open for typing it is an `input`, and `NATIVE` leaves it be.
 */
const numberField: TouchSurface = {
  match: within("number-input"),
  mode: () => "axis",
  pan: (surface, _dx, dy) => scrollerOf(surface)?.scrollBy(0, -dy),
};

/** Anything else that opts in by attribute. */
const optIn: TouchSurface = {
  match: within("[data-touch-mouse]"),
  mode: () => "mouse",
};

export const EDITOR_TOUCH_SURFACES: TouchSurface[] = [
  timelineCanvas,
  trackHeaders,
  timelineChrome,
  preview,
  keyframeEditor,
  numberField,
  optIn,
];
