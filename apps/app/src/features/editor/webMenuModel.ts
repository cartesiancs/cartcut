/**
 * The browser build's menu bar, as data: the desktop app's menus
 * (`electron/lib/menuLayout.ts`), less what a browser cannot do, with every
 * shortcut written the way the platform writes it.
 *
 * Left out in a browser, by the user's decision (2026-11-09): the four tools
 * that need the desktop (Record and Screen Recorder capture the screen through
 * Electron's desktop capturer, Automatic Caption needs the macOS speech
 * engine, Proxy Media needs FFmpeg), and the window's own items (Close, Quit,
 * Minimise, Zoom, the devtools), which a page cannot act on. The Extensions
 * menu is empty there, so it is not drawn.
 *
 * Pure: `webMenuBar.ts` draws it and `webMenuKeys.ts` binds its shortcuts.
 */

import { MENU_LAYOUT, tidySlots } from "../../../../../electron/lib/menuLayout";
import {
  MENU_COMMANDS,
  menuCommand,
  type MenuCommand,
  type MenuCommandId,
} from "../../../../../electron/lib/menuCommands";
import { formatShortcut, type ShortcutToken } from "../../utils/platform";

/** Commands a browser does not offer at all. */
export const WEB_HIDDEN_COMMANDS: ReadonlySet<MenuCommandId> = new Set<MenuCommandId>([
  "utilities.record",
  "utilities.screenRecorder",
  "utilities.automaticCaption",
  "utilities.proxyMedia",
]);

export type WebMenuAction = "autosave" | "fullscreen" | "credit" | "setting" | "learnMore";

export type WebMenuItem =
  | { kind: "command"; id: MenuCommandId; label: string; shortcut: string | null }
  | { kind: "action"; action: WebMenuAction; label: string }
  | { kind: "separator" };

export type WebMenu = { label: string; items: WebMenuItem[] };

const ACTION_LABELS: Record<WebMenuAction, string> = {
  autosave: "Auto Save",
  fullscreen: "Toggle Full Screen",
  credit: "Credit",
  setting: "Setting",
  learnMore: "Learn More",
};

/** An Electron accelerator as the tokens `formatShortcut` reads. */
export function acceleratorTokens(accelerator: string): ShortcutToken[] {
  return accelerator.split("+").map((part) => {
    switch (part) {
      case "CmdOrCtrl":
      case "CommandOrControl":
      case "Cmd":
      case "Command":
        return "Mod";
      case "Control":
        return "Ctrl";
      case "Option":
        return "Alt";
      case "Plus":
        return "+";
      default:
        return part;
    }
  });
}

/** `⇧⌘S` on macOS, `Ctrl+Shift+S` elsewhere. */
export function shortcutLabel(accelerator: string | undefined, isMac: boolean): string | null {
  return accelerator == null ? null : formatShortcut(acceleratorTokens(accelerator), isMac);
}

/** Every menu a browser draws, in the desktop's order. */
export function webMenus(isMac: boolean): WebMenu[] {
  const menus: WebMenu[] = [];
  for (const menu of MENU_LAYOUT) {
    const slots: (WebMenuItem | "-")[] = [];
    for (const slot of menu.slots) {
      if (slot === "-") {
        slots.push("-");
      } else if (typeof slot === "string") {
        if (WEB_HIDDEN_COMMANDS.has(slot)) {
          continue;
        }
        const command = menuCommand(slot);
        slots.push({
          kind: "command",
          id: slot,
          label: command.label,
          shortcut: shortcutLabel(command.accelerator, isMac),
        });
      } else {
        const special = slot.special;
        if (
          special === "autosave" ||
          special === "fullscreen" ||
          special === "credit" ||
          special === "setting" ||
          special === "learnMore"
        ) {
          slots.push({ kind: "action", action: special, label: ACTION_LABELS[special] });
        }
      }
    }
    const items = tidySlots(slots).map((slot) => (slot === "-" ? ({ kind: "separator" } as const) : slot));
    if (items.length > 0) {
      menus.push({ label: menu.label, items });
    }
  }
  return menus;
}

/**
 * The shortcuts a browser has to bind itself: on the desktop the system menu
 * fires these, and nothing in the page listens for them. The ones the page
 * already binds (`rendererOwnsKey`: undo, copy, split, the preview's zoom) stay
 * with their own handlers.
 */
export function webShortcutCommands(): MenuCommand[] {
  return MENU_COMMANDS.filter(
    (command) =>
      command.accelerator != null && command.rendererOwnsKey !== true && !WEB_HIDDEN_COMMANDS.has(command.id),
  );
}

export type KeyLike = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** The `KeyboardEvent.code` a key token is on, or `null` for one this does not bind. */
function codeOf(key: string): string | null {
  if (/^[A-Za-z]$/.test(key)) {
    return `Key${key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(key)) {
    return `Digit${key}`;
  }
  switch (key) {
    case "/":
      return "Slash";
    case "-":
      return "Minus";
    case "+":
    case "=":
      return "Equal";
    default:
      return null;
  }
}

/**
 * Whether a keystroke is this accelerator. By `code`, so a layout that types
 * another character on the key still matches, the way a desktop menu's
 * accelerator does. The platform modifier is strict, as `hasEditorModifier`
 * is: ⌘ alone on macOS, Ctrl alone elsewhere, and never Alt unless asked.
 */
export function matchesAccelerator(accelerator: string, event: KeyLike, isMac: boolean): boolean {
  const tokens = acceleratorTokens(accelerator);
  const key = tokens[tokens.length - 1];
  const code = codeOf(key);
  if (code == null || event.code !== code) {
    return false;
  }
  const wantMod = tokens.includes("Mod");
  const wantShift = tokens.includes("Shift");
  const wantAlt = tokens.includes("Alt");
  const wantCtrl = tokens.includes("Ctrl");
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const otherCommand = isMac ? event.ctrlKey : event.metaKey;
  return (
    mod === wantMod &&
    event.shiftKey === wantShift &&
    event.altKey === wantAlt &&
    // On macOS Ctrl is its own modifier; elsewhere it is the platform's.
    (isMac ? otherCommand === wantCtrl : otherCommand === false)
  );
}

/**
 * The next item a key press lands on, skipping separators, wrapping at the
 * ends. `from` of -1 starts before the first.
 */
export function nextItem(items: readonly WebMenuItem[], from: number, step: 1 | -1): number {
  if (items.length === 0) {
    return -1;
  }
  let index = from;
  for (let tries = 0; tries < items.length; tries += 1) {
    index = (index + step + items.length) % items.length;
    if (from === -1 && step === -1 && tries === 0) {
      index = items.length - 1;
    }
    if (items[index].kind !== "separator") {
      return index;
    }
  }
  return -1;
}
