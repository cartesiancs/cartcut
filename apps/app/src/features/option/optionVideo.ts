import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { VideoElementType } from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { addKeyframe, setTrackActive } from "../animation/keyframeOps";
import { setIn } from "../../utils/immutable";
import { GestureCommit } from "./gestureCommit";

@customElement("option-video")
export class OptionVideo extends LitElement {
  elementId: string;
  enableFilter: boolean;
  filterList: any[];
  constructor() {
    super();

    this.elementId = "";
    this.enableFilter = false;
    this.filterList = [];
    this.hide();
  }

  private lc = new LocaleController(this);
  private keyframeControl = new KeyframeController(this);
  /** Coalesces a spinner scrub into a single undo step. */
  private gesture = new GestureCommit();

  @property()
  timelineState: any = useTimelineStore.getInitialState();

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  timeline = this.timelineState.timeline;

  @property()
  isShow = false;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;
    });

    return this;
  }

  render() {
    const filterListRender: any = [];

    for (let index = 0; index < this.filterList.length; index++) {
      const element = this.filterList[index];
      filterListRender.push(html`<div class="d-flex col-12">
        <select
          @change=${(e) => this.handleChangeUpdateKey(e, index)}
          class="form-select bg-dark text-light form-select-sm"
          aria-label="select screen"
          style="
              height: fit-content;
          "
        >
          <option value="chromakey">Chroma Key</option>
          <option value="blur">Blur</option>
          <option value="radialblur">Radial Blur</option>
        </select>

        <input
          @change=${(e) => this.handleChangeUpdateBlur(e, index)}
          type="number"
          class="form-control bg-default text-light ${this.filterList[index]
            .name == "radialblur"
            ? ""
            : "d-none"}"
          value="0"
        />

        <input
          @change=${(e) => this.handleChangeUpdateBlur(e, index)}
          type="number"
          class="form-control bg-default text-light ${this.filterList[index]
            .name == "blur"
            ? ""
            : "d-none"}"
          value="5"
        />

        <div class="d-flex row gap-2">
          <input
            @change=${(e) => this.handleChangeUpdateChromakey(e, index)}
            type="color"
            aria-event="chromakey_color_${index}"
            class="form-control bg-default text-light ${this.filterList[index]
              .name == "chromakey"
              ? ""
              : "d-none"}"
            value="#000000"
          />

          <div
            class="input-group mb-3 ${this.filterList[index].name == "chromakey"
              ? ""
              : "d-none"}"
          >
            <span
              class="input-group-text bg-default text-light"
              id="basic-addon2"
              >f</span
            >
            <input
              @change=${(e) => this.handleChangeUpdateChromakey(e, index)}
              type="number"
              aria-event="chromakey_force_${index}"
              class="form-control bg-default text-light"
              value="0.5"
              step="0.01"
              max="1"
              max="min"
            />
          </div>
        </div>
      </div>`);
    }

    return html`
      <default-transform
        .elementId=${this.elementId}
        .timeline=${this.timeline}
        .timelineCursor=${this.timelineCursor}
        .timelineState=${this.timelineState}
        .isShow=${this.isShow}
      ></default-transform>

      <button
        type="button"
        class="btn btn-sm mb-2 ${this.enableFilter
          ? "btn-primary"
          : "btn-default"}  text-light"
        @click=${this.handleClickEnableFilter}
      >
        ${!this.enableFilter ? "Enable" : "Disable"} Filter
      </button>

      <div class="mb-4 ${this.enableFilter ? "" : "d-none"}">
        <label class="form-label text-light">Filter List</label>
        <div class="d-flex row gap-2">${filterListRender}</div>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light ${this.filterList
            .length >= 1
            ? "d-none"
            : ""}"
          @click=${this.handleClickAddFilter}
        >
          Add Filter
        </button>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light ${this.filterList
            .length == 1
            ? ""
            : "d-none"}"
          @click=${this.handleClickRemoveFilter}
        >
          Remove Filter
        </button>
      </div>

      <div class="mb-4">
        <label class="form-label text-light">Animate Preset</label>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light"
          @click=${() =>
            this.handleClickAddAnimatePreset(0, 0, 250, 100, "opacity")}
        >
          Fade In
        </button>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light"
          @click=${() =>
            this.handleClickAddAnimatePreset(0, 10, 250, 12, "scale")}
        >
          Zoom In
        </button>
      </div>

      <!-- <div class="mb-2">
        <label class="form-label text-light">Speed</label>
        <input
          @change=${this.updateSpeed}
          aria-event="speed"
          type="number"
          class="form-control bg-default text-light"
          value="1"
          min="0.5"
          max="2"
        />
      </div> -->
    `;
  }

  hide() {
    this.classList.add("d-none");
    this.isShow = false;
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  isExistElement(elementId) {
    return this.timeline.hasOwnProperty(elementId);
  }

  setElementId({ elementId }) {
    const state = useTimelineStore.getState();
    const timeline = state.timeline as any;

    this.elementId = elementId;
    this.enableFilter = timeline[this.elementId].filter.enable;
    this.filterList = timeline[this.elementId].filter.list;

    this.requestUpdate();
  }

  updateSpeed() {
    const speed = this.querySelector("input[aria-event='speed'") as any;

    this.timelineState.updateTimeline(
      this.elementId,
      ["speed"],
      parseFloat(speed.value),
    );
  }

  hexToRgb(hex) {
    hex = hex.replace(/^#/, "");

    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }

    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

    return { r, g, b };
  }

  handleChangeUpdateKey(e, index) {
    console.log(e.target.value);
    this.filterList[index].name = e.target.value;
    document.querySelector("preview-canvas").setChangeFilter();

    this.requestUpdate();
  }

  handleChangeUpdateBlur(e, index) {
    const value = parseFloat(e.target.value);
    const valueArray = [`f=${value}`];
    this.filterList[index].value = valueArray.join(":");
    document.querySelector("preview-canvas").setChangeFilter();

    this.requestUpdate();
  }

  handleChangeUpdateChromakey(e, index) {
    const color = this.querySelector(
      `input[aria-event='chromakey_color_${index}'`,
    ) as any;
    const force = this.querySelector(
      `input[aria-event='chromakey_force_${index}'`,
    ) as any;

    const rgb = this.hexToRgb(color.value);
    const f = parseFloat(force.value);
    console.log(f, "FFFFFFFF");
    const valueArray = [`r=${rgb.r}`, `g=${rgb.g}`, `b=${rgb.b}`, `f=${f}`];
    this.filterList[index].value = valueArray.join(":");
    document.querySelector("preview-canvas").setChangeFilter();

    this.requestUpdate();
  }

  handleClickAddFilter() {
    const state = useTimelineStore.getState();
    const element = state.timeline[this.elementId];
    if (element.filetype !== "video") {
      return;
    }
    const filterList = element.filter?.list;

    filterList?.push({
      name: "chromakey",
      value: "r=0:g=0:b=0:r=0.5",
    });

    this.timelineState.updateTimeline(
      this.elementId,
      ["filter", "list"],
      filterList,
    );

    this.filterList = filterList as any;

    document.querySelector("preview-canvas").setChangeFilter();

    this.requestUpdate();
  }

  handleClickRemoveFilter() {
    this.timelineState.updateTimeline(this.elementId, ["filter", "list"], []);

    this.filterList = [];

    document.querySelector("preview-canvas").setChangeFilter();

    this.requestUpdate();
  }

  /**
   * Apply an animation preset — a fade in, a scale up — as one undo step.
   *
   * Three writes used to make this up: an in-place `isActivate = true` on the
   * store snapshot, two `addPoint` calls, and a `patchTimeline` that recorded no
   * history. Undoing a preset was impossible, and the in-place write reached
   * back into every history entry that shared the element.
   */
  handleClickAddAnimatePreset(ax, ay, bx, by, type) {
    const elementId = this.elementId;
    useTimelineStore.getState().withCheckpoint((doc) => {
      let next = setTrackActive(doc, elementId, type, true);
      next = addKeyframe(next, elementId, type, "x", ax, ay);
      next = addKeyframe(next, elementId, type, "x", bx, by);
      return next;
    });

    this.requestUpdate();
  }

  handleClickEnableFilter() {
    const state = useTimelineStore.getState();
    const element = state.timeline[this.elementId];
    if (element.filetype !== "video") {
      return;
    }
    const enableFilter = element.filter?.enable;

    this.enableFilter = !enableFilter;

    this.timelineState.updateTimeline(
      this.elementId,
      ["filter", "enable"],
      !enableFilter,
    );

    this.requestUpdate();
  }

  handleLocation() {
    const xDom: any = this.querySelector(
      "number-input[aria-event='location-x'",
    );
    const yDom: any = this.querySelector(
      "number-input[aria-event='location-y'",
    );

    const x = parseFloat(parseFloat(xDom.value).toFixed(2));
    const y = parseFloat(parseFloat(yDom.value).toFixed(2));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    // The static location and, when position is animated, the keyframe at the
    // playhead, as a single undo step. `addAnimationPoint` used to record the
    // keyframes through one path and the location through another — an
    // in-place write plus `patchTimeline`, which keeps no history at all.
    const elementId = this.elementId;
    const startTime = this.timeline[elementId].startTime;
    const atMs = this.timelineCursor - startTime;

    // One step per scrub, not per mousemove: `number-input` dispatches
    // `onChange` on every pointer move, and a checkpoint each would evict the
    // whole undo stack on a single drag.
    this.gesture.apply((doc) => {
      let next = doc;
      if ((next.elements[elementId] as any)?.animation?.position?.isActivate) {
        next = addKeyframe(next, elementId, "position", "x", atMs, x);
        next = addKeyframe(next, elementId, "position", "y", atMs, y);
      }
      const element = next.elements[elementId];
      if (element == null) {
        return next;
      }
      return {
        ...next,
        elements: {
          ...next.elements,
          [elementId]: setIn(element, ["location"], { x, y }),
        },
      };
    });

    this.requestUpdate();
  }
}
