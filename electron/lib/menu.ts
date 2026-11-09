import { setMenuRebuilder } from "./menuRebuild.js";
import { buildMenuGroups } from "../extension/menuContributions.js";
import { extensionMenus, listExtensions } from "../extension/host.js";
import { app, BrowserWindow, Menu } from "electron";
import * as path from "path";
import { mainWindow, window } from "./window.js";
import { menuCommand, type MenuCommandId } from "./menuCommands.js";
import { LEARN_MORE_URL, MENU_LAYOUT, type MenuSpecial } from "./menuLayout.js";
import { autosaveSubmenu } from "./autosaveMenu.js";
import { autosaveRings } from "./autosave.js";
import isDev from "electron-is-dev";

const isMac = process.platform === "darwin";

/**
 * One menu item, from the command table.
 *
 * The click handler is the whole reason `rendererOwnsKey` exists. A menu
 * accelerator is registered with the system and fires whatever the page does
 * with the same keystroke — the comment on the View menu below records what
 * that cost the last time it was overlooked — so for a combination the
 * renderer already binds, sending the command from here as well would run it
 * twice. `triggeredByAccelerator` is what tells the two apart: the item still
 * carries the accelerator, which is what draws the shortcut beside the label,
 * but pressing the keys is left to the renderer's own handler, which knows
 * which surface has focus and whether the user is typing. Choosing the item
 * with the mouse always sends.
 */
function item(id: MenuCommandId) {
  const command = menuCommand(id);

  return {
    label: command.label,
    accelerator: command.accelerator,
    click: (_menuItem: any, _window: any, event: any) => {
      if (command.rendererOwnsKey && event?.triggeredByAccelerator) {
        return;
      }
      mainWindow?.webContents.send("menu:command", command.id);
    },
  };
}

const separator = { type: "separator" };

/**
 * The Extensions menu, built from what the host reported.
 *
 * Every item sends the one `extension.command` id with the extension and
 * command in the payload, the way `file.autoSaveRecover` already carries which
 * recovery point. `MenuCommandId` stays a closed union that way, so an item
 * with nothing behind it remains a compile error rather than a click that does
 * nothing.
 *
 * No accelerators. A menu accelerator is global to the window, so a binding
 * here would fire while the user typed into a caption; extension keybindings
 * live in the renderer, which can see what has focus.
 */
function extensionMenuTemplate(): any[] {
  const groups = buildMenuGroups(
    extensionMenus().map((entry) => ({
      extId: entry.extId,
      displayName:
        listExtensions().find((listing) => listing.id === entry.extId)?.displayName ?? entry.extId,
      items: entry.items,
    })),
  );

  return groups.map((group) => ({
    label: group.displayName,
    submenu: group.items.map((menuItem) => ({
      label: menuItem.label,
      click: () => {
        mainWindow?.webContents.send("menu:command", "extension.command", {
          extId: menuItem.extId,
          commandId: menuItem.commandId,
        });
      },
    })),
  }));
}



/** The About ▸ Credit window. */
async function openCredit(): Promise<void> {
  const indexFile = "apps/app/page/credit.html";

  const credit = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    titleBarStyle: "customButtonsOnHover",

    webPreferences: {
      nodeIntegration: true,
    },
  });

  credit.loadFile(indexFile);
  credit.setAlwaysOnTop(true, "screen-saver");
  credit.setVisibleOnAllWorkspaces(true);
  credit.show();
}

/** The About ▸ Setting window. */
async function openSetting(): Promise<void> {
  window.createWindow({
    width: 600,
    height: 540,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
    },
    indexFile: "apps/app/page/setting.html",
  });
}

/**
 * One special slot of `menuLayout.ts`, as Electron items. A list, because a
 * slot can stand for nothing in this build (the devtools outside development)
 * or for a whole submenu's worth.
 */
function specialItems(special: MenuSpecial): any[] {
  switch (special) {
    case "autosave":
      // Built from the cache main already holds, because Electron builds a
      // submenu synchronously; there is no hook that could await a read when
      // the menu opens. `autosave.ts` calls `installMenu` again when the cache
      // changes.
      return [
        autosaveSubmenu(
          autosaveRings(),
          (key, file) => {
            mainWindow?.webContents.send("menu:command", "file.autoSaveRecover", {
              key,
              file,
            });
          },
          Date.now(),
          -new Date().getTimezoneOffset(),
        ),
      ];
    case "closeOrQuit":
      return [isMac ? { role: "close" } : { role: "quit" }];
    case "fullscreen":
      return [{ role: "togglefullscreen" }];
    // No `reload`/`forceReload`, in any build. A menu item *is* its keystroke
    // (`role: "reload"` registers CmdOrCtrl+R with the system), and ⌘R on a
    // video editor is a data-loss key: the renderer holds the whole
    // `TimelineDocument` and the undo history, and a reload drops both with no
    // prompt. Reloading during development is a restart (`npm run start`), or
    // `npm run start:hot`, opted into per session (`lib/devReload.ts`).
    //
    // The devtools stay, under `isDev`: they read the page rather than
    // replacing it. `lib/window.ts` no longer opens them at launch unless
    // `CARTCUT_DEVTOOLS=1`, so this item is the usual way in.
    case "devtools":
      return isDev ? [separator, { role: "toggleDevTools" }] : [];
    case "minimize":
      return [{ role: "minimize" }];
    case "zoom":
      return [{ role: "zoom" }];
    case "credit":
      return [{ label: "Credit", click: openCredit }];
    case "setting":
      return [{ label: "Setting", click: openSetting }];
    case "learnMore":
      return [
        {
          label: "Learn More",
          click: async () => {
            const { shell } = require("electron");
            await shell.openExternal(LEARN_MORE_URL);
          },
        },
      ];
    case "extensions":
      return extensionMenuTemplate();
  }
}

/**
 * The whole menu, built fresh.
 *
 * A function rather than the module-level constant it was, because the File
 * menu now holds a submenu whose contents change while the app runs. The
 * constant was also evaluated at *require* time, before `app` was populated,
 * so `app.name` in the macOS app menu was read earlier than it needed to be;
 * building on demand fixes that as a side effect.
 *
 * Every menu but the macOS app menu comes from `menuLayout.ts`, which the
 * browser build's menu bar reads too.
 *
 * Two notes the layout cannot carry:
 *
 * - **Edit has no `undo`/`redo`/`cut`/`copy`/`paste` roles.** Those act on the
 *   focused text field and nothing else, so choosing Edit → Copy with three
 *   clips selected copied nothing at all. The items reach the editor's own
 *   commands instead, and the renderer's dispatcher hands the keystroke back to
 *   the native editing command when the caret is in a text field.
 * - **View has no `resetZoom`/`zoomIn`/`zoomOut` roles.** Their default
 *   accelerators are exactly CmdOrCtrl+0/+/-, which the preview canvas binds
 *   for fit and zoom, and a renderer `preventDefault` cannot cancel a
 *   main-process menu accelerator, so both fired: the preview zoomed and the
 *   whole UI scaled with it.
 *
 * `CmdOrCtrl` resolves per platform here in the main process and reaches the
 * renderer as IPC, never as a keydown it has to classify.
 */
function buildTemplate(): any[] {
  const menus = MENU_LAYOUT.map((menu) => {
    const submenu = menu.slots.flatMap((slot) =>
      slot === "-"
        ? [separator]
        : typeof slot === "string"
          ? [item(slot)]
          : specialItems(slot.special),
    );
    // A role menu takes its label from the role, as it always has; the
    // browser's bar draws `menu.label`.
    return {
      ...(menu.role != null ? { role: menu.role } : { label: menu.label }),
      submenu,
    };
  })
    // Present only when something is in it. An empty Extensions menu on a
    // machine with no extensions is a row that teaches the user nothing and
    // that they cannot make useful without leaving the app.
    .filter((menu) => menu.submenu.length > 0);

  return [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              separator,
              { role: "services" },
              separator,
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              separator,
              { role: "quit" },
            ],
          },
        ]
      : []),
    ...menus,
  ];
}

/**
 * Install the menu, reflecting the current Auto Save cache.
 *
 * Called once at window creation and again whenever the cache changes.
 * `autosave.ts` owns the list and calls back here; nothing polls, because
 * every change to the cache is something this process just did.
 */
export function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
}

// Registered once, so anything that changes the menu can ask for a rebuild
// without importing this module and without knowing whether a menu is open.
setMenuRebuilder(installMenu);
