/**
 * Ending every gesture in progress, before the timeline under it changes.
 *
 * Three gestures hold a document of their own while the button is down: the
 * timeline canvas's drag (`pendingDoc`, committed whole on mouseup), the
 * keyframe editor's curve drag (previewed through the store, reset to its
 * `originDoc` on mouseup) and a number field's scrub (`GestureCommit`). Each
 * one writes that document back when it ends, into whichever timeline is live
 * by then. A switch of timeline in the middle of one (a tab, an undo that
 * falls back to main) would have it write one timeline's document over
 * another's.
 *
 * So the paths that change the timeline dispatch this event first, while the
 * outgoing timeline is still the live one, and each gesture abandons itself
 * exactly as it does on a window blur. Each also checks
 * `timelineStore.switchEpoch` when it ends, for a switch nothing announced.
 *
 * A no-op where there is no `window`, which is every node suite.
 */

export const CANCEL_GESTURES_EVENT = "cartcut:cancel-gestures";

export function cancelActiveGestures(): void {
  const target = (globalThis as { window?: EventTarget }).window;
  if (target == null || typeof target.dispatchEvent !== "function") {
    return;
  }
  target.dispatchEvent(new Event(CANCEL_GESTURES_EVENT));
}
