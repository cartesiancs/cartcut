import { app, BrowserWindow, Menu } from "electron";
import * as path from "path";
import { mainWindow, window } from "./window.js";
import { menuCommand, type MenuCommandId } from "./menuCommands.js";
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

const template: any = [
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
  // { role: 'fileMenu' }
  {
    label: "File",
    submenu: [
      // `CmdOrCtrl` resolves per platform here in the main process and reaches
      // the renderer as IPC, never as a keydown it has to classify — so these
      // stay correct alongside the renderer's strict Cmd-on-macOS modifier
      // rather than competing with it.
      item("file.open"),
      item("file.save"),
      item("file.saveAs"),
      separator,
      item("file.importMedia"),
      item("file.exportVideo"),
      separator,
      isMac ? { role: "close" } : { role: "quit" },
    ],
  },
  // { role: 'editMenu' }
  //
  // No `undo`/`redo`/`cut`/`copy`/`paste` roles. Those act on the focused text
  // field and nothing else, so choosing Edit → Copy with three clips selected
  // copied nothing at all — the menu named a command the editor has and then
  // ran a different one. These items reach the editor's own commands instead,
  // and the renderer's dispatcher hands the keystroke back to the native
  // editing command when the caret is in a text field, which is the only case
  // the roles were serving.
  {
    label: "Edit",
    submenu: [
      item("edit.undo"),
      item("edit.redo"),
      separator,
      item("edit.cut"),
      item("edit.copy"),
      item("edit.paste"),
      item("edit.delete"),
      separator,
      item("edit.selectAll"),
      item("edit.deselectAll"),
    ],
  },
  {
    label: "Clip",
    submenu: [
      item("clip.split"),
      item("clip.merge"),
      separator,
      item("clip.detachAudio"),
      item("clip.rotate"),
      separator,
      item("clip.group"),
      item("clip.ungroup"),
      separator,
      item("clip.moveTrackUp"),
      item("clip.moveTrackDown"),
    ],
  },
  {
    label: "Playback",
    submenu: [
      item("playback.playPause"),
      separator,
      item("playback.previousFrame"),
      item("playback.nextFrame"),
      separator,
      item("playback.goToStart"),
      item("playback.goToEnd"),
    ],
  },
  // { role: 'viewMenu' }
  {
    label: "View",
    submenu: [
      // No `resetZoom`/`zoomIn`/`zoomOut` roles. Their default accelerators are
      // exactly CmdOrCtrl+0/+/-, which is what the preview canvas binds for
      // fit and zoom — and a renderer `preventDefault` cannot cancel a
      // main-process menu accelerator, so both fired: the preview zoomed and
      // the whole UI scaled with it. The editor's chrome is a fixed layout that
      // has no use for browser page zoom, so the keys go to the preview, and
      // these items name that rather than the page's zoom.
      item("view.previewFit"),
      item("view.previewZoomIn"),
      item("view.previewZoomOut"),
      separator,
      { role: "togglefullscreen" },
      // No `reload`/`forceReload`, in any build. A menu item *is* its
      // keystroke — `role: "reload"` registers CmdOrCtrl+R with the system —
      // and ⌘R on a video editor is a data-loss key: the renderer holds the
      // whole `TimelineDocument` and the undo history, and a reload drops both
      // with no prompt. That is as true in development as in a release, where
      // the document being thrown away is the one under test, so the item is
      // simply gone. Reloading during development is a restart
      // (`npm run start`), which is what picks up a new main-process build
      // anyway.
      //
      // The devtools stay, under `isDev` — they read the page rather than
      // replacing it. `lib/window.ts` opens them on the same condition.
      ...(isDev ? [separator, { role: "toggleDevTools" }] : []),
    ],
  },
  // { role: 'windowMenu' }
  {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }],
  },
  {
    label: "About",
    submenu: [
      {
        label: "Credit",
        click: async () => {
          const indexFile = "apps/app/page/credit.html";

          let mainWindow = new BrowserWindow({
            width: 600,
            height: 400,
            frame: false,
            titleBarStyle: "customButtonsOnHover",

            webPreferences: {
              nodeIntegration: true,
            },
          });

          mainWindow.loadFile(indexFile);
          mainWindow.setAlwaysOnTop(true, "screen-saver");
          mainWindow.setVisibleOnAllWorkspaces(true);
          mainWindow.show();
        },
      },
      {
        label: "Setting",
        click: async () => {
          window.createWindow({
            width: 600,
            height: 540,
            webPreferences: {
              preload: path.join(__dirname, "../preload.js"),
            },
            indexFile: "apps/app/page/setting.html",
          });
        },
      },
    ],
  },
  {
    role: "help",
    submenu: [
      item("help.shortcuts"),
      separator,
      {
        label: "Learn More",
        click: async () => {
          const { shell } = require("electron");
          await shell.openExternal("https://blog.nugget.studio/");
        },
      },
    ],
  },
];

const menu = Menu.buildFromTemplate(template);

export { menu };
