import { app } from "electron";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { basename } from "path";
import { mainWindow } from "../main";
import { ffmpegConfig } from "../lib/ffmpeg";
import { RenderOptions, missingInputs } from "./ffmpegArgs";
import { resolveExportSettings } from "./exportSettings";
import {
  dropRenderedAudio,
  prepareRenderedAudio,
  EMPTY_RENDERED_AUDIO,
  type RenderedAudioSet,
} from "./renderedAudio";
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
  rendered: RenderedAudioSet = EMPTY_RENDERED_AUDIO,
): ExportSession {
  const started = startExportSession(ffmpegConfig.FFMPEG_PATH, options, timeline, {
    onSuccess: (finished) => {
      if (finished === session) session = null;
      void dropRenderedAudio(finished.rendered ?? EMPTY_RENDERED_AUDIO);
      send("PROCESSING_FINISH", { destination: finished.destination });
    },
    onError: (failed, detail) => {
      if (failed === session) session = null;
      void dropRenderedAudio(failed.rendered ?? EMPTY_RENDERED_AUDIO);
      send("render:v2:error", {
        sessionId: failed.id,
        ...detail,
        stderrTail: failed.stderrTail.join("\n"),
      });
    },
    onCancelled: (cancelled) => {
      if (cancelled === session) session = null;
      void dropRenderedAudio(cancelled.rendered ?? EMPTY_RENDERED_AUDIO);

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
  // `async` because a ramped clip's audio is retimed before the spawn. The
  // renderer already awaits this handler, so the wait reaches the user as the
  // export taking a moment to begin rather than as anything new.
  start: async (_event: unknown, options: RenderOptions, timeline: any) => {
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

    // After the missing-input refusal and before the spawn, so a ramp that
    // cannot be retimed reaches the user the same way a missing file does: as a
    // refusal to begin, with the clip named. There is deliberately no fallback
    // to a constant `atempo` at the ramp's mean rate, which would deliver a
    // file whose sound slides against its picture with nothing saying so.
    const { sampleRate, channels } = resolveExportSettings(options);
    const rendered = await prepareRenderedAudio(
      ffmpegConfig.FFMPEG_PATH,
      timeline,
      { sampleRate, channels },
      app.getPath("temp"),
    );

    let started: ExportSession;
    try {
      started = startFFmpegProcess(options, timeline, rendered);
    } catch (error) {
      await dropRenderedAudio(rendered);
      throw error;
    }
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
