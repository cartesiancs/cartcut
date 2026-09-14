/**
 * A region that can hold docked windows, and the splitters between them.
 *
 * This is the only component in the feature that knows about layout. It
 * measures itself, hands the size to `windowStore`, asks `layoutHost` for the
 * rects, and writes them as inline styles. `<app-window>` below it is chrome
 * and nothing else.
 *
 * Geometry is written as an inline `style` rather than through CSS classes on
 * purpose: there is then exactly one place a rect is decided, it is a pure
 * function with a test, and a stylesheet cannot quietly disagree with it.
 *
 * ## The splitter
 *
 * The gesture is the idiom the app's four other dividers use, a flag plus
 * window-level `mousemove`/`mouseup`. What is different is that the arithmetic
 * is not here: `windowDrag.ts#resolveWindowDrag` owns it, so the case that
 * actually breaks splitters, what happens at the ends of their travel, is
 * reachable from a node test. The four existing ones keep theirs inline in a
 * `mousemove` handler and none of them has a test.
 *
 * Unlike those four, the listeners are removed on disconnect. They are bound
 * once and kept, rather than `.bind(this)` at registration time, which is what
 * makes that possible: a fresh function per call is a listener nobody can ever
 * take off again.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import "./appWindow";
import {
  SPLITTER_HANDLE,
  resolveWindowDrag,
  type DragHandle,
  type Point,
} from "./windowDrag";
import {
  axisOf,
  type Rect,
  type Size,
  type WindowPlacement,
  type WindowState,
} from "./windowLayout";
import { windowsOfHost } from "./windowOps";
import { hostLayout, windowStore, type IWindowStore } from "./windowStore";

/**
 * What this host is able to show, whether or not it is currently open.
 *
 * Declared by the caller, because the caller is the one that can build the
 * content and knows its localised name. A panel listed here but not open in the
 * store draws nothing, so opening a window is a store write and never a change
 * to the template.
 */
export type WindowPanel = {
  id: string;
  label: string;
  icon?: string;
  content: TemplateResult;
};

const rectStyle = (rect: Rect): string =>
  `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;`;

type DragRecord = {
  id: string;
  handle: DragHandle;
  origin: WindowPlacement;
  originRect: Rect;
  minSize: Size;
  from: Point;
};

@customElement("window-host")
export class WindowHost extends LitElement {
  @property()
  hostId = "";

  /** The region's own content, shown in whatever the windows leave behind. */
  @property({ attribute: false })
  content: TemplateResult | typeof nothing = nothing;

  @property({ attribute: false })
  panels: WindowPanel[] = [];

  @property({ attribute: false })
  windowState: IWindowStore = windowStore.getInitialState();

  /** The window whose splitter is being dragged, for the hover style. */
  @property()
  draggingId: string | null = null;

  private unsubscribe: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private drag: DragRecord | null = null;

  private readonly onMouseMove = (event: MouseEvent) => this.handleMouseMove(event);
  private readonly onMouseUp = () => this.handleMouseUp();

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // The host element is a custom element with no styles of its own, so it is
    // `display: inline` and collapses to nothing. `.window-host` is what gives
    // it the box every rect below is measured against.
    this.classList.add("window-host");

    this.unsubscribe = windowStore.subscribe((state) => {
      this.windowState = state;
    });

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(this);
    this.measure();

    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  /**
   * Hand the store the region's size, in whole pixels.
   *
   * Rounded, because `getBoundingClientRect` reports the fractions that a
   * percentage-width column inevitably has (measured here: 500.515625 tall),
   * and every rect derived from it inherits them. A window whose edge falls on
   * a half pixel has its 1px border drawn as two half-intensity rows, which is
   * a visibly soft edge on a 2x display and, less obviously, is why the border
   * is a usable thing for `caption-window.spec.ts` to look for at all.
   */
  private measure() {
    const box = this.getBoundingClientRect();
    windowStore.getState().measureHost(this.hostId, {
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }

  private hostPoint(event: MouseEvent): Point {
    const box = this.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  private handleSplitterDown(event: MouseEvent, win: WindowState, rect: Rect) {
    if (win.placement.mode !== "docked") {
      return;
    }
    // Without this the drag starts a text selection across the whole region,
    // and the selection highlight follows the pointer over the preview.
    event.preventDefault();

    this.drag = {
      id: win.id,
      handle: SPLITTER_HANDLE[win.placement.side],
      origin: win.placement,
      originRect: rect,
      minSize: win.minSize,
      from: this.hostPoint(event),
    };
    this.draggingId = win.id;
  }

  private handleMouseMove(event: MouseEvent) {
    if (this.drag == null) {
      return;
    }

    const state = windowStore.getState();
    const host = state.hostSizes[this.hostId];
    if (host == null) {
      return;
    }

    const plan = resolveWindowDrag({
      origin: this.drag.origin,
      originRect: this.drag.originRect,
      host,
      minSize: this.drag.minSize,
      from: this.drag.from,
      to: this.hostPoint(event),
      handle: this.drag.handle,
    });

    if (plan.kind === "none") {
      return;
    }

    state.place(this.drag.id, plan.placement);
    this.notifyPreviewResized();
  }

  private handleMouseUp() {
    if (this.drag == null) {
      return;
    }
    this.drag = null;
    this.draggingId = null;
    // One more after the gesture ends. `resizeEvent` arms a 300ms debounce over
    // a 50ms poll, and `previewRatio` is written asynchronously by the canvas's
    // own rAF draw, so the last move alone can settle before the final ratio
    // has landed.
    this.notifyPreviewResized();
  }

  /**
   * Tell the legacy overlay the preview changed size.
   *
   * Optional-chained, unlike `Control` and `Timeline` which call it outright:
   * `element-control` is only mounted while the preview tab is the one on
   * screen, so in a docking world it can genuinely be absent. `preview-canvas`
   * needs nothing, it observes its own canvas.
   */
  private notifyPreviewResized() {
    (document.querySelector("element-control") as any)?.resizeEvent();
  }

  render() {
    const layout = hostLayout(this.windowState, this.hostId);
    const open = new Map(
      windowsOfHost(this.windowState.windows, this.hostId).map((win) => [win.id, win]),
    );

    return html`
      <div class="window-host-content" style=${rectStyle(layout.content)}>
        ${this.content}
      </div>

      ${layout.windows.map((entry) => {
        const win = open.get(entry.id);
        const panel = this.panels.find((candidate) => candidate.id === entry.id);
        if (win == null || panel == null) {
          return nothing;
        }

        const vertical =
          win.placement.mode === "docked" && axisOf(win.placement.side) === "width";

        return html`
          ${entry.splitter == null
            ? nothing
            : html`<div
                class="window-splitter ${vertical ? "is-vertical" : "is-horizontal"} ${this
                  .draggingId === entry.id
                  ? "is-dragging"
                  : ""}"
                style=${rectStyle(entry.splitter)}
                @mousedown=${(event: MouseEvent) =>
                  this.handleSplitterDown(event, win, entry.rect)}
              ></div>`}

          <app-window
            class="app-window"
            style=${rectStyle(entry.rect)}
            .windowId=${entry.id}
            .label=${panel.label}
            .icon=${panel.icon ?? ""}
            .closable=${win.closable}
            .content=${panel.content}
            @mousedown=${() => windowStore.getState().focus(entry.id)}
            @windowClose=${() => windowStore.getState().close(entry.id)}
          ></app-window>
        `;
      })}
    `;
  }
}
