import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { VideoElementType } from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { addKeyframe } from "../animation/keyframeOps";
import { applyPreset, type PresetName } from "../animation/presets";
import { bakeRateFor } from "../animation/keyframes";
import { renderOptionStore } from "../../states/renderOptionStore";
import { setIn } from "../../utils/immutable";
import { GestureCommit } from "./gestureCommit";
import { isAudibleElement } from "../timeline/audio";
import {
  filterOf,
  isFilterEnabled,
  setFilterEnabled,
  setVideoFilter,
} from "../timeline/filterOps";
import type { FilterInput } from "../renderer/filter/params";
import "./controlAudioVolume";
import "./controlBlendMode";
import "./controlClipSpeed";
import "./optionLutSection";
import "./optionMaskSection";
import "./animationPresetBrowser";
import "./optionTabBar";
import type { OptionTab } from "./optionTabBar";

@customElement("option-video")
export class OptionVideo extends LitElement {
  elementId: string;
  constructor() {
    super();

    this.elementId = "";
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

  /**
   * Which pane is showing. Component state, not document state: it is where the
   * user is looking, not something about the clip, and it must not survive into
   * the project file or cost an undo step.
   */
  @property()
  tab: OptionTab = "media";

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;
    });

    return this;
  }

  render() {
    // Read from the store rather than from a cached copy, so the panel follows
    // an undo, or an edit the agent made, without being told to.
    const filter = this.filter;
    const isChromakey = filter?.name === "chromakey";

    // Every field binds with `.value`, not a `value` attribute. The attribute
    // is a *default* that lit sets once, so the controls used to show
    // "Chroma Key" and the hardcoded defaults no matter what the clip carried.
    const filterEditor =
      filter == null
        ? ""
        : html`<div class="d-flex col-12">
            <select
              @change=${this.handleChangeFilterName}
              .value=${filter.name}
              class="form-select bg-dark text-light form-select-sm"
              aria-label="select screen"
              aria-event="filter_name"
              style="
              height: fit-content;
          "
            >
              <option value="chromakey">Chroma Key</option>
              <option value="blur">Blur</option>
              <option value="radialblur">Radial Blur</option>
            </select>

            <!-- One field for both blurs. They were two inputs differing only
                 in which one carried d-none, which is how the hidden one kept
                 whatever had last been typed into it. -->
            <input
              @change=${this.handleChangeStrength}
              type="number"
              aria-event="filter_strength"
              min="0"
              step="1"
              class="form-control bg-default text-light ${isChromakey
                ? "d-none"
                : ""}"
              .value=${String(filter.strength ?? "")}
            />

            <div class="d-flex row gap-2 ${isChromakey ? "" : "d-none"}">
              <input
                @change=${this.handleChangeChromakey}
                type="color"
                aria-event="chromakey_color"
                class="form-control bg-default text-light"
                .value=${filter.color ?? "#000000"}
              />

              <div class="input-group mb-3">
                <span
                  class="input-group-text bg-default text-light"
                  id="basic-addon2"
                  >f</span
                >
                <input
                  @change=${this.handleChangeChromakey}
                  type="number"
                  aria-event="chromakey_force"
                  class="form-control bg-default text-light"
                  .value=${String(filter.threshold ?? "")}
                  step="0.01"
                  min="0"
                  max="1"
                />
              </div>
            </div>
          </div>`;

    return html`
      <option-tab-bar
        .active=${this.tab}
        @tab-change=${(e: CustomEvent<OptionTab>) => {
          this.tab = e.detail;
        }}
      ></option-tab-bar>

      <!--
        Every pane stays mounted; only one is shown. See optionTabBar.ts - the
        controls inside subscribe to the document when they mount, and toggling
        would otherwise drop and re-add those subscriptions on every click.
      -->
      <div class=${this.tab === "mask" ? "" : "d-none"}>
        <option-mask-section
          .elementIds=${[this.elementId]}
        ></option-mask-section>
      </div>

      <div class=${this.tab === "animation" ? "" : "d-none"}>
        <animation-preset-browser
          .elementIds=${[this.elementId]}
        ></animation-preset-browser>
      </div>

      <div class=${this.tab === "media" ? "" : "d-none"}>
      <default-transform
        .elementId=${this.elementId}
        .timeline=${this.timeline}
        .timelineCursor=${this.timelineCursor}
        .timelineState=${this.timelineState}
        .isShow=${this.isShow}
      ></default-transform>

      <audio-volume
        class=${this.hasAudio() ? "" : "d-none"}
        .elementId=${this.elementId}
        .isShow=${this.isShow && this.hasAudio()}
      ></audio-volume>

      <!--
        Between the level and the appearance rows, because speed is the one
        property here that reaches both halves of the clip: it resizes the
        picture on the timeline and retimes the sound with it.
      -->
      <clip-speed
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></clip-speed>

      <blend-mode
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></blend-mode>

      <!--
        Next to the blend mode, because the two are the same question asked
        twice: how this clip's picture is changed before it meets the scene,
        and how it meets it. Picking *which* filter happens in the Filter tab
        against thumbnails; what belongs here is how strongly it applies.
      -->
      <option-lut-section .elementId=${this.elementId}></option-lut-section>

      <button
        type="button"
        class="btn btn-sm mb-2 mt-2 ${this.enableFilter
          ? "btn-primary"
          : "btn-default"}  text-light"
        @click=${this.handleClickEnableFilter}
      >
        ${!this.enableFilter ? "Enable" : "Disable"} Filter
      </button>

      <div class="mb-4 ${this.enableFilter ? "" : "d-none"}">
        <label class="form-label text-light">Filter List</label>
        <div class="d-flex row gap-2">${filterEditor}</div>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light ${filter == null
            ? ""
            : "d-none"}"
          @click=${this.handleClickAddFilter}
        >
          Add Filter
        </button>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light ${filter == null
            ? "d-none"
            : ""}"
          @click=${this.handleClickRemoveFilter}
        >
          Remove Filter
        </button>
      </div>

      <!-- <div class="mb-4">
        <label class="form-label text-light">Animate Preset</label>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light"
          @click=${() => this.handleClickAddAnimatePreset("fade_in")}
        >
          Fade In
        </button>

        <button
          type="button"
          class="btn btn-sm mt-2 w-100 bg-dark text-light"
          @click=${() => this.handleClickAddAnimatePreset("zoom_in")}
        >
          Zoom In
        </button>
      </div> -->

      </div>
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

  /**
   * Whether this clip has a level worth setting.
   *
   * Reuses `isAudibleElement` rather than re-deriving
   * `isExistAudio && !audioDetached`, which would make a fourth place that has
   * to agree with it — and gets the detached case right for free: once the
   * sound belongs to the twin clip, a fader here would do nothing.
   */
  private hasAudio(): boolean {
    return isAudibleElement(this.timeline?.[this.elementId]);
  }

  setElementId({ elementId }) {
    this.elementId = elementId;
    this.requestUpdate();
  }

  /** Whether this clip's filters are switched on, per the store. */
  private get enableFilter(): boolean {
    return isFilterEnabled(
      useTimelineStore.getState().timeline[this.elementId],
    );
  }

  /**
   * The filter this clip carries, structured, or `null` for none.
   *
   * Derived on every render rather than cached in a field. The field used to be
   * assigned the store's own `filter.list` array, which the handlers then wrote
   * to in place — on an object every undo entry shares, so editing a filter
   * silently rewrote the history behind it.
   */
  private get filter(): FilterInput | null {
    return filterOf(useTimelineStore.getState().timeline[this.elementId]);
  }

  /**
   * Apply a filter edit as one undo step.
   *
   * No repaint call is needed and none should be added back. `preview-canvas`
   * subscribes to the store and redraws on every change, and the WebGL pipeline
   * reads `element.filter` per frame — so writing to the store *is* the
   * repaint. The `preview-canvas.setChangeFilter()` these handlers used to call
   * has not existed since the renderer was replaced, and threw every time.
   */
  private commitFilter(filter: FilterInput | null) {
    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setVideoFilter(doc, elementId, filter));

    this.requestUpdate();
  }

  /**
   * Switch to another kind of filter.
   *
   * The new filter is built from its *name alone*, so its parameters are seeded
   * fresh. Carrying the old string across is what made this the bug it was:
   * `value` is positional `k=v:k=v` whose keys differ per filter, so a blur's
   * `f=5` read as a chromakey threshold keys out every pixel and the clip
   * vanishes.
   */
  handleChangeFilterName(e) {
    // A `change` that names the filter already showing is not an edit — and
    // building a fresh one would throw away the colour and threshold beside it.
    // A `<select>` does not fire on re-picking the same option, so this guards
    // the programmatic path rather than a click.
    if (e.target.value === this.filter?.name) {
      return;
    }
    this.commitFilter({ name: e.target.value });
  }

  handleChangeStrength(e) {
    const raw = parseFloat(e.target.value);
    if (!Number.isFinite(raw)) {
      return;
    }
    // The shaders read the strength with `parseInt`, so storing 8.7 would
    // display as 8 on the next render and never settle.
    const strength = Math.max(0, Math.round(raw));
    this.commitFilter({ name: this.filter?.name ?? "blur", strength });
  }

  handleChangeChromakey() {
    const color = this.querySelector(
      "input[aria-event='chromakey_color']",
    ) as HTMLInputElement | null;
    const force = this.querySelector(
      "input[aria-event='chromakey_force']",
    ) as HTMLInputElement | null;

    const threshold = parseFloat(force?.value ?? "");
    this.commitFilter({
      name: "chromakey",
      color: color?.value ?? "#000000",
      // `max="1"` on the input is not enforced for a typed value, and a
      // threshold above 1 keys out the whole frame.
      threshold: Number.isFinite(threshold)
        ? Math.min(1, Math.max(0, threshold))
        : undefined,
    });
  }

  handleClickAddFilter() {
    this.commitFilter({ name: "chromakey" });
  }

  handleClickRemoveFilter() {
    this.commitFilter(null);
  }

  /**
   * Apply an animation preset — a fade in, a scale up — as one undo step.
   *
   * Three writes used to make this up: an in-place `isActivate = true` on the
   * store snapshot, two `addPoint` calls, and a `patchTimeline` that recorded no
   * history. Undoing a preset was impossible, and the in-place write reached
   * back into every history entry that shared the element.
   */
  handleClickAddAnimatePreset(preset: PresetName) {
    const elementId = this.elementId;
    // Baked at the project's own rate, not the 60Hz default: a 120fps project
    // would otherwise hand two consecutive frames the same value and the preset
    // would visibly run at half speed until the file was reloaded.
    const bakeHz = bakeRateFor(renderOptionStore.getState().options.fps);
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        applyPreset(doc, elementId, preset, 250, bakeHz),
      );

    this.requestUpdate();
  }

  /**
   * Switch the clip's filters on or off.
   *
   * Through `withCheckpoint` rather than `updateTimeline`, which records no
   * history at all — so turning a chromakey on used to be an edit Cmd+Z could
   * not take back. The parameters stay put underneath, which is what makes the
   * button usable as an A/B against the original.
   */
  handleClickEnableFilter() {
    const elementId = this.elementId;
    const enable = !this.enableFilter;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setFilterEnabled(doc, elementId, enable));

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
