/**
 * The Shape section: a clip's parametric outline, and its fill, in the Media
 * pane.
 *
 * A section rather than a tab. The tab bar is already four wide and turns into a
 * size container past that (`optionTabBar.ts`), and this is a property of the
 * shape rather than a mode of working on it, so it sits with the fill colour it
 * belongs beside.
 *
 * **A fixed section, not a choose-one.** The clip *is* a shape, so there is
 * nothing to add and nothing to take off: its head carries the eye that folds
 * the controls away rather than the `+` the LUT section offers. Which of the two
 * a section shows is the whole difference between the two kinds in the
 * inspector, and both are drawn by `optionKit.ts`.
 *
 * Every write goes through `timeline/shapeOps.ts`, the same ops `set_shape`
 * uses, and a slider drag goes through `GestureCommit`, so one drag is one undo
 * step however many values it passed through.
 *
 * **A shape with no recipe is offered one.** That is every polygon clicked out
 * by hand and every shape made before recipes existed. Choosing a kind replaces
 * the outline, which the panel says before it happens, and it is one undo step.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  SHAPE_GEOMETRY_KINDS,
  type CornerRadii,
  type ShapeGeometry,
  type ShapeGeometryKind,
} from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { shapeGeometryOf, type ShapeGeometryPatch } from "../shape/shapeGeometry";
import {
  cornerRadiiOf,
  countOf,
  holeOf,
  innerRatioOf,
  MAX_SHAPE_COUNT,
  MIN_SHAPE_COUNT,
} from "../shape/shapeOutline";
import type { TimelineDocument } from "../timeline/tracks";
import {
  isShapeElement,
  setClipFillColorMany,
  setClipShapeGeometryMany,
} from "../timeline/shapeOps";
import { GestureCommit } from "./gestureCommit";
import { eyeButton, iconButton, section, sliderField } from "./optionKit";

/** The icon each kind is offered under, in the order the row shows them. */
const KIND_ICONS: Record<ShapeGeometryKind, string> = {
  rectangle: "square",
  ellipse: "circle",
  polygon: "pentagon",
  star: "star",
};

const KIND_LABELS: Record<ShapeGeometryKind, string> = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
};

/** The numeric rows each kind offers, in the order they are shown. */
type RowKey = "count" | "innerRatio" | "arcStart" | "arcSweep" | "hole";

const ROWS: Record<ShapeGeometryKind, RowKey[]> = {
  rectangle: [],
  ellipse: ["arcStart", "arcSweep", "hole"],
  polygon: ["count"],
  star: ["count", "innerRatio"],
};

type RowSpec = { label: string; min: number; max: number; step: number; suffix: string };

const ROW_SPECS: Record<RowKey, RowSpec> = {
  count: { label: "Count", min: MIN_SHAPE_COUNT, max: MAX_SHAPE_COUNT, step: 1, suffix: "" },
  // Stored 0 to 1, shown as a percentage: a star's waist reads far better as
  // "38%" than as "0.38", and it is the number Figma shows too.
  innerRatio: { label: "Point depth", min: 0, max: 100, step: 1, suffix: "%" },
  arcStart: { label: "Arc start", min: 0, max: 360, step: 1, suffix: "°" },
  arcSweep: { label: "Arc sweep", min: 0, max: 360, step: 1, suffix: "°" },
  hole: { label: "Hole", min: 0, max: 100, step: 1, suffix: "%" },
};

const STYLES = `
  option-shape-section .shape-corner-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-top: 6px;
  }
`;

@customElement("option-shape-section")
export class OptionShapeSection extends LitElement {
  @property({ attribute: false })
  elementIds: string[] = [];

  /**
   * Whether the four corners are edited together.
   *
   * Component state, not document state: it is how the user is working, not
   * something about the clip. A recipe whose four radii differ opens unlinked,
   * because showing one number for four different ones would be a lie the first
   * drag would make true.
   */
  private linkedCorners = true;

  /**
   * Whether the section's controls are showing. Component state for the same
   * reason: it is where the user is looking.
   */
  private open = true;

  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // Or the timeline canvas's document-level mousedown clears the selection
    // before the slider receives its own.
    this.setAttribute("data-keeps-selection", "");
    // A spinner drag abandoned with Escape. `onCancel` bubbles, so one listener
    // covers every field.
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

  private get geometry(): ShapeGeometry | null {
    const first = this.targets[0];
    return first == null
      ? null
      : shapeGeometryOf(useTimelineStore.getState().timeline[first]);
  }

  private get fillColor(): string {
    const first = this.targets[0];
    if (first == null) {
      return "#ffffff";
    }
    const element: any = useTimelineStore.getState().timeline[first];
    return element?.option?.fillColor ?? "#ffffff";
  }

  /**
   * The largest radius worth offering: half the clip's shorter side.
   *
   * Past that the corners of a rectangle meet and it is a stadium, so the
   * slider has nowhere further to go. `roundCorners` caps the trim itself, so a
   * larger number typed into the box is harmless rather than rejected.
   */
  private get radiusCeiling(): number {
    const first = this.targets[0];
    const element: any =
      first == null ? null : useTimelineStore.getState().timeline[first];
    const shorter = Math.min(
      Number(element?.width) || 100,
      Number(element?.height) || 100,
    );
    return Math.max(1, Math.round(shorter / 2));
  }

  private scrub(patch: ShapeGeometryPatch): void {
    const ids = this.targets;
    this.gesture.apply((doc) => setClipShapeGeometryMany(doc, ids, patch));
    this.requestUpdate();
  }

  private commit = (): void => {
    this.gesture.flush();
    this.requestUpdate();
  };

  /** One immediate step, for a discrete choice or a typed value. */
  private write(fn: (doc: TimelineDocument) => TimelineDocument): void {
    this.gesture.flush();
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private chooseKind(kind: ShapeGeometryKind): void {
    const ids = this.targets;
    this.write((doc) => setClipShapeGeometryMany(doc, ids, { kind }));
  }

  private patchFor(key: RowKey, value: number): ShapeGeometryPatch {
    const geometry = this.geometry;
    switch (key) {
      case "count":
        return { count: Math.round(value) };
      case "innerRatio":
        return { innerRatio: value / 100 };
      case "hole":
        return { hole: value / 100 };
      case "arcStart":
        return { arc: { start: value, sweep: geometry?.arc?.sweep ?? 360 } };
      case "arcSweep":
        return { arc: { start: geometry?.arc?.start ?? 0, sweep: value } };
    }
  }

  /**
   * The number a row shows, resolved from the recipe.
   *
   * Not called `valueOf`. That name is `Object.prototype`'s, and overriding it
   * with a different signature makes the class no longer assignable to
   * `Object`, which makes lit's `@property` decorator fail to resolve its
   * overload with an error that names neither this method nor that reason.
   */
  private rowValue(key: RowKey, geometry: ShapeGeometry): number {
    switch (key) {
      case "count":
        return countOf(geometry);
      case "innerRatio":
        return Math.round(innerRatioOf(geometry) * 100);
      case "hole":
        return Math.round(holeOf(geometry) * 100);
      case "arcStart":
        return geometry.arc?.start ?? 0;
      case "arcSweep":
        return geometry.arc?.sweep ?? 360;
    }
  }

  private renderRow(key: RowKey, geometry: ShapeGeometry): TemplateResult {
    const spec = ROW_SPECS[key];
    const value = this.rowValue(key, geometry);
    return html`
      <div class="opt-field" data-shape-row=${key}>
        ${sliderField({
          label: spec.label,
          suffix: spec.suffix,
          value,
          min: spec.min,
          max: spec.max,
          step: spec.step,
          onScrub: (next) => this.scrub(this.patchFor(key, next)),
          onCommit: this.commit,
          onTyped: (next) => this.typed(key, next),
          onInvalid: () => this.requestUpdate(),
        })}
      </div>
    `;
  }

  private typed(key: RowKey, value: number): void {
    const patch = this.patchFor(key, value);
    const ids = this.targets;
    this.write((doc) => setClipShapeGeometryMany(doc, ids, patch));
  }

  private radiusPatch(radii: CornerRadii): ShapeGeometryPatch {
    // Four equal corners canonicalise back to one number inside
    // `normalizeShapeGeometry`, so the linked and unlinked paths cannot write
    // two different spellings of the same rounding.
    return { radius: radii };
  }

  private renderCorners(geometry: ShapeGeometry): TemplateResult {
    const radii = cornerRadiiOf(geometry);
    const ceiling = this.radiusCeiling;
    const perCorner = geometry.kind === "rectangle";
    const labels = ["Top left", "Top right", "Bottom right", "Bottom left"];
    const ids = this.targets;

    const setAll = (value: number): ShapeGeometryPatch => ({ radius: value });
    const setOne = (index: number, value: number): ShapeGeometryPatch => {
      const next = [...radii] as CornerRadii;
      next[index] = value;
      return this.radiusPatch(next);
    };

    return html`
      <div class="opt-field" data-shape-row="radius">
        ${sliderField({
          label: "Corner radius",
          value: Math.round(radii[0]),
          // The box accepts any radius, so a number past the ceiling is kept
          // rather than rejected; the track can only draw as far as it goes.
          rangeValue: Math.min(ceiling, Math.round(radii[0])),
          min: 0,
          max: ceiling,
          trailing: perCorner
            ? iconButton({
                icon: this.linkedCorners ? "link" : "link_off",
                title: this.linkedCorners
                  ? "Corners are linked. Click to set each one."
                  : "Corners are separate. Click to link them.",
                on: this.linkedCorners,
                onClick: () => {
                  this.linkedCorners = !this.linkedCorners;
                  this.requestUpdate();
                },
              })
            : undefined,
          onScrub: (next) => this.scrub(setAll(next)),
          onCommit: this.commit,
          onTyped: (next) =>
            this.write((doc) => setClipShapeGeometryMany(doc, ids, setAll(next))),
          onInvalid: () => this.requestUpdate(),
        })}
        ${perCorner && !this.linkedCorners
          ? html`<div class="shape-corner-grid">
              ${
                // Laid out **where the corners are**, not in the order they are
                // stored. The column is too narrow to carry a written label
                // beside each box, and the 2x2 arrangement says which corner is
                // which on its own, which is how Figma does it too. The stored
                // order is clockwise, so reading order needs 0, 1, 3, 2.
                [0, 1, 3, 2].map(
                  (index) => html`
                    <input
                      type="number"
                      class="opt-num opt-num-center"
                      data-corner=${index}
                      title=${labels[index]}
                      aria-label=${labels[index]}
                      min="0"
                      step="1"
                      .value=${String(Math.round(radii[index]))}
                      @change=${(e: Event) => {
                        const value = Number((e.target as HTMLInputElement).value);
                        if (!Number.isFinite(value)) {
                          this.requestUpdate();
                          return;
                        }
                        this.write((doc) =>
                          setClipShapeGeometryMany(doc, ids, setOne(index, value)),
                        );
                      }}
                    />
                  `,
                )
              }
            </div>`
          : ""}
      </div>
    `;
  }

  private renderKindRow(current: ShapeGeometryKind | null): TemplateResult {
    return html`
      <div class="opt-seg" role="group" aria-label="Shape kind">
        ${SHAPE_GEOMETRY_KINDS.map(
          (kind) => html`
            <button
              type="button"
              class="opt-seg-item ${current === kind ? "is-on" : ""}"
              data-shape-kind=${kind}
              title=${KIND_LABELS[kind]}
              aria-label=${KIND_LABELS[kind]}
              aria-pressed=${current === kind ? "true" : "false"}
              @click=${() => this.chooseKind(kind)}
            >
              <span class="material-symbols-outlined">${KIND_ICONS[kind]}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  render(): TemplateResult {
    if (this.targets.length === 0) {
      return html``;
    }
    const geometry = this.geometry;
    const fill = this.fillColor;

    return html`
      <style>
        ${STYLES}
      </style>
      ${section({
        title: "Shape",
        actions: eyeButton(this.open, this.open ? "Hide" : "Show", () => {
          this.open = !this.open;
          this.requestUpdate();
        }),
        body: this.open
          ? html`
              <div class="opt-field">${this.renderKindRow(geometry?.kind ?? null)}</div>
              ${geometry == null
                ? html`<div class="opt-field opt-hint">
                    <span class="material-symbols-outlined opt-hint-icon"
                      >info</span
                    >
                    Drawn by hand. A kind replaces the outline.
                  </div>`
                : html`
                    ${ROWS[geometry.kind].map((key) => this.renderRow(key, geometry))}
                    ${this.renderCorners(geometry)}
                  `}
            `
          : undefined,
      })}
      ${section({
        title: "Fill",
        actions: html`
          <span class="opt-value">${fill.toUpperCase()}</span>
          <input
            type="color"
            class="opt-swatch"
            aria-event="font-color"
            title="Fill color"
            .value=${fill}
            @input=${(e: Event) => {
              const value = (e.target as HTMLInputElement).value;
              const ids = this.targets;
              this.gesture.apply((doc) => setClipFillColorMany(doc, ids, value));
              this.requestUpdate();
            }}
            @change=${this.commit}
          />
        `,
      })}
    `;
  }
}
