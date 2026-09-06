import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { renderMain } from "./lib/render.js";
import { window } from "./lib/window.js";
import { updater } from "./lib/autoUpdater.js";

import config from "./config.json";

import ffmpeg from "fluent-ffmpeg";

import path from "path";
import isDev from "electron-is-dev";
import log from "electron-log";

import { shellLib } from "./lib/shell.js";
import { electronInit } from "./lib/init.js";
import { fontLib } from "./lib/font.js";
import { presetLib } from "./lib/preset.js";
import { ipcExtension } from "./ipc/ipcExtension.js";
import { ipcStore } from "./ipc/ipcStore.js";
import { ipcApp } from "./ipc/ipcApp.js";
import { ipcTimeline } from "./ipc/ipcTimeline.js";
import { ipcDialog } from "./ipc/ipcDialog.js";
import { ipcFilesystem } from "./ipc/ipcFilesystem.js";
import { downloadFfmpeg, validateFFmpeg } from "./validate.js";
import { ipcStream } from "./ipc/ipcStream.js";
import { ipcDesktopCapturer } from "./ipc/ipcDesktopCapturer.js";
import { ipcOverlayRecord } from "./ipc/ipcOverlayRecord.js";
import { closeRecorder } from "./lib/recorder.js";

import "./render/renderFrame.js";
import { ipcRenderV2 } from "./render/renderFrame.js";
import { ipcMedia } from "./ipc/ipcMedia.js";
import { ipcProxy } from "./ipc/ipcProxy.js";
import { runServer } from "./webServer.js";
import { ipcSelfhosted } from "./ipc/ipcSelfhosted.js";
import { httpFFmpegRenderV2 } from "./server/controllers/render.js";
import { ipcAi } from "./ipc/ipcAi.js";
import { ipcYtdlp } from "./ipc/ipcYtdlp.js";
import { attachBridge } from "./mcp/bridge.js";
import { startMcpServer, stopMcpServer } from "./mcp/server.js";
import Store from "electron-store";

const store = new Store();

let resourcesPath = "";
export let mainWindow;

// How long the splash image stays up before the editor window is revealed.
const SPLASH_DURATION_MS = 3000;

log.info("App starting...");
if (isDev) {
  resourcesPath = ".";
  log.info("Running in development");
} else {
  resourcesPath = process.resourcesPath;
  log.info("Running in production");
}

// const FFMPEG_BIN_PATH = ffmpegConfig.FFMPEG_BIN_PATH;
// const FFMPEG_PATH = ffmpegConfig.FFMPEG_PATH;
// const FFPROBE_PATH = ffmpegConfig.FFPROBE_PATH;

autoUpdater.on("checking-for-update", updater.checkingForUpdate);
autoUpdater.on("update-available", updater.updateAvailable);
autoUpdater.on("update-not-available", updater.updateNotAvailable);
autoUpdater.on("error", updater.error);
autoUpdater.on("download-progress", updater.downloadProgress);
autoUpdater.on("update-downloaded", updater.updateDownloaded);

// const createFfmpegDir = async () => {
//   let mkdir = await fsp.mkdir(FFMPEG_BIN_PATH, { recursive: true });
//   let status = mkdir == null ? false : true;
//   return { status: status };
// };

ipcMain.on("DOWNLOAD_FFMPEG", async (evt) => {
  downloadFfmpeg("ffmpeg");
});

ipcMain.on("CLIENT_READY", async (evt) => {
  evt.sender.send("EXIST_FFMPEG", resourcesPath, config);
});

ipcMain.handle("GET_METADATA", async (evt, bloburl, mediapath) => {
  const result = new Promise((resolve, reject) => {
    ffmpeg.ffprobe(mediapath, (err, metadata) => {
      console.log(mediapath, metadata, bloburl);
      resolve({
        bloburl: bloburl,
        metadata: metadata,
      });
    });
  });

  return result;
});
ipcMain.on("INIT", electronInit.init);
ipcMain.on("SELECT_DIR", ipcDialog.openDirectory);
ipcMain.on("OPEN_PATH", shellLib.openPath);
ipcMain.on("OPEN_URL", shellLib.openUrl);
ipcMain.on("RENDER", renderMain.start);

ipcMain.handle("ffmpeg:combineFrame", renderMain.combineFrame);
ipcMain.handle(
  "ffmpeg:extractAudioFromVideo",
  renderMain.extractAudioFromVideo,
);

ipcMain.handle("extension:timeline:get", ipcTimeline.get);
ipcMain.handle("extension:timeline:add", ipcTimeline.add);

ipcMain.handle("dialog:openDirectory", ipcDialog.openDirectory);
ipcMain.handle("dialog:openFile", ipcDialog.openFile);
ipcMain.handle("dialog:exportVideo", ipcDialog.exportVideo);
ipcMain.handle("dialog:saveProject", ipcDialog.saveProject);

ipcMain.handle("filesystem:getDirectory", ipcFilesystem.getDirectory);
ipcMain.handle("filesystem:mkdir", ipcFilesystem.makeDirectory);
ipcMain.handle("filesystem:emptyDirSync", ipcFilesystem.emptyDirectorySync);
ipcMain.handle("filesystem:writeFile", ipcFilesystem.writeFile);
ipcMain.handle("filesystem:readFile", ipcFilesystem.readFile);
ipcMain.handle("filesystem:removeDirectory", ipcFilesystem.removeDirectory);
ipcMain.handle("filesystem:removeFile", ipcFilesystem.removeFile);
ipcMain.handle("filesystem:existFile", ipcFilesystem.existFile);
ipcMain.handle(
  "filesystem:saveGeneratedAsset",
  ipcFilesystem.saveGeneratedAsset,
);

ipcMain.handle("store:set", ipcStore.set);
ipcMain.handle("store:get", ipcStore.get);
ipcMain.handle("store:delete", ipcStore.delete);

ipcMain.on("app:forceClose", ipcApp.forceClose);
ipcMain.on("app:restart", ipcApp.restart);

ipcMain.handle("stream:saveBufferToVideo", ipcStream.saveBufferToVideo);
ipcMain.handle("stream:saveBufferToAudio", ipcStream.saveBufferToAudio);
ipcMain.handle("stream:saveBufferToTempFile", ipcStream.saveBufferToTempFile);

ipcMain.handle("media:backgroundRemove", ipcMedia.backgroundRemove);

// Proxy media. `generate` is long-running and reports on `proxy:progress`.
ipcMain.handle("proxy:list", ipcProxy.list);
ipcMain.handle("proxy:stats", ipcProxy.stats);
ipcMain.handle("proxy:inspect", ipcProxy.inspect);
ipcMain.handle("proxy:generate", ipcProxy.generate);
ipcMain.handle("proxy:clear", ipcProxy.clear);

ipcMain.handle("app:getResourcesPath", ipcApp.getResourcesPath);
ipcMain.handle("app:getTempPath", ipcApp.getTempPath);
ipcMain.handle("app:getAppInfo", ipcApp.getAppInfo);
ipcMain.handle("font:getLists", fontLib.getFontList);
ipcMain.handle("font:getLocalFontLists", fontLib.getLocalFontList);
ipcMain.handle("font:getPresetFontLists", fontLib.getPresetFontList);

// Enumeration only. `presetLib` never parses a manifest and never opens a path
// the renderer chose — see its header for why the schema lives on the far side
// of this boundary.
ipcMain.handle("preset:list", presetLib.list);
ipcMain.handle("preset:userDirectory", presetLib.userDirectory);
ipcMain.handle(
  "preset:installLut",
  (_event, name: string, extension: string, bytes: Uint8Array) =>
    presetLib.installLut(name, extension, bytes),
);

ipcMain.handle("desktopCapturer:getSources", ipcDesktopCapturer.getSources);

// The editor calls only `show`. Everything below it is the recorder's engine
// renderer asking main for the four things a renderer cannot do: disk, the
// pointer, FFmpeg, and the tray. See `electron/ipc/ipcOverlayRecord.ts`.
ipcMain.handle("overlayRecord:show", ipcOverlayRecord.show);
ipcMain.handle("overlayRecord:close", ipcOverlayRecord.close);
ipcMain.handle("overlayRecord:sources", ipcOverlayRecord.sources);
ipcMain.handle("overlayRecord:platform", ipcOverlayRecord.platform);
ipcMain.handle("overlayRecord:permissions", ipcOverlayRecord.permissions);
ipcMain.handle(
  "overlayRecord:requestPermission",
  ipcOverlayRecord.requestPermission,
);
ipcMain.handle("overlayRecord:setTray", ipcOverlayRecord.setTray);
ipcMain.handle("overlayRecord:setOverlay", ipcOverlayRecord.setOverlay);
ipcMain.handle("overlayRecord:setDrawing", ipcOverlayRecord.setDrawing);
ipcMain.handle("overlayRecord:armDisplayMedia", ipcOverlayRecord.armDisplayMedia);
ipcMain.handle(
  "overlayRecord:disarmDisplayMedia",
  ipcOverlayRecord.disarmDisplayMedia,
);
ipcMain.handle("overlayRecord:start", ipcOverlayRecord.start);
// `handle`, not `on`: `append` resolves only once the pipe has room, and that
// resolution is the backpressure the encoder awaits — the same arrangement
// `render:v2:sendFrame` uses for export frames.
ipcMain.handle("overlayRecord:append", ipcOverlayRecord.append);
ipcMain.handle("overlayRecord:finishFile", ipcOverlayRecord.finishFile);
ipcMain.handle("overlayRecord:pause", ipcOverlayRecord.pause);
ipcMain.handle("overlayRecord:resume", ipcOverlayRecord.resume);
ipcMain.handle("overlayRecord:stroke", ipcOverlayRecord.stroke);
ipcMain.handle("overlayRecord:click", ipcOverlayRecord.click);
ipcMain.handle("overlayRecord:stop", ipcOverlayRecord.stop);
ipcMain.handle("overlayRecord:deliver", ipcOverlayRecord.deliver);
ipcMain.handle("overlayRecord:cancel", ipcOverlayRecord.cancel);
ipcMain.handle("overlayRecord:openFolder", ipcOverlayRecord.openFolder);

ipcMain.handle("extension:open:file", ipcExtension.openFile);
ipcMain.handle("extension:open:dir", ipcExtension.openDir);

ipcMain.handle("selfhosted:run", ipcSelfhosted.run);

ipcMain.handle("ai:stt", ipcAi.stt);
ipcMain.handle("ai:text", ipcAi.text);
ipcMain.handle("ai:setKey", ipcAi.setKey);
ipcMain.handle("ai:getKey", ipcAi.getKey);
ipcMain.handle("ai:runMcpServer", ipcAi.runMcpServer);
ipcMain.handle("agent:getStatus", ipcAi.mcpStatus);

ipcMain.handle("ytdlp:downloadVideo", ipcYtdlp.downloadVideo);

// `handle`, not `on`: `start` has to resolve after the spawn so frame 0 cannot
// race it, and `sendFrame` resolves only once the pipe has room, which is what
// applies backpressure now that frames are raw.
ipcMain.handle("render:v2:start", ipcRenderV2.start);
ipcMain.handle("render:v2:sendFrame", ipcRenderV2.sendFrame);
ipcMain.handle("render:v2:finishStream", ipcRenderV2.finishStream);
ipcMain.handle("render:v2:cancel", ipcRenderV2.cancel);

ipcMain.handle(
  "render:offscreen:readyToRender",
  httpFFmpegRenderV2.readyToRender,
);
ipcMain.handle("render:offscreen:start", httpFFmpegRenderV2.start);
// `handle`: `sendFrame` resolves only when the pipe has room, and that
// resolution is what applies backpressure to the offscreen frame loop.
ipcMain.handle("render:offscreen:sendFrame", httpFFmpegRenderV2.sendFrame);
ipcMain.handle(
  "render:offscreen:finishStream",
  httpFFmpegRenderV2.finishStream,
);

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("cartcutapp", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("cartcutapp");
}

const gotTheLock = app.requestSingleInstanceLock();
let deeplinkingUrl;

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    if (process.platform == "win32") {
      deeplinkingUrl = commandLine.slice(1)[1];
      mainWindow.webContents.send("LOGIN_SUCCESS", deeplinkingUrl);
    }
  });

  app.whenReady().then(() => {
    // The editor loads hidden behind the splash and is revealed when it
    // closes, so the first thing on screen is the splash image and not a
    // half-painted editor.
    const splashWindow = window.createSplashWindow();
    splashWindow.once("ready-to-show", () => splashWindow.show());

    mainWindow = window.createMainWindow({ show: false });

    // A dropped file must never replace the editor.
    //
    // Chromium's default action for a file dropped on a page is to navigate to
    // it, and the editor is a `file://` page, so that navigation is permitted:
    // one drop that no handler called `preventDefault` on and the whole app is
    // gone, replaced by a video player, with the project unsaved and no way
    // back. The renderer guards this too; the cost of the two disagreeing is
    // the user's work, so it is worth guarding twice.
    //
    // Scoped to the editor window on purpose. Bound to every `webContents` it
    // would also stop the `<webview>` the extension browser navigates freely.
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== mainWindow.webContents.getURL()) {
        event.preventDefault();
        log.warn("[nav] blocked navigation to", url);
      }
    });

    const revealEditor = () => {
      if (!splashWindow.isDestroyed()) splashWindow.destroy();
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
      }
    };

    setTimeout(revealEditor, SPLASH_DURATION_MS);

    validateFFmpeg();

    // The MCP tools reach the timeline through this window; without it every
    // tool call fails with "editor window is not available".
    attachBridge(mainWindow.webContents);

    // Started here rather than behind the settings button so that Claude Code
    // can connect to a running Cartcut without the user first remembering to
    // switch something on. It listens on loopback and requires a bearer token
    // (`electron/mcp/server.ts`), and a failure to bind is not fatal — the
    // settings dialog reports it.
    if (store.get("mcp_autostart") !== false) {
      startMcpServer().then((result) => {
        if (!result.ok) {
          log.warn("[mcp] could not start:", result.error);
        }
      });
    }

    // window.createAutomaticCaptionWindow();

    mainWindow.on("close", function (e) {
      e.preventDefault();
      mainWindow.webContents.send("WHEN_CLOSE_EVENT", "message");
    });
  });

  app.on("open-url", function (event, data) {
    mainWindow.webContents.send("LOGIN_SUCCESS", data);
  });
}

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});

// Release port 9826 on the way out, so relaunching does not hit EADDRINUSE.
app.on("will-quit", () => {
  stopMcpServer();

  // Best effort. `ipcApp.forceClose` reaches `app.exit(0)`, which does not run
  // this — but a tray icon outliving its app is the one leftover a user can
  // see, so it is worth removing on every path that does.
  closeRecorder();
});
