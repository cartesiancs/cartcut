/**
 * One FFmpeg export process and the stdin pipe feeding it.
 *
 * Both export paths — the in-app `render:v2` and the HTTP/offscreen
 * `render:offscreen` — spawn the same command and stream frames the same way,
 * and each used to hold its own bare `let ffmpegProcess`. That module-level
 * singleton meant a second export orphaned the first (its stdin was never
 * ended, so it never exited) and could route frames into the wrong process.
 *
 * The session id here is what makes a stale message a no-op instead of a
 * cross-wire, and `writeFrame` is what stops the renderer outrunning the
 * encoder now that frames are raw rather than PNG-compressed.
 *
 * Like `ffmpegArgs.ts`, this deliberately imports nothing from `electron/lib`:
 * binary resolution pulls in `electron-is-dev`, which throws outside a real
 * Electron process and would make the whole module untestable. The caller
 * passes the path in.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import {
  buildFFmpegArgs,
  frameByteLength,
  frameFormatFor,
  RenderOptions,
} from "./ffmpegArgs";

/** How many stderr lines to keep so a failure can say what went wrong. */
const STDERR_TAIL_LINES = 64;

export type ExportSession = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  destination: string;
  /**
   * Exact bytes each frame must be, or 0 when the pipe is self-delimiting.
   *
   * `rawvideo` is an unframed fixed-stride byte stream: one short or long
   * write shears every frame after it, silently, to the end of the file. PNG
   * could absorb that locally; raw cannot.
   */
  expectedFrameBytes: number;
  framesWritten: number;
  stderrTail: string[];
  cancelled: boolean;
  finished: boolean;
  /** In-flight `drain`, shared by concurrent writers. */
  drain: Promise<void> | null;
};

let nextSessionId = 0;

export type SessionHandlers = {
  /** Exited zero and was not cancelled. */
  onSuccess: (session: ExportSession) => void;
  onError: (
    session: ExportSession,
    detail: { message: string; code?: number | null; signal?: string | null },
  ) => void;
  onCancelled?: (session: ExportSession) => void;
};

export function startExportSession(
  ffmpegPath: string,
  options: RenderOptions,
  timeline: Record<string, any>,
  handlers: SessionHandlers,
): ExportSession {
  // Argument construction lives in `ffmpegArgs.ts` so it can be unit tested;
  // this function only owns the process.
  const args = buildFFmpegArgs(options, timeline);
  const child = spawn(ffmpegPath, args);

  const session: ExportSession = {
    id: `export-${++nextSessionId}`,
    process: child,
    destination: options.videoDestination,
    expectedFrameBytes:
      frameFormatFor(options) === "rawvideo" && options.previewSize != null
        ? frameByteLength(options.previewSize.w, options.previewSize.h)
        : 0,
    framesWritten: 0,
    stderrTail: [],
    cancelled: false,
    finished: false,
    drain: null,
  };

  child.stderr.on("data", (data) => {
    const text = data.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") {
        continue;
      }
      session.stderrTail.push(line);
      if (session.stderrTail.length > STDERR_TAIL_LINES) {
        session.stderrTail.shift();
      }
    }
    console.log("[ffmpeg]", text);
  });

  // Without this an EPIPE against a dead FFmpeg is an unhandled `'error'`
  // event, which takes the whole main process down.
  child.stdin.on("error", (error) => {
    console.error("[ffmpeg] stdin", error);
  });

  child.on("error", (error) => {
    session.finished = true;
    handlers.onError(session, {
      message: `Failed to launch FFmpeg: ${error.message}`,
    });
  });

  child.on("close", (code, signal) => {
    session.finished = true;

    if (session.cancelled) {
      handlers.onCancelled?.(session);
      return;
    }

    if (code === 0) {
      handlers.onSuccess(session);
      return;
    }

    // This branch used to be missing: `close` reported success whatever the
    // exit code, so a failed encode — bad codec/container pair, disk full, a
    // torn frame stream — left the user with a truncated file and a checkmark.
    handlers.onError(session, {
      code,
      signal,
      message: `FFmpeg exited with code ${code}${signal ? ` (${signal})` : ""}`,
    });
  });

  return session;
}

/** Thrown when a frame's byte length does not match the declared stride. */
export class FrameSizeError extends Error {}

/**
 * Write one frame, resolving when it is safe to send the next.
 *
 * PNG's cost was acting as accidental flow control. Raw frames are ~30x
 * cheaper to produce, so without honouring `write`'s return value the renderer
 * outruns FFmpeg and the main process's buffer grows without limit.
 *
 * The drain promise is raced against process death: FFmpeg drains stdin for as
 * long as it is alive, so the only way `'drain'` never fires is that there is
 * nothing left to read.
 */
export function writeFrame(
  session: ExportSession,
  buffer: Buffer,
): Promise<void> {
  if (
    session.expectedFrameBytes > 0 &&
    buffer.length !== session.expectedFrameBytes
  ) {
    return Promise.reject(
      new FrameSizeError(
        `Frame ${session.framesWritten} was ${buffer.length} bytes, ` +
          `expected ${session.expectedFrameBytes}`,
      ),
    );
  }

  const stdin = session.process.stdin;
  if (session.finished || !stdin.writable) {
    return Promise.reject(new Error("FFmpeg is no longer accepting frames"));
  }

  const flushed = stdin.write(buffer);
  session.framesWritten += 1;
  if (flushed) {
    return Promise.resolve();
  }

  if (session.drain != null) {
    return session.drain;
  }

  const pending = new Promise<void>((resolve, reject) => {
    const settle = (fn: () => void) => () => {
      stdin.off("drain", onDrain);
      session.process.off("close", onClose);
      session.process.off("error", onClose);
      session.drain = null;
      fn();
    };
    const onDrain = settle(resolve);
    const onClose = settle(() =>
      reject(new Error("FFmpeg exited while a frame was in flight")),
    );

    stdin.once("drain", onDrain);
    session.process.once("close", onClose);
    session.process.once("error", onClose);
  });

  session.drain = pending;
  return pending;
}

export function cancelSession(session: ExportSession): void {
  if (session.finished) {
    return;
  }
  session.cancelled = true;
  // Marked finished synchronously, not on `close`. The exit is asynchronous,
  // and until it lands the session still looks live — which made "cancel, then
  // export again" fail with "an export is already running" for as long as the
  // kill took to be reaped. Nothing may be written to a killed process anyway.
  session.finished = true;
  // SIGKILL rather than SIGTERM: FFmpeg reads SIGTERM as "finish the file",
  // which is the opposite of what cancelling means.
  session.process.kill("SIGKILL");
}
