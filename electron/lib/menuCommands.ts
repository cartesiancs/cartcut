/**
 * Every command the application menu can issue, as data.
 *
 * The menu bar is a second surface onto the editor's commands, and the rule
 * `features/editor/actions.ts` states for the toolbar applies here too: the
 * menu item and the keystroke must be the same behaviour, not two
 * implementations of it. So this module holds only *what* the menu offers —
 * `electron/lib/menu.ts` arranges it into menus, and the renderer's
 * `features/editor/menuCommands.ts` runs it. Nothing here imports Electron,
 * which is what lets a suite on the renderer side check that every id listed
 * below is one the renderer actually implements.
 *
 * **`rendererOwnsKey` is the load-bearing field.** A menu accelerator is
 * registered with the system and fires whatever the page does with the same
 * keystroke — a renderer `preventDefault` does not cancel it, which is the
 * lesson `menu.ts` already records about the zoom roles. So for a combination
 * the renderer *also* binds on `keydown`, sending the command from here as
 * well would run it twice: two undo steps for one ⌘Z. Those entries carry
 * `rendererOwnsKey`, and their click handler does nothing when the click came
 * from the accelerator rather than from the menu. The accelerator is still
 * registered — that is what draws "⌘Z" next to the item — but the keystroke is
 * left to the handler that already has the editor's context: which canvas has
 * focus, whether a text field is being typed into, whether the mask pen owns
 * the key.
 *
 * The rest are menu-owned: no renderer `keydown` binds them, so the click
 * handler sends them however it was triggered.
 *
 * Deliberately absent: accelerators for Space, the arrow keys, Delete and
 * Backspace. A menu accelerator is global to the window and there is no
 * per-focus escape from it, so registering Space would toggle playback every
 * time someone typed a space into a caption, and Backspace would delete the
 * selected clip instead of a character. Those bindings stay where they can see
 * the focus — `elementTimelineCanvas._handleKeydown` and
 * `Timeline._handleKeydown` — and their menu items are offered without a
 * shortcut rather than with one that would misfire. `features/editor/shortcuts`
 * is where the user reads what they are.
 */

export type MenuCommandId =
  // File
  | "file.open"
  | "file.save"
  | "file.saveAs"
  | "file.importMedia"
  | "file.exportVideo"
  // Edit
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "edit.deselectAll"
  // Clip
  | "clip.split"
  | "clip.merge"
  | "clip.detachAudio"
  | "clip.rotate"
  | "clip.group"
  | "clip.ungroup"
  | "clip.moveTrackUp"
  | "clip.moveTrackDown"
  // Playback
  | "playback.playPause"
  | "playback.nextFrame"
  | "playback.previousFrame"
  | "playback.goToStart"
  | "playback.goToEnd"
  // View
  | "view.previewFit"
  | "view.previewZoomIn"
  | "view.previewZoomOut"
  // Help
  | "help.shortcuts";

export interface MenuCommand {
  id: MenuCommandId;
  /** What the menu item says. Title Case, as macOS menus are. */
  label: string;
  /** An Electron accelerator, or absent for an item with no shortcut. */
  accelerator?: string;
  /**
   * The renderer binds this accelerator on `keydown` and handles it there.
   * The item still shows the shortcut; pressing it does not send the command.
   */
  rendererOwnsKey?: boolean;
}

export const MENU_COMMANDS: readonly MenuCommand[] = [
  // ------------------------------------------------------------------- File
  { id: "file.open", label: "Open Project…", accelerator: "CmdOrCtrl+O" },
  { id: "file.save", label: "Save Project", accelerator: "CmdOrCtrl+S" },
  {
    id: "file.saveAs",
    label: "Save Project As…",
    accelerator: "CmdOrCtrl+Shift+S",
  },
  {
    id: "file.importMedia",
    label: "Import Media…",
    accelerator: "CmdOrCtrl+I",
  },
  {
    id: "file.exportVideo",
    label: "Export Video…",
    accelerator: "CmdOrCtrl+E",
  },

  // ------------------------------------------------------------------- Edit
  {
    id: "edit.undo",
    label: "Undo",
    accelerator: "CmdOrCtrl+Z",
    rendererOwnsKey: true,
  },
  {
    id: "edit.redo",
    label: "Redo",
    accelerator: "CmdOrCtrl+Shift+Z",
    rendererOwnsKey: true,
  },
  {
    id: "edit.cut",
    label: "Cut",
    accelerator: "CmdOrCtrl+X",
    rendererOwnsKey: true,
  },
  {
    id: "edit.copy",
    label: "Copy",
    accelerator: "CmdOrCtrl+C",
    rendererOwnsKey: true,
  },
  {
    id: "edit.paste",
    label: "Paste",
    accelerator: "CmdOrCtrl+V",
    rendererOwnsKey: true,
  },
  // ⌫ and ⌦ are bound in the renderer and cannot be registered here — see the
  // note at the top of this file.
  { id: "edit.delete", label: "Delete" },
  { id: "edit.selectAll", label: "Select All", accelerator: "CmdOrCtrl+A" },
  {
    id: "edit.deselectAll",
    label: "Deselect All",
    accelerator: "CmdOrCtrl+Shift+A",
  },

  // ------------------------------------------------------------------- Clip
  {
    id: "clip.split",
    label: "Split at Playhead",
    accelerator: "CmdOrCtrl+D",
    rendererOwnsKey: true,
  },
  { id: "clip.merge", label: "Merge Clips" },
  { id: "clip.detachAudio", label: "Detach Audio" },
  { id: "clip.rotate", label: "Rotate 90°" },
  { id: "clip.group", label: "Group", accelerator: "CmdOrCtrl+G" },
  { id: "clip.ungroup", label: "Ungroup", accelerator: "CmdOrCtrl+Shift+G" },
  { id: "clip.moveTrackUp", label: "Move Up a Track" },
  { id: "clip.moveTrackDown", label: "Move Down a Track" },

  // --------------------------------------------------------------- Playback
  { id: "playback.playPause", label: "Play / Pause" },
  { id: "playback.nextFrame", label: "Next Frame" },
  { id: "playback.previousFrame", label: "Previous Frame" },
  { id: "playback.goToStart", label: "Go to Start" },
  { id: "playback.goToEnd", label: "Go to End" },

  // ------------------------------------------------------------------- View
  {
    id: "view.previewFit",
    label: "Fit Preview",
    accelerator: "CmdOrCtrl+0",
    rendererOwnsKey: true,
  },
  {
    id: "view.previewZoomIn",
    label: "Zoom In",
    accelerator: "CmdOrCtrl+Plus",
    rendererOwnsKey: true,
  },
  {
    id: "view.previewZoomOut",
    label: "Zoom Out",
    accelerator: "CmdOrCtrl+-",
    rendererOwnsKey: true,
  },

  // ------------------------------------------------------------------- Help
  {
    id: "help.shortcuts",
    label: "Keyboard Shortcuts",
    accelerator: "CmdOrCtrl+/",
  },
];

const BY_ID = new Map<MenuCommandId, MenuCommand>(
  MENU_COMMANDS.map((command) => [command.id, command]),
);

/**
 * Throws rather than returning `undefined`, matching
 * `features/editor/shortcuts#shortcut`: the ids are a closed union, so a miss
 * means the table and the menu have drifted, and an item labelled `undefined`
 * is a worse way to discover that than a crash on startup.
 */
export function menuCommand(id: MenuCommandId): MenuCommand {
  const command = BY_ID.get(id);
  if (command == null) {
    throw new Error(`Unknown menu command: ${id}`);
  }
  return command;
}
