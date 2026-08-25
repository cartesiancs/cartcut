import { emptyAnimation } from "../animation/keyframes";
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import {
  IControlPanelStore,
  controlPanelStore,
} from "../../states/controlPanelStore";
import { v4 as uuidv4 } from "uuid";
import { placeNewElement } from "../timeline/placement";
import {
  IPreviewViewportStore,
  previewViewportStore,
} from "../../states/previewViewportStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { ZOOM_STEP } from "./viewport";
import { createShapeElement, shapePoints } from "../element/shapeElement";

/** 100% is the fit scale, so it doubles as the "fit" preset. */
const ZOOM_PRESETS = [25, 50, 100, 200, 400, 800];

@customElement("preview-top-bar")
export class PreviewTopBar extends LitElement {
  constructor() {
    super();
  }

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  control = this.timelineState.control;

  @property()
  controlPanel: IControlPanelStore = controlPanelStore.getInitialState();

  @property()
  activePanel = this.controlPanel.active;

  @property()
  nowActivePanel = this.controlPanel.nowActive;

  @property()
  timeline: any = this.timelineState.timeline;

  @property()
  viewportStore: IPreviewViewportStore = previewViewportStore.getInitialState();

  @property()
  viewport = this.viewportStore.viewport;

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.control = state.control;
      this.timeline = state.timeline;
    });

    controlPanelStore.subscribe((state) => {
      this.activePanel = state.active;
      this.nowActivePanel = state.nowActive;
    });

    previewViewportStore.subscribe((state) => {
      this.viewport = state.viewport;
      this.requestUpdate();
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
    });

    return this;
  }

  _handleClickZoom(factor: number) {
    previewViewportStore
      .getState()
      .setZoom(previewViewportStore.getState().viewport.zoom * factor);
  }

  _handleClickZoomPreset(zoom: number) {
    previewViewportStore.getState().setZoom(zoom);
  }

  _handleClickFit() {
    const previewSize = this.renderOption.previewSize;
    previewViewportStore
      .getState()
      .fit(Number(previewSize.w), Number(previewSize.h));
  }

  createShape(shape) {
    const elementId = uuidv4();

    // Shape construction lives in `element/shapeElement.ts` so the agent's
    // `add_shape` and this button produce the same element. The pen tool's own
    // freehand path (`previewCanvas.createShape`) is a different thing and
    // stays where it is.
    const element = createShapeElement({ shape });

    this.timelineState.withCheckpoint((doc) =>
      placeNewElement(
        doc,
        elementId,
        element,
        useTimelineStore.getState().cursor,
        uuidv4(),
      ),
    );
    this.timeline = useTimelineStore.getState().timeline;

    return elementId;
  }

  createSquare() {
    return this.createShape(shapePoints("rectangle"));
  }

  createTriangle() {
    return this.createShape(shapePoints("triangle"));
  }

  createCircle() {
    return this.createShape(shapePoints("ellipse"));
  }

  _handleClickButton(type) {
    this.timelineState.setCursorType(type);
  }

  _handleClickPanelButton(panel) {
    this.controlPanel.setActivePanel(panel);
  }

  /**
   * The close icon lives inside the tab button, so without stopping the click
   * here it bubbles straight into `_handleClickPanelButton` and re-focuses the
   * panel that was just closed — the preview never comes back. `closePanel`
   * owns the fallback to the preview.
   */
  _handleClickRemovePanelButton(event: Event, panel) {
    event.stopPropagation();
    this.controlPanel.closePanel(panel);
  }

  /** Whether the tab strip is scrolled away from its left / right edge. */
  @property()
  tabOverflowStart = false;

  @property()
  tabOverflowEnd = false;

  private tabResizeObserver: ResizeObserver | null = null;

  private get tabScroller(): HTMLElement | null {
    return this.querySelector(".preview-tab-scroll");
  }

  /**
   * The fades are the only sign that the strip scrolls, so they have to track
   * both content changes (a re-render lands here) and width changes (the
   * preview splitter, which never re-renders this component).
   */
  protected updated(): void {
    const scroller = this.tabScroller;
    if (!scroller) {
      return;
    }

    if (!this.tabResizeObserver) {
      this.tabResizeObserver = new ResizeObserver(() =>
        this._syncTabOverflow(),
      );
      this.tabResizeObserver.observe(scroller);
    }

    this._syncTabOverflow();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.tabResizeObserver?.disconnect();
    this.tabResizeObserver = null;
  }

  private _syncTabOverflow() {
    const scroller = this.tabScroller;
    if (!scroller) {
      return;
    }

    // Sub-pixel layout leaves a fraction of scroll room on a strip that already
    // fits, so a whole pixel is the threshold for "there is more over there".
    // Writing the same booleans back is a no-op for Lit, which is what keeps
    // updated() -> sync -> updated() from looping.
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    this.tabOverflowStart = scroller.scrollLeft > 1;
    this.tabOverflowEnd = scroller.scrollLeft < maxScroll - 1;
  }

  _handleTabScroll() {
    this._syncTabOverflow();
  }

  /**
   * A plain mouse only produces deltaY, and the strip scrolls on X alone —
   * without this the tabs it hides would be unreachable outside a trackpad.
   */
  _handleTabWheel(event: WheelEvent) {
    const scroller = event.currentTarget as HTMLElement;
    if (scroller.scrollWidth <= scroller.clientWidth) {
      return;
    }

    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (delta == 0) {
      return;
    }

    event.preventDefault();
    scroller.scrollLeft += delta;
  }

  render() {
    const activePanelMap = this.activePanel.map((item) => {
      return html` <button
        @click=${() => this._handleClickPanelButton(item)}
        class="btn btn-xxs ${this.nowActivePanel == item
          ? "btn-active"
          : "btn-default"} text-light preview-top-button m-0"
      >
        ${item}
        <span
          class="material-symbols-outlined icon-xs"
          @click=${(e: Event) => this._handleClickRemovePanelButton(e, item)}
        >
          close
        </span>
      </button>`;
    });

    return html`
      <style>
        .timeline-cursor-buttons {
          display: flex;
          flex-direction: row;
          gap: 0.5rem;
          height: 2rem;
          border-bottom: 0.05rem #3a3f44 solid;
          align-items: center;
          justify-content: space-between;
        }

        .timeline-cursor-button {
          border: none;
        }

        .preview-top-button {
          font-size: 12px;
          font-weight: bolder;
          display: flex;
          align-items: center;
          gap: 0.25rem;
          white-space: nowrap;
        }

        /* min-width: 0 is what lets the strip shrink past its content width;
           without it the flex item stays intrinsically sized and shoves the
           tools on the right off the end of the bar. */
        .preview-tab-bar {
          flex: 1 1 auto;
          min-width: 0;
        }

        .preview-tool-bar {
          flex: 0 0 auto;
        }

        .preview-tab-scroll {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 0.5rem;
          min-width: 0;
          overflow-x: auto;
          overflow-y: hidden;
          /* No scrollbar anywhere: the edge fades are the affordance. */
          scrollbar-width: none;
          -ms-overflow-style: none;
        }

        .preview-tab-scroll::-webkit-scrollbar {
          display: none;
        }

        .preview-tab-scroll > * {
          flex: 0 0 auto;
        }

        /* A mask rather than an overlaid gradient, so the fade holds over the
           bar's background whatever that background becomes. */
        .preview-tab-scroll.fade-start {
          -webkit-mask-image: linear-gradient(
            to right,
            transparent 0,
            #000 1.5rem
          );
          mask-image: linear-gradient(to right, transparent 0, #000 1.5rem);
        }

        .preview-tab-scroll.fade-end {
          -webkit-mask-image: linear-gradient(
            to left,
            transparent 0,
            #000 1.5rem
          );
          mask-image: linear-gradient(to left, transparent 0, #000 1.5rem);
        }

        .preview-tab-scroll.fade-start.fade-end {
          -webkit-mask-image: linear-gradient(
            to right,
            transparent 0,
            #000 1.5rem,
            #000 calc(100% - 1.5rem),
            transparent 100%
          );
          mask-image: linear-gradient(
            to right,
            transparent 0,
            #000 1.5rem,
            #000 calc(100% - 1.5rem),
            transparent 100%
          );
        }

        /*
         * Segmented control: [zoom out][ 100% v ][zoom in].
         *
         * Bootstrap's .btn-group corner reset skips .dropdown-toggle, so the
         * middle segment would keep its right radius and cut a notch into the
         * zoom-in button. Round the outer edges only, and let the segments
         * stretch to a shared height instead of each sizing itself (.btn-xxs
         * pins height: fit-content, which blocks align-items: stretch).
         */
        .preview-zoom-group {
          display: inline-flex;
          align-items: stretch;
        }

        .preview-zoom-group > .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: auto !important;
          margin: 0 !important;
          border-radius: 0 !important;
        }

        /* of-type, not of-child: the .dropdown-menu <ul> is a sibling here, so
           child position depends on where the menu sits in the markup. */
        .preview-zoom-group > .btn:first-of-type {
          border-top-left-radius: 10px !important;
          border-bottom-left-radius: 10px !important;
        }

        .preview-zoom-group > .btn:last-of-type {
          border-top-right-radius: 10px !important;
          border-bottom-right-radius: 10px !important;
        }

        /* Hairline dividers so the three segments read as one control. */
        .preview-zoom-group > .btn + .btn,
        .preview-zoom-group > .dropdown-menu + .btn {
          box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.08);
        }

        .preview-zoom-value {
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          min-width: 3.75rem;
        }

        /* Bootstrap's caret is inline-block and drags the baseline around;
           size it down and let flex do the centring. */
        .preview-zoom-value::after {
          margin-left: 0.3rem;
          opacity: 0.6;
          vertical-align: middle;
        }
      </style>

      <div class="timeline-cursor-buttons bg-darker">
        <div class="d-flex gap-2 justify-content-start p-1 preview-tab-bar">
          <!-- Pinned outside the scroller: the way back to the preview must
               never be the thing that scrolled out of view. -->
          <button
            @click=${() => this._handleClickPanelButton("")}
            class="btn btn-xxs ${this.nowActivePanel == ""
              ? "btn-active"
              : "btn-default"} text-light preview-top-button m-0"
          >
            preview
          </button>

          <div
            class="preview-tab-scroll ${this.tabOverflowStart
              ? "fade-start"
              : ""} ${this.tabOverflowEnd ? "fade-end" : ""}"
            @scroll=${this._handleTabScroll}
            @wheel=${this._handleTabWheel}
          >
            ${activePanelMap}
          </div>
        </div>
        <div class="d-flex gap-2 justify-content-end p-1 preview-tool-bar">
          <button
            @click=${() => this._handleClickButton("pointer")}
            class="btn btn-xxs ${this.control.cursorType == "pointer"
              ? "btn-primary"
              : "btn-default"} text-light m-0"
          >
            <span class="material-symbols-outlined icon-xs"> near_me </span>
          </button>
          <button
            @click=${() => this._handleClickButton("text")}
            class="btn btn-xxs ${this.control.cursorType == "text"
              ? "btn-primary"
              : "btn-default"} text-light m-0"
          >
            <span class="material-symbols-outlined icon-xs"> text_fields </span>
          </button>

          <div class="btn-group">
            <button
              class="btn btn-xxs btn-default dropdown-toggle text-light m-0"
              data-bs-toggle="dropdown"
              aria-expanded="false"
            >
              <span class="material-symbols-outlined icon-xs"> add </span>
            </button>

            <ul class="dropdown-menu">
              <li>
                <a
                  class="dropdown-item dropdown-item-sm"
                  @click=${this.createSquare}
                >
                  <span class="material-symbols-outlined icon-xs">
                    square
                  </span>
                  Square</a
                >
                <a
                  class="dropdown-item dropdown-item-sm"
                  @click=${this.createTriangle}
                >
                  <span class="material-symbols-outlined icon-xs">
                    change_history
                  </span>
                  Triangle</a
                >
                <a
                  class="dropdown-item dropdown-item-sm"
                  @click=${this.createCircle}
                >
                  <span class="material-symbols-outlined icon-xs">
                    circle
                  </span>
                  Circle</a
                >
                <a
                  class="dropdown-item dropdown-item-sm ${this.control
                    .cursorType == "shape"
                    ? "bg-primary"
                    : ""}"
                  @click=${() => this._handleClickButton("shape")}
                >
                  <span class="material-symbols-outlined icon-xs"> edit </span>
                  Pen Tool</a
                >
              </li>
            </ul>
          </div>

          <div class="btn-group preview-zoom-group">
            <button
              @click=${() => this._handleClickZoom(1 / ZOOM_STEP)}
              class="btn btn-xxs btn-default text-light m-0"
              title="Zoom out"
            >
              <span class="material-symbols-outlined icon-xs"> zoom_out </span>
            </button>

            <button
              class="btn btn-xxs btn-default dropdown-toggle text-light m-0 preview-zoom-value"
              data-bs-toggle="dropdown"
              aria-expanded="false"
            >
              ${Math.round(this.viewport.zoom)}%
            </button>

            <ul class="dropdown-menu">
              <li>
                ${ZOOM_PRESETS.map(
                  (zoom) =>
                    html`<a
                      class="dropdown-item dropdown-item-sm"
                      @click=${() => this._handleClickZoomPreset(zoom)}
                    >
                      ${zoom}%${zoom == 100 ? " (Fit)" : ""}
                    </a>`,
                )}
              </li>
            </ul>

            <button
              @click=${() => this._handleClickZoom(ZOOM_STEP)}
              class="btn btn-xxs btn-default text-light m-0"
              title="Zoom in"
            >
              <span class="material-symbols-outlined icon-xs"> zoom_in </span>
            </button>
          </div>

          <button
            @click=${this._handleClickFit}
            class="btn btn-xxs btn-default text-light m-0"
            title="Fit to frame"
          >
            <span class="material-symbols-outlined icon-xs"> fit_screen </span>
          </button>

          <button
            @click=${() => this._handleClickButton("lockKeyboard")}
            class="btn btn-xxs ${this.control.cursorType == "lockKeyboard"
              ? "btn-primary"
              : "btn-default"} text-light m-0"
          >
            <span class="material-symbols-outlined icon-xs"> lock </span>
          </button>
          <span></span>
        </div>
      </div>
    `;
  }
}
