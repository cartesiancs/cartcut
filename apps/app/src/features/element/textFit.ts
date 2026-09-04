/**
 * Keeping a text clip's box the size of the text in it.
 *
 * `element.height` used to be the line advance, so it was an *input* to the
 * layout: growing the box pushed the lines apart. Now the advance comes from
 * `text/metrics.ts` and the height is a *consequence* — the box a text tool
 * draws around what you typed, which is how every NLE behaves.
 *
 * Nothing else in the app has to know. The selection outline, the hit test, the
 * eight resize grips, the rotation pivot and the Size panel all already read
 * `height`; they simply start getting a number that means what they assume it
 * means.
 *
 * Why this lives in `features/element/` and not `features/timeline/`: measuring
 * text needs a canvas, and the pure ops are deliberately DOM-free so they run
 * under `environment: "node"`. `fittedHeightWith` takes the context so the node
 * suites can hand it a Skia one — the same split `renderer/surface.ts` uses.
 *
 * The fit is best-effort. It runs where layout-affecting edits commit, not on a
 * timer and not from `normalizeDocument` (which runs on every checkpoint and
 * has no canvas). A height that has gone stale costs a slightly wrong selection
 * box and pivot, never a wrong picture — the drawing reads the advance, which
 * is always correct.
 */

import type { TextElementType, TimelineElement } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import { measureTextBlock } from "../renderer/text";
import { defaultTextHeight } from "../text/metrics";

/**
 * The property paths that change how tall a text block is.
 *
 * A typed height holds until the text moves under it, so the fit has to know
 * which edits count. Colour, alignment and every effect are absent on purpose:
 * they repaint the same block at the same size, and re-fitting on them would
 * throw away a box the user set by hand for no reason at all.
 *
 * `width` is in here because on a text clip it is the *wrapping* width —
 * narrowing a caption gives it more lines.
 */
const RE_FITTING_PATHS = new Set([
  "width",
  "text",
  "fontsize",
  "letterSpacing",
  "options.lineHeight",
  "options.isBold",
  "options.isItalic",
  "options.textTransform",
]);

/** Does writing these paths change the size of the block? */
export function affectsTextBlock(paths: string[][]): boolean {
  return paths.some((path) => RE_FITTING_PATHS.has(path.join(".")));
}

/**
 * The height this element's box should have, measured with `ctx`.
 *
 * Rounded up: a fractional box leaves the bottom row of a descender outside the
 * selection outline and outside the canvas rasterisation sizes from.
 */
export function fittedHeightWith(
  ctx: CanvasRenderingContext2D,
  element: TextElementType,
): number {
  const { blockHeight } = measureTextBlock(ctx, element);
  if (!Number.isFinite(blockHeight) || blockHeight <= 0) {
    return defaultTextHeight(element.fontsize);
  }
  return Math.max(1, Math.ceil(blockHeight));
}

/**
 * A scratch context to measure against, or `null` where there is no DOM.
 *
 * One canvas for the whole module rather than one per call: `measureTextBlock`
 * sets `font` and `letterSpacing` on it every time, so nothing carries over,
 * and creating an element per keystroke is pure garbage. `rasterizeText.ts`
 * uses the same probe idea for the same reason.
 */
let probe: HTMLCanvasElement | null = null;
function probeContext(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") {
    return null;
  }
  if (probe == null) {
    probe = document.createElement("canvas");
  }
  return probe.getContext("2d");
}

/** The measured height, or `null` when nothing can be measured. */
export function fittedHeightOf(element: TextElementType): number | null {
  const ctx = probeContext();
  return ctx == null ? null : fittedHeightWith(ctx, element);
}

/**
 * Re-fit the boxes of the named text clips.
 *
 * Returns its input **by identity** when no height moved, which is what lets
 * callers fold this into a `withCheckpoint` without turning every colour change
 * into an undo step. Ids that are missing, or that name something other than
 * text, are skipped rather than refused — callers hand it a whole selection.
 *
 * `ctx` is injectable for the node suites; production callers omit it and get
 * the shared probe.
 */
export function withFittedTextHeights(
  doc: TimelineDocument,
  elementIds: string[],
  ctx: CanvasRenderingContext2D | null = probeContext(),
): TimelineDocument {
  if (ctx == null || elementIds.length === 0) {
    return doc;
  }

  let elements: Record<string, TimelineElement> | null = null;

  for (const elementId of elementIds) {
    const element = doc.elements[elementId];
    if (element == null || element.filetype !== "text") {
      continue;
    }

    // A keyframed height is authored rather than derived, so the fit has
    // nothing to say about it. It would also be invisible: the sampled height
    // is what reaches the renderer, so writing a static one changes no pixels
    // while still dirtying the document — an undo step per width scrub for a
    // number nobody can see.
    if ((element as any).animation?.size?.isActivate === true) {
      continue;
    }

    const height = fittedHeightWith(ctx, element);
    if (height === element.height) {
      continue;
    }

    elements ??= { ...doc.elements };
    elements[elementId] = { ...element, height };
  }

  return elements == null ? doc : { ...doc, elements };
}
