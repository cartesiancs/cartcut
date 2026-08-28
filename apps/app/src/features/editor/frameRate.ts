/**
 * Changing the project's frame rate.
 *
 * The rate itself is one number in one store, and setting it is one line. What
 * makes this a module is everything that has to move with it, and the fact that
 * three separate surfaces — the settings panel, project load, and the e2e
 * harness — must all move it the same way.
 *
 * Three things follow a rate change:
 *
 *   1. **The zoom ceiling.** It is a frame measurement (`zoom.ts#maxRangeForFps`),
 *      so lowering the rate can leave the timeline zoomed past the end of its own
 *      slider.
 *   2. **The playhead.** It was on a frame boundary of the old grid, which is
 *      almost never a boundary of the new one. Left alone, the preview would
 *      draw an instant that no exported frame corresponds to.
 *   3. **Baked animation.** The baked lanes are a cache read by nearest-sample
 *      lookup, so a 60Hz bake in a 120fps project steps at half rate. See
 *      `keyframes.ts#bakeRateFor`.
 *
 * What does *not* follow is the edit itself. Clips keep their `startTime` and
 * `trim` in milliseconds, exactly as authored — a rate change is a change of
 * grid, not a re-cut. That is what every NLE does, and it is the only choice
 * that cannot lose work: the alternative, re-quantizing every boundary onto the
 * new grid, is destructive and not undoable in a way the user would recognise.
 * Clips off the new grid are pulled onto it the next time they are dragged or
 * trimmed, which is where the user is looking when it happens.
 *
 * The rebake goes through `withCheckpoint`, and `rebakeAnimations` declines by
 * identity — so a project with no animation, or one already baked at this rate,
 * records no undo step at all.
 *
 * Lives in `features/editor/` for the reason stated in `actions.ts`:
 * `features/timeline/` is store-free by design, and this reads three stores.
 */

import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { bakeRateFor } from "../animation/keyframes";
import { rebakeAnimations } from "../animation/keyframeOps";
import { coerceFps, normalizeFps, snapMsToFrame } from "../timeline/frames";
import { clampRange } from "../timeline/zoom";

/**
 * The project's frame rate, ready to hand to a pure function.
 *
 * Read through `normalizeFps` rather than trusted: the store guarantees a whole
 * positive rate, but this is also called before the store has been touched at
 * all, and from the agent bridge where `options` may not exist yet.
 */
export function projectFps(): number {
  return normalizeFps(renderOptionStore.getState().options?.fps);
}

/** The rate to bake this project's animation curves at. */
export function projectBakeHz(): number {
  return bakeRateFor(projectFps());
}

/**
 * Set the project's frame rate, and bring everything that depends on it along.
 *
 * Returns the rate actually stored, which is `coerceFps(requested)` — the
 * caller is usually a text field, and it needs to write that value back so the
 * user can see that `0` became 60 rather than wondering why nothing happened.
 */
export function setProjectFps(requested: number): number {
  const fps = coerceFps(requested);

  const renderOptions = renderOptionStore.getState();
  if (renderOptions.options.fps === fps) {
    return fps;
  }
  renderOptions.setFps(fps);

  const timeline = useTimelineStore.getState();

  const range = clampRange(timeline.range, fps);
  if (range !== timeline.range) {
    timeline.setRange(range);
  }

  const cursor = snapMsToFrame(timeline.cursor, fps);
  if (cursor !== timeline.cursor) {
    timeline.setCursor(cursor);
  }

  timeline.withCheckpoint((doc) => rebakeAnimations(doc, bakeRateFor(fps)));

  return fps;
}
