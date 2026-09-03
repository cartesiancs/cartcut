/**
 * A tray menu, described as data.
 *
 * The recorder's menu is where every setting is changed, and every one of those
 * settings is validated by `apps/app/src/features/record/recordSettings.ts` —
 * which `electron/` may not import, because widening `.tsconfig`'s `rootDir`
 * relocates the whole main-process build out of `main/` and the app stops
 * finding its entry point.
 *
 * So the engine renderer builds the *model* and the main process renders it.
 * What is duplicated across the boundary is only the vocabulary of a menu —
 * label, checkbox, radio, submenu — and that is a stable thing to duplicate:
 * adding a setting adds an item, not a kind of item, so this file does not
 * change when the recorder gains an option. The alternative, teaching main
 * about cameras and bitrates, would have to be kept in step by hand forever.
 * `lib/preset.ts` makes the same call for the same reason.
 *
 * Nothing here imports Electron at runtime — `MenuItemConstructorOptions` is a
 * type-only import and is erased — so the conversion is testable.
 */

import type { MenuItemConstructorOptions } from "electron";

/**
 * One row.
 *
 * `id` is what comes back on a click. It is opaque to this side: the engine
 * chose it and the engine interprets it, so a new setting needs no change here.
 */
export type TrayItem =
  | { type: "separator" }
  | {
      type: "normal" | "checkbox" | "radio";
      id: string;
      label: string;
      checked?: boolean;
      enabled?: boolean;
      /** Shown on hover — used to say *why* a disabled item is disabled. */
      toolTip?: string;
    }
  | {
      type: "submenu";
      label: string;
      enabled?: boolean;
      toolTip?: string;
      items: TrayItem[];
    };

export type TrayModel = {
  tooltip: string;
  items: TrayItem[];
};

/**
 * The model as an Electron menu template.
 *
 * `onClick` is called with the item's `id`; separators and submenus never have
 * one, so nothing can arrive that the engine did not name. A submenu with no
 * items becomes a disabled row rather than an empty flyout, which is what an
 * unpopulated device list would otherwise produce — a menu that opens onto
 * nothing and says nothing.
 */
export function toMenuTemplate(
  model: TrayModel,
  onClick: (id: string) => void,
): MenuItemConstructorOptions[] {
  return model.items.map((item) => toMenuItem(item, onClick));
}

function toMenuItem(
  item: TrayItem,
  onClick: (id: string) => void,
): MenuItemConstructorOptions {
  if (item.type === "separator") {
    return { type: "separator" };
  }

  if (item.type === "submenu") {
    if (item.items.length === 0) {
      return {
        label: item.label,
        enabled: false,
        toolTip: item.toolTip,
      };
    }

    return {
      label: item.label,
      enabled: item.enabled !== false,
      toolTip: item.toolTip,
      submenu: item.items.map((child) => toMenuItem(child, onClick)),
    };
  }

  return {
    id: item.id,
    label: item.label,
    type: item.type,
    // Electron throws on `checked` for a `normal` item, and the engine has no
    // reason to know that, so it is dropped here rather than guarded there.
    ...(item.type === "normal" ? {} : { checked: item.checked === true }),
    enabled: item.enabled !== false,
    toolTip: item.toolTip,
    click: () => onClick(item.id),
  };
}
