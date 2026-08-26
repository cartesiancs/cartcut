/**
 * What the compositor has to do differently on this frame.
 *
 * Deciding it up front, as one pure function, rather than inside the paint
 * loop. Three reasons, in order of how much they matter:
 *
 *  1. **The scratch decision must be made before the first pixel is drawn.** A
 *     shader effect reads back the composited frame, which only works if the
 *     frame was composited into a canvas at project resolution with an identity
 *     transform. The preview's target is neither — it is device-sized and
 *     carries the viewport's pan and zoom. So either everything goes into a
 *     scratch canvas from the start, or nothing does; there is no way to
 *     discover halfway through that one was needed.
 *  2. **A transition draws two clips at once**, so the loop needs to know which
 *     ids to skip *before* it reaches them.
 *  3. It is testable under `environment: "node"`, where there is no WebGL. All
 *     the decisions live here; `FxCompositor` only executes them.
 *
 * The other property worth stating: when a document has no effects and no
 * transitions, this returns a plan that says "do nothing", and
 * `renderTimelineAtTime` takes byte-for-byte the path it always took. That is
 * what lets the existing golden pixel suites keep passing untouched.
 */

import type {
  EffectElementType,
  Timeline,
  TransitionElementType,
} from "../../../@types/timeline";
import { isTimeInRange } from "../../../utils/time";
import { spanOf } from "../../timeline/geometry";
import { progressOf, windowOf } from "../../timeline/transitionGeometry";

/** How a preset wants to be executed. `null` when it is not installed. */
export type PresetMode = "overlay" | "shader";

export type ActiveTransition = {
  id: string;
  element: TransitionElementType;
  fromId: string;
  toId: string;
  /** 0..1, snapped to the frame grid so preview and export agree. */
  progress: number;
  /**
   * The element the paint loop is at when the transition should be drawn.
   *
   * Whichever of the two clips paints first. They share a track and the sort is
   * by start time, so this is the outgoing clip in every ordinary case — but
   * taking the minimum means a document where that is somehow untrue still
   * draws the transition once, in a defined place, rather than never.
   */
  drawAtId: string;
};

export type ActiveEffect = {
  id: string;
  element: EffectElementType;
  mode: PresetMode;
};

export type FramePlan = {
  /** Keyed by `drawAtId`. */
  transitions: Map<string, ActiveTransition>;
  /** Ids a transition will draw, which the loop must not draw again. */
  claimed: Set<string>;
  /** Keyed by element id, consulted as the loop reaches each one. */
  effects: Map<string, ActiveEffect>;
  /**
   * Whether the frame must be composited into a project-resolution canvas.
   *
   * True only for shader effects. An overlay is a Canvas2D composite operation
   * against what is already there, which needs no readback; a transition draws
   * its two clips into buffers of its own and hands back a finished image. Only
   * a shader effect has to *read* the target.
   */
  needsScratch: boolean;
  /** Nothing to do — the loop should take its original path. */
  empty: boolean;
};

/** A plan that changes nothing, shared so the common path allocates nothing. */
const EMPTY_PLAN: FramePlan = {
  transitions: new Map(),
  claimed: new Set(),
  effects: new Map(),
  needsScratch: false,
  empty: true,
};

export type PlanFrameInput = {
  elements: Timeline;
  timeInMs: number;
  fps: number;
  /**
   * How the preset behind an element wants to run, or `null` when it is not
   * installed.
   *
   * Injected rather than imported so this module stays free of the registry —
   * which reads the disk — and so a test can describe a preset without one.
   * A `null` here is the missing-preset path: the element is skipped entirely
   * and the frame renders as though it were not there, which is the
   * pass-through behaviour the whole feature promises.
   */
  modeOf: (presetId: string) => PresetMode | null;
};

/**
 * Whether this document contains an effect or a transition at all.
 *
 * One pass over the keys, and worth its own export: it is what lets a caller
 * decide *not* to build an `FxRuntime`. Doing so allocates a canvas and a
 * WebGL context, and the overwhelming majority of projects — and of exports —
 * need neither. Checking first keeps the cost of this feature at zero for
 * everyone not using it.
 */
export function hasFxElements(elements: Timeline): boolean {
  for (const element of Object.values(elements)) {
    if (element.filetype === "effect" || element.filetype === "transition") {
      return true;
    }
  }
  return false;
}

export function planFrame(input: PlanFrameInput): FramePlan {
  const { elements, timeInMs, fps, modeOf } = input;

  if (!hasFxElements(elements)) {
    return EMPTY_PLAN;
  }

  const transitions = new Map<string, ActiveTransition>();
  const claimed = new Set<string>();
  const effects = new Map<string, ActiveEffect>();
  let needsScratch = false;

  for (const [id, element] of Object.entries(elements)) {
    if (element.filetype === "transition") {
      const from = elements[element.fromId];
      const to = elements[element.toId];
      // A transition whose clips have gone is skipped rather than half-drawn.
      // `repairTransitions` should have removed it, but a document reaches the
      // compositor from IPC and from `.ngt` as well as from an edit.
      if (from == null || to == null) {
        continue;
      }
      if (modeOf(element.presetId) == null) {
        // Preset not installed. The clips still draw normally through the
        // ordinary path — a missing transition degrades to a cut, which is the
        // edit that was there before anyone added one.
        continue;
      }

      const { start, end } = windowOf(element);
      if (!isTimeInRange(timeInMs, start, end)) {
        continue;
      }

      const drawAtId =
        from.priority <= to.priority ? element.fromId : element.toId;

      transitions.set(drawAtId, {
        id,
        element,
        fromId: element.fromId,
        toId: element.toId,
        progress: progressOf(element, timeInMs, fps),
        drawAtId,
      });
      claimed.add(element.fromId);
      claimed.add(element.toId);
      continue;
    }

    if (element.filetype === "effect") {
      const mode = modeOf(element.presetId);
      if (mode == null) {
        continue;
      }
      const { start, end } = spanOf(element);
      if (!isTimeInRange(timeInMs, start, end)) {
        continue;
      }

      effects.set(id, { id, element, mode });
      if (mode === "shader") {
        needsScratch = true;
      }
    }
  }

  const empty = transitions.size === 0 && effects.size === 0;
  if (empty) {
    return EMPTY_PLAN;
  }

  return { transitions, claimed, effects, needsScratch, empty };
}
