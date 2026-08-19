// position, rotation, opacity, scale, width, height
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { KeyframeController } from "../../controllers/keyframe";
import {
  sampleTrack,
  sampleTrackXY,
} from "../animation/keyframes";
import { addKeyframe } from "../animation/keyframeOps";
import { setIn } from "../../utils/immutable";
import { GestureCommit } from "./gestureCommit";
import type { AnimatableProperty } from "../../@types/timeline";
import "../filter/backgroundRemove";

@customElement("default-transform")
export class OptionImage extends LitElement {
  private lc = new LocaleController(this);
  private keyframeControl = new KeyframeController(this);
  /** Coalesces a spinner scrub into a single undo step. */
  private gesture = new GestureCommit();

  @property()
  elementId;

  @property()
  timeline;

  @property()
  timelineCursor;

  @property()
  timelineState;

  @property()
  isShow;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      if (this.isExistElement(this.elementId) && this.isShow) {
        this.updateValue();
      }
    });

    return this;
  }

  constructor() {
    super();
  }

  render() {
    return html`
      <label class="form-label text-light"
        >${this.lc.t("setting.position")}</label
      >
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div class="d-flex flex-row gap-2 justify-content-start">
          <number-input
            aria-event="location-x"
            @onChange=${this.handleLocation}
            value="0"
          ></number-input>
          <number-input
            aria-event="location-y"
            @onChange=${this.handleLocation}
            value="0"
          ></number-input>
        </div>
        <div class="d-flex flex-row gap-2 justify-content-end">
          <button
            class="btn btn-xxs text-light mr-2"
            @click=${() => this.setAnimationEnable("position")}
          >
            <span
              class="material-symbols-outlined icon-xsm ${this.getAnimationEnable(
                "position",
              )
                ? "text-light"
                : "text-secondary"}"
            >
              stat_0
            </span>
          </button>
        </div>
      </div>

      <label class="form-label text-light">Size</label>
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div class="d-flex flex-row gap-2 justify-content-start">
          <number-input
            aria-event="width"
            @onChange=${this.handleSize}
            value="10"
          ></number-input>
          <number-input
            aria-event="height"
            @onChange=${this.handleSize}
            value="10"
          ></number-input>
        </div>
        <div class="d-flex flex-row gap-2 justify-content-end"></div>
      </div>

      <label class="form-label text-light"
        >${this.lc.t("setting.opacity")}</label
      >
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div class="d-flex flex-row gap-2 justify-content-start">
          <number-input
            aria-event="opacity"
            @onChange=${this.handleOpacity}
            value="100"
            max="100"
          ></number-input>
        </div>
        <div class="d-flex flex-row gap-2 justify-content-end">
          <button
            class="btn btn-xxs text-light mr-2"
            @click=${() => this.setAnimationEnable("opacity")}
          >
            <span
              class="material-symbols-outlined icon-xsm ${this.getAnimationEnable(
                "opacity",
              )
                ? "text-light"
                : "text-secondary"}"
            >
              stat_0
            </span>
          </button>
        </div>
      </div>

      <label class="form-label text-light">Rotation</label>
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div class="d-flex flex-row gap-2 justify-content-start">
          <number-input
            aria-event="rotation"
            @onChange=${this.handleRotation}
            value="0"
          ></number-input>
        </div>
        <div class="d-flex flex-row gap-2 justify-content-end">
          <button
            class="btn btn-xxs text-light mr-2"
            @click=${() => this.setAnimationEnable("rotation")}
          >
            <span
              class="material-symbols-outlined icon-xsm ${this.getAnimationEnable(
                "rotation",
              )
                ? "text-light"
                : "text-secondary"}"
            >
              stat_0
            </span>
          </button>
        </div>
      </div>
    `;
  }

  isExistElement(elementId) {
    return this.timeline.hasOwnProperty(elementId);
  }

  updateValue() {
    const xDom: any = this.querySelector(
      "number-input[aria-event='location-x'",
    );
    const yDom: any = this.querySelector(
      "number-input[aria-event='location-y'",
    );
    const opacityDom: any = this.querySelector(
      "number-input[aria-event='opacity'",
    );
    const rotationDom: any = this.querySelector(
      "number-input[aria-event='rotation'",
    );
    const width: any = this.querySelector("number-input[aria-event='width'");
    const height: any = this.querySelector("number-input[aria-event='height'");

    const position = this.getPosition();
    const opacity = this.getOpacity();
    const rotation = this.getRotation();

    xDom.value = position.x;
    yDom.value = position.y;
    opacityDom.value = opacity.x;
    rotationDom.value = rotation.x;
    width.value = this.timeline[this.elementId].width;
    height.value = this.timeline[this.elementId].height;
  }

  /**
   * The value a property shows right now, animated or not.
   *
   * These six methods used to carry their own copy of the nearest-neighbour
   * scan, plus a dead `index`/`indexToMs`/`indexPoint` triple copied from the
   * renderer's sampler, plus a `try`/`catch` swallowing whatever went wrong.
   * The copy also read `ax || location.x`, so an animated value of exactly 0 —
   * the left edge, fully transparent, no rotation — was falsy and silently
   * showed the static value instead. `sampleTrack` uses `??`.
   */
  private track(animationType: string) {
    return this.timeline?.[this.elementId]?.animation?.[animationType];
  }

  private isAnimated(animationType: string): boolean {
    return this.track(animationType)?.isActivate === true;
  }

  getOpacity() {
    const fallback = this.timeline[this.elementId].opacity;
    if (!this.isAnimated("opacity")) {
      return { x: fallback };
    }
    return {
      x: sampleTrack(
        this.track("opacity"),
        this.timeline[this.elementId].startTime,
        this.timelineCursor,
        fallback,
      ),
    };
  }

  getRotation() {
    const fallback = this.timeline[this.elementId].rotation;
    if (!this.isAnimated("rotation")) {
      return { x: fallback };
    }
    return {
      x: sampleTrack(
        this.track("rotation"),
        this.timeline[this.elementId].startTime,
        this.timelineCursor,
        fallback,
      ),
    };
  }

  getPosition() {
    const location = this.timeline[this.elementId].location ?? { x: 0, y: 0 };
    if (!this.isAnimated("position")) {
      return { x: location.x, y: location.y };
    }
    return sampleTrackXY(
      this.track("position"),
      this.timeline[this.elementId].startTime,
      this.timelineCursor,
      location.x,
      location.y,
    );
  }

  getAnimationEnable(animationType): boolean {
    return this.track(animationType)?.isActivate === true;
  }

  /**
   * Toggle a property's animation.
   *
   * Turning it on seeds one keyframe at the playhead from the element's current
   * static value, so the element does not jump the moment animation is enabled.
   * `appendFirstAnimation`, which used to do that by mutating the store
   * snapshot, now lives in `keyframeOps.setTrackActive` where it is pure and
   * covered.
   */
  setAnimationEnable(animationType) {
    const element = this.timeline?.[this.elementId];
    if (element == null) {
      return;
    }
    this.keyframeControl.setActive({
      elementId: this.elementId,
      animationType,
      active: !this.getAnimationEnable(animationType),
      atMs: this.timelineCursor - element.startTime,
    });
    this.requestUpdate();
  }

  /**
   * Commit a value change from a number input as one undo step.
   *
   * The static field and, when the property is animated, the keyframe at the
   * playhead move together, and the whole scrub of the spinner is one step.
   * `number-input` fires `onChange` on every mousemove, so committing per event
   * would evict the entire undo stack on a single drag; `GestureCommit`
   * previews until the gesture settles and then records once.
   *
   * The four handlers below used to do neither — they assigned straight into
   * the store snapshot and called `patchTimeline`, which records no history at
   * all and, because history entries share their nested objects, rewrote the
   * past as well.
   */
  private commitValue(
    statics: Array<{ path: string[]; value: any }>,
    keyframes: Array<{ animationType: AnimatableProperty; lane: 0 | 1; value: number }> = [],
  ) {
    const elementId = this.elementId;
    const element = this.timeline?.[elementId];
    if (element == null) {
      return;
    }
    const atMs = this.timelineCursor - element.startTime;

    this.gesture.apply((doc) => {
      let next = doc;

      for (const { animationType, lane, value } of keyframes) {
        if (next.elements[elementId]?.["animation"]?.[animationType]?.isActivate !== true) {
          continue;
        }
        next = addKeyframe(
          next,
          elementId,
          animationType,
          lane === 1 ? "y" : "x",
          atMs,
          value,
        );
      }

      for (const { path, value } of statics) {
        const current = next.elements[elementId];
        if (current == null) {
          continue;
        }
        next = {
          ...next,
          elements: {
            ...next.elements,
            [elementId]: setIn(current, path, value),
          },
        };
      }

      return next;
    });
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

    this.commitValue(
      [{ path: ["location"], value: { x, y } }],
      [
        { animationType: "position", lane: 0, value: x },
        { animationType: "position", lane: 1, value: y },
      ],
    );
  }

  handleOpacity() {
    const dom: any = this.querySelector("number-input[aria-event='opacity'");
    const opacity = parseInt(dom.value);
    if (!Number.isFinite(opacity)) {
      return;
    }
    this.commitValue(
      [{ path: ["opacity"], value: opacity }],
      [{ animationType: "opacity", lane: 0, value: opacity }],
    );
  }

  handleRotation() {
    const dom = this.querySelector(
      "number-input[aria-event='rotation'",
    ) as any;
    const rotation = parseInt(dom.value);
    if (!Number.isFinite(rotation)) {
      return;
    }
    this.commitValue(
      [{ path: ["rotation"], value: rotation }],
      [{ animationType: "rotation", lane: 0, value: rotation }],
    );
  }

  handleSize() {
    const width: any = this.querySelector("number-input[aria-event='width'");
    const height: any = this.querySelector("number-input[aria-event='height'");

    const w = parseFloat(width.value);
    const h = parseFloat(height.value);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      return;
    }

    // Size carries no animation track, so this is a plain value change.
    this.commitValue([
      { path: ["width"], value: w },
      { path: ["height"], value: h },
    ]);
  }
}
