/**
 * The recorder's tray icon.
 *
 * The recorder has no window of its own to put controls in — a window would be
 * one more thing on screen while the screen is being recorded, and the user
 * would spend the take moving it out of shot. So the tray *is* the interface,
 * and it has to survive being rebuilt on every settings change without
 * flickering out of the menu bar.
 *
 * Two things the old `createOverlayWindowTray` got wrong, both of which this
 * exists to fix:
 *
 *  - **Nothing held the `Tray`.** It was a local inside a function, so once the
 *    closure was collectable the icon could vanish from the menu bar mid-session
 *    — the documented failure mode of an unreferenced `Tray`. Here the module
 *    holds it for as long as the recorder is open.
 *  - **The icon path was relative to the working directory.** `path.join(
 *    "assets/icons/png/tray.png")` resolves against the cwd, which is the
 *    repository only when the app was started as `electron .` from inside it.
 *    Launched any other way — `open -a`, the Finder, a debugger — it resolves to
 *    nothing and the tray is a blank rectangle. Same trap `lib/preset.ts`
 *    documents, same fix.
 */

import { app, Menu, nativeImage, Tray } from "electron";
import isDev from "electron-is-dev";
import log from "electron-log";
import path from "path";
import { toMenuTemplate, type TrayModel } from "./recordTrayMenu.js";

let tray: Tray | null = null;

/**
 * Where the tray image is, under either launch.
 *
 * `app.getAppPath()` rather than `"."` in development, and `resourcesPath` when
 * packaged — `assets` is an `extraResources` directory, so it sits beside the
 * asar rather than inside it. Computed per call because `app` is not reliably
 * populated while this module is still being imported.
 */
function trayIconPath(): string {
  const root = isDev === true ? app.getAppPath() : process.resourcesPath;
  return path.join(root, "assets", "icons", "png", "tray.png");
}

/**
 * Show the tray, or update the one already showing.
 *
 * Rebuilding the menu in place rather than destroying and recreating the
 * `Tray`: on macOS a destroyed tray leaves its slot in the menu bar and the new
 * one appears at the far right, so a recorder whose settings were touched
 * twice walks across the menu bar as the user uses it.
 */
export function showRecordTray(
  model: TrayModel,
  onClick: (id: string) => void,
): void {
  if (tray == null || tray.isDestroyed()) {
    const image = nativeImage.createFromPath(trayIconPath());

    if (image.isEmpty()) {
      log.warn("[record] tray icon missing at", trayIconPath());
    }

    // A template image is drawn from its alpha channel alone, so macOS can
    // invert it for a dark menu bar. Without this the icon is a black smudge
    // on a black bar for anyone in dark mode.
    image.setTemplateImage(true);
    tray = new Tray(image);
  }

  tray.setToolTip(model.tooltip);
  tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(model, onClick)));
}

/** Take the icon out of the menu bar. Safe to call when there is none. */
export function destroyRecordTray(): void {
  if (tray != null && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}

/** Whether the recorder currently owns a tray icon. */
export function hasRecordTray(): boolean {
  return tray != null && !tray.isDestroyed();
}
