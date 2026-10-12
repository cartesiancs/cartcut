/**
 * The Backdrop section: an effect or LUT preset run over what is beneath a
 * shape, inside its outline. A face mosaic, a frosted panel, a smear across
 * one band.
 *
 * A choose-one section, like the LUT: a shape has no backdrop until one is
 * picked, so the head carries a `+`, and the `+` writes nothing. It opens the
 * preset list, and only choosing a preset is an edit. The `x` takes the
 * backdrop away, one undo step.
 *
 * The first backdrop on a shape switches its fill off, as the agent's
 * `set_shape_backdrop` does: an opaque fill hides the very thing the backdrop
 * draws, and someone who picked a mosaic and saw nothing change would decide
 * it had not worked. The Fill section's Opacity brings the fill back as a tint.
 *
 * The rest is `<option-effect>`'s, deliberately: the same Intensity row with
 * its keyframe diamond, the same parameter controls generated from the
 * manifest, and the same rule that a value change writes a keyframe only where
 * the track is armed. A backdrop's tracks are an effect's (`intensity`,
 * `fx:<key>`), riding on the shape's own `animation`.
 *
 * Every write goes through `timeline/shapeOps.ts`, the ops the agent uses, and
 * a slider drag through `GestureCommit`, so one drag is one undo step.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  FX_PARAM_TRACK_PREFIX,
  type AnimatableProperty,
  type BackdropFx,
} from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { addKeyframe } from "../animation/keyframeOps";
import { projectBakeHz } from "../editor/frameRate";
import { backdropModeOf } from "../fx/backdropPreset";
import { renderParamControls } from "../fx/fxParamControls";
import {
  defaultParamsFor,
  presetsOfKind,
  subscribePresets,
} from "../fx/presetRegistry";
import type { FxPreset } from "../fx/presetTypes";
import { resolvePreset } from "../fx/resolvePreset";
import { backdropFxOf } from "../shape/backdropFx";
import type { TimelineDocument } from "../timeline/tracks";
import {
  chooseClipBackdrop,
  isShapeElement,
  patchClipBackdropFx,
  setClipBackdropFx,
} from "../timeline/shapeOps";
import "./controlKeyframeNav";
import { GestureCommit } from "./gestureCommit";
import { addButton, removeButton, section, sliderField } from "./optionKit";

/** What the preset list offers: every effect shader, then every LUT. */
function backdropChoices(): { effects: FxPreset[]; luts: FxPreset[] } {
  const usable = (preset: FxPreset) => backdropModeOf(preset) != null;
  return {
    effects: presetsOfKind("effect").filter(usable),
    luts: presetsOfKind("lut").filter(usable),
  };
}

@customElement("option-backdrop-section")
export class OptionBackdropSection extends LitElement {
  @property({ attribute: false })
  elementIds: string[] = [];

  /**
   * Whether the `+` has been pressed on a shape with no backdrop yet.
   *
   * Component state: it is where the user is looking. Opening the list costs
   * no undo step; choosing from it is the edit.
   */
  private choosing = false;

  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // The list fills in when the presets arrive, and changes when one is
    // installed or downloaded.
    this.teardown.push(subscribePresets(() => this.requestUpdate()));
    // Or the timeline canvas's document-level mousedown clears the selection
    // before a control in here receives its own.
    this.setAttribute("data-keeps-selection", "");
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

  /** The ids that are shapes, read from the store every render. */
  private get targets(): string[] {
    const timeline = useTimelineStore.getState().timeline;
    return this.elementIds.filter((id) => isShapeElement(timeline[id]));
  }

  /** The first shape's backdrop, which is what the section shows. */
  private get backdrop(): BackdropFx | null {
    const first = this.targets[0];
    return first == null
      ? null
      : backdropFxOf(useTimelineStore.getState().timeline[first]);
  }

  private write(fn: (doc: TimelineDocument) => TimelineDocument): void {
    this.gesture.flush();
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private handleChoose = (e: Event): void => {
    const presetId = (e.target as HTMLSelectElement).value;
    if (presetId === "") {
      return;
    }
    const ids = this.targets;
    this.choosing = false;
    // `chooseClipBackdrop` keeps the intensity across a preset change and
    // switches the fill off for a first backdrop, as a dropped tile and the
    // agent do.
    this.write((doc) =>
      ids.reduce(
        (acc, id) =>
          chooseClipBackdrop(acc, id, {
            presetId,
            params: defaultParamsFor(presetId),
          }),
        doc,
      ),
    );
  };

  private handleRemove = (): void => {
    const ids = this.targets;
    this.choosing = false;
    this.write((doc) =>
      ids.reduce((acc, id) => setClipBackdropFx(acc, id, null), doc),
    );
  };

  /**
   * One value change on every selected shape, as the keyframe and the static
   * field it keyframes: `<option-effect>`'s `write`, per shape. A keyframe is
   * written only where that shape's track is armed, and the static value
   * either way, so the shape falls back to it the moment the track is off.
   */
  private valueWrite(
    property: AnimatableProperty | null,
    value: number | string | boolean | number[],
    patch: { params?: Record<string, number | string | boolean | number[]>; intensity?: number },
  ): (doc: TimelineDocument) => TimelineDocument {
    const ids = this.targets;
    const bakeHz = projectBakeHz();
    const cursor = useTimelineStore.getState().cursor;
    return (doc) => {
      let next = doc;
      for (const id of ids) {
        const element: any = next.elements[id];
        if (element == null) {
          continue;
        }
        if (
          property != null &&
          typeof value === "number" &&
          Number.isFinite(value) &&
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
        next = patchClipBackdropFx(next, id, patch);
      }
      return next;
    };
  }

  private intensityWrite(value: number) {
    return this.valueWrite("intensity", value, { intensity: value });
  }

  private paramWrite(key: string, value: number | string | boolean | number[]) {
    return this.valueWrite(
      typeof value === "number"
        ? (`${FX_PARAM_TRACK_PREFIX}${key}` as AnimatableProperty)
        : null,
      value,
      { params: { [key]: value } },
    );
  }

  private renderSelect(current: BackdropFx | null): TemplateResult {
    const { effects, luts } = backdropChoices();
    const listed = [...effects, ...luts].some((p) => p.id === current?.presetId);
    const option = (preset: FxPreset) =>
      // Marked on the option as well as through the select's `.value`: Lit
      // commits `.value` before it renders these options, so on a first render
      // there is nothing to match. `<option-effect>` states the same trap.
      html`<option value=${preset.id} ?selected=${preset.id === current?.presetId}>
        ${preset.name}
      </option>`;
    return html`
      <select
        class="opt-select"
        aria-label="backdrop preset"
        aria-event="backdrop-preset"
        .value=${current?.presetId ?? ""}
        @change=${this.handleChoose}
      >
        ${current == null
          ? html`<option value="" selected disabled>Choose an effect</option>`
          : listed
            ? ""
            : // A preset this machine does not have still shows, selected, so
              // the list does not claim a different one is current.
              html`<option value=${current.presetId} selected>
                ${current.program?.manifest?.name ?? current.presetId}
                ${current.program != null ? "(inline)" : "(missing)"}
              </option>`}
        ${effects.length > 0
          ? html`<optgroup label="Effects">${effects.map(option)}</optgroup>`
          : ""}
        ${luts.length > 0
          ? html`<optgroup label="LUTs">${luts.map(option)}</optgroup>`
          : ""}
      </select>
    `;
  }

  render(): TemplateResult {
    const ids = this.targets;
    if (ids.length === 0) {
      return html``;
    }
    const backdrop = this.backdrop;

    if (backdrop == null) {
      return section({
        title: "Backdrop",
        actions: this.choosing
          ? removeButton("Cancel", () => {
              this.choosing = false;
              this.requestUpdate();
            })
          : addButton(
              "Run an effect on what is beneath this shape",
              () => {
                this.choosing = true;
                this.requestUpdate();
              },
              "backdrop-add",
            ),
        body: this.choosing
          ? html`
              <div class="opt-field">${this.renderSelect(null)}</div>
              <div class="opt-field opt-hint">
                <span class="material-symbols-outlined opt-hint-icon">blur_on</span>
                Runs on every layer beneath this shape, inside its outline. A
                mosaic over a face is Pixelate on an ellipse.
              </div>
            `
          : undefined,
      });
    }

    const preset = resolvePreset(backdrop);
    const runs = backdropModeOf(preset) != null;
    const first = ids[0];

    return section({
      title: "Backdrop",
      actions: removeButton("Remove the backdrop", this.handleRemove, "backdrop-remove"),
      body: html`
        <div class="opt-field">${this.renderSelect(backdrop)}</div>
        ${runs
          ? html`<div class="opt-field opt-hint">
              <span class="material-symbols-outlined opt-hint-icon">layers</span>
              Runs on every layer beneath this shape, inside its outline.
            </div>`
          : html`<div class="opt-field opt-hint">
              <span class="material-symbols-outlined opt-hint-icon">warning</span>
              Not available here, so the shape is filled solid until it is. Its
              settings are kept.
            </div>`}
        <div class="opt-field">
          ${sliderField({
            label: "Intensity",
            suffix: "%",
            value: backdrop.intensity,
            min: 0,
            max: 100,
            trailing: html`<control-keyframe-nav
              .elementId=${first}
              .property=${"intensity"}
              .label=${"Intensity"}
            ></control-keyframe-nav>`,
            onScrub: (value) => {
              this.gesture.apply(this.intensityWrite(value));
              this.requestUpdate();
            },
            onCommit: () => {
              this.gesture.flush();
              this.requestUpdate();
            },
            onTyped: (value) => this.write(this.intensityWrite(value)),
            onInvalid: () => this.requestUpdate(),
          })}
        </div>
        ${preset != null && preset.params.length > 0
          ? renderParamControls({
              params: preset.params,
              values: backdrop.params,
              keyframe: {
                elementId: first,
                trackFor: (param) =>
                  param.type === "number"
                    ? (`${FX_PARAM_TRACK_PREFIX}${param.key}` as AnimatableProperty)
                    : null,
              },
              onScrub: (key, value) => {
                this.gesture.apply(this.paramWrite(key, value));
                this.requestUpdate();
              },
              onCommit: (key, value) => this.write(this.paramWrite(key, value)),
            })
          : ""}
      `,
    });
  }
}
