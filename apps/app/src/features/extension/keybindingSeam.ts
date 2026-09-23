/**
 * The one place an extension's keystroke reaches the editor.
 *
 * One, deliberately. `elementTimelineCanvas` listens on `window`, so it sees
 * every keystroke in the app; adding a second seam in `Timeline` or
 * `previewCanvas` would dispatch the same press twice. Those two bind only
 * reserved chords anyway, so there is nothing for a second seam to catch.
 *
 * Placed after the canvas's own `switch` and before its modifier check, which
 * means the typing guard and the mask pen have already had the event: an
 * extension can never take a key away from a caption field or from a stroke in
 * progress.
 */

import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { IS_MAC } from "../../utils/platform";
import { runContributedCommand } from "./bridge";
import { contributionStore } from "./contributions";
import {
  resolveBindings,
  resolveKeybinding,
  type BindingProblem,
  type KeyEventLike,
  type ResolvedBinding,
} from "./keybindings";

let cached: { source: unknown; bindings: ResolvedBinding[]; problems: BindingProblem[] } | null = null;

/**
 * Resolve once per contribution list, not once per keystroke.
 *
 * `resolveBindings` walks the app's whole shortcut table to build the reserved
 * set, and this runs inside a `keydown` handler on `window`. Doing that work
 * per press would put it on the path of every keystroke in the editor,
 * including every character typed into a caption.
 */
function bindings(): { bindings: ResolvedBinding[]; problems: BindingProblem[] } {
  const declared = contributionStore.getState().keybindings;
  if (cached?.source === declared) {
    return cached;
  }
  const resolved = resolveBindings(declared);
  for (const problem of resolved.problems) {
    console.warn("[extension] " + problem.extId + ": `" + problem.key + "` " + problem.reason);
  }
  cached = { source: declared, ...resolved };
  return cached;
}

/**
 * Run an extension binding if one matches. Returns whether it did.
 *
 * The caller `preventDefault`s and stops on `true`, so a handled key never
 * also reaches the app's own modifier branch below it.
 */
export function dispatchExtensionKeybinding(event: KeyEventLike): boolean {
  try {
    return resolve(event);
  } catch (error) {
    // Caught because of where this runs. `elementTimelineCanvas` listens on
    // `window`, so this is on the path of every keystroke in the editor: a
    // throw here would stop the arrow keys, Delete and every `mod+` shortcut
    // for the rest of the session, and the cause would be an extension's
    // keybinding. No chord an extension can currently declare reaches a
    // throw; this is what keeps that true of the ones it declares later.
    console.warn("[extension] a keybinding could not be resolved", error);
    return false;
  }
}

function resolve(event: KeyEventLike): boolean {
  const table = bindings();
  if (table.bindings.length === 0) {
    return false;
  }

  const ids = selectionStore.getState().ids;
  const elements = useTimelineStore.getState().timeline;
  const types = ids
    .map((id) => (elements[id] as { filetype?: string } | undefined)?.filetype)
    .filter((filetype): filetype is string => typeof filetype === "string");

  const binding = resolveKeybinding(
    table.bindings,
    event,
    { selectionCount: ids.length, selectionTypes: types },
    IS_MAC,
  );
  if (binding == null) {
    return false;
  }

  void runContributedCommand(binding.extId, binding.commandId);
  return true;
}
