/**
 * Visibility windowing — is an element on screen at a given time?
 *
 * Single implementation of the static/dynamic windowing that was copy-pasted
 * into previewCanvas.drawCanvas, render.ts nextFrameRender and offscreen-render.
 * Semantics preserved exactly:
 *   - static (image/text/gif/shape): [start, start + duration)
 *   - dynamic (video): [start, start + duration/speed) AND [start+trim.start, start+trim.end)
 *   - audio contributes no visuals and is excluded from the visible set
 */

import type { RenderElement, RenderTimeline } from "../model/timeline.types";
import { getElementType } from "../model/elementType";
import { resolveStartTime } from "./startTime";

export function isElementVisibleAtTime(
  el: RenderElement,
  timeline: RenderTimeline,
  timeMs: number,
): boolean {
  if (el.filetype === "audio") return false;

  const startTime = resolveStartTime(el, timeline);
  const duration = Number(el.duration) || 0;
  const elementType = getElementType(el.filetype);

  let visible: boolean;
  if (elementType === "static") {
    visible = timeMs >= startTime && timeMs < startTime + duration;
  } else {
    const speed = Number(el.speed) || 1;
    visible = timeMs >= startTime && timeMs < startTime + duration / speed;
  }

  if (el.filetype === "video" && el.trim) {
    visible =
      visible &&
      timeMs >= startTime + el.trim.startTime &&
      timeMs < startTime + el.trim.endTime;
  }

  return visible;
}

/**
 * Ids of every element visible at `timeMs`, excluding audio, in insertion order.
 * Callers that need z-order should run `sortIdsByPriority` (they compose).
 */
export function getVisibleElementIds(
  timeline: RenderTimeline,
  timeMs: number,
): string[] {
  const ids: string[] = [];
  for (const id in timeline) {
    if (!Object.prototype.hasOwnProperty.call(timeline, id)) continue;
    if (isElementVisibleAtTime(timeline[id], timeline, timeMs)) ids.push(id);
  }
  return ids;
}
