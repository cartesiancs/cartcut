/**
 * Turning a window's background throttling off for a while, and back to what
 * it was afterwards.
 *
 * The renderer counts its own holders (`features/graphic/paintHold.ts`) and
 * sends one `false` when the first starts and one `true` when the last ends.
 * Taking that `true` literally switched throttling on for a window that had it
 * off before the hold: since a contact sheet holds too, one sheet was enough
 * to stop a hidden window that relied on painting from ever painting again.
 * So `true` ends the hold and restores the window's own setting, read when the
 * hold began.
 */

export type ThrottlingTarget = {
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
};

export function createThrottlingHold() {
  const before = new WeakMap<ThrottlingTarget, boolean>();
  return (target: ThrottlingTarget, allowed: boolean): void => {
    if (!allowed) {
      if (!before.has(target)) {
        before.set(target, target.getBackgroundThrottling());
      }
      target.setBackgroundThrottling(false);
      return;
    }
    const restored = before.get(target);
    before.delete(target);
    target.setBackgroundThrottling(restored ?? true);
  };
}
