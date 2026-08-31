import {
  isVisualTimelineElement,
  type Timeline,
  type VisualTimelineElement,
} from "../../@types/timeline";
import { isElementVisibleAtTime } from "../element/time";
import { createMemo } from "../timeline/transform";
import { renderElement } from "./element";
import { effectTimeOf } from "./fx/effectTime";
import { planFrame, type FramePlan } from "./fx/planFrame";
import type { FxRuntime } from "./fx/runtime";
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

/**
 * `Object.entries().sort()` per frame, keyed by document identity.
 *
 * Every edit returns a whole new `Timeline` object, so identity is a sound
 * cache key: a document that is `===` to one already sorted cannot have had an
 * element added, removed, or re-prioritised. `WeakMap` so a superseded
 * document does not pin its entry.
 */
const sortedByPriority = new WeakMap<
  Timeline,
  [string, Timeline[string]][]
>();

function prioritySorted(timeline: Timeline): [string, Timeline[string]][] {
  const cached = sortedByPriority.get(timeline);
  if (cached != null) {
    return cached;
  }
  const sorted = Object.entries(timeline).sort(
    ([, a], [, b]) => a.priority - b.priority,
  );
  sortedByPriority.set(timeline, sorted);
  return sorted;
}

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
  /**
   * Effects and transitions, or `null` to skip them entirely.
   *
   * A trailing optional so every existing call site and every golden pixel
   * suite compiles and behaves exactly as before. It is `null` in the node test
   * environment, which has no WebGL, and in any caller that has not been wired
   * up yet — and in both cases this function takes the path it always took.
   */
  fx?: FxRuntime | null,
) {
  const plan =
    fx == null
      ? null
      : planFrame({
          elements: timeline,
          timeInMs,
          fps: fx.fps,
          modeOf: fx.modeOf,
        });

  // Nothing to composite: keep the original single-pass path, drawing straight
  // into the caller's context. This is the branch every existing suite takes.
  if (fx == null || plan == null || plan.empty) {
    paint(
      ctx,
      timeline,
      timeInMs,
      renderers,
      backgroundColor,
      width,
      height,
      outlineOptions,
      callbackPerElementRender,
      null,
      null,
    );
    return;
  }

  // A shader effect reads back what has been drawn, which only works at project
  // resolution under an identity transform. The preview's context is neither,
  // so the whole frame is composited into a scratch canvas and blitted once.
  const scratch = plan.needsScratch ? fx.compositor.scratchCtx(width, height) : null;
  const target = scratch ?? ctx;

  paint(
    target,
    timeline,
    timeInMs,
    renderers,
    backgroundColor,
    width,
    height,
    outlineOptions,
    callbackPerElementRender,
    plan,
    fx,
  );

  if (scratch != null) {
    fx.compositor.flushScratch(ctx, width, height);
  }
}

function paint(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  timeInMs: number,
  renderers: TimelineRenderers,
  backgroundColor: string,
  width: number,
  height: number,
  outlineOptions: OutlineOption,
  callbackPerElementRender:
    | ((elementId: string, element: VisualTimelineElement) => void)
    | undefined,
  plan: FramePlan | null,
  fx: FxRuntime | null,
): void {
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  const prioritySortedTimeline = prioritySorted(timeline);

  // One cache for the whole frame, discarded with it. The matrices it holds are
  // resolved at `timeInMs`, so reusing it across frames would draw the previous
  // one; within a frame it turns every sibling's chain walk into a lookup.
  const memo = createMemo();
  const context = { elements: timeline, memo };

  /**
   * The same context, marked as drawing into a buffer holding one clip alone.
   *
   * Built once per frame rather than spread at each `drawOne` call, so the
   * transform memo is shared with the main loop instead of being rebuilt.
   */
  const isolatedContext = { ...context, isolated: true };

  /**
   * Draw one element by itself into some other context.
   *
   * Handed to the compositor so a transition can render its two clips into
   * separate buffers. It goes through the same `renderElement` as the main loop,
   * which is what makes a clip's own transform, opacity, keyframes and group
   * parenting apply inside a transition exactly as they do outside one.
   *
   * Blend is the one thing that does *not* carry across — see
   * `ElementRenderContext.isolated`. The buffer it draws into is transparent and
   * empty, so there is nothing under the clip to blend with.
   */
  const drawOne = (into: CanvasRenderingContext2D, elementId: string): void => {
    const element = timeline[elementId];
    if (element == null || !isVisualTimelineElement(element)) {
      return;
    }
    renderElement(
      into,
      elementId,
      element,
      timeInMs,
      false,
      renderers[element.filetype] as ElementRenderFunction<typeof element>,
      isolatedContext,
    );
  };

  for (const [elementId, element] of prioritySortedTimeline) {
    if (plan != null && fx != null) {
      const transition = plan.transitions.get(elementId);
      if (transition != null) {
        const preset = fx.presetOf(transition.element.presetId);
        if (preset != null) {
          fx.compositor.drawTransition(
            ctx,
            transition,
            preset,
            width,
            height,
            drawOne,
          );
        }
        continue;
      }
      // The other half of the pair, already drawn by the transition above.
      if (plan.claimed.has(elementId)) {
        continue;
      }

      const effect = plan.effects.get(elementId);
      if (effect != null) {
        const preset = fx.presetOf(effect.element.presetId);
        if (preset != null) {
          fx.compositor.applyEffect(
            ctx,
            effect,
            preset,
            width,
            height,
            effect.mode === "overlay"
              ? fx.overlayFrameFor(elementId, effect.element, timeInMs)
              : null,
            effect.mode === "lut" ? fx.lutFor(effect.element.presetId) : null,
            // Element-local and frame-snapped, so an animated effect runs the
            // same in the preview as in the render. See `fx/effectTime.ts`.
            effectTimeOf(effect.element, timeInMs, fx.fps),
          );
        }
        continue;
      }
    }

    // Audio has no picture, and a group draws nothing — it exists only to hold
    // a transform for its children, which they collect through `parentId` in
    // `context` rather than through anything that happens in this loop. An
    // effect and a transition are excluded by the same guard: both are
    // whole-frame operations handled above, not elements that paint themselves.
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
