/**
 * The Mask pane of a clip's inspector.
 *
 * One component included by all four inspectors that have one, rather than four
 * copies of the same eleven controls — which is what `Maskable` being a mixin
 * over the same five types as `Blendable` and `Gradable` means in the UI, and
 * exactly the argument `optionLutSection` makes for itself.
 *
 * ## Words and icons, no prose
 *
 * A shape is chosen from five icons, not from a dropdown of names: the choice
 * is visual, and a list saying "Heart" is a worse version of a heart. Every
 * other control is one word and a number. There is no explanatory text in here
 * at all, deliberately.
 *
 * ## Every field writes its static value and its keyframe together
 *
 * `commitField` is the pattern `controlDefaultTransform.commitValue`
 * established: the mask field *and*, when that property's track is switched on,
 * a keyframe at the playhead, inside one `GestureCommit`. Doing them separately
 * is what let a scrub record one undo step per mousemove, and what let an
 * active track immediately overwrite the number the user had just typed.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  MASK_SHAPES,
  type AnimatableProperty,
  type MaskShape,
  type MaskType,
  type TimelineElement,
} from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { useTimelineStore } from "../../states/timelineStore";
import { addKeyframe } from "../animation/keyframeOps";
import { maskOf } from "../mask/maskShape";
import {
  isMaskable,
  setClipMask,
  setClipMaskFields,
  type MaskFieldPatch,
} from "../timeline/maskOps";
import { GestureCommit } from "./gestureCommit";
import "../../components/input/input";

/** The icon for each shape. Material Symbols names. */
const SHAPE_ICON: Record<MaskShape, string> = {
  rectangle: "crop_square",
  star: "star",
  heart: "favorite",
  pen: "stylus",
};

@customElement("option-mask-section")
export class OptionMaskSection extends LitElement {
  /**
   * The clips to act on.
   *
   * An array so that `option-text`, which is multi-select, can use this
   * unchanged — the same reason `setClipMaskMany` exists. The first id is the
   * one the panel *reads* from and the one the pen draws on; every id is
   * written to.
   */
  @property({ type: Array })
  elementIds: string[] = [];

  private keyframeControl = new KeyframeController(this);
  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // The timeline canvas's document-level mousedown clears the selection
    // before any button in here receives its own — so without this, clicking a
    // shape would act on nothing.
    this.setAttribute("data-keeps-selection", "");
    // A spinner drag abandoned with Escape. `onCancel` bubbles, so one listener
    // covers all seven fields. The bounds above mirror what `coerceMask`
    // enforces — size and feather non-negative, roundness 0-100, position and
    // rotation deliberately free — so the drag stops where the op would have
    // stopped it instead of showing a number the store is about to overrule.
    this.addEventListener("onCancel", () => this.gesture.cancel());
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
  }

  private get primaryId(): string {
    return this.elementIds[0] ?? "";
  }

  private get element(): TimelineElement | null {
    return useTimelineStore.getState().timeline[this.primaryId] ?? null;
  }

  private get mask(): MaskType | null {
    return maskOf(this.element);
  }

  private get cursor(): number {
    return useTimelineStore.getState().cursor;
  }

  private get penActive(): boolean {
    return useTimelineStore.getState().control.cursorType === "pen";
  }

  // --------------------------------------------------------------- writing

  /**
   * Pick a shape, or clear the mask by picking the one it already has.
   *
   * Choosing `pen` **starts drawing**, rather than storing an empty pen mask
   * and waiting to be told again. An empty pen mask renders as no mask at all,
   * so without this the first click on the pen would look like it had done
   * nothing — the picture would be unchanged and the only new thing on screen
   * would be a second pen button further down the panel.
   */
  private handleShape(shape: MaskShape | null) {
    const ids = [...this.elementIds];
    const current = this.mask?.shape ?? null;
    const next = shape === current ? null : shape;

    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        ids.reduce(
          (accumulated, id) => setClipMask(accumulated, id, next),
          doc,
        ),
      );

    if (next === "pen") {
      this.startPen();
    } else if (this.penActive) {
      // Switching to a built-in shape while a stroke is in progress abandons
      // it: the drawing would have nowhere to land.
      useTimelineStore.getState().setCursorType("pointer");
    }
    this.requestUpdate();
  }

  /**
   * A field change, with its keyframe, as one undo step.
   *
   * The keyframe is written **only where that property's track is already
   * switched on**, which is what makes the number boxes usable both as static
   * controls and as an animation's authoring surface without a mode switch.
   * Written before the static field so `setClipMaskFields` sees the document
   * the keyframe left, and the two cannot be undone apart.
   */
  private commitField(
    patch: MaskFieldPatch,
    keys: Array<{ property: AnimatableProperty; lane: "x" | "y"; value: number }> = [],
  ) {
    const ids = [...this.elementIds];
    this.gesture.apply((doc) => {
      let next = doc;
      for (const id of ids) {
        const element: any = next.elements[id];
        if (element == null) {
          continue;
        }
        const atMs = this.cursor - element.startTime;
        for (const key of keys) {
          if (element.animation?.[key.property]?.isActivate !== true) {
            continue;
          }
          next = addKeyframe(next, id, key.property, key.lane, atMs, key.value);
        }
        next = setClipMaskFields(next, id, patch);
      }
      return next;
    });
    this.requestUpdate();
  }

  /** The value out of one of the row's `<number-input>`s. */
  private numberAt(event: Event): number {
    const value = (event.target as any)?.value;
    const parsed = typeof value === "string" ? parseFloat(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
  }

  private trackActive(property: AnimatableProperty): boolean {
    return (this.element as any)?.animation?.[property]?.isActivate === true;
  }

  private toggleTrack(property: AnimatableProperty) {
    const element = this.element;
    if (element == null) {
      return;
    }
    this.keyframeControl.setActive({
      elementId: this.primaryId,
      animationType: property,
      active: !this.trackActive(property),
      atMs: this.cursor - element.startTime,
    });
    this.requestUpdate();
  }

  /**
   * Arm the pen on the clip this panel is showing.
   *
   * The tool is only switched on if the canvas accepted a session, so the
   * button cannot light up on a clip the pen could never commit to — and the
   * two pieces of state, the cursor type and the session, cannot disagree about
   * whether a stroke is in progress.
   */
  private startPen(): void {
    if (this.elementIds.length !== 1) {
      return;
    }
    const canvas: any = document.querySelector("preview-canvas");
    if (canvas?.beginPen?.(this.primaryId) === true) {
      useTimelineStore.getState().setCursorType("pen");
    }
  }

  private togglePen() {
    if (this.penActive) {
      useTimelineStore.getState().setCursorType("pointer");
      this.requestUpdate();
      return;
    }
    this.startPen();
    this.requestUpdate();
  }

  // --------------------------------------------------------------- drawing

  private keyButton(property: AnimatableProperty) {
    return html`
      <button
        class="btn btn-xxs text-light mr-2"
        aria-event="mask-key-${property}"
        title=${property}
        @click=${() => this.toggleTrack(property)}
      >
        <span
          class="material-symbols-outlined icon-xsm ${this.trackActive(property)
            ? "text-light"
            : "text-secondary"}"
        >
          stat_0
        </span>
      </button>
    `;
  }

  private row(
    label: string,
    inputs: unknown,
    property: AnimatableProperty | null,
  ) {
    return html`
      <label class="form-label text-light">${label}</label>
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div class="d-flex flex-row gap-2 justify-content-start">${inputs}</div>
        <div class="d-flex flex-row gap-2 justify-content-end">
          ${property == null ? "" : this.keyButton(property)}
        </div>
      </div>
    `;
  }

  render() {
    if (!isMaskable(this.element)) {
      return html``;
    }
    const mask = this.mask;

    const shapes = html`
      <div class="d-flex flex-row gap-1 mb-3">
        ${MASK_SHAPES.map(
          (shape) => html`
            <button
              class="btn btn-xxs ${mask?.shape === shape
                ? "btn-primary"
                : "btn-default"} text-light flex-fill"
              aria-event="mask-shape-${shape}"
              title=${shape}
              @click=${() => this.handleShape(shape)}
            >
              <span class="material-symbols-outlined icon-xs">
                ${SHAPE_ICON[shape]}
              </span>
            </button>
          `,
        )}
      </div>
    `;

    if (mask == null) {
      return html`<div class="mt-2">${shapes}</div>`;
    }

    return html`
      <div class="mt-2">
        ${shapes}
        ${this.row(
          "Position",
          html`
            <number-input
              aria-event="mask-x"
              .value=${mask.location.x}
              step="1"
              sensitivity="1"
              @onChange=${(e: Event) =>
                this.commitField(
                  { location: { x: this.numberAt(e), y: mask.location.y } },
                  [
                    { property: "maskPosition", lane: "x", value: this.numberAt(e) },
                    { property: "maskPosition", lane: "y", value: mask.location.y },
                  ],
                )}
            ></number-input>
            <number-input
              aria-event="mask-y"
              .value=${mask.location.y}
              step="1"
              sensitivity="1"
              @onChange=${(e: Event) =>
                this.commitField(
                  { location: { x: mask.location.x, y: this.numberAt(e) } },
                  [
                    { property: "maskPosition", lane: "x", value: mask.location.x },
                    { property: "maskPosition", lane: "y", value: this.numberAt(e) },
                  ],
                )}
            ></number-input>
          `,
          "maskPosition",
        )}
        ${this.row(
          "Size",
          html`
            <number-input
              aria-event="mask-w"
              .value=${mask.size.width}
              min="0"
              step="1"
              sensitivity="1"
              @onChange=${(e: Event) =>
                this.commitField(
                  { size: { width: this.numberAt(e), height: mask.size.height } },
                  [
                    { property: "maskSize", lane: "x", value: this.numberAt(e) },
                    { property: "maskSize", lane: "y", value: mask.size.height },
                  ],
                )}
            ></number-input>
            <number-input
              aria-event="mask-h"
              .value=${mask.size.height}
              min="0"
              step="1"
              sensitivity="1"
              @onChange=${(e: Event) =>
                this.commitField(
                  { size: { width: mask.size.width, height: this.numberAt(e) } },
                  [
                    { property: "maskSize", lane: "x", value: mask.size.width },
                    { property: "maskSize", lane: "y", value: this.numberAt(e) },
                  ],
                )}
            ></number-input>
          `,
          "maskSize",
        )}
        ${this.row(
          "Rotation",
          html`<number-input
            aria-event="mask-rotation"
            .value=${mask.rotation}
            sensitivity="0.5"
            @onChange=${(e: Event) =>
              this.commitField({ rotation: this.numberAt(e) }, [
                { property: "maskRotation", lane: "x", value: this.numberAt(e) },
              ])}
          ></number-input>`,
          "maskRotation",
        )}
        ${this.row(
          "Feather",
          html`<number-input
            aria-event="mask-feather"
            .value=${mask.feather}
            min="0"
            sensitivity="0.2"
            @onChange=${(e: Event) =>
              this.commitField({ feather: this.numberAt(e) }, [
                { property: "maskFeather", lane: "x", value: this.numberAt(e) },
              ])}
          ></number-input>`,
          "maskFeather",
        )}
        ${this.row(
          "Round",
          html`<number-input
            aria-event="mask-roundness"
            .value=${mask.roundness}
            min="0"
            max="100"
            @onChange=${(e: Event) =>
              this.commitField({ roundness: this.numberAt(e) }, [
                { property: "maskRoundness", lane: "x", value: this.numberAt(e) },
              ])}
          ></number-input>`,
          "maskRoundness",
        )}

        <div class="d-flex flex-row gap-1">
          <button
            class="btn btn-xxs ${mask.invert === true
              ? "btn-primary"
              : "btn-default"} text-light flex-fill"
            aria-event="mask-invert"
            title="invert"
            @click=${() => this.commitField({ invert: mask.invert !== true })}
          >
            <span class="material-symbols-outlined icon-xs">
              invert_colors
            </span>
          </button>
          <button
            class="btn btn-xxs ${this.penActive
              ? "btn-primary"
              : "btn-default"} text-light flex-fill"
            aria-event="mask-draw"
            title="draw"
            ?disabled=${this.elementIds.length !== 1}
            @click=${() => this.togglePen()}
          >
            <span class="material-symbols-outlined icon-xs"> stylus </span>
          </button>
        </div>
      </div>
    `;
  }
}
