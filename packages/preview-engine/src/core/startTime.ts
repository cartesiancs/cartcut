/**
 * Resolve an element's effective start time in ms.
 *
 * Text elements can be parented to another clip (`parentKey`); their start is
 * offset by the parent's start time. All other elements start at their own
 * `startTime`. Previously duplicated inline in every renderer's frame loop.
 */

import type { RenderElement, RenderTimeline } from "../model/timeline.types";

export function resolveStartTime(
  el: RenderElement,
  timeline: RenderTimeline,
): number {
  const own = Number(el.startTime) || 0;
  if (el.filetype === "text" && el.parentKey && el.parentKey !== "standalone") {
    const parent = timeline[el.parentKey];
    const parentStart = parent ? Number(parent.startTime) || 0 : 0;
    return own + parentStart;
  }
  return own;
}
