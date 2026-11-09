/**
 * Which menu every command sits in, and in what order, as data.
 *
 * Two menu bars are built from this one list: the application menu Electron
 * draws (`menu.ts`) and the menu a browser build draws at the left of its top
 * bar (`apps/app/src/features/editor/webMenuBar.ts`). Kept here, with no
 * Electron import, so the two cannot drift: an item added to one is in the
 * other, in the same place, and `menuLayout.test.ts` checks every command in
 * `menuCommands.ts` appears exactly once.
 *
 * A slot is a command id, a separator, or one of the few things that are not a
 * command: the Auto Save submenu, whose rows change while the app runs, and the
 * window-level items (Close, Full Screen, the devtools, Minimise), which each
 * surface supplies in its own way or leaves out.
 */

import type { MenuCommandId } from "./menuCommands";

export type MenuSpecial =
  /** The Auto Save recovery submenu. */
  | "autosave"
  /** Close the window on macOS, quit elsewhere. */
  | "closeOrQuit"
  | "fullscreen"
  /** Development builds only. */
  | "devtools"
  | "minimize"
  | "zoom"
  /** About CartCut. */
  | "credit"
  /** The settings. */
  | "setting"
  /** The tutorial page on the web. */
  | "learnMore"
  /** The Extensions menu's contents, built from what is installed. */
  | "extensions";

export type MenuSlot = MenuCommandId | "-" | { special: MenuSpecial };

export type MenuLayout = {
  label: string;
  /** Electron's role for a whole menu, where it has one (macOS's Help search). */
  role?: "help";
  slots: readonly MenuSlot[];
};

export const MENU_LAYOUT: readonly MenuLayout[] = [
  {
    label: "File",
    slots: [
      "file.open",
      "file.save",
      "file.saveAs",
      "-",
      { special: "autosave" },
      "-",
      "file.importMedia",
      "file.importSubtitles",
      "file.exportVideo",
      "file.exportSubtitles",
      "-",
      { special: "closeOrQuit" },
    ],
  },
  {
    label: "Edit",
    slots: [
      "edit.undo",
      "edit.redo",
      "-",
      "edit.cut",
      "edit.copy",
      "edit.paste",
      "edit.delete",
      "-",
      "edit.selectAll",
      "edit.deselectAll",
    ],
  },
  {
    label: "Clip",
    slots: [
      "clip.split",
      "clip.merge",
      "-",
      "clip.detachAudio",
      "clip.rotate",
      "-",
      "clip.group",
      "clip.ungroup",
      "-",
      "clip.moveTrackUp",
      "clip.moveTrackDown",
    ],
  },
  {
    label: "Playback",
    slots: [
      "playback.playPause",
      "-",
      "playback.previousFrame",
      "playback.nextFrame",
      "-",
      "playback.goToStart",
      "playback.goToEnd",
    ],
  },
  {
    label: "Utilities",
    slots: [
      "utilities.record",
      "utilities.audioRecord",
      "utilities.screenRecorder",
      "-",
      "utilities.automaticCaption",
      "utilities.textToSpeech",
      "utilities.prompter",
      "-",
      "utilities.autoTrack",
      "utilities.proxyMedia",
      "-",
      "utilities.exportTemplate",
    ],
  },
  {
    label: "View",
    slots: [
      "view.previewFit",
      "view.previewZoomIn",
      "view.previewZoomOut",
      "-",
      { special: "fullscreen" },
      { special: "devtools" },
    ],
  },
  {
    label: "Extensions",
    slots: [{ special: "extensions" }],
  },
  {
    label: "Window",
    slots: [{ special: "minimize" }, { special: "zoom" }],
  },
  {
    label: "About",
    slots: [{ special: "credit" }, { special: "setting" }],
  },
  {
    label: "Help",
    role: "help",
    slots: [
      "help.shortcuts",
      "help.tutorial",
      "help.resetOnboarding",
      "-",
      { special: "learnMore" },
    ],
  },
];

/**
 * The slots with separators tidied: none at either end and never two in a
 * row. A surface that leaves items out (the browser has no Screen Recorder)
 * would otherwise draw a rule with nothing between it and the next.
 */
export function tidySlots<T>(slots: readonly (T | "-")[]): (T | "-")[] {
  const out: (T | "-")[] = [];
  for (const slot of slots) {
    if (slot === "-" && (out.length === 0 || out[out.length - 1] === "-")) {
      continue;
    }
    out.push(slot);
  }
  while (out.length > 0 && out[out.length - 1] === "-") {
    out.pop();
  }
  return out;
}

/** Where the Learn More item points. */
export const LEARN_MORE_URL = "https://cartesiancs.com/cartcut/tutorial";
