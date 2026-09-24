/**
 * The Border and Shadow section, in the Media pane.
 *
 * A section rather than a tab, for the reason `optionShapeSection.ts` gives:
 * the tab bar is already four wide, and these are properties of the clip
 * rather than modes of working on it. It is shown for the three types that
 * draw a picture inside a box — shape, image and video. Text has its own pair
 * under Effects, which strokes the glyphs rather than the box, and the two are
 * deliberately not merged: they answer different questions and a user who
 * found "Border" in both places would reasonably expect the same thing.
 *
 * Every write goes through `timeline/decorationOps.ts`, the same ops
 * `set_clip_decoration` uses, so the panel and the agent cannot disagree about
 * what a border is. A slider drag goes through `GestureCommit`, so one drag is
 * one undo step however many values it passed through.
 *
 * Laid out the way `optionShapeSection` is, and for the reason stated there:
 * the inspector column is narrow, and a slider sharing its line with a label
 * and a number box is left about seventy pixels to travel its whole range.
 *
 * The rest of the markup follows what the sibling sections already do rather
 * than inventing a second look: a `form-label` titles a group, a row of
 * `btn-xxs` buttons is how a closed choice is offered, `aria-event` names an
 * interactive control, and a colour input scrubs through the gesture instead
 * of committing on every `input` event. The last of those is not cosmetic —
 * `optionShapeSection`'s header records that writing a colour straight through
 * was what made a picker drag cost one undo step per event.
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

/** What each alignment is called, and the order the row offers them. */
/**
 * What each alignment is called in the row.
 *
 * Short because the column is about 200px and three `btn-xxs` share it, which
 * is the same reason the reveal section says "Char", "Word", "Line". The full
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

  /**
   * A group's title and its on switch on one line.
   *
   * The arrangement `optionAdjustSection` uses for a group heading and its
   * Reset: the name takes the room and the control sits at the end, so two
   * groups stacked read as two groups rather than as a list of buttons.
   */
  private renderHeading(
    label: string,
    event: string,
    enabled: boolean,
    onToggle: () => void,
  ): TemplateResult {
    return html`
      <div class="d-flex flex-row align-items-center gap-1 mb-2">
        <label class="form-label text-light flex-grow-1 mb-0">${label}</label>
        <button
          class="btn btn-xxs ${enabled
            ? "btn-primary"
            : "btn-default"} text-light"
          aria-event=${event}
          title=${enabled ? `Turn ${label.toLowerCase()} off` : `Turn ${label.toLowerCase()} on`}
          @click=${onToggle}
        >
          <span class="material-symbols-outlined icon-xs">
            ${enabled ? "visibility" : "visibility_off"}
          </span>
        </button>
      </div>
    `;
  }

  private renderRow(
    row: Row,
    value: number,
    onScrub: (next: number) => void,
    onTyped: (next: number) => void,
  ): TemplateResult {
    return html`
      <div class="mb-2">
        <div
          class="d-flex align-items-center justify-content-between"
          style="gap: 8px;"
        >
          <label class="text-light text-truncate mb-0" style="font-size: 11px;">
            ${row.label}${row.suffix === "" ? "" : ` (${row.suffix})`}
          </label>
          <input
            type="number"
            class="form-control form-control-sm bg-default text-light text-end px-1 py-0 flex-shrink-0"
            style="width: 3.8em; font-size: 11px; height: 20px;"
            min=${String(row.min)}
            max=${String(row.max)}
            step=${String(row.step)}
            .value=${String(Math.round(value))}
            @change=${(e: Event) => {
              const next = Number((e.target as HTMLInputElement).value);
              if (!Number.isFinite(next)) {
                // Put the box back to what the document says rather than
                // writing a NaN.
                this.requestUpdate();
                return;
              }
              onTyped(next);
            }}
          />
        </div>
        <input
          type="range"
          class="form-range option-range mt-1"
          min=${String(row.min)}
          max=${String(row.max)}
          step=${String(row.step)}
          .value=${String(value)}
          @input=${(e: Event) =>
            onScrub(Number((e.target as HTMLInputElement).value))}
          @change=${this.commit}
        />
      </div>
    `;
  }

  /**
   * A colour, scrubbed rather than committed per event.
   *
   * The same shape `optionShapeSection` gives Fill Color, and for the reason
   * its header records: a picker drag fires `input` continuously, so writing
   * each one through `withCheckpoint` costs an undo step per event and makes
   * the colour impossible to take back in one press.
   */
  private renderColor(
    label: string,
    event: string,
    value: string,
    onScrub: (next: string) => void,
  ): TemplateResult {
    return html`
      <div class="mb-2">
        <label class="form-label text-light">${label}</label>
        <input
          type="color"
          aria-event=${event}
          class="form-control bg-default form-control-color"
          title="Choose your color"
          .value=${value}
          @input=${(e: Event) => onScrub((e.target as HTMLInputElement).value)}
          @change=${this.commit}
        />
      </div>
    `;
  }

  private renderStroke(stroke: ClipStroke): TemplateResult {
    const ids = this.targets;
    return html`
      <div class="mb-3">
        ${this.renderHeading("Border", "decoration-stroke", stroke.enable, () =>
          this.write((doc) =>
            setClipStrokeMany(doc, ids, { enable: !stroke.enable }),
          ),
        )}
        ${stroke.enable
          ? html`
              ${this.renderRow(
                STROKE_ROWS.width,
                stroke.width,
                (width) => this.scrubStroke({ width }),
                (width) =>
                  this.write((doc) => setClipStrokeMany(doc, ids, { width })),
              )}
              ${this.renderRow(
                STROKE_ROWS.opacity,
                stroke.opacity,
                (opacity) => this.scrubStroke({ opacity }),
                (opacity) =>
                  this.write((doc) => setClipStrokeMany(doc, ids, { opacity })),
              )}
              ${this.renderColor(
                "Border Color",
                "decoration-stroke-color",
                stroke.color,
                (color) => this.scrubStroke({ color }),
              )}
              <div class="mb-2">
                <label class="form-label text-light">Align</label>
                <div class="d-flex flex-row gap-1">
                  ${STROKE_ALIGNMENTS.map(
                    (align) => html`
                      <button
                        class="btn btn-xxs ${stroke.align === align
                          ? "btn-primary"
                          : "btn-default"} text-light flex-fill"
                        aria-event="decoration-align-${align}"
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
          : ""}
      </div>
    `;
  }

  private renderShadow(shadow: ClipShadow): TemplateResult {
    const ids = this.targets;
    const row = (
      key: keyof typeof SHADOW_ROWS,
      value: number,
    ): TemplateResult =>
      this.renderRow(
        SHADOW_ROWS[key],
        value,
        (next) => this.scrubShadow({ [key]: next } as ShadowPatch),
        (next) =>
          this.write((doc) =>
            setClipShadowMany(doc, ids, { [key]: next } as ShadowPatch),
          ),
      );

    return html`
      <div class="mb-3">
        ${this.renderHeading("Shadow", "decoration-shadow", shadow.enable, () =>
          this.write((doc) =>
            setClipShadowMany(doc, ids, { enable: !shadow.enable }),
          ),
        )}
        ${shadow.enable
          ? html`
              ${row("offsetX", shadow.offsetX)}
              ${row("offsetY", shadow.offsetY)} ${row("blur", shadow.blur)}
              ${row("opacity", shadow.opacity)}
              ${this.renderColor(
                "Shadow Color",
                "decoration-shadow-color",
                shadow.color,
                (color) => this.scrubShadow({ color }),
              )}
            `
          : ""}
      </div>
    `;
  }

  render() {
    if (this.targets.length === 0) {
      return html``;
    }
    const { stroke, shadow } = this.fields;
    return html`${this.renderStroke(stroke)}${this.renderShadow(shadow)}`;
  }
}
