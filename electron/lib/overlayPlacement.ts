/**
 * Which screen the recorder's overlay covers.
 *
 * The overlay is the viewfinder: the camera bubble and the drawing surface,
 * stretched over one display's whole `bounds`. It is created on the primary
 * display, and the screen being captured is a setting the engine renderer owns,
 * so the two agree only by luck. When they disagree the bubble sits on a
 * monitor nothing is recording, and it is invisible in the finished file
 * because the compositor draws its own bubble into the captured display
 * instead. That is the bug this module exists to close: the engine sends the
 * captured display's id with every overlay refresh, and `lib/recorder.ts` moves
 * the window onto it.
 *
 * Pure arithmetic over plain records, with no Electron import, so the matching
 * rule is testable. `Display.id` is a number and `desktopCapturer`'s
 * `display_id` is a string; the comparison is on the string form, which is what
 * `recordSession.ts` already does for the cursor sampler.
 */

export type Bounds = { x: number; y: number; width: number; height: number };

/** Just enough of an Electron `Display` to place a window on it. */
export type DisplayLike = { id: number | string; bounds: Bounds };

/**
 * The bounds the overlay should take, or `null` to leave it where it is.
 *
 * Null for two cases that are not failures. A **window source** has no
 * `display_id` at all (`desktopCapturer` reports one only for screens), so
 * there is nothing to follow and moving to a guess would be worse than
 * standing still. And an **id no display answers to** is what a stale setting
 * looks like after a monitor is unplugged, which the source list will correct
 * on its next enumeration.
 */
export function overlayBoundsFor(
  displays: readonly DisplayLike[],
  displayId: unknown,
): Bounds | null {
  if (typeof displayId !== "string" || displayId === "") {
    return null;
  }

  const display = displays.find(
    (candidate) => String(candidate.id) === displayId,
  );

  if (display == null) {
    return null;
  }

  const { x, y, width, height } = display.bounds;

  // A display reporting no area is one being reconfigured. Resizing the overlay
  // to nothing would hide it with no way back short of reopening the recorder.
  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  return { x, y, width, height };
}

/** Whether a move would change anything, so a refresh that did not can skip it. */
export function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (a == null || b == null) {
    return a === b;
  }
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}
