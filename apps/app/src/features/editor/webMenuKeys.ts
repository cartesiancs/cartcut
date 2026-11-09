/**
 * The menu's own shortcuts, in a browser.
 *
 * On the desktop the system menu fires ⌘O, ⌘S, ⌘⇧S, ⌘I, ⌘E, ⌘A, ⌘⇧A, ⌘G, ⌘⇧G
 * and ⌘/ (`electron/lib/menu.ts`), and nothing in the page listens for them.
 * A browser has no such menu, so without this they did the browser's thing:
 * ⌘S saved the web page, ⌘O opened a file in a new tab, ⌘A selected the whole
 * page. Bound here, they run the same `runMenuCommand` the menu bar's items
 * do.
 *
 * Like a desktop accelerator they fire whatever has focus, with one exception
 * the desktop menu makes too: Select All and Deselect All belong to a text
 * field while the caret is in one (`menuCommands.ts` hands them over there),
 * so they are left to the browser.
 */

import { matchesAccelerator, webShortcutCommands } from "./webMenuModel";
import { runMenuCommand } from "./menuCommands";
import { IS_MAC } from "../../utils/platform";
import { isTypingEvent } from "../../utils/typingTarget";

const FIELD_COMMANDS = new Set(["edit.selectAll", "edit.deselectAll"]);

export function installWebMenuKeys(target: Window = window): () => void {
  const commands = webShortcutCommands();
  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) {
      return;
    }
    const command = commands.find((candidate) =>
      matchesAccelerator(candidate.accelerator as string, event, IS_MAC),
    );
    if (command == null) {
      return;
    }
    if (FIELD_COMMANDS.has(command.id) && isTypingEvent(event)) {
      return;
    }
    event.preventDefault();
    runMenuCommand(command.id);
  };
  target.addEventListener("keydown", onKeydown);
  return () => target.removeEventListener("keydown", onKeydown);
}
