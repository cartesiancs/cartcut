/**
 * What the sidebar's keyframe diamond is looking at.
 *
 * The control it exists for used to be a two-state boolean — lit when
 * `animation[property].isActivate` was true and dim otherwise — which is the
 * *stopwatch's* question, not the diamond's. Every other NLE's diamond answers a
 * different one: **is there a keyframe on the frame the playhead is on**, and
 * where are its neighbours. That is three states plus two jumps, and none of it
 * was derivable from what the panel read.
 *
 * Pure and DOM-free, so it runs under `environment: "node"` and the component
 * becomes a thin renderer over it. `fps` arrives as an argument rather than off
 * `renderOptionStore`, the rule `features/animation/` already keeps.
 *
 * ## "At the playhead" means the same frame
 *
 * Not a millisecond tolerance. `agent/commands/animation.ts` matches within
 * 2ms, which is right for an agent naming a time and wrong here: at 60fps a
 * frame is 16.7ms, so a keyframe 5ms off the playhead — the same frame, and
 * indistinguishable on screen — would read as "no keyframe" and a click would
 * plant a *second* one 5ms away from the first. Comparing frame indices is what
 * the user sees, and it absorbs the off-grid keyframes the curve editor's Alt
 * and the agent can both author.
 *
 * `msToFrameFloor`, not `msToFrame`. `frames.ts#frameStartMs` states the
 * distinction: an edit rounds because the user is aiming at a boundary, a clock
 * floors because at `t` the picture shows the frame whose interval contains
 * `t`. "Is there a keyframe on the frame I am looking at" is the clock's
 * question. The two agree wherever a keyframe sits on a boundary, which is
 * everywhere the panels author one.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../@types/timeline";
import { msToFrameFloor } from "../timeline/frames";
import { spanLength } from "../timeline/geometry";
import { isTrackLive } from "../timeline/keyframeMarkers";
import { lanesOf } from "./keyframes";

/**
 * `off`   — nothing to navigate: the track is switched off, or it is on and
 *           carries no keyframes at all, which renders identically.
 * `empty` — armed, but the playhead's frame has no keyframe on it.
 * `on`    — a keyframe sits on the playhead's frame.
 */
export type KeyframeMark = "off" | "empty" | "on";

export type KeyframeNavState = {
  mark: KeyframeMark;
  /**
   * The **stored** time of the keyframe on the playhead's frame, in
   * element-local ms, or `null`. Stored rather than snapped so a caller can
   * look it up by exact equality afterwards.
   */
  atMs: number | null;
  /** Nearest keyframe strictly before the playhead's frame, or `null`. */
  prevMs: number | null;
  /** Nearest keyframe strictly after the playhead's frame, or `null`. */
  nextMs: number | null;
  /**
   * Whether the playhead is over the clip at all.
   *
   * `false` means nothing can be keyed here: a keyframe outside the span never
   * plays, so writing one reports success for an edit with no visible effect.
   * The panel converts the playhead with `cursor - startTime` and has never
   * clamped it, so arming a property with the playhead elsewhere seeded a
   * keyframe at a negative time.
   */
  inSpan: boolean;
};

const EMPTY: KeyframeNavState = {
  mark: "off",
  atMs: null,
  prevMs: null,
  nextMs: null,
  inSpan: false,
};

/**
 * Every instant this one property is keyed at, deduped, ascending.
 *
 * `keyframeMarkers.keyframeTimes` is the union across *all* properties and does
 * not dedupe — right for a single timeline lane, wrong here, where the diamond
 * belongs to one property and a paired `position` would otherwise report each
 * instant twice and make one arrow press step half a keyframe.
 *
 * The union across a property's own lanes is still needed: `addKeyframePaired`
 * keeps `x` and `y` at the same instants, but a project authored before it
 * existed can have lanes of different lengths.
 */
export function keyframeTimesOf(
  element: TimelineElement | null | undefined,
  property: AnimatableProperty,
): number[] {
  if (element == null || !animatableProperties(element).includes(property)) {
    return [];
  }
  const track = (element as any).animation?.[property];
  if (track == null || typeof track !== "object") {
    return [];
  }

  const times: number[] = [];
  for (const lane of lanesOf(property)) {
    const list = Array.isArray(track[lane]) ? track[lane] : [];
    for (const keyframe of list) {
      const t = keyframe?.p?.[0];
      if (typeof t === "number" && Number.isFinite(t)) {
        times.push(t);
      }
    }
  }

  times.sort((a, b) => a - b);
  // Exact duplicates only. Two lanes keyed a hair apart are two real keyframes
  // and the frame comparison below is what folds them for the diamond.
  return times.filter((t, i) => i === 0 || t !== times[i - 1]);
}

/**
 * The diamond's state for one property at one playhead position.
 *
 * `cursorMs` is an absolute timeline time; the conversion to element-local ms
 * happens here so no caller has to remember it.
 */
export function keyframeNavAt(
  element: TimelineElement | null | undefined,
  property: AnimatableProperty,
  cursorMs: number,
  fps: number,
): KeyframeNavState {
  if (element == null || !Number.isFinite(cursorMs)) {
    return EMPTY;
  }

  const startTime = (element as any).startTime;
  if (!Number.isFinite(startTime)) {
    return EMPTY;
  }

  const atMs = cursorMs - startTime;
  // Half-open, matching `spanOf`: the clip occupies [start, start + length).
  const inSpan = atMs >= 0 && atMs < spanLength(element);

  if (!isTrackLive(element, property)) {
    // An armed-but-empty track reads as `off` on purpose — it renders from the
    // static value, so calling it armed would light the diamond for an
    // animation nobody can see.
    return { ...EMPTY, inSpan };
  }

  const frame = msToFrameFloor(atMs, fps);
  let here: number | null = null;
  let prevMs: number | null = null;
  let nextMs: number | null = null;

  for (const t of keyframeTimesOf(element, property)) {
    const f = msToFrameFloor(t, fps);
    if (f === frame) {
      // Ties go to the earliest, which is how `sampleBaked` resolves them.
      here ??= t;
    } else if (f < frame) {
      prevMs = t;
    } else if (nextMs == null) {
      nextMs = t;
    }
  }

  return {
    mark: here == null ? "empty" : "on",
    atMs: here,
    prevMs,
    nextMs,
    inSpan,
  };
}
