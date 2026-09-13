/**
 * The inspector for a full-frame effect.
 *
 * Tag name fixed by `optionGroup`'s `option-${filetype}` convention.
 *
 * Deliberately shorter than the other panels, because an effect has less to
 * say: no width, no height, no position, no rotation. It covers the frame
 * exactly, always — see `EffectElementType`, which omits the `Visual` mixin for
 * that reason. What is left is which preset, how strong, how it combines, and
 * whatever the preset itself declared.
 *
 * The note about scope is worth the space it takes. An effect applies to
 * everything painted *beneath* it, which is not visible from the element and is
 * the single thing most likely to confuse someone whose grade is not touching
 * the clip they expected.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import {
  FX_PARAM_TRACK_PREFIX,
  type AnimatableProperty,
  type EffectElementType,
} from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import {
  setEffectBlend,
  setEffectIntensity,
  setEffectParams,
  setEffectPreset,
} from "../timeline/effectOps";
import { addKeyframe } from "../animation/keyframeOps";
import { projectBakeHz } from "../editor/frameRate";
import { defaultParamsFor, presetById, presetsOfKind } from "../fx/presetRegistry";
import { renderParamControls } from "../fx/fxParamControls";
import { GestureCommit } from "./gestureCommit";
import { scrubOn } from "../input/inputScrub";
import { sweepSpec } from "../input/numberScrub";
import "./controlKeyframeNav";

const SCRUB_INTENSITY = scrubOn(sweepSpec(0, 100, 1));

/**
 * Blend modes offered for an overlay preset.
 *
 * A subset of what Canvas2D accepts, chosen because these are the ones that
 * read as "combine light" rather than as a compositing trick — and because the
 * compositor's fast path is pinned against the GLSL equivalents for exactly
 * these.
 */
const BLEND_MODES = [
  { value: "screen", label: "Screen" },
  { value: "lighter", label: "Add" },
  { value: "overlay", label: "Overlay" },
  { value: "soft-light", label: "Soft Light" },
  { value: "multiply", label: "Multiply" },
  { value: "source-over", label: "Normal" },
];

@customElement("option-effect")
export class OptionEffect extends LitElement {
  elementId: string;

  constructor() {
    super();
    this.elementId = "";
    this.hide();
  }

  private gesture = new GestureCommit();

  @property()
  timeline: any = useTimelineStore.getInitialState().timeline;

  @property()
  isShow = false;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.requestUpdate();
    });

    // Subscribed rather than pushed at — `optionGroup.showOption` only fires
    // from the timeline canvas's mousedown, so an agent or toolbar selection
    // would never reach this panel.
    selectionStore.subscribe((state) => {
      const id = state.ids[0];
      if (id != null && this.timeline[id]?.filetype === "effect") {
        this.elementId = id;
        this.requestUpdate();
      }
    });

    // Or the canvas's document-level mousedown clears the selection before any
    // control in here receives its click.
    this.setAttribute("data-keeps-selection", "");

    return this;
  }

  hide() {
    this.classList.add("d-none");
    this.isShow = false;
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  setElementId({ elementId }: { elementId: string }) {
    this.elementId = elementId;
    this.requestUpdate();
  }

  /** Read from the store every render, never cached — see `optionVideo`. */
  private get effect(): EffectElementType | null {
    const element = useTimelineStore.getState().timeline[this.elementId];
    return element != null && element.filetype === "effect" ? element : null;
  }

  private commit(fn: (doc: any) => any) {
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private handleChangePreset = (e: Event) => {
    const presetId = (e.target as HTMLSelectElement).value;
    const id = this.elementId;
    this.commit((doc) =>
      setEffectPreset(doc, id, presetId, defaultParamsFor(presetId)),
    );
  };

  private handleChangeBlend = (e: Event) => {
    const blend = (e.target as HTMLSelectElement)
      .value as GlobalCompositeOperation;
    const id = this.elementId;
    this.commit((doc) => setEffectBlend(doc, id, blend));
  };

  /**
   * One value change, as the keyframe *and* the static field it keyframes.
   *
   * The rule `controlDefaultTransform.commitValue` and
   * `optionMaskSection.commitField` both follow: **write a keyframe only where
   * the track is switched on**, and write it before the static field so the op
   * that writes the field sees the document the keyframe left. That is what
   * makes one number box serve as a static control and as an animation's
   * authoring surface with no mode switch.
   *
   * The static write happens either way. While a track is armed nothing reads
   * the field, but it is what the renderer falls back to the moment the track
   * is switched off, and leaving it at a stale value is the jump
   * `withStaticValue` exists to prevent at the other end.
   *
   * `property` is `null` for a parameter that may not carry a track, which is
   * every kind but `number`.
   */
  private write(
    id: string,
    property: AnimatableProperty | null,
    value: number,
    setStatic: (doc: TimelineDocument) => TimelineDocument,
  ): (doc: TimelineDocument) => TimelineDocument {
    // `projectBakeHz()`, not the op's 60Hz default: a baked lane is a cache read
    // by nearest sample, so one written coarser than the project's rate hands
    // consecutive frames the same value and the curve steps. See
    // `keyframes.ts#bakeRateFor`.
    const bakeHz = projectBakeHz();
    const cursor = useTimelineStore.getState().cursor;

    return (doc) => {
      let next = doc;
      const element: any = next.elements[id];
      if (element == null || !Number.isFinite(value)) {
        return doc;
      }
      if (
        property != null &&
        element.animation?.[property]?.isActivate === true
      ) {
        next = addKeyframe(
          next,
          id,
          property,
          "x",
          cursor - element.startTime,
          value,
          undefined,
          bakeHz,
        );
      }
      return setStatic(next);
    };
  }

  /**
   * One parameter's write, keyframe included when its track is armed.
   *
   * A non-numeric parameter has no track at all, so `write` is handed `null`
   * and does the static half only. `setEffectParams` merges one key, so a
   * colour and a number never overwrite each other.
   */
  private paramWrite(
    id: string,
    key: string,
    value: number | string | boolean | number[],
  ): (doc: TimelineDocument) => TimelineDocument {
    const setStatic = (doc: TimelineDocument) =>
      setEffectParams(doc, id, { [key]: value });
    if (typeof value !== "number") {
      return setStatic;
    }
    return this.write(
      id,
      `${FX_PARAM_TRACK_PREFIX}${key}` as AnimatableProperty,
      value,
      setStatic,
    );
  }

  private handleScrubIntensity = (e: Event) => {
    const value = Number((e.target as HTMLInputElement).value);
    const id = this.elementId;
    this.gesture.apply(
      this.write(id, "intensity", value, (doc) =>
        setEffectIntensity(doc, id, value),
      ),
    );
    this.requestUpdate();
  };

  private handleCommitIntensity = (e: Event) => {
    const value = Number((e.target as HTMLInputElement).value);
    const id = this.elementId;
    this.commit(
      this.write(id, "intensity", value, (doc) =>
        setEffectIntensity(doc, id, value),
      ),
    );
  };

  render() {
    const effect = this.effect;
    if (effect == null) {
      return html``;
    }

    const preset = presetById(effect.presetId);
    const installed = presetsOfKind("effect");
    const isOverlay = preset?.render.type === "overlay";

    return html`
      <div class="p-2">
        <label class="form-label text-light">Effect</label>

        ${preset == null
          ? html`<div class="alert alert-warning p-2" style="font-size: 11px;">
              The preset <code>${effect.presetId}</code> is not installed. This
              effect does nothing for now, and its settings are kept — they come
              back if the preset is installed again.
            </div>`
          : ""}

        <select
          class="form-select bg-dark text-light form-select-sm mb-1"
          .value=${effect.presetId}
          @change=${this.handleChangePreset}
        >
          ${preset == null
            ? html`<option value=${effect.presetId}>
                ${effect.presetId} (missing)
              </option>`
            : ""}
          ${installed.map(
            (entry) => html`<option value=${entry.id}>${entry.name}</option>`,
          )}
        </select>

        <div class="text-secondary mb-3" style="font-size: 10px;">
          Applies to every layer beneath this track. Drag the track up or down
          to change what it touches.
        </div>

        <label class="form-label text-secondary" style="font-size: 11px;">
          Intensity
        </label>
        <div class="d-flex gap-2 align-items-center mb-3">
          <input
            type="range"
            class="form-range"
            min="0"
            max="100"
            step="1"
            .value=${String(effect.intensity)}
            @input=${this.handleScrubIntensity}
            @change=${this.handleCommitIntensity}
          />
          <input
            type="number"
            class="form-control bg-default text-light form-control-sm scrub-number"
            style="width: 5rem;"
            min="0"
            max="100"
            step="1"
            .value=${String(Math.round(effect.intensity))}
            @mousedown=${SCRUB_INTENSITY}
            @change=${this.handleCommitIntensity}
          />
          <control-keyframe-nav
            .elementId=${this.elementId}
            .property=${"intensity"}
            .label=${"Intensity"}
          ></control-keyframe-nav>
        </div>

        ${isOverlay
          ? html`
              <label
                class="form-label text-secondary"
                style="font-size: 11px;"
              >
                Blend
              </label>
              <select
                class="form-select bg-dark text-light form-select-sm mb-3"
                .value=${effect.blend ??
                (preset?.render.type === "overlay"
                  ? (preset.render.blend ?? "screen")
                  : "screen")}
                @change=${this.handleChangeBlend}
              >
                ${BLEND_MODES.map(
                  (mode) =>
                    html`<option value=${mode.value}>${mode.label}</option>`,
                )}
              </select>
            `
          : ""}

        ${preset != null && preset.params.length > 0
          ? html`
              <hr class="border-secondary" />
              ${renderParamControls({
                params: preset.params,
                values: effect.params,
                // The manifest gets the last word on what may be animated.
                // `animatableProperties` offers a track for any parameter whose
                // stored value is a number, which a `select`'s is too; only
                // here is the declared type in scope to refuse it.
                keyframe: {
                  elementId: this.elementId,
                  trackFor: (param) =>
                    param.type === "number"
                      ? (`${FX_PARAM_TRACK_PREFIX}${param.key}` as AnimatableProperty)
                      : null,
                },
                onScrub: (key, value) => {
                  const id = this.elementId;
                  this.gesture.apply(
                    this.paramWrite(id, key, value),
                  );
                  this.requestUpdate();
                },
                onCommit: (key, value) => {
                  const id = this.elementId;
                  this.commit(this.paramWrite(id, key, value));
                },
              })}
            `
          : ""}
      </div>
    `;
  }
}
