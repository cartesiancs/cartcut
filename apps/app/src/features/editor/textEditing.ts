/**
 * ⌘X / ⌘C / ⌘V / ⌘Z / ⇧⌘Z / ⌘A *inside a text field*.
 *
 * The Edit menu used to carry Electron's `cut`, `copy`, `paste`, `undo` and
 * `redo` roles. A role acts on the focused editable and nothing else, which is
 * why Edit → Copy with three clips selected copied nothing — so those items are
 * the editor's own clip commands now (`electron/lib/menu.ts`). This module is
 * the half that went missing with the roles: the same keys, meaning the text,
 * while the caret is in a field.
 *
 * It is deliberately *not* folded into `elementTimelineCanvas._handleKeydown`.
 * That handler's first act is to yield on `isTypingEvent`, and it should stay
 * that way — it is the timeline's keyboard, and the rule that it never touches a
 * keystroke aimed at a text field is worth more than the two lines saved.
 *
 * `preventDefault` is only issued once the command has somewhere to go. Blink
 * has its own bindings for these keys and may or may not act on them depending
 * on the field and the platform; cancelling and then dispatching explicitly is
 * one action either way, whereas cancelling and dispatching nothing — which is
 * what the web build would do, with no main process behind the bridge — would
 * be none.
 */

import { hasEditorModifier } from "../../utils/platform";
import { isTypingEvent } from "../../utils/typingTarget";
import { runNativeEditing } from "./menuCommands";

function handleKeydown(event: KeyboardEvent) {
  if (!isTypingEvent(event) || !hasEditorModifier(event)) {
    return;
  }

  // `event.code`, matching the rest of the app's shortcuts: it names the
  // physical key, so this keeps working on a layout where ⌘Z is somewhere else.
  switch (event.code) {
    case "KeyZ":
      if (runNativeEditing(event.shiftKey ? "redo" : "undo")) {
        event.preventDefault();
      }
      return;
    case "KeyX":
      if (runNativeEditing("cut")) {
        event.preventDefault();
      }
      return;
    case "KeyC":
      if (runNativeEditing("copy")) {
        event.preventDefault();
      }
      return;
    case "KeyV":
      if (runNativeEditing("paste")) {
        event.preventDefault();
      }
      return;
    case "KeyA":
      if (runNativeEditing("selectAll")) {
        event.preventDefault();
      }
      return;
  }
}

/** Called once, from `event.ts`, alongside the menu wiring it belongs with. */
export function installTextEditingShortcuts(): void {
  window.addEventListener("keydown", handleKeydown);
}
