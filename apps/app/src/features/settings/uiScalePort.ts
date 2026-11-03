/**
 * The UI scale, from the renderer's side: the preload's two `editor` calls as
 * a narrow port, and the one CSS variable the stylesheet needs.
 *
 * Main owns the scale (`electron/lib/uiScale.ts`): it stores it, applies it as
 * the window's zoom and refuses anything that is not a choice. `null` where
 * there is no bridge, which is the web build: a browser has its own zoom, and
 * the row renders disabled there, as the cloud and storage rows do.
 */

import {
  normalizeUiScale,
  type UiScale,
} from "../../../../../electron/lib/uiScale";

export type UiScalePort = {
  uiScale: () => Promise<unknown>;
  setUiScale: (scale: number) => Promise<{ ok?: boolean; scale?: unknown } | undefined>;
};

export function uiScalePort(): UiScalePort | null {
  const api = (globalThis as { electronAPI?: { req?: { editor?: Partial<UiScalePort> } } })
    ?.electronAPI?.req?.editor;
  return typeof api?.uiScale === "function" && typeof api.setUiScale === "function"
    ? (api as UiScalePort)
    : null;
}

/** The scale the editor is at, or `null` with no bridge or no answer. */
export async function readUiScale(port = uiScalePort()): Promise<UiScale | null> {
  if (port == null) {
    return null;
  }
  try {
    return normalizeUiScale(await port.uiScale());
  } catch {
    return null;
  }
}

/** Ask main for `scale`. The scale it applied, or `null` when it refused. */
export async function requestUiScale(
  scale: UiScale,
  port = uiScalePort(),
): Promise<UiScale | null> {
  if (port == null) {
    return null;
  }
  try {
    const result = await port.setUiScale(scale);
    return result?.ok === true ? normalizeUiScale(result.scale) : null;
  } catch {
    return null;
  }
}

/**
 * `--ui-scale` on the root, for the few rules that have to undo the zoom:
 * the top bar's room for the window buttons, which the OS draws at a fixed
 * size in screen points whatever the page's zoom (`.top-bar` in `style.scss`).
 */
export function reflectUiScale(
  root: { style: { setProperty: (name: string, value: string) => void } },
  scale: UiScale,
): void {
  root.style.setProperty("--ui-scale", String(scale));
}
