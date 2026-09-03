import { BrowserWindow, Menu, screen } from "electron";
import { menu } from "./menu.js";
import { autoUpdater } from "electron-updater";
import { installDisplayMediaHandler } from "./displayMedia.js";

import isDev from "electron-is-dev";
import path from "path";

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

    // The handler moved to `lib/displayMedia.ts`. The one that used to be
    // inline here granted `sources[0]` to anything that asked — including a
    // page inside the `<webview>` extension sandbox — and logged every window
    // on the machine to the console while it did it.
    installDisplayMediaHandler();

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

  /**
   * The recorder's viewfinder: the camera bubble and the drawing surface.
   *
   * Transparent, click-through and floating over everything, so it can sit on
   * top of whatever is being recorded without being in the way of it.
   *
   * **`setContentProtection(true)` is the load-bearing line.** It maps to
   * `NSWindowSharingNone` on macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows, so
   * the compositor leaves this window out of every screen capture — including
   * ours. Without it the bubble the user sees is captured into the screen
   * recording, and the composite pass then draws a second bubble on top of the
   * first. It is also why the bubble can be positioned live and still end up
   * wherever the finished file says: the picture and the preview are two
   * renderings of the same layout, not one recording of the other.
   *
   * Sized to `bounds`, not `workAreaSize`: the work area excludes the menu bar
   * and the dock, and an overlay that stops short of them cannot draw over the
   * part of the screen that is being recorded.
   */
  createRecordOverlayWindow: () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { x, y, width, height } = primaryDisplay.bounds;

    const overlayWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
      resizable: false,
      transparent: true,
      backgroundColor: "#00000000",
      skipTaskbar: true,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      movable: false,
      show: false,
      hasShadow: false,
      roundedCorners: false,
      focusable: false,
    });

    overlayWindow.setContentProtection(true);
    overlayWindow.setAlwaysOnTop(true, "screen-saver");

    // `skipTransformProcessType` for the reason `createSplashWindow` documents
    // at length: without it, asking for `visibleOnFullScreen` on macOS turns
    // the whole process into an accessory and the Dock icon never comes back.
    overlayWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });

    // `forward: true` so the overlay still sees `mousemove` while ignoring
    // clicks — that is what lets drawing mode be armed without the window
    // having to become interactive first.
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.loadFile("apps/overlay-record/dist/overlay.html");
    overlayWindow.once("ready-to-show", () => overlayWindow.show());

    return overlayWindow;
  },

  /**
   * The recorder's engine: every capture stream, every encoder, the composite
   * pass. No UI at all.
   *
   * Hidden, and hidden is the point — it must never appear in the recording,
   * and it has nothing to show. `backgroundThrottling: false` is what keeps an
   * unfocused, invisible window running its encode loop at full rate; Chromium
   * otherwise clamps timers in a backgrounded renderer to once a second, which
   * would drop a screen recording to one frame per second the moment the user
   * clicked on anything.
   *
   * Separate from the overlay because their lifetimes differ: the overlay
   * closes the instant the take stops, and the engine keeps working through the
   * composite pass afterwards.
   */
  createRecordEngineWindow: () => {
    const engineWindow = new BrowserWindow({
      width: 480,
      height: 320,
      webPreferences: {
        backgroundThrottling: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
      show: false,
      skipTaskbar: true,
      frame: false,
    });

    engineWindow.loadFile("apps/overlay-record/dist/engine.html");

    // Off by default even in development. The engine has no UI worth
    // inspecting, and an open devtools window is a second debugger target that
    // anything driving the app over CDP has to step around — plus it appears on
    // screen, which is unhelpful for a window whose whole job is not to.
    // `lib/recorder.ts` forwards its console to the main log instead.
    if (isDev && process.env.CARTCUT_RECORD_DEVTOOLS === "1") {
      engineWindow.webContents.openDevTools({ mode: "detach" });
    }

    return engineWindow;
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

export { window, mainWindow };
