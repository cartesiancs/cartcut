/**
 * Refusing an edit while somebody else holds the timeline.
 *
 * `timelineLockStore` says whether it is held; this says what to do about it,
 * which is two things: decline, and tell the user once.
 *
 * It sits in `features/editor/` rather than beside the store for the reason
 * `actions.ts` gives about itself. The store is a fact; this reads it, reaches
 * the DOM for a toast, and keeps a module-local memory of what it has already
 * said. None of that belongs in a `createStore` call.
 *
 * ## Once per lock, not once per gesture
 *
 * The refusal is a dead end, so the user tries again: a drag that did nothing
 * is followed by another drag, and a Delete that did nothing by another Delete.
 * A toast each time would be a notice every few seconds saying the same thing,
 * which is the failure `autosaveBridge.ts` names about a full disk: a message
 * repeated at that rate is worse than the condition it reports.
 *
 * So the notice fires on the first refusal after each lock and not again. The
 * memory resets as soon as the timeline is free, which is why every call site
 * goes through `refusesEdit` rather than reading the store itself.
 */

import {
  isTimelineLocked,
  timelineLockMessage,
} from "../../states/timelineLockStore";

let announced = false;

/**
 * Whether this edit should be turned away, telling the user if it is the first.
 *
 * Call it at the moment of the gesture, not at render time: a locked timeline
 * is a state the user is watching change, and a captured answer goes stale
 * between the press and the release.
 */
export function refusesEdit(): boolean {
  if (!isTimelineLocked()) {
    announced = false;
    return false;
  }

  if (!announced) {
    announced = true;
    notify(timelineLockMessage());
  }
  return true;
}

/**
 * The same question with no notice attached.
 *
 * For the places that ask in order to *draw* something rather than to refuse
 * something: a lock glyph on a track header, a cursor that does not change on
 * hover. Announcing from a render path would put a toast on screen because the
 * window resized.
 */
export function timelineIsLocked(): boolean {
  return isTimelineLocked();
}

function notify(message: string): void {
  // The node suites that drive the guards have no `document`, and neither does
  // anything running before the toast host has mounted. A refusal that could
  // only be reported is still a refusal, so the notice is what is optional
  // here, never the decline.
  if (typeof document === "undefined") {
    return;
  }
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "5000",
  });
}
