/**
 * The browser's own right-click menu, in the web and demo builds.
 *
 * Electron shows a native context menu only when main builds one, and main
 * builds none, so in the desktop app a right-click shows the menus the editor
 * draws and nothing else. A browser shows its own everywhere: "Save image as"
 * over the preview canvas, and its menu stacked on top of the timeline's clip
 * menu, which never cancels the event. This makes the browser builds match.
 *
 * A text field keeps it, so cut, copy, paste and spelling still work there.
 *
 * Capture phase, so a component that stops the event's propagation cannot let
 * the native menu through. Cancelling the default does not stop the editor's
 * own handlers, which still run after this one.
 */

import { isTypingEvent, type KeyEventLike } from "../../utils/typingTarget";

/** The part of a `contextmenu` event this module reads and writes. */
export type ContextMenuEventLike = KeyEventLike & {
  preventDefault(): void;
};

/** `window`, or a fake of it. */
export type ContextMenuTarget = {
  addEventListener(
    type: "contextmenu",
    listener: (event: ContextMenuEventLike) => void,
    options: { capture: true },
  ): void;
};

export function installNativeContextMenuGuard(
  env: "web" | "electron" | "demo",
  target: ContextMenuTarget,
): void {
  if (env === "electron") {
    return;
  }

  target.addEventListener(
    "contextmenu",
    (event) => {
      if (!isTypingEvent(event)) {
        event.preventDefault();
      }
    },
    { capture: true },
  );
}
