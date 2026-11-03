/**
 * The editor's UI scale, chosen in Settings ▸ General: the page zoom of the
 * editor window.
 *
 * Page zoom rather than CSS `zoom` or a transform. Chromium then lays the
 * whole page out in fewer, larger CSS px, so pointer coordinates,
 * `getBoundingClientRect` and every canvas's hit test stay in the one unit
 * they were written in, and `devicePixelRatio` rises with the zoom so the
 * preview and the timeline stay sharp. Nothing on the export path reads
 * `devicePixelRatio`, so a scale never reaches a delivered file.
 *
 * It belongs to the editor window alone. Chromium keys zoom by origin and
 * every window here is `file://`, but Electron keeps a `file://` page's zoom
 * on its own WebContents (measured on Electron 44: 1.5 on one window left a
 * second `file://` window, and one opened after it, at 1). The recorder's
 * overlay is laid out in screen pixels and has to stay at 1.
 *
 * No imports, so the renderer's settings dialog lists the same choices.
 */

export const UI_SCALE_STORE_KEY = "ui_scale";

/** The choices, smallest first. */
export const UI_SCALES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type UiScale = (typeof UI_SCALES)[number];

export const DEFAULT_UI_SCALE: UiScale = 1;

/**
 * At the one place a scale is written: one of the choices, or `null` to
 * refuse. Exact equality, so `1.2` or `"1.25"` is refused rather than rounded
 * to something the user never picked.
 */
export function coerceUiScale(value: unknown): UiScale | null {
  return UI_SCALES.find((scale) => scale === value) ?? null;
}

/**
 * On every read of the stored value. The store is a JSON file anyone can
 * edit, so anything that is not one of the choices reads as 100%. Never
 * throws.
 */
export function normalizeUiScale(value: unknown): UiScale {
  return coerceUiScale(value) ?? DEFAULT_UI_SCALE;
}

/** What the settings dialog shows for a scale: `125%`. */
export function uiScaleLabel(scale: UiScale): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * The top bar's height in CSS px (`.top-bar` in `style.scss`). Under a zoom
 * it is this many times the scale on screen, while the macOS window buttons
 * stay where the window puts them, in screen points.
 */
const TOP_BAR_HEIGHT = 34;

/**
 * Where the macOS window buttons go so they stay centred in the top bar.
 *
 * `{ x: 10, y: 10 }` at 100%, which is where they always were; the bar grows
 * by `TOP_BAR_HEIGHT * (scale - 1)` and the buttons move down by half of it.
 */
export function trafficLightPositionFor(scale: UiScale): { x: number; y: number } {
  return { x: 10, y: Math.round(10 + (TOP_BAR_HEIGHT * (scale - 1)) / 2) };
}
