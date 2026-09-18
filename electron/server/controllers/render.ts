import fs from "fs";
import * as fsp from "fs/promises";
import fse from "fs-extra";
import { Router, Response, Request } from "express";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import { window } from "../../lib/window.js";
import { mainWindow } from "../../main";
import { app, ipcMain } from "electron";
import { ffmpegConfig } from "../../lib/ffmpeg";
import { sendRenderDone, sendRenderProgress } from "../sockets/conn.js";
import {
  cancelSession,
  ExportSession,
  FrameSizeError,
  startExportSession,
  writeFrame,
} from "../../render/framePipe";
import { resolveExportSettings } from "../../render/exportSettings";
import {
  dropRenderedAudio,
  prepareRenderedAudio,
  EMPTY_RENDERED_AUDIO,
} from "../../render/renderedAudio";

let session: ExportSession | null = null;
let offscreenRender;

export async function startFFmpegProcess(options, timeline) {
  // The speed ramp's audio is retimed before the spawn on this path too, or an
  // offscreen export would ship a ramped clip whose sound plays at the clip's
  // mean rate against a picture that ramps. Same helper, same refusal.
  const { sampleRate, channels } = resolveExportSettings(options);
  const rendered = await prepareRenderedAudio(
    ffmpegConfig.FFMPEG_PATH,
    timeline,
    { sampleRate, channels },
    app.getPath("temp"),
  );

  // Shares the session/backpressure machinery with the in-app export path.
  // This used to be a second bare `let ffmpegProcess` with its own copy of the
  // spawn, so the two could disagree and neither honoured `write`'s return.
  session = startExportSession(
    ffmpegConfig.FFMPEG_PATH,
    options,
    timeline,
    {
      onSuccess: (finished) => {
        if (finished === session) session = null;
        void dropRenderedAudio(finished.rendered);
        mainWindow.webContents.send("PROCESSING_FINISH", {
          destination: finished.destination,
        });
      },
      onError: (failed, detail) => {
        if (failed === session) session = null;
        void dropRenderedAudio(failed.rendered);
        console.error("[render:offscreen]", detail.message, failed.stderrTail);
        mainWindow.webContents.send("render:offscreen:error", {
          ...detail,
          stderrTail: failed.stderrTail.join("\n"),
        });
      },
      onCancelled: (cancelled) => {
        if (cancelled === session) session = null;
        void dropRenderedAudio(cancelled.rendered);
      },
    },
    rendered,
  );
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
  // Awaited, so a ramp that cannot be retimed rejects the start rather than
  // leaving the offscreen window feeding frames to a process that never spawned.
  start: async (event, options, timeline) => {
    sendRenderProgress(0);
    await startFFmpegProcess(options, timeline);
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
