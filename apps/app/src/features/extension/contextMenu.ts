/**
 * Extension items in the clip context menu.
 *
 * The timeline's context menu is built as an HTML **string** and injected into
 * `#menuRightClick`, with each row's behaviour in an inline `onclick` that
 * reaches back through `document.querySelector`. That is the shape every
 * existing row uses, so an extension's row uses it too rather than being the
 * one item rendered a different way.
 *
 * Building a string means every value interpolated into it is an injection
 * site. Two defences, and they are not the same defence:
 *
 * - **Text is escaped.** A title comes from a stranger's manifest and lands in
 *   an attribute.
 * - **Ids are matched against their patterns, and a row is dropped if they do
 *   not fit.** Escaping cannot help inside the single-quoted JavaScript string
 *   in the `onclick`, and the ids are the only thing that goes there. Main
 *   validates them when it reads the manifest, but the renderer receives them
 *   from another process and `contributions.ts` reads defensively for the same
 *   reason; this is the last place before they become code.
 *
 * Pure, so both can be asserted rather than trusted. There is no DOM test
 * environment here, which is exactly why the string is built somewhere a node
 * suite can read it.
 */

import { COMMAND_ID_PATTERN, EXTENSION_ID_PATTERN } from "./shared";
import { matchesWhen, type WhenContext } from "./keybindings";
import type { ContributedMenuItem, IContributionStore } from "./contributions";

/** Where a contributed item can appear. Must match `electron/extension/manifest.ts`. */
export const CLIP_MENU_LOCATION = "timeline/clip";

/** A row in a dropdown is one line. Longer is a paragraph in a menu. */
export const MAX_ITEM_LABEL = 60;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cleanLabel(value: string): string {
  // Newlines and tabs are what turn one row into something that overflows the
  // menu on some platforms and renders as a box on others.
  const flat = value.replace(/[\r\n\t]+/g, " ").trim();
  return flat.length > MAX_ITEM_LABEL ? flat.slice(0, MAX_ITEM_LABEL - 1) + "…" : flat;
}

/**
 * The items this selection should see, in a stable order.
 *
 * Sorted by extension then by title, so the rows do not shuffle between two
 * openings of the same menu because an extension happened to activate in
 * between.
 */
export function clipMenuItems(
  state: IContributionStore,
  context: WhenContext,
): ContributedMenuItem[] {
  return state.menus
    .filter((item) => item.location === CLIP_MENU_LOCATION && matchesWhen(item.when, context))
    .sort((a, b) => a.extId.localeCompare(b.extId) || a.title.localeCompare(b.title));
}

/**
 * The rows, as the markup the dropdown expects.
 *
 * An empty string when there is nothing, which the caller interpolates
 * harmlessly. A separator is included only when there is something to separate,
 * so a machine with no extensions sees the menu exactly as it was.
 */
export function extensionMenuHtml(items: readonly ContributedMenuItem[]): string {
  const rows = items
    .map((item) => {
      // Dropped rather than escaped. An id that does not match its pattern is
      // not a row with a formatting problem, it is a message this process
      // should not have been sent.
      if (!EXTENSION_ID_PATTERN.test(item.extId) || !COMMAND_ID_PATTERN.test(item.commandId)) {
        return "";
      }
      const label = cleanLabel(item.title);
      if (label === "") {
        return "";
      }
      const call =
        "document.querySelector('element-timeline-canvas').runExtensionMenuItem('" +
        item.extId +
        "', '" +
        item.commandId +
        "')";
      return (
        '<menu-dropdown-item onclick="' +
        escapeAttribute(call) +
        '" item-name="' +
        escapeAttribute(label) +
        '" item-icon="extension"></menu-dropdown-item>'
      );
    })
    .join("");

  return rows === "" ? "" : rows;
}
