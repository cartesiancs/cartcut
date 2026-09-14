/**
 * The Shape section: a clip's parametric outline, in the Media pane.
 *
 * A section rather than a tab. The tab bar is already four wide and turns into
 * a size container past that (`optionTabBar.ts`), and this is a property of the
 * shape rather than a mode of working on it, so it sits with the fill colour it
 * belongs beside.
 *
 * Every write goes through `timeline/shapeOps.ts`, the same ops `set_shape`
 * uses, and a slider drag goes through `GestureCommit`, so one drag is one undo
 * step however many values it passed through. Laid out the way
 * `optionAdjustSection` is laid out, and for the reason stated there: the
 * inspector column is narrow, and a slider sharing its line with a label and a
 * number box is left about seventy pixels to travel its whole range.
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
  option-shape-section .shape-range {
    display: block;
    width: 100%;
    height: 1.1rem;
    padding: 0;
    margin: 0;
  }
  option-shape-section .shape-corner-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
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
      <div class="mb-2" data-shape-row=${key}>
        <div class="d-flex align-items-center justify-content-between" style="gap: 8px;">
          <label class="text-light text-truncate mb-0" style="font-size: 11px;">
            ${spec.label}${spec.suffix === "" ? "" : ` (${spec.suffix})`}
          </label>
          <input
            type="number"
            class="form-control form-control-sm bg-default text-light text-end px-1 py-0 flex-shrink-0"
            style="width: 3.8em; font-size: 11px; height: 20px;"
            min=${String(spec.min)}
            max=${String(spec.max)}
            step=${String(spec.step)}
            .value=${String(value)}
            @change=${(e: Event) => this.typed(key, e)}
          />
        </div>
        <input
          type="range"
          class="form-range shape-range mt-1"
          min=${String(spec.min)}
          max=${String(spec.max)}
          step=${String(spec.step)}
          .value=${String(value)}
          @input=${(e: Event) =>
            this.scrub(this.patchFor(key, Number((e.target as HTMLInputElement).value)))}
          @change=${this.commit}
        />
      </div>
    `;
  }

  private typed(key: RowKey, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) {
      // Put the box back to what the document says rather than writing a NaN.
      this.requestUpdate();
      return;
    }
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

    const setAll = (value: number): ShapeGeometryPatch => ({ radius: value });
    const setOne = (index: number, value: number): ShapeGeometryPatch => {
      const next = [...radii] as CornerRadii;
      next[index] = value;
      return this.radiusPatch(next);
    };

    return html`
      <div class="mb-2" data-shape-row="radius">
        <div class="d-flex align-items-center justify-content-between" style="gap: 8px;">
          <label class="text-light text-truncate mb-0" style="font-size: 11px;">
            Corner radius
          </label>
          <div class="d-flex align-items-center" style="gap: 4px;">
            <input
              type="number"
              class="form-control form-control-sm bg-default text-light text-end px-1 py-0 flex-shrink-0"
              style="width: 3.8em; font-size: 11px; height: 20px;"
              min="0"
              step="1"
              .value=${String(Math.round(radii[0]))}
              @change=${(e: Event) => {
                const value = Number((e.target as HTMLInputElement).value);
                if (!Number.isFinite(value)) {
                  this.requestUpdate();
                  return;
                }
                const ids = this.targets;
                this.write((doc) => setClipShapeGeometryMany(doc, ids, setAll(value)));
              }}
            />
            ${perCorner
              ? html`<button
                  class="btn btn-xs ${this.linkedCorners
                    ? "btn-primary"
                    : "btn-default"} text-light m-0 p-0"
                  style="width: 20px; height: 20px;"
                  title=${this.linkedCorners
                    ? "Corners are linked. Click to set each one."
                    : "Corners are separate. Click to link them."}
                  @click=${() => {
                    this.linkedCorners = !this.linkedCorners;
                    this.requestUpdate();
                  }}
                >
                  <span class="material-symbols-outlined icon-xs">
                    ${this.linkedCorners ? "link" : "link_off"}
                  </span>
                </button>`
              : ""}
          </div>
        </div>
        <input
          type="range"
          class="form-range shape-range mt-1"
          min="0"
          max=${String(ceiling)}
          step="1"
          .value=${String(Math.min(ceiling, Math.round(radii[0])))}
          @input=${(e: Event) =>
            this.scrub(setAll(Number((e.target as HTMLInputElement).value)))}
          @change=${this.commit}
        />
        ${perCorner && !this.linkedCorners
          ? html`<div class="shape-corner-grid mt-1">
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
                      class="form-control form-control-sm bg-default text-light text-center px-1 py-0"
                      style="font-size: 11px; height: 20px;"
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
                        const ids = this.targets;
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
      <div class="d-flex gap-1 mb-2">
        ${SHAPE_GEOMETRY_KINDS.map(
          (kind) => html`
            <button
              class="btn btn-xxs ${current === kind
                ? "btn-primary"
                : "btn-default"} text-light m-0 flex-grow-1"
              data-shape-kind=${kind}
              title=${KIND_LABELS[kind]}
              @click=${() => this.chooseKind(kind)}
            >
              <span class="material-symbols-outlined icon-xs">
                ${KIND_ICONS[kind]}
              </span>
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

    return html`
      <style>
        ${STYLES}
      </style>
      <div class="mb-3">
        <label class="form-label text-light">Shape</label>
        ${this.renderKindRow(geometry?.kind ?? null)}
        ${geometry == null
          ? html`<div class="text-light" style="font-size: 10px; opacity: 0.7;">
              This shape was drawn by hand. Choosing a kind replaces its
              outline.
            </div>`
          : html`
              ${ROWS[geometry.kind].map((key) => this.renderRow(key, geometry))}
              ${this.renderCorners(geometry)}
            `}
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Fill Color</label>
        <input
          type="color"
          aria-event="font-color"
          class="form-control bg-default form-control-color"
          title="Choose your color"
          .value=${this.fillColor}
          @input=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            const ids = this.targets;
            this.gesture.apply((doc) => setClipFillColorMany(doc, ids, value));
            this.requestUpdate();
          }}
          @change=${this.commit}
        />
      </div>
    `;
  }
}
