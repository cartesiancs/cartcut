/**
 * Which rasters and which GL generator a graphic draws with right now.
 *
 * The rule `asset/videoScope.ts` states for decoders, applied to graphics: an
 * export owns what it draws with. The preview keeps one set (its generator, the
 * latest HTML raster per clip), and an export or a contact sheet opens a scope
 * of its own for the length of one synchronous composite, so editing during a
 * render cannot change the picture under the frame loop.
 *
 * A dynamic extent rather than a table, because `App.ts` installs the *export*
 * renderer table for templates even in the preview: which table drew a graphic
 * says nothing about which caller it belongs to. The same constraint as the
 * video scope follows: the draw must be synchronous, and there is no fallback
 * to the preview's set from inside a scope.
 */

import type { GraphicGl } from "../renderer/graphicGl";

export type GraphicScope = {
  readonly id: string;
  /** This caller's own generator. Created blocking, disposed by the caller. */
  readonly gl: GraphicGl | null;
  /** The frame grid this caller snaps to. */
  readonly fps: number;
  /**
   * HTML rasters for this frame, by element id (namespaced inside a template).
   * Cleared and refilled before every composite; a clip missing from it draws
   * nothing rather than a raster from some other frame.
   */
  readonly rasters: Map<string, CanvasImageSource>;
};

let active: GraphicScope | null = null;

export function activeGraphicScope(): GraphicScope | null {
  return active;
}

/**
 * Run `draw` with `scope` answering every graphic lookup. **`draw` must be
 * synchronous**; restores the previous scope even when it throws.
 */
export function withGraphicScope<T>(scope: GraphicScope | null, draw: () => T): T {
  const previous = active;
  active = scope;
  try {
    return draw();
  } finally {
    active = previous;
  }
}

export function createGraphicScope(
  id: string,
  gl: GraphicGl | null,
  fps: number,
): GraphicScope {
  return { id, gl, fps, rasters: new Map() };
}

/**
 * Whether a document holds a graphic anywhere, templates included when they
 * are passed expanded. What lets an export or a contact sheet skip creating a
 * generator and a host for the overwhelming majority of projects.
 */
export function hasGraphicElements(elements: Record<string, { filetype?: string }>): boolean {
  for (const element of Object.values(elements)) {
    if (element?.filetype === "graphic") {
      return true;
    }
  }
  return false;
}
