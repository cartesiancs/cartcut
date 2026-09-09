import { mainWindow } from "../lib/window";

/**
 * The native text-editing commands, for the renderer to hand a keystroke back
 * to when the caret is in a text field.
 *
 * The Edit menu used to carry Electron's `undo`/`cut`/`copy`/`paste` roles,
 * which are exactly these calls. Replacing them with the editor's own clip
 * commands (see `lib/menu.ts`) left typing with nowhere to go, so this is that
 * half, kept and made explicit: `features/editor/textEditing.ts` cancels the
 * keystroke's default and asks for the command by name, which is one action
 * whatever the engine would otherwise have done with the key.
 *
 * `paste` is why this goes through the main process rather than
 * `document.execCommand`, which Chromium refuses for clipboard *reads*.
 *
 * The allowlist is the point of the indirection: the renderer names a command
 * and cannot reach anything else on `webContents`.
 */
const COMMANDS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
] as const;

type EditingCommand = (typeof COMMANDS)[number];

function isEditingCommand(value: unknown): value is EditingCommand {
  return (
    typeof value === "string" && (COMMANDS as readonly string[]).includes(value)
  );
}

export const ipcEditing = {
  run: (event: unknown, command: unknown) => {
    if (!isEditingCommand(command)) {
      return;
    }
    mainWindow?.webContents[command]();
  },
};
