import {
  BrowserWindow,
  desktopCapturer,
  Menu,
  session,
  screen,
  Tray,
  nativeImage,
} from "electron";
import { menu } from "./menu.js";
import { autoUpdater } from "electron-updater";

import isDev from "electron-is-dev";
import path from "path";

const trayIcon = nativeImage.createFromPath(
  path.join("assets/icons/png/tray.png"),
);

let mainWindow;
const WINDOW_BACKGROUND_COLOR = "#252729";
const WINDOW_ICON = path.join(__dirname, "..", "assets/icons/png/512x512.png");

// apps/app/assets/images/splash.png is 1724x1037; keep that aspect ratio so the image
// fills the window with no letterboxing.
const SPLASH_WIDTH = 640;
const SPLASH_HEIGHT = Math.round((SPLASH_WIDTH * 1037) / 1724);

const window = {
  createMainWindow: ({ show = true }: { show?: boolean } = {}) => {
    mainWindow = window.createWindow({
      width: 1400,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: true,
        preload: path.join(__dirname, "..", "preload.js"),
      },
      indexFile: "apps/app/index.html",
      show: show,
    });

    // Not `checkForUpdatesAndNotify`: that raises a native notification once
    // the download finishes, which would land alongside the "Update ready"
    // dialog in `lib/autoUpdater.ts`. Development is already a no-op — the
    // updater bails on `app.isPackaged`.
    autoUpdater.checkForUpdates();
    Menu.setApplicationMenu(menu);

    session.defaultSession.setDisplayMediaRequestHandler((_, callback) => {
      desktopCapturer
        .getSources({ types: ["window", "screen"] })
        .then((sources) => {
          for (let i = 0; i < sources.length; ++i) {
            console.log(
              sources[i].name,
              sources[i].thumbnail.getSize(),
              sources[i].thumbnail.getAspectRatio(),
              sources[i].thumbnail.getScaleFactors(),
            );
          }

          callback({ video: sources[0], audio: "loopback" });
        });
    });

    if (isDev) {
      mainWindow.webContents.openDevTools();
    }

    return mainWindow;
  },

  createWindow: ({ width, height, webPreferences, indexFile, show }: any) => {
    const newWindow = new BrowserWindow({
      width: width,
      height: height,
      webPreferences: webPreferences,
      show: show !== false,
      backgroundColor: WINDOW_BACKGROUND_COLOR,
      icon: WINDOW_ICON,
      titleBarStyle: "hidden",
      frame: false,

      trafficLightPosition: { x: 10, y: 10 },
      ...(process.platform !== "darwin"
        ? {
            titleBarOverlay: {
              color: "#0f1012",
              symbolColor: "#ffffff",
            },
          }
        : {}),
    });

    newWindow.loadFile(indexFile);

    return newWindow;
  },

  // Shown for `SPLASH_DURATION_MS` (see `electron/main.ts`) while the editor
  // window loads behind it, hidden. Nothing but the image: no frame, no
  // background, no chrome, no drop shadow and no rounded corners — and
  // floating above every other window, ours and everyone else's.
  createSplashWindow: () => {
    const splashWindow = new BrowserWindow({
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
      center: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // "screen-saver" is the level that also clears full-screen apps; plain
    // `alwaysOnTop: true` only floats above normal windows.
    splashWindow.setAlwaysOnTop(true, "screen-saver");

    // `skipTransformProcessType` is not optional here. On macOS, asking for
    // `visibleOnFullScreen` makes Electron call
    // `TransformProcessType(kProcessTransformToUIElementApplication)` on the
    // *whole process* — the app turns into an accessory and loses its Dock
    // icon. Destroying the splash does not transform it back, so the icon
    // stays gone for the rest of the session. Skipping the transform keeps
    // the collection behaviour without touching the activation policy.
    splashWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });

    splashWindow.loadFile("apps/app/page/splash.html");

    return splashWindow;
  },

  createCreditWindow: () => {
    const indexFile = "apps/app/page/credit.html";
    const newWindow = new BrowserWindow({
      width: 600,
      height: 500,
      backgroundColor: WINDOW_BACKGROUND_COLOR,
    });

    newWindow.loadFile(indexFile);

    return newWindow;
  },

  createOverlayRecordWindow: () => {
    const indexFile = "apps/overlay-record/dist/index.html";
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize as any;

    const overlayWindow = new BrowserWindow({
      width: width,
      height: height,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
      resizable: false,
      transparent: true,
      skipTaskbar: true,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      movable: false,
      show: false,
      hasShadow: false,
    });

    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    overlayWindow.setVisibleOnAllWorkspaces(true);
    overlayWindow.setPosition(0, 0, false);
    overlayWindow.show();
    overlayWindow.setIgnoreMouseEvents(true);

    overlayWindow.loadFile(indexFile);

    // setInterval(() => {
    //   overlayWindow.webContents.send("overlayRecord:stop:res", {
    //     msg: "Hello Renderer!",
    //   });
    // }, 1000);

    return overlayWindow;
  },

  createOffscreenRenderWindow: () => {
    const indexFile = "packages/render/dist/index.html";

    const renderWindow = new BrowserWindow({
      width: 100,
      height: 100,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
      resizable: false,
      transparent: true,
      skipTaskbar: true,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      movable: false,
      show: false,
    });

    renderWindow.loadFile(indexFile);

    return renderWindow;
  },

  createAutomaticCaptionWindow: () => {
    const overlayWindow = new BrowserWindow({
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
      width: 600,
      height: 500,
      backgroundColor: WINDOW_BACKGROUND_COLOR,
    });

    overlayWindow.loadURL("http://localhost:5173/");

    // setInterval(() => {
    //   overlayWindow.webContents.send("overlayRecord:stop:res", {
    //     msg: "Hello Renderer!",
    //   });
    // }, 1000);

    return overlayWindow;
  },
};

const createOverlayWindowTray = (overlayWindow) => {
  const tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Exit",
      type: "checkbox",
      checked: false,
      click: (menuItem) => {
        overlayWindow.webContents.send("overlayRecord:stop:res", "");
        overlayWindow.close();
        tray.destroy();
        console.log("Stop Record:", menuItem.checked);
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
};

export { window, mainWindow, createOverlayWindowTray };
