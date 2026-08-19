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

import "./render/renderFrame.js";
import { ipcRenderV2 } from "./render/renderFrame.js";
import { ipcMedia } from "./ipc/ipcMedia.js";
import { runServer } from "./webServer.js";
import { ipcSelfhosted } from "./ipc/ipcSelfhosted.js";
import { httpFFmpegRenderV2 } from "./server/controllers/render.js";
import { ipcAi } from "./ipc/ipcAi.js";
import { ipcYtdlp } from "./ipc/ipcYtdlp.js";

let resourcesPath = "";
export let mainWindow;

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

ipcMain.handle("store:set", ipcStore.set);
ipcMain.handle("store:get", ipcStore.get);
ipcMain.handle("store:delete", ipcStore.delete);

ipcMain.on("app:forceClose", ipcApp.forceClose);
ipcMain.on("app:restart", ipcApp.restart);

ipcMain.handle("stream:saveBufferToVideo", ipcStream.saveBufferToVideo);
ipcMain.handle("stream:saveBufferToAudio", ipcStream.saveBufferToAudio);
ipcMain.handle("stream:saveBufferToTempFile", ipcStream.saveBufferToTempFile);

ipcMain.handle("media:backgroundRemove", ipcMedia.backgroundRemove);

ipcMain.handle("app:getResourcesPath", ipcApp.getResourcesPath);
ipcMain.handle("app:getTempPath", ipcApp.getTempPath);
ipcMain.handle("app:getAppInfo", ipcApp.getAppInfo);
ipcMain.handle("font:getLists", fontLib.getFontList);
ipcMain.handle("font:getLocalFontLists", fontLib.getLocalFontList);

ipcMain.handle("desktopCapturer:getSources", ipcDesktopCapturer.getSources);
ipcMain.handle("overlayRecord:show", ipcOverlayRecord.show);

ipcMain.handle("extension:open:file", ipcExtension.openFile);
ipcMain.handle("extension:open:dir", ipcExtension.openDir);

ipcMain.handle("selfhosted:run", ipcSelfhosted.run);

ipcMain.handle("ai:stt", ipcAi.stt);
ipcMain.handle("ai:text", ipcAi.text);
ipcMain.handle("ai:setKey", ipcAi.setKey);
ipcMain.handle("ai:getKey", ipcAi.getKey);
ipcMain.handle("ai:runMcpServer", ipcAi.runMcpServer);

ipcMain.handle("ytdlp:downloadVideo", ipcYtdlp.downloadVideo);

ipcMain.on("render:v2:start", ipcRenderV2.start);
ipcMain.on("render:v2:sendFrame", ipcRenderV2.sendFrame);
ipcMain.on("render:v2:finishStream", ipcRenderV2.finishStream);

ipcMain.handle(
  "render:offscreen:readyToRender",
  httpFFmpegRenderV2.readyToRender,
);
ipcMain.on("render:offscreen:start", httpFFmpegRenderV2.start);
ipcMain.on("render:offscreen:sendFrame", httpFFmpegRenderV2.sendFrame);
ipcMain.on("render:offscreen:finishStream", httpFFmpegRenderV2.finishStream);

// ipcMain.on("overlayRecord:stop:res", async (evt) => {
//   mainWindow.webContents.send("overlayRecord:stop:res", "");
// });

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
    mainWindow = window.createMainWindow();
    validateFFmpeg();

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
