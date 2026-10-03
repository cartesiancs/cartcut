/**
 * Whether the editor lays itself out for a phone.
 *
 * Two separate answers, because they are not the same question:
 *
 * - **Touch input** is wanted wherever a finger can reach the page. A tablet
 *   or a touchscreen laptop keeps the desktop layout but still needs a finger
 *   to drag a clip, and the bridge only ever acts on touches, so a mouse on the
 *   same machine is untouched.
 * - **The mobile layout** is wanted where the three-column editor cannot fit:
 *   a coarse pointer and a short side no longer than `MOBILE_MAX_SHORT_SIDE`.
 *   The short side rather than the width, so turning a phone sideways does not
 *   throw the user back into a desktop editor 390px tall.
 *
 * Never for the Electron build: the installed app is a desktop app, and a
 * narrow window there is a window somebody resized, not a phone.
 *
 * `?mobile=1` and `?mobile=0` force either layout, for testing a phone layout
 * on a desktop browser and for a phone user who wants the full editor.
 */

export type LayoutEnv = "web" | "electron" | "demo";

export type LayoutProbe = {
  env: LayoutEnv;
  /** `matchMedia("(pointer: coarse)")`: the primary pointer is a finger. */
  coarsePointer: boolean;
  /** `maxTouchPoints > 0` or `ontouchstart` in window. */
  touchCapable: boolean;
  width: number;
  height: number;
  /** `location.search`. */
  search: string;
};

/** The longest short side that still gets the phone layout, in CSS px. */
export const MOBILE_MAX_SHORT_SIDE = 900;

function override(search: string): boolean | null {
  const value = new URLSearchParams(search).get("mobile");
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return null;
}

export function wantsMobileLayout(probe: LayoutProbe): boolean {
  if (probe.env === "electron") {
    return false;
  }
  const forced = override(probe.search);
  if (forced != null) {
    return forced;
  }
  return (
    probe.coarsePointer &&
    Math.min(probe.width, probe.height) <= MOBILE_MAX_SHORT_SIDE
  );
}

export function wantsTouchBridge(probe: LayoutProbe): boolean {
  if (probe.env === "electron") {
    return false;
  }
  return probe.touchCapable || wantsMobileLayout(probe);
}
