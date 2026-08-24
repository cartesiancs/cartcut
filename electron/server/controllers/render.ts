import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";
import { Router, Response, Request } from "express";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import { window } from "../../lib/window.js";
import { mainWindow } from "../../main";
import { ipcMain } from "electron";
import { ffmpegConfig } from "../../lib/ffmpeg";
import { sendRenderDone, sendRenderProgress } from "../sockets/conn.js";
import {
  cancelSession,
  ExportSession,
  FrameSizeError,
  startExportSession,
  writeFrame,
} from "../../render/framePipe";

let session: ExportSession | null = null;
let offscreenRender;

export function startFFmpegProcess(options, timeline) {
  // Shares the session/backpressure machinery with the in-app export path.
  // This used to be a second bare `let ffmpegProcess` with its own copy of the
  // spawn, so the two could disagree and neither honoured `write`'s return.
  session = startExportSession(ffmpegConfig.FFMPEG_PATH, options, timeline, {
    onSuccess: (finished) => {
      if (finished === session) session = null;
      mainWindow.webContents.send("PROCESSING_FINISH", {
        destination: finished.destination,
      });
    },
    onError: (failed, detail) => {
      if (failed === session) session = null;
      console.error("[render:offscreen]", detail.message, failed.stderrTail);
      mainWindow.webContents.send("render:offscreen:error", {
        ...detail,
        stderrTail: failed.stderrTail.join("\n"),
      });
    },
    onCancelled: (cancelled) => {
      if (cancelled === session) session = null;
    },
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

  sendFrame: async (event, arrayBuffer, per) => {
    if (session == null || session.cancelled) {
      return;
    }
    sendRenderProgress(per);

    try {
      // Awaited: resolves when the pipe has room, which is the backpressure
      // signal the offscreen window's frame loop waits on.
      await writeFrame(session, Buffer.from(arrayBuffer));
    } catch (error) {
      // A torn frame cannot be recovered from — every later frame in a
      // rawvideo stream carries the same offset — so stop rather than finish a
      // silently corrupt file.
      if (error instanceof FrameSizeError) {
        console.error("[render:offscreen]", error.message);
        cancelSession(session);
      }
      throw error;
    }
  },
  finishStream: () => {
    if (session != null) {
      session.process.stdin.end();
      sendRenderDone(options.videoDestination);
    }
  },
};
