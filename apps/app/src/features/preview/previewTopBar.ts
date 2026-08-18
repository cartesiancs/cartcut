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

    const width = 100;
    const height = 100;

    this.timeline[elementId] = {
      key: elementId,
      // Both are overwritten by `placeNewElement` below, which picks the track
      // and derives the paint rank from it.
      trackId: "",
      priority: 1,
      blob: "",
      startTime: 0,
      duration: 1000,
      opacity: 100,
      location: { x: 0, y: 0 },
      rotation: 0,
      width: width,
      height: height,
      oWidth: width,
      oHeight: height,
      ratio: width / height,
      filetype: "shape",
      localpath: "SHAPE",
      shape: shape,
      option: {
        fillColor: "#ffffff",
      },
      animation: {
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: [[], []],
          ay: [[], []],
        },
        opacity: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        scale: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        rotation: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
      },
      timelineOptions: {
        color: "rgb(59, 143, 179)",
      },
    };

    const element = this.timeline[elementId];
    delete this.timeline[elementId];
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
    const shape = [
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 0],
    ];

    return this.createShape(shape);
  }

  createTriangle() {
    const shape = [
      [50, 0],
      [0, 100],
      [100, 100],
    ];

    return this.createShape(shape);
  }

  createCircle() {
    const shape: number[][] = [];
    const centerX = 50;
    const centerY = 50;
    const radius = 50;
    const numSegments = 50;

    for (let i = 0; i < numSegments; i++) {
      const angle = (2 * Math.PI * i) / numSegments;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      shape.push([x, y]);
    }

    return this.createShape(shape);
  }

  _handleClickButton(type) {
    this.timelineState.setCursorType(type);
  }

  _handleClickPanelButton(panel) {
    this.controlPanel.setActivePanel(panel);
    console.log("A", panel);
  }

  _handleClickRemovePanelButton(panel) {
    const filter = this.activePanel.filter((item) => {
      return item != panel;
    }) as any;
    this.controlPanel.updatePanel(filter);
    this.controlPanel.setActivePanel("");

    console.log("A", panel);
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
          @click=${() => this._handleClickRemovePanelButton(item)}
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
        <div class="d-flex col gap-2 justify-content-start p-1">
          <button
            @click=${() => this._handleClickPanelButton("")}
            class="btn btn-xxs ${this.nowActivePanel == ""
              ? "btn-active"
              : "btn-default"} text-light preview-top-button m-0"
          >
            preview
          </button>

          ${activePanelMap}
        </div>
        <div class="d-flex col gap-2 justify-content-end p-1">
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
                  (zoom) => html`<a
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
        </div>
      </div>
    `;
  }
}
