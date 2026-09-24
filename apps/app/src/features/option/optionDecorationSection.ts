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
const ALIGN_LABELS: Record<StrokeAlignment, string> = {
  inner: "Inside",
  center: "Centre",
  outer: "Outside",
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

const STYLES = `
  option-decoration-section .decor-range {
    display: block;
    width: 100%;
    height: 1.1rem;
    padding: 0;
    margin: 0;
  }
  option-decoration-section .decor-swatch {
    width: 100%;
    height: 22px;
    padding: 2px;
  }
`;

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

  private renderToggle(
    label: string,
    enabled: boolean,
    onToggle: () => void,
  ): TemplateResult {
    return html`
      <button
        type="button"
        class="btn btn-sm w-100 mb-2 ${enabled
          ? "btn-primary"
          : "btn-default"} text-light"
        style="font-size: 11px;"
        data-decor-toggle=${label}
        @click=${onToggle}
      >
        ${enabled ? "Disable" : "Enable"} ${label}
      </button>
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
          class="form-range decor-range mt-1"
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

  private renderColor(
    label: string,
    value: string,
    onPick: (next: string) => void,
  ): TemplateResult {
    return html`
      <div class="mb-2">
        <label class="text-light mb-1 d-block" style="font-size: 11px;">
          ${label}
        </label>
        <input
          type="color"
          class="form-control form-control-sm form-control-color bg-default decor-swatch"
          .value=${value}
          @input=${(e: Event) => onPick((e.target as HTMLInputElement).value)}
        />
      </div>
    `;
  }

  private renderStroke(stroke: ClipStroke): TemplateResult {
    const ids = this.targets;
    return html`
      ${this.renderToggle("Border", stroke.enable, () =>
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
            ${this.renderColor("Border colour", stroke.color, (color) =>
              this.write((doc) => setClipStrokeMany(doc, ids, { color })),
            )}
            <div class="mb-2">
              <label class="text-light mb-1 d-block" style="font-size: 11px;">
                Align
              </label>
              <div class="btn-group w-100" role="group">
                ${STROKE_ALIGNMENTS.map(
                  (align) => html`
                    <button
                      type="button"
                      class="btn btn-sm ${stroke.align === align
                        ? "btn-primary"
                        : "btn-default"} text-light"
                      style="font-size: 11px;"
                      data-decor-align=${align}
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
      ${this.renderToggle("Shadow", shadow.enable, () =>
        this.write((doc) =>
          setClipShadowMany(doc, ids, { enable: !shadow.enable }),
        ),
      )}
      ${shadow.enable
        ? html`
            ${row("offsetX", shadow.offsetX)} ${row("offsetY", shadow.offsetY)}
            ${row("blur", shadow.blur)} ${row("opacity", shadow.opacity)}
            ${this.renderColor("Shadow colour", shadow.color, (color) =>
              this.write((doc) => setClipShadowMany(doc, ids, { color })),
            )}
          `
        : ""}
    `;
  }

  render() {
    if (this.targets.length === 0) {
      return html``;
    }
    const { stroke, shadow } = this.fields;

    return html`
      <style>
        ${STYLES}
      </style>
      <hr class="border-secondary" />
      <span class="text-light mb-2 d-block" style="font-size: 12px;">
        Border and Shadow
      </span>
      ${this.renderStroke(stroke)} ${this.renderShadow(shadow)}
    `;
  }
}
