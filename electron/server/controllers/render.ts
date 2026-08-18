import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";
import { Router, Response, Request } from "express";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import { window } from "../../lib/window.js";
import { spawn } from "child_process";
import { mainWindow } from "../../main";
import { ipcMain } from "electron";
import { ffmpegConfig } from "../../lib/ffmpeg";
import { sendRenderDone, sendRenderProgress } from "../sockets/conn.js";
import { buildFFmpegArgs } from "../../render/ffmpegArgs";

let ffmpegProcess;
let offscreenRender;

export function startFFmpegProcess(options, timeline) {
  const ffmpegPath = ffmpegConfig.FFMPEG_PATH;

  // Shares the tested builder with the in-app export path; this used to be a
  // near-verbatim copy, so the two could disagree about the audio graph.
  const args = buildFFmpegArgs(options, timeline);

  ffmpegProcess = spawn(ffmpegPath, args);

  ffmpegProcess.stderr.on("data", (data) => {
    console.log("[ffmpeg]", data.toString());
  });

  ffmpegProcess.on("close", (code) => {
    mainWindow.webContents.send("PROCESSING_FINISH");
  });
}

let timeline, options;

export const httpRender = {
  start: async function (req: Request, res: Response) {
    timeline = req.body.timeline;
    options = req.body.options;

    if (offscreenRender) {
      offscreenRender.webContents.send("render:offscreen:start", {
        timeline: timeline,
        options: options,
      });
    } else {
      offscreenRender = window.createOffscreenRenderWindow();
    }

    res.status(200).send({
      status: true,
    });
  },
};

export const httpFFmpegRenderV2 = {
  start: (event, options, timeline) => {
    sendRenderProgress(0);
    startFFmpegProcess(options, timeline);
  },

  readyToRender: (event) => {
    console.log("== READT TO RENDER");

    return { status: true, timeline: timeline, options: options };

    //startFFmpegProcess(options, timeline);
  },

  sendFrame: (event, arrayBuffer, per) => {
    const buffer = Buffer.from(arrayBuffer);
    sendRenderProgress(per);
    if (ffmpegProcess && ffmpegProcess.stdin.writable) {
      ffmpegProcess.stdin.write(buffer);
    }
  },
  finishStream: () => {
    if (ffmpegProcess) {
      ffmpegProcess.stdin.end();
      sendRenderDone(options.videoDestination);
    }
  },
};
