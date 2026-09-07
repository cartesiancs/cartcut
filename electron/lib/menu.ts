import { app, BrowserWindow, Menu } from "electron";
import * as path from "path";
import { mainWindow, window } from "./window.js";

const isMac = process.platform === "darwin";

const template: any = [
  // { role: 'appMenu' }
  ...(isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : []),
  // { role: 'fileMenu' }
  {
    label: "File",
    submenu: [
      {
        label: "Save Project",
        // `CmdOrCtrl` resolves per platform here in the main process and
        // reaches the renderer as IPC, never as a keydown it has to classify —
        // so this stays correct alongside the renderer's strict Cmd-on-macOS
        // modifier rather than competing with it.
        accelerator: "CmdOrCtrl+S",
        click: () => {
          mainWindow.webContents.send("SHORTCUT_CONTROL_S");
        },
      },
      {
        label: "Open Project",
        accelerator: "CmdOrCtrl+O",
        click: () => {
          mainWindow.webContents.send("SHORTCUT_CONTROL_O");
        },
      },
    ],
  },
  // { role: 'editMenu' }
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
    ],
  },
  // { role: 'viewMenu' }
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      // No `resetZoom`/`zoomIn`/`zoomOut`. Their default accelerators are
      // exactly CmdOrCtrl+0/+/-, which is what the preview canvas binds for
      // fit and zoom — and a renderer `preventDefault` cannot cancel a
      // main-process menu accelerator, so both fired: the preview zoomed and
      // the whole UI scaled with it. The editor's chrome is a fixed layout
      // that has no use for browser page zoom, so the keys go to the preview.
      { role: "togglefullscreen" },
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
