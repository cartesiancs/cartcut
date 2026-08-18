import { spawn } from "child_process";
import { mainWindow } from "../main";
import { ipcMain } from "electron";
import { ffmpegConfig } from "../lib/ffmpeg";
import { buildFFmpegArgs } from "./ffmpegArgs";

let ffmpegProcess;

export function startFFmpegProcess(options, timeline) {
  const ffmpegPath = ffmpegConfig.FFMPEG_PATH;

  // Argument construction lives in `ffmpegArgs.ts` so it can be unit tested;
  // this function only owns the process.
  const args = buildFFmpegArgs(options, timeline);

  ffmpegProcess = spawn(ffmpegPath, args);

  ffmpegProcess.stderr.on("data", (data) => {
    console.log("[ffmpeg]", data.toString());
  });

  ffmpegProcess.on("close", (code) => {
    mainWindow.webContents.send("PROCESSING_FINISH");
  });
}

export const ipcRenderV2 = {
  start: (event, options, timeline) => {
    startFFmpegProcess(options, timeline);
  },
  sendFrame: (event, arrayBuffer) => {
    const buffer = Buffer.from(arrayBuffer);
    if (ffmpegProcess && ffmpegProcess.stdin.writable) {
      ffmpegProcess.stdin.write(buffer);
    }
  },
  finishStream: () => {
    if (ffmpegProcess) {
      ffmpegProcess.stdin.end();
    }
  },
};
