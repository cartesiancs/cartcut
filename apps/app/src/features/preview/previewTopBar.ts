import { emptyAnimation } from "../animation/keyframes";
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import {
  ActiveStringType,
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
import {
  createShapeElement,
  geometryForKind,
} from "../element/shapeElement";
import { createNullElement } from "../element/nullElement";

/** 100% is the fit scale, so it doubles as the "fit" preset. */
const ZOOM_PRESETS = [25, 50, 100, 200, 400, 800];

/**
 * What each tab says. The panel ids are code identifiers ("autoTrack") and
 * used to be printed as they were, beside a docked window's title-cased
 * "Text to Speech" on the same line.
 */
const PANEL_LABELS: Record<ActiveStringType, string> = {
  "": "Preview",
  record: "Record",
  audioRecord: "Audio Record",
  proxy: "Proxy",
  autoTrack: "Auto Track",
};

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

  /**
   * Place a parametric shape at the playhead.
   *
   * Every entry in this menu names a **kind**, so every shape it makes carries
   * a recipe and its options are reachable from the sidebar the moment it
   * lands. The polygon tool is the one entry that does not: it makes an outline
   * by hand and there is no recipe that would describe it.
   *
   * Shape construction lives in `element/shapeElement.ts` so the agent's
   * `add_shape` and this button produce the same element.
   */
  createShape(geometry) {
    const elementId = uuidv4();

    const element = createShapeElement({ geometry });

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

  /**
   * Add an empty null object, centred on the frame and spanning the project.
   *
   * Unlike `createShape` this starts at 0 rather than at the playhead, and the
   * reason is `localSampleAt`: it falls back to the static value for a cursor
   * before an element's `startTime`, so a null seated at the playhead would
   * have its keyframes silently ignored everywhere to the left of it. After
   * Effects seats a new layer at the top of the comp for the same reason.
   *
   * The frame centre and the project length are read *here* and passed in —
   * `nullElement.ts` is a pure factory and does not know the store exists.
   */
  createNull() {
    const elementId = uuidv4();
    const { previewSize, duration } = this.renderOption;

    const element = createNullElement({
      center: { x: Number(previewSize.w) / 2, y: Number(previewSize.h) / 2 },
      // `renderOption.duration` is in seconds.
      duration: duration * 1000,
    });

    this.timelineState.withCheckpoint((doc) =>
      placeNewElement(doc, elementId, element, 0, uuidv4()),
    );
    this.timeline = useTimelineStore.getState().timeline;

    return elementId;
  }

  createSquare() {
    return this.createShape(geometryForKind("rectangle"));
  }

  /**
   * A triangle is a polygon with three points, not a kind of its own.
   *
   * That is Figma's arrangement and the whole reason the vertex count is a
   * number the user can change: with a separate kind, turning this into a
   * pentagon would be a change of kind rather than a change of one field, and
   * the sidebar would have to offer a conversion nobody would look for.
   */
  createTriangle() {
    return this.createShape(geometryForKind("triangle"));
  }

  createCircle() {
    return this.createShape(geometryForKind("ellipse"));
  }

  createStar() {
    return this.createShape(geometryForKind("star"));
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

  /**
   * One tab in the strip.
   *
   * The preview goes through this too, as the `""` panel, so at a narrow width
   * it scrolls and fades with the rest instead of sitting pinned beside a strip
   * that does. It is the one tab with no close, because `""` is where closing
   * any other tab falls back to.
   */
  private _renderTab(panel: ActiveStringType) {
    const label = PANEL_LABELS[panel] ?? panel;
    const on = this.nowActivePanel == panel;
    return html`<button
      type="button"
      data-panel=${panel}
      @click=${() => this._handleClickPanelButton(panel)}
      class="tb-tab ${on ? "is-on" : ""}"
      aria-selected=${on ? "true" : "false"}
    >
      ${label}
      ${panel == ""
        ? ""
        : html`<span
            class="material-symbols-outlined tb-tab-close"
            role="button"
            title="Close ${label}"
            aria-label="Close ${label}"
            @click=${(e: Event) => this._handleClickRemovePanelButton(e, panel)}
            >close</span
          >`}
    </button>`;
  }

  /** A cursor mode in the pointer / text segmented control. */
  private _renderMode(type: string, icon: string, label: string) {
    const on = this.control.cursorType == type;
    return html`<button
      type="button"
      class="tb-seg-item ${on ? "is-on" : ""}"
      title=${label}
      aria-label=${label}
      aria-pressed=${on ? "true" : "false"}
      @click=${() => this._handleClickButton(type)}
    >
      <span class="material-symbols-outlined">${icon}</span>
    </button>`;
  }

  /** One row of the add menu. */
  private _renderAddItem(icon: string, label: string, onClick: () => void) {
    return html`<a
      class="dropdown-item dropdown-item-sm dropdown-item-icon"
      @click=${onClick}
    >
      <span class="material-symbols-outlined">${icon}</span>${label}</a
    >`;
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
    this._syncFocusedTab();
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

  /** The panel `_syncFocusedTab` last scrolled to, so it scrolls once per change. */
  private scrolledForPanel: ActiveStringType | null = null;

  /**
   * Scroll the focused tab into view when the focus moves.
   *
   * This is what replaces the preview button being pinned: the way back to the
   * preview may now scroll away, but clicking it from anywhere brings it back
   * on screen, the same as any other tab. Only on a change of focus, or a user
   * who scrolled the strip by hand would be yanked back on the next unrelated
   * re-render; this component re-renders on every store write.
   */
  private _syncFocusedTab() {
    if (this.scrolledForPanel === this.nowActivePanel) {
      return;
    }
    this.scrolledForPanel = this.nowActivePanel;

    const scroller = this.tabScroller;
    const tab = scroller?.querySelector(
      `[data-panel="${this.nowActivePanel}"]`,
    ) as HTMLElement | null;
    if (!scroller || !tab) {
      return;
    }

    // Measured against the scroller's own box rather than offsetLeft, which is
    // relative to whichever ancestor happens to be positioned.
    const view = scroller.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const left = rect.left - view.left + scroller.scrollLeft;
    const right = left + rect.width;

    // Clear the edge fade, or the tab that was just focused arrives half
    // transparent, which reads as the click having gone somewhere else.
    const fade = 24;

    if (left - fade < scroller.scrollLeft) {
      scroller.scrollLeft = Math.max(0, left - fade);
    } else if (right + fade > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right + fade - scroller.clientWidth;
    }
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
          /* Named for _toolbar.scss, which drops the lesser tools when a
             docked window leaves the column too narrow to hold them all. */
          container: previewbar / inline-size;
        }

        /* min-width: 0 is what lets the strip shrink past its content width;
           without it the flex item stays intrinsically sized and shoves the
           tools on the right off the end of the bar. Carried by the scroller
           itself: every tab including the preview lives inside it, so there is
           nothing left for an outer wrapper to hold. */
        .preview-tab-bar {
          flex: 1 1 auto;
          min-width: 0;
        }

        .preview-tool-bar {
          flex: 0 0 auto;
        }

        /* 2px, not the 0.5rem the filled chips needed: a quiet tab has no box
           of its own to separate, and wider gaps read as three loose words. */
        .preview-tab-scroll {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 2px;
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
      </style>

      <div class="timeline-cursor-buttons bg-darker">
        <!-- The preview is the first tab, not a button beside the strip:
             one row of tabs that all scroll together is the only arrangement
             that still looks like one thing at a few hundred pixels. -->
        <div
          class="preview-tab-bar preview-tab-scroll p-1 ${this.tabOverflowStart
            ? "fade-start"
            : ""} ${this.tabOverflowEnd ? "fade-end" : ""}"
          @scroll=${this._handleTabScroll}
          @wheel=${this._handleTabWheel}
        >
          ${this._renderTab("")}
          ${this.activePanel.map((item) => this._renderTab(item))}
        </div>
        <div class="tb-group p-1 preview-tool-bar">
          <!--
            Pointer and text are a closed choice, so they are one control. The
            polygon tool is a third cursor mode, reached from the add menu, and
            raises the add button while it is engaged. Lock is a fourth and sits
            apart at the end, because it is about the keyboard.
          -->
          <div class="tb-seg" role="group" aria-label="Cursor">
            ${this._renderMode("pointer", "near_me", "Select")}
            ${this._renderMode("text", "text_fields", "Text")}
          </div>

          <div class="dropdown">
            <!--
              classMap, not an interpolated string: Bootstrap keeps the open
              state as a show class on this button as well as on the menu.
              Picking Polygon flips is-on while the menu is open, a string
              binding rewrites the whole attribute and deletes show, and from
              then on Bootstrap's outside click skips the menu (button not
              open) and its toggle refuses to reopen it (menu already open),
              so nothing closes it. classMap adds and removes is-on alone.
            -->
            <button
              type="button"
              class="tb-btn ${classMap({
                "is-on": this.control.cursorType == "shape",
              })}"
              data-bs-toggle="dropdown"
              aria-expanded="false"
              title="Add a shape"
              aria-label="Add a shape"
            >
              <span class="material-symbols-outlined">add</span>
              <span class="material-symbols-outlined tb-caret">expand_more</span>
            </button>

            <ul class="dropdown-menu tb-menu">
              <li>
                ${this._renderAddItem("square", "Square", this.createSquare)}
                ${this._renderAddItem(
                  "change_history",
                  "Triangle",
                  this.createTriangle,
                )}
                ${this._renderAddItem("circle", "Circle", this.createCircle)}
                ${this._renderAddItem("star", "Star", this.createStar)}
                <a
                  class="dropdown-item dropdown-item-sm dropdown-item-icon"
                  @click=${() => this._handleClickButton("shape")}
                >
                  <span class="material-symbols-outlined">polyline</span>
                  <!--
                    Called "Pen Tool" until masks existed, which was the name of
                    a different tool: this one click-appends straight segments
                    to a new *shape element*, and it sits in the create menu
                    beside Square, Triangle and Circle because that is what it
                    makes. The pen in the Mask tab cuts the clip that is already
                    selected and creates nothing. Two tools called a pen is the
                    "two things called a filter" problem, one tab over.
                  -->
                  Polygon${this.control.cursorType == "shape"
                    ? html`<span
                        class="material-symbols-outlined tb-menu-check"
                        >check</span
                      >`
                    : ""}</a
                >
                <hr class="dropdown-divider" />
                <!--
                  Below the divider because it is not a shape: it draws nothing
                  at all. A null is a transform to hang other clips off,
                  attached through the Parent dropdown in the side panel. The
                  same element type "Group selected" produces; this one starts
                  empty.
                -->
                ${this._renderAddItem(
                  "filter_center_focus",
                  "Null Object",
                  this.createNull,
                )}
              </li>
            </ul>
          </div>

          <div class="tb-sep"></div>

          <div class="tb-zoom dropdown">
            <button
              type="button"
              class="tb-zoom-step"
              title="Zoom out"
              aria-label="Zoom out"
              @click=${() => this._handleClickZoom(1 / ZOOM_STEP)}
            >
              <span class="material-symbols-outlined">zoom_out</span>
            </button>

            <button
              type="button"
              class="tb-zoom-value"
              data-bs-toggle="dropdown"
              aria-expanded="false"
              title="Zoom presets"
            >
              ${Math.round(this.viewport.zoom)}%
              <span class="material-symbols-outlined tb-caret">expand_more</span>
            </button>

            <ul class="dropdown-menu tb-menu">
              <li>
                ${ZOOM_PRESETS.map(
                  (zoom) =>
                    html`<a
                      class="dropdown-item dropdown-item-sm dropdown-item-icon"
                      @click=${() => this._handleClickZoomPreset(zoom)}
                    >
                      ${zoom}%${zoom == 100 ? " (Fit)" : ""}${Math.round(
                        this.viewport.zoom,
                      ) == zoom
                        ? html`<span
                            class="material-symbols-outlined tb-menu-check"
                            >check</span
                          >`
                        : ""}
                    </a>`,
                )}
              </li>
            </ul>

            <button
              type="button"
              class="tb-zoom-step"
              title="Zoom in"
              aria-label="Zoom in"
              @click=${() => this._handleClickZoom(ZOOM_STEP)}
            >
              <span class="material-symbols-outlined">zoom_in</span>
            </button>
          </div>

          <button
            type="button"
            class="tb-btn tb-fit"
            title="Fit to frame"
            aria-label="Fit to frame"
            @click=${this._handleClickFit}
          >
            <span class="material-symbols-outlined">fit_screen</span>
          </button>

          <div class="tb-sep"></div>

          <button
            type="button"
            class="tb-btn ${this.control.cursorType == "lockKeyboard"
              ? "is-on"
              : ""}"
            title="Lock keyboard shortcuts"
            aria-label="Lock keyboard shortcuts"
            aria-pressed=${this.control.cursorType == "lockKeyboard"
              ? "true"
              : "false"}
            @click=${() => this._handleClickButton("lockKeyboard")}
          >
            <span class="material-symbols-outlined"
              >${this.control.cursorType == "lockKeyboard"
                ? "lock"
                : "lock_open"}</span
            >
          </button>
        </div>
      </div>
    `;
  }
}
