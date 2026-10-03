import {
  TouchGesture,
  type GestureCommand,
  type SurfaceMode,
  type TouchPoint,
} from "./touchGesture";

/**
 * One kind of mouse-driven surface a finger may land on.
 *
 * Everything not claimed by a surface is left to the browser, so buttons,
 * inputs, sliders and the panels' own scrolling behave exactly as a phone
 * expects. Claiming a touch means cancelling it, which takes the native scroll
 * and the native click away with it, so only surfaces that cannot work any
 * other way are listed.
 */
export type TouchSurface = {
  /** The surface element a touch on `target` belongs to, or `null`. */
  match(target: Element): Element | null;
  mode(surface: Element, target: Element, x: number, y: number): SurfaceMode;
  /** The finger dragged the content by (`dx`, `dy`) CSS px. */
  pan?(surface: Element, dx: number, dy: number, x: number, y: number): void;
  /** Two fingers spread by `scale` about (`x`, `y`) since the last call. */
  pinch?(surface: Element, scale: number, x: number, y: number): void;
};

type Active = {
  surface: TouchSurface;
  element: Element;
  /** The element the first finger landed on: where a press and a click go. */
  target: Element;
};

const points = (list: TouchList): TouchPoint[] =>
  Array.from(list, (touch) => ({
    id: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));

/**
 * Feed claimed touches to the surface under them as mouse events.
 *
 * The listeners sit on the document in the capture phase and are non-passive,
 * since cancelling is the point: Chrome makes document-level touch listeners
 * passive unless told otherwise, and a passive `preventDefault` is ignored with
 * a console warning while the page scrolls under the drag.
 */
export function installTouchBridge(
  doc: Document,
  surfaces: TouchSurface[],
): () => void {
  const view = doc.defaultView ?? window;
  const gesture = new TouchGesture();
  let active: Active | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether a primary press is currently held, for `buttons`. */
  let held = 0;
  /**
   * Where the last mouse event was sent, for `movementX`/`movementY`. A number
   * field's scrub reads only those (they are what keep counting under pointer
   * lock), and an untrusted event reports 0 unless told otherwise.
   */
  let lastPoint: { x: number; y: number } | null = null;

  const now = () => view.performance.now();

  const disarm = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    disarm();
    const deadline = gesture.longPressDeadline();
    if (deadline == null) {
      return;
    }
    timer = setTimeout(
      () => {
        timer = null;
        run(gesture.tick(now()));
      },
      Math.max(0, deadline - now()),
    );
  };

  const mouse = (command: Extract<GestureCommand, { kind: "mouse" }>) => {
    if (active == null) {
      return;
    }
    const { type, x, y, button } = command;
    // A press and the click it becomes belong to what the finger landed on,
    // as a mouse's do. A move and a release belong to what is under the finger
    // now, so a surface's own `mousemove` hears a drag across it and the
    // window-level listeners every drag installs hear it by bubbling.
    const pressLike = type === "mousedown" || type === "click" || type === "dblclick";
    const under = pressLike ? null : doc.elementFromPoint(x, y);
    const target =
      pressLike || under == null || !under.isConnected ? active.target : under;

    if (type === "mousedown") {
      held = button === 2 ? 2 : 1;
      // The touch was cancelled, so focus did not move. A text field focused
      // before would keep the keyboard up over the timeline the user is now
      // dragging on; a mouse press here would have blurred it.
      const focused = doc.activeElement as HTMLElement | null;
      if (focused != null && focused !== doc.body && !active.element.contains(focused)) {
        focused.blur?.();
      }
    }
    const buttons = type === "mouseup" || type === "click" || type === "dblclick" ? 0 : held;
    if (type === "mouseup") {
      held = 0;
    }
    const movementX = type === "mousemove" && lastPoint != null ? x - lastPoint.x : 0;
    const movementY = type === "mousemove" && lastPoint != null ? y - lastPoint.y : 0;
    lastPoint = { x, y };

    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button,
        buttons,
        movementX,
        movementY,
        detail: type === "dblclick" ? 2 : 1,
      }),
    );
  };

  const run = (commands: GestureCommand[]) => {
    for (const command of commands) {
      if (active == null) {
        return;
      }
      if (command.kind === "mouse") {
        mouse(command);
      } else if (command.kind === "pan") {
        active.surface.pan?.(
          active.element,
          command.dx,
          command.dy,
          command.x,
          command.y,
        );
      } else {
        active.surface.pinch?.(
          active.element,
          command.scale,
          command.x,
          command.y,
        );
      }
    }
  };

  const finish = () => {
    if (!gesture.active) {
      disarm();
      active = null;
      held = 0;
      lastPoint = null;
    }
  };

  const onStart = (event: TouchEvent) => {
    if (active == null) {
      // The innermost element, not the retargeted one: a field that renders
      // into a shadow root listens on an element inside it, and an event sent
      // to the host would never reach that listener.
      const origin = event.composedPath()[0] ?? event.target;
      const target = origin instanceof Element ? origin : null;
      if (target == null) {
        return;
      }
      for (const surface of surfaces) {
        const element = surface.match(target);
        if (element != null) {
          active = { surface, element, target };
          break;
        }
      }
      if (active == null) {
        return;
      }
    }
    event.preventDefault();
    const touches = points(event.touches);
    const first = touches[0];
    const mode =
      first == null
        ? "mouse"
        : active.surface.mode(active.element, active.target, first.x, first.y);
    run(gesture.start(touches, now(), mode));
    arm();
    finish();
  };

  const onMove = (event: TouchEvent) => {
    if (active == null) {
      return;
    }
    event.preventDefault();
    run(gesture.move(points(event.touches)));
    arm();
  };

  const onEnd = (event: TouchEvent) => {
    if (active == null) {
      return;
    }
    event.preventDefault();
    run(gesture.end(points(event.touches), now()));
    finish();
  };

  const onCancel = () => {
    if (active == null) {
      return;
    }
    run(gesture.cancel());
    finish();
  };

  const options: AddEventListenerOptions = { capture: true, passive: false };
  doc.addEventListener("touchstart", onStart, options);
  doc.addEventListener("touchmove", onMove, options);
  doc.addEventListener("touchend", onEnd, options);
  doc.addEventListener("touchcancel", onCancel, options);

  return () => {
    disarm();
    doc.removeEventListener("touchstart", onStart, options);
    doc.removeEventListener("touchmove", onMove, options);
    doc.removeEventListener("touchend", onEnd, options);
    doc.removeEventListener("touchcancel", onCancel, options);
  };
}
