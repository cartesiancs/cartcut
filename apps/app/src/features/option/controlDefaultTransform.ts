// position, rotation, opacity, scale, width, height
import { LitElement, PropertyValues, html } from "lit";
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
import { withFittedTextHeights } from "../element/textFit";
import type { AnimatableProperty } from "../../@types/timeline";
import "../filter/backgroundRemove";
import "./controlParent";

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
      if (this.isExistElement(this.targetId) && this.isShow) {
        this.updateValue();
      }
    });

    return this;
  }

  constructor() {
    super();
  }

  /**
   * The clip these fields act on.
   *
   * Two shapes arrive on `elementId`. `option-image`, `option-video`,
   * `option-shape` and `option-groupelement` pass a bare id; `option-text`
   * passes the whole selection as an array, because
   * `elementTimelineCanvas.showSideOption` routes *every* text selection —
   * single included — through `showOptions`.
   *
   * A one-element array used to work by accident: `timeline[["a"]]` coerces the
   * key to `"a"`. A two-element one becomes `"a,b"`, which names nothing, so
   * `updateValue` was skipped and every handler below declined in silence.
   * Normalising once, here, is what makes the "single-element only" contract
   * `controlParent.ts` states true rather than accidental.
   *
   * Empty means nothing is selected, the same sentinel `parent-select` uses.
   * `timeline[""]` is undefined, so every `isExistElement` and `element == null`
   * guard below already reads it as "no clip" — and a `string` keeps it out of
   * the computed keys and index expressions those guards protect.
   */
  private get targetId(): string {
    const id: any = this.elementId;
    return (Array.isArray(id) ? id[0] : id) ?? "";
  }

  /**
   * Re-read the fields when the panel is pointed at a different clip.
   *
   * `updateValue` is the only thing that writes these inputs, and its other
   * caller is a *timeline store* subscription — but selecting a clip changes
   * `selectionStore`, which that subscription never hears. The one notification
   * a click does produce is `setCursorType("pointer")` at the top of
   * `elementTimelineCanvas._handleMouseDown`, and it fires *before*
   * `showSideOption` swaps `elementId`, so it refreshes the boxes with the
   * outgoing clip's numbers.
   *
   * The result was a panel showing the previously selected clip's position while
   * a new one was selected — most visible right after a duplicate, where the
   * copy starts at the original's coordinates and the two look linked.
   *
   * `optionText.resetValue` already does exactly this for the font fields; this
   * is the missing half of it. Runs after render, so the inputs exist.
   */
  updated(changed: PropertyValues) {
    if (!changed.has("elementId") && !changed.has("isShow")) {
      return;
    }
    if (this.isExistElement(this.targetId) && this.isShow) {
      this.updateValue();
    }
  }

  render() {
    return html`
      <!--
        Above Position deliberately: the parent decides which space every
        number below it is written in, so reading the panel top to bottom reads
        the transform in the order it is composed. The control renders nothing
        at all when there is no group to pick, so a project that has never made
        one sees the panel exactly as it was before.

        No backticks in here: this comment sits inside a lit template literal,
        and one would end it.
      -->
      <parent-select
        .elementId=${this.targetId}
        .isShow=${this.isShow}
      ></parent-select>
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
        <div class="d-flex flex-row gap-2 justify-content-end">
          <button
            class="btn btn-xxs text-light mr-2"
            @click=${() => this.setAnimationEnable("size")}
          >
            <span
              class="material-symbols-outlined icon-xsm ${this.getAnimationEnable(
                "size",
              )
                ? "text-light"
                : "text-secondary"}"
            >
              stat_0
            </span>
          </button>
        </div>
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
    // Guarded now that `updated` calls this too: that runs on the first render,
    // which can land before the parent has bound `timeline`. An empty id — the
    // "nothing selected" sentinel — falls out on its own, since no clip is
    // filed under it.
    return this.timeline?.hasOwnProperty(elementId) === true;
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
    const size = this.getSize();
    width.value = size.x;
    height.value = size.y;
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
    return this.timeline?.[this.targetId]?.animation?.[animationType];
  }

  private isAnimated(animationType: string): boolean {
    return this.track(animationType)?.isActivate === true;
  }

  getOpacity() {
    const fallback = this.timeline[this.targetId].opacity;
    if (!this.isAnimated("opacity")) {
      return { x: fallback };
    }
    return {
      x: sampleTrack(
        this.track("opacity"),
        this.timeline[this.targetId].startTime,
        this.timelineCursor,
        fallback,
      ),
    };
  }

  getRotation() {
    const fallback = this.timeline[this.targetId].rotation;
    if (!this.isAnimated("rotation")) {
      return { x: fallback };
    }
    return {
      x: sampleTrack(
        this.track("rotation"),
        this.timeline[this.targetId].startTime,
        this.timelineCursor,
        fallback,
      ),
    };
  }

  getPosition() {
    const location = this.timeline[this.targetId].location ?? { x: 0, y: 0 };
    if (!this.isAnimated("position")) {
      return { x: location.x, y: location.y };
    }
    return sampleTrackXY(
      this.track("position"),
      this.timeline[this.targetId].startTime,
      this.timelineCursor,
      location.x,
      location.y,
    );
  }

  getSize() {
    const element = this.timeline[this.targetId];
    if (!this.isAnimated("size")) {
      return { x: element.width, y: element.height };
    }
    // The number in the box is the number on the canvas. Showing the static
    // field while a track drives the picture is how the panel ends up
    // disagreeing with the preview, and then a scrub of the spinner writes a
    // keyframe carrying a value the user never saw.
    return sampleTrackXY(
      this.track("size"),
      element.startTime,
      this.timelineCursor,
      element.width,
      element.height,
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
    const elementId = this.targetId;
    const element = this.timeline?.[elementId];
    if (element == null) {
      return;
    }
    this.keyframeControl.setActive({
      elementId,
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
    const elementId = this.targetId;
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

    // Rounded the way `handleLocation` rounds, and now for a second reason:
    // with `size` animated these fields show a *sampled* value, and a baked
    // sample is a float — committing `249.99999999999997` straight back would
    // write that into the keyframe the user is standing on.
    const w = parseFloat(parseFloat(width.value).toFixed(2));
    const h = parseFloat(parseFloat(height.value).toFixed(2));
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      return;
    }

    // Both fields are written on every change — this handler cannot tell which
    // one the user touched, so it compares against what is stored.
    const widthChanged = this.timeline?.[this.targetId]?.width !== w;

    // The static box and, when `size` is animated, the keyframe at the
    // playhead, as one undo step — exactly what `handleLocation` does for
    // `position`. `commitValue` writes the keyframes only where the track is
    // active, so a clip nobody has animated takes the same path it always did.
    this.commitValue(
      [
        { path: ["width"], value: w },
        { path: ["height"], value: h },
      ],
      [
        { animationType: "size", lane: 0, value: w },
        { animationType: "size", lane: 1, value: h },
      ],
    );

    // A text clip's width is its wrapping width, so changing it changes how
    // many lines there are and the box has to be re-measured. A typed *height*
    // is left exactly as typed: it holds until the next edit that moves the
    // text, which is how an auto-sizing text box behaves everywhere else.
    //
    // `withFittedTextHeights` declines on its own for a clip whose height the
    // size track owns, so there is no second condition here.
    if (widthChanged) {
      const elementId = this.targetId;
      this.gesture.apply((doc) => withFittedTextHeights(doc, [elementId]));
    }
  }
}
