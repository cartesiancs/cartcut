/**
 * The Border and Shadow sections, in the Media pane.
 *
 * Sections rather than tabs, for the reason `optionShapeSection.ts` gives: the
 * tab bar is already four wide, and these are properties of the clip rather
 * than modes of working on it. Shown for the three types that draw a picture
 * inside a box: shape, image and video. Text has its own pair under Effects,
 * which strokes the glyphs rather than the box, and the two are deliberately
 * not merged: they answer different questions and a user who found "Border" in
 * both places would reasonably expect the same thing.
 *
 * Both are off until they are switched on, so each head carries the eye and
 * each body appears with it. That is the same control `optionShapeSection` uses
 * to fold its controls away, and the difference is worth knowing: there the eye
 * is component state, here it is `enable` on the clip, because a border that is
 * off is a fact about the project rather than about where the user is looking.
 *
 * Every write goes through `timeline/decorationOps.ts`, the same ops
 * `set_clip_decoration` uses, so the panel and the agent cannot disagree about
 * what a border is. A slider drag goes through `GestureCommit`, so one drag is
 * one undo step however many values it passed through.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  STROKE_ALIGNMENTS,
  type ClipShadow,
  type ClipStroke,
  type StrokeAlignment,
} from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import {
  decorationFieldsOf,
  isDecoratable,
  setClipShadowMany,
  setClipStrokeMany,
  type ShadowPatch,
  type StrokePatch,
} from "../timeline/decorationOps";
import type { TimelineDocument } from "../timeline/tracks";
import { GestureCommit } from "./gestureCommit";
import { colorField, eyeButton, section, sliderField } from "./optionKit";

/**
 * What each alignment is called in the row.
 *
 * Short because the column is about 200px and three cells share it, which is
 * the same reason the reveal section says "Char", "Word", "Line". The full
 * words are the `title`, where there is room for them.
 */
const ALIGN_LABELS: Record<StrokeAlignment, string> = {
  inner: "In",
  center: "Mid",
  outer: "Out",
};

const ALIGN_TITLES: Record<StrokeAlignment, string> = {
  inner: "Inside the outline",
  center: "Straddling the outline",
  outer: "Outside the outline",
};

type Row = {
  label: string;
  min: number;
  max: number;
  step: number;
  suffix: string;
};

const STROKE_ROWS: Record<"width" | "opacity", Row> = {
  width: { label: "Width", min: 0, max: 100, step: 1, suffix: "px" },
  opacity: { label: "Opacity", min: 0, max: 100, step: 1, suffix: "%" },
};

const SHADOW_ROWS: Record<"offsetX" | "offsetY" | "blur" | "opacity", Row> = {
  offsetX: { label: "Offset X", min: -200, max: 200, step: 1, suffix: "px" },
  offsetY: { label: "Offset Y", min: -200, max: 200, step: 1, suffix: "px" },
  blur: { label: "Blur", min: 0, max: 200, step: 1, suffix: "px" },
  opacity: { label: "Opacity", min: 0, max: 100, step: 1, suffix: "%" },
};

@customElement("option-decoration-section")
export class OptionDecorationSection extends LitElement {
  @property({ attribute: false })
  elementIds: string[] = [];

  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // Or the timeline canvas's document-level mousedown clears the selection
    // before the slider receives its own.
    this.setAttribute("data-keeps-selection", "");
    // A spinner drag abandoned with Escape. `onCancel` bubbles, so one
    // listener covers every field.
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

  /** The ids that can carry a decoration, read from the store every render. */
  private get targets(): string[] {
    const timeline = useTimelineStore.getState().timeline;
    return this.elementIds.filter((id) => isDecoratable(timeline[id]));
  }

  /**
   * What the controls show: the first target's values, defaults merged in.
   *
   * The first rather than a mixed-state summary, which is what the rest of this
   * panel does for a multi-selection. A second clip with a different border
   * shows the first one's numbers and takes the next write, which is the
   * behaviour the shape section and the adjust section already have.
   */
  private get fields(): { stroke: ClipStroke; shadow: ClipShadow } {
    const first = this.targets[0];
    const element =
      first == null ? null : useTimelineStore.getState().timeline[first];
    return decorationFieldsOf(element);
  }

  private scrubStroke(patch: StrokePatch): void {
    const ids = this.targets;
    this.gesture.apply((doc) => setClipStrokeMany(doc, ids, patch));
    this.requestUpdate();
  }

  private scrubShadow(patch: ShadowPatch): void {
    const ids = this.targets;
    this.gesture.apply((doc) => setClipShadowMany(doc, ids, patch));
    this.requestUpdate();
  }

  private commit = (): void => {
    this.gesture.flush();
    this.requestUpdate();
  };

  /** One immediate step, for a toggle, a colour or a typed number. */
  private write(fn: (doc: TimelineDocument) => TimelineDocument): void {
    this.gesture.flush();
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  /** One named value, wrapped so a sibling field's margin applies to it. */
  private field(
    row: Row,
    value: number,
    onScrub: (next: number) => void,
    onTyped: (next: number) => void,
  ): TemplateResult {
    return html`
      <div class="opt-field">
        ${sliderField({
          label: row.label,
          suffix: row.suffix,
          value,
          min: row.min,
          max: row.max,
          step: row.step,
          bipolar: row.min < 0,
          onScrub,
          onCommit: this.commit,
          onTyped,
          onInvalid: () => this.requestUpdate(),
        })}
      </div>
    `;
  }

  private renderStroke(stroke: ClipStroke): TemplateResult {
    const ids = this.targets;
    return section({
      title: "Border",
      actions: eyeButton(
        stroke.enable,
        stroke.enable ? "Turn border off" : "Turn border on",
        () =>
          this.write((doc) =>
            setClipStrokeMany(doc, ids, { enable: !stroke.enable }),
          ),
        "decoration-stroke",
      ),
      body: stroke.enable
        ? html`
            ${this.field(
              STROKE_ROWS.width,
              stroke.width,
              (width) => this.scrubStroke({ width }),
              (width) =>
                this.write((doc) => setClipStrokeMany(doc, ids, { width })),
            )}
            ${this.field(
              STROKE_ROWS.opacity,
              stroke.opacity,
              (opacity) => this.scrubStroke({ opacity }),
              (opacity) =>
                this.write((doc) => setClipStrokeMany(doc, ids, { opacity })),
            )}
            <div class="opt-field">
              ${colorField({
                label: "Color",
                value: stroke.color,
                event: "decoration-stroke-color",
                onScrub: (color) => this.scrubStroke({ color }),
                onCommit: this.commit,
              })}
            </div>
            <div class="opt-field">
              <div class="opt-row">
                <label class="opt-label">Align</label>
              </div>
              <div
                class="opt-seg"
                role="group"
                aria-label="Border alignment"
                style="margin-top: 6px;"
              >
                ${STROKE_ALIGNMENTS.map(
                  (align) => html`
                    <button
                      type="button"
                      class="opt-seg-item ${stroke.align === align
                        ? "is-on"
                        : ""}"
                      aria-event="decoration-align-${align}"
                      aria-pressed=${stroke.align === align ? "true" : "false"}
                      title=${ALIGN_TITLES[align]}
                      @click=${() =>
                        this.write((doc) =>
                          setClipStrokeMany(doc, ids, { align }),
                        )}
                    >
                      ${ALIGN_LABELS[align]}
                    </button>
                  `,
                )}
              </div>
            </div>
          `
        : undefined,
    });
  }

  private renderShadow(shadow: ClipShadow): TemplateResult {
    const ids = this.targets;
    const field = (
      key: keyof typeof SHADOW_ROWS,
      value: number,
    ): TemplateResult =>
      this.field(
        SHADOW_ROWS[key],
        value,
        (next) => this.scrubShadow({ [key]: next } as ShadowPatch),
        (next) =>
          this.write((doc) =>
            setClipShadowMany(doc, ids, { [key]: next } as ShadowPatch),
          ),
      );

    return section({
      title: "Shadow",
      actions: eyeButton(
        shadow.enable,
        shadow.enable ? "Turn shadow off" : "Turn shadow on",
        () =>
          this.write((doc) =>
            setClipShadowMany(doc, ids, { enable: !shadow.enable }),
          ),
        "decoration-shadow",
      ),
      body: shadow.enable
        ? html`
            ${field("offsetX", shadow.offsetX)}
            ${field("offsetY", shadow.offsetY)} ${field("blur", shadow.blur)}
            ${field("opacity", shadow.opacity)}
            <div class="opt-field">
              ${colorField({
                label: "Color",
                value: shadow.color,
                event: "decoration-shadow-color",
                onScrub: (color) => this.scrubShadow({ color }),
                onCommit: this.commit,
              })}
            </div>
          `
        : undefined,
    });
  }

  render() {
    if (this.targets.length === 0) {
      return html``;
    }
    const { stroke, shadow } = this.fields;
    return html`${this.renderStroke(stroke)}${this.renderShadow(shadow)}`;
  }
}
