/**
 * Rebuilding the application menu without snapping it shut under the user.
 *
 * `Menu.setApplicationMenu` replaces the whole native menu bar, and on macOS
 * that closes whatever menu is open. Auto Save learned this first: a save
 * landing while someone reads the File menu would shut it mid-read. Extensions
 * hit the same thing from the other direction, because an extension can
 * contribute menu items at any moment during activation.
 *
 * So the flag lives here, owned once, rather than in each feature that needs
 * it. Two copies fed from the same two events would agree right up until one
 * of them was updated and the other was not.
 */

let menuOpen = false;
let pending = false;
let rebuild: (() => void) | null = null;

/** Set by `main.ts`, which is the only module that may reinstall the menu. */
export function setMenuRebuilder(handler: () => void): void {
  rebuild = handler;
}

/** Told by `main.ts` from `menu-will-show` and `menu-will-close`. */
export function setMenuOpenState(open: boolean): void {
  menuOpen = open;
  if (!open && pending) {
    pending = false;
    rebuild?.();
  }
}

export function isMenuOpen(): boolean {
  return menuOpen;
}

/**
 * Rebuild now, or as soon as the menu the user is reading closes.
 *
 * Collapsing to a single pending flag rather than a queue is the right shape:
 * the menu is rebuilt from current state, so two deferred rebuilds and one
 * produce the same menu.
 */
export function scheduleMenuRebuild(): void {
  if (menuOpen) {
    pending = true;
    return;
  }
  rebuild?.();
}
