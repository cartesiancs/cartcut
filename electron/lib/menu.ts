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
        accelerator: process.platform === "darwin" ? "Cmd+S" : "Control+S",
        click: () => {
          mainWindow.webContents.send("SHORTCUT_CONTROL_S");
        },
      },
      {
        label: "Open Project",
        accelerator: process.platform === "darwin" ? "Cmd+O" : "Control+O",
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
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
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
      // {
      //   label: "About Cartcut",
      //   click: async () => {
      //     let mainWindow = window.createWindow({
      //       width: 600,
      //       height: 240,
      //       webPreferences: {
      //         nodeIntegration: true,
      //         contextIsolation: false,
      //       },
      //       indexFile: "./app/page/about.html",
      //     });
      //   },
      // },
      {
        label: "Credit",
        click: async () => {
          const indexFile = "app/page/credit.html";

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
            indexFile: "./app/page/setting.html",
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
