import {
  isVisualTimelineElement,
  type Timeline,
  type VisualTimelineElement,
} from "../../@types/timeline";
import { isElementVisibleAtTime } from "../element/time";
import { createMemo } from "../timeline/transform";
import { renderElement } from "./element";
import type { ElementRenderFunction } from "./type";

export type TimelineRenderers = {
  [K in VisualTimelineElement["filetype"]]: ElementRenderFunction<
    Extract<VisualTimelineElement, { filetype: K }>
  >;
};

type OutlineOption = {
  controlOutlineEnabled: boolean;
  activeElementId: string;
};

export function renderTimelineAtTime(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  timeInMs: number,
  renderers: TimelineRenderers,
  backgroundColor: string,
  width: number,
  height: number,
  outlineOptions: OutlineOption = {
    controlOutlineEnabled: false,
    activeElementId: "",
  },
  callbackPerElementRender?: (
    elementId: string,
    element: VisualTimelineElement,
  ) => void,
) {
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // TODO: sorting on every render is inefficient, should be optimized
  const prioritySortedTimeline = Object.entries(timeline).sort(
    ([, a], [, b]) => a.priority - b.priority,
  );

  // One cache for the whole frame, discarded with it. The matrices it holds are
  // resolved at `timeInMs`, so reusing it across frames would draw the previous
  // one; within a frame it turns every sibling's chain walk into a lookup.
  const memo = createMemo();
  const context = { elements: timeline, memo };

  for (const [elementId, element] of prioritySortedTimeline) {
    // Audio has no picture, and a group draws nothing — it exists only to hold
    // a transform for its children, which they collect through `parentId` in
    // `context` rather than through anything that happens in this loop.
    if (!isVisualTimelineElement(element)) {
      continue;
    }

    // Deliberately the element's *own* span. A group's span does not gate its
    // children: parenting here is spatial only, as it is in After Effects, and
    // a caption parented to a title block must not vanish because the block's
    // bar on the timeline is shorter than the caption's.
    if (!isElementVisibleAtTime(timeInMs, timeline, element)) {
      continue;
    }

    renderElement(
      ctx,
      elementId,
      element,
      timeInMs,
      outlineOptions.controlOutlineEnabled &&
        elementId === outlineOptions.activeElementId,
      renderers[element.filetype] as ElementRenderFunction<typeof element>,
      context,
    );

    callbackPerElementRender?.(elementId, element);
  }
}
