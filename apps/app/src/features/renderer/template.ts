/**
 * Drawing a template: the one element whose picture is another timeline.
 *
 * `renderElement` has already done everything it does for an image by the time
 * this is called — the parent chain, the local matrix, the sampled box and
 * `globalAlpha` are all applied, and the context is in the element's own space
 * with the box at `(0, 0, width, height)`. So this renderer's whole job is to
 * put the referenced composition into that rectangle, and a template inherits
 * position, size, rotation, opacity, keyframes, group parenting and the control
 * outline without any of them knowing it exists.
 *
 * ## The layer, and why not `layerFor`
 *
 * The composition is drawn into a buffer of the template's **native** size and
 * blitted once. It cannot use `layerFor`: that keys on the destination canvas
 * and sizes to it, and both are wrong here — a template composes at its own
 * resolution, and `renderElement` may already be holding that destination's
 * blend layer for this very draw. `namedLayer` keys on the placed element's id
 * instead, so two instances of one template get two buffers.
 *
 * ## The transparent background
 *
 * `renderTimelineAtTime` fills its frame before it draws anything, so the
 * background colour passed in has to be fully transparent. A template is a
 * *layer*: painting the project's background inside it would blank everything
 * beneath it, and — this is the part that makes it worth a comment — the result
 * looks exactly like a template that is simply full-bleed. `templateComposite.test.ts`
 * pins it with a half-height clip and a coloured scene.
 *
 * ## What is deliberately not passed
 *
 * `fx` is `null`. Effects and transitions inside a template do not render:
 * `FxRuntime`'s compositor holds a single shared scratch surface, and entering
 * it from inside a nested render would have it clear the frame it is composing.
 * Making it re-entrant is the phase-2 work. Until then `paint` skips both
 * through `isVisualTimelineElement`, which is silent — so `templateExport.ts`
 * warns at the moment a template carrying them is written, where someone can
 * still do something about it.
 *
 * ## The resolver is injected
 *
 * Not imported. `templateRegistry.ts` reaches `window.electronAPI` and the
 * renderer suites have no such thing, and the same arrangement lets a test
 * drive the real drawing path against a document it built by hand. The same
 * choice `lutRegistry.installLutResolver` makes.
 */

import type { TemplateElementType, Timeline } from "../../@types/timeline";
import { composeTemplate, type TemplateData } from "../template/compose";
import { namedLayer } from "./surface";
import { renderTimelineAtTime, type TimelineRenderers } from "./timeline";

/** Fully transparent: `fillRect` with this over a cleared layer is a no-op. */
const TRANSPARENT = "rgba(0, 0, 0, 0)";

let resolveTemplate: (templateId: string) => TemplateData | null = () => null;
let renderers: TimelineRenderers | null = null;

/**
 * Point the template renderer at a registry and a renderer table.
 *
 * Called once at startup beside `installLutResolver()`, and by the renderer
 * suites with a table of their own.
 */
export function installTemplateResolver(
  resolve: (templateId: string) => TemplateData | null,
  table: TimelineRenderers,
): void {
  resolveTemplate = resolve;
  renderers = table;
}

/**
 * The composed document for one placed template, remembered between frames.
 *
 * Keyed on the `TemplateData` and then on the element object. Both are stable
 * by identity across frames — a pure op returns unchanged elements by
 * reference, so an edit elsewhere in the project does not invalidate this, and
 * an edit to *this* element's fills does. `WeakMap` throughout, so neither a
 * superseded element nor an uninstalled template is pinned.
 */
const composed = new WeakMap<
  TemplateData,
  WeakMap<TemplateElementType, Timeline>
>();

function compositionFor(
  data: TemplateData,
  elementId: string,
  element: TemplateElementType,
): Timeline {
  let byElement = composed.get(data);
  if (byElement == null) {
    byElement = new WeakMap();
    composed.set(data, byElement);
  }
  const hit = byElement.get(element);
  if (hit != null) {
    return hit;
  }
  const built = composeTemplate(data, elementId, element);
  byElement.set(element, built);
  return built;
}

/**
 * The template's own time at a project cursor.
 *
 * A straight offset, with no speed term: a template's rate is fixed along with
 * its length, so there is no `duration/speed` to divide by. Clamped to the
 * composition's own span, which only matters for a hand-edited document whose
 * bar is longer than the template it names — `isElementVisibleAtTime` has
 * already excluded everything outside the bar.
 */
export function innerCursorOf(
  element: TemplateElementType,
  timelineCursor: number,
  durationMs: number,
): number {
  const offset = timelineCursor - (Number(element.startTime) || 0);
  return Math.min(Math.max(offset, 0), Math.max(0, durationMs));
}

export function renderTemplate(
  ctx: CanvasRenderingContext2D,
  elementId: string,
  element: TemplateElementType,
  timelineCursor: number,
): void {
  const table = renderers;
  if (table == null) {
    return;
  }

  const data = resolveTemplate(element.templateId);
  // Not installed, not read yet, or unreadable — all three draw nothing and
  // report nothing. The contract `lutFor` already has, and the reason the bar
  // carries the template's `name`: something has to say what is missing, and
  // the picture is the wrong place for it.
  if (data == null) {
    return;
  }

  const nativeW = Number(data.size?.w) || 0;
  const nativeH = Number(data.size?.h) || 0;
  const layer = namedLayer(elementId, nativeW, nativeH);
  if (layer == null) {
    return;
  }

  renderTimelineAtTime(
    layer.ctx,
    compositionFor(data, elementId, element),
    innerCursorOf(element, timelineCursor, data.durationMs),
    table,
    TRANSPARENT,
    nativeW,
    nativeH,
    undefined,
    undefined,
    null,
  );

  const width = Number(element.width) || 0;
  const height = Number(element.height) || 0;
  if (!(width > 0) || !(height > 0)) {
    return;
  }

  // Into the element's local box, which is where every other renderer draws.
  // The context already carries the transform, so a rotated or animated
  // template needs nothing here.
  ctx.drawImage(
    layer.canvas,
    0,
    0,
    nativeW,
    nativeH,
    0,
    0,
    width,
    height,
  );
}
