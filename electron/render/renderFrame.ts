import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { basename } from "path";
import { mainWindow } from "../main";
import { ffmpegConfig } from "../lib/ffmpeg";
import { RenderOptions, missingInputs } from "./ffmpegArgs";
import {
  cancelSession,
  ExportSession,
  FrameSizeError,
  startExportSession,
  writeFrame,
} from "./framePipe";

let session: ExportSession | null = null;

function send(channel: string, payload: unknown): void {
  if (mainWindow != null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** The live session, or null when `id` names one that has been superseded. */
function currentSession(id: string | undefined): ExportSession | null {
  if (session == null) {
    return null;
  }
  // A missing id keeps any un-migrated caller working.
  if (id != null && session.id !== id) {
    return null;
  }
  return session;
}

export function startFFmpegProcess(
  options: RenderOptions,
  timeline: Record<string, any>,
): ExportSession {
  const started = startExportSession(ffmpegConfig.FFMPEG_PATH, options, timeline, {
    onSuccess: (finished) => {
      if (finished === session) session = null;
      send("PROCESSING_FINISH", { destination: finished.destination });
    },
    onError: (failed, detail) => {
      if (failed === session) session = null;
      send("render:v2:error", {
        sessionId: failed.id,
        ...detail,
        stderrTail: failed.stderrTail.join("\n"),
      });
    },
    onCancelled: (cancelled) => {
      if (cancelled === session) session = null;

      // The kill is asynchronous, so by the time it is reaped the user may
      // already have started another export — and if that one writes to the
      // same path, deleting "the partial file" would delete theirs instead.
      const takenOver =
        session != null && session.destination === cancelled.destination;
      if (!takenOver) {
        void unlink(cancelled.destination).catch(() => {});
      }

      send("render:v2:cancelled", { sessionId: cancelled.id });
    },
  });

  session = started;
  return started;
}

export const ipcRenderV2 = {
  start: (_event: unknown, options: RenderOptions, timeline: any) => {
    if (session != null && !session.finished) {
      throw new Error("An export is already running");
    }

    // Before the spawn, and `start` is awaited by the renderer, so this reaches
    // the user as a refusal to begin rather than as a failure at the end.
    //
    // FFmpeg cannot open a missing input, so it exits during startup — but by
    // then the renderer has been handed a session id and draws the entire
    // timeline before anything notices. The report that eventually arrives is
    // "FFmpeg exited with code 1", one stack trace per frame still in flight,
    // and no mention of which file. See `missingInputs`.
    const missing = missingInputs(timeline, existsSync);
    if (missing.length > 0) {
      const names = missing.map((path) => basename(path)).join(", ");
      throw new Error(
        missing.length === 1
          ? `Cannot export: the source file ${names} is missing. Relink or remove that clip and try again.`
          : `Cannot export: ${missing.length} source files are missing — ${names}. Relink or remove those clips and try again.`,
      );
    }

    const started = startFFmpegProcess(options, timeline);
    return {
      sessionId: started.id,
      expectedFrameBytes: started.expectedFrameBytes,
    };
  },

  sendFrame: async (
    _event: unknown,
    arrayBuffer: ArrayBuffer,
    sessionId?: string,
  ) => {
    const target = currentSession(sessionId);
    if (target == null || target.cancelled) {
      return;
    }

    try {
      await writeFrame(target, Buffer.from(arrayBuffer));
    } catch (error) {
      // A torn frame cannot be recovered from — every later frame in a
      // rawvideo stream is offset by the same amount — so stop rather than
      // finish a silently corrupt file.
      if (error instanceof FrameSizeError) {
        cancelSession(target);
        send("render:v2:error", {
          sessionId: target.id,
          message: error.message,
        });
      }
      throw error;
    }
  },

  finishStream: (_event: unknown, sessionId?: string) => {
    const target = currentSession(sessionId);
    target?.process.stdin.end();
  },

  cancel: (_event: unknown, sessionId?: string) => {
    const target = currentSession(sessionId);
    if (target != null) {
      cancelSession(target);
    }
  },
};
