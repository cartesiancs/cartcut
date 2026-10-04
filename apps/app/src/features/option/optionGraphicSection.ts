/**
 * A graphic's own controls: its name, its preset, and the preset's parameters.
 *
 * Writes through `timeline/graphicOps.ts` and, for a numeric parameter whose
 * `fx:` track is armed, a keyframe first, the rule `optionEffect.write` states:
 * one box serves as the static control and as the animation's authoring
 * surface. Handlers are arrow properties because `<option-graphic>` embeds this
 * in its template.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import {
  FX_PARAM_TRACK_PREFIX,
  type AnimatableProperty,
  type FxParams,
  type GraphicElementType,
} from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import {
  setGraphicName,
  setGraphicParams,
  setGraphicPreset,
} from "../timeline/graphicOps";
import { addKeyframe } from "../animation/keyframeOps";
import { projectBakeHz } from "../editor/frameRate";
import { defaultParamsFor, presetsOfKind } from "../fx/presetRegistry";
import { resolvePreset } from "../fx/resolvePreset";
import { renderParamControls, type FontChoice } from "../fx/fxParamControls";
import { bundledFonts, loadFontLibrary, systemFonts } from "../font/fontLibrary";
import { GestureCommit } from "./gestureCommit";
import { section } from "./optionKit";
import "./optionProgramSection";

@customElement("option-graphic-section")
export class OptionGraphicSection extends LitElement {
  @property({ attribute: false })
  elementId = "";

  /** Passed so a change to the clip is a property change and re-renders this. */
  @property({ attribute: false })
  element: GraphicElementType | null = null;

  private gesture = new GestureCommit();

  /** Faces a font parameter offers, once the library has loaded. */
  private fonts: FontChoice[] = [{ value: "default", label: "Default" }];

  createRenderRoot() {
    this.style.display = "block";
    void loadFontLibrary().then(() => {
      this.fonts = [
        { value: "default", label: "Default" },
        // By file name, so the project names a face every install has rather
        // than this machine's path to it.
        ...bundledFonts().map((entry) => ({
          value: "bundled:" + (entry.path.split(/[\\/]/).pop() ?? entry.name),
          label: entry.name,
        })),
        ...systemFonts().map((entry) => ({ value: entry.path, label: entry.name })),
      ];
      this.requestUpdate();
    });
    return this;
  }

  /** The system's open dialog, limited to pictures. `null` when cancelled. */
  private pickImage = async (): Promise<string | null> => {
    const dialog = (globalThis as any)?.electronAPI?.req?.dialog;
    if (typeof dialog?.openFile !== "function") {
      return null;
    }
    const path = await dialog.openFile(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
    return typeof path === "string" && path !== "" ? path : null;
  };

  private get graphic(): GraphicElementType | null {
    const element = useTimelineStore.getState().timeline[this.elementId];
    return element != null && element.filetype === "graphic" ? element : null;
  }

  private commit(fn: (doc: TimelineDocument) => TimelineDocument) {
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private handleName = (event: Event) => {
    const name = (event.target as HTMLInputElement).value;
    const id = this.elementId;
    this.commit((doc) => setGraphicName(doc, id, name));
  };

  private handlePreset = (event: Event) => {
    const presetId = (event.target as HTMLSelectElement).value;
    const id = this.elementId;
    this.commit((doc) => setGraphicPreset(doc, id, presetId, defaultParamsFor(presetId)));
  };

  /** A parameter write, as a keyframe too when its track is armed. */
  private paramWrite(
    key: string,
    value: FxParams[string],
  ): (doc: TimelineDocument) => TimelineDocument {
    const id = this.elementId;
    const setStatic = (doc: TimelineDocument) => setGraphicParams(doc, id, { [key]: value });
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return setStatic;
    }
    const property = `${FX_PARAM_TRACK_PREFIX}${key}` as AnimatableProperty;
    const bakeHz = projectBakeHz();
    const cursor = useTimelineStore.getState().cursor;
    return (doc) => {
      let next = doc;
      const element: any = next.elements[id];
      if (element == null) {
        return doc;
      }
      if (element.animation?.[property]?.isActivate === true) {
        next = addKeyframe(next, id, property, "x", cursor - element.startTime, value, undefined, bakeHz);
      }
      return setStatic(next);
    };
  }

  render() {
    const graphic = this.graphic;
    if (graphic == null) {
      return html``;
    }
    const preset = resolvePreset(graphic);
    const inline = graphic.program != null;
    const installed = presetsOfKind("graphic");

    return html`
      ${section({
        title: "Graphic",
        grow: true,
        actions: html`
          <select
            class="opt-select"
            aria-label="graphic preset"
            .value=${graphic.presetId}
            @change=${this.handlePreset}
          >
            ${inline
              ? html`<option value=${graphic.presetId} selected>
                  ${graphic.program?.manifest?.name ?? "Inline"} (inline)
                </option>`
              : preset == null
                ? html`<option value=${graphic.presetId} selected>
                    ${graphic.presetId} (missing)
                  </option>`
                : ""}
            ${installed.map(
              (entry) =>
                html`<option value=${entry.id} ?selected=${entry.id === graphic.presetId}>
                  ${entry.name}${entry.origin === "user" ? " *" : ""}
                </option>`,
            )}
          </select>
        `,
      })}
      ${section({
        title: "Settings",
        body: html`
          <div class="opt-field">
            <div class="opt-row">
              <label class="opt-label">Name</label>
              <input
                type="text"
                class="opt-text-input"
                aria-label="graphic name"
                .value=${graphic.name ?? ""}
                @change=${this.handleName}
              />
            </div>
          </div>
          ${preset == null && !inline
            ? html`<div class="opt-hint" style="margin-bottom: 12px;">
                <span class="material-symbols-outlined opt-hint-icon">warning</span>
                Not installed. This graphic draws nothing for now, and its settings are kept.
              </div>`
            : ""}
          ${preset != null && preset.params.length > 0
            ? renderParamControls({
                params: preset.params,
                values: graphic.params,
                fonts: this.fonts,
                pickImage: this.pickImage,
                keyframe: {
                  elementId: this.elementId,
                  trackFor: (param) =>
                    param.type === "number"
                      ? (`${FX_PARAM_TRACK_PREFIX}${param.key}` as AnimatableProperty)
                      : null,
                },
                onScrub: (key, value) => {
                  this.gesture.apply(this.paramWrite(key, value));
                  this.requestUpdate();
                },
                onCommit: (key, value) => {
                  this.commit(this.paramWrite(key, value));
                },
              })
            : ""}
        `,
      })}
      ${inline
        ? html`<option-program-section
            .elementId=${this.elementId}
            .program=${graphic.program}
          ></option-program-section>`
        : ""}
    `;
  }
}
