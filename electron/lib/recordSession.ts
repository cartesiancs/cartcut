/**
 * One recording, from the first byte to the file the editor opens.
 *
 * The engine renderer owns the interesting half — the capture streams, the
 * WebCodecs encoders, the composite pass — because that is where the media APIs
 * are. This module owns the four things it cannot do from inside a renderer:
 *
 *  1. **Bytes to disk.** A 30-minute 4K take is several gigabytes; holding it
 *     in a renderer's memory the way the in-panel recorder does
 *     (`features/record/screenRecord.ts` pushes every chunk into an array and
 *     concatenates at the end) is a crash on a long recording. Chunks are
 *     appended as they arrive, and `appendChunk` resolves only once the pipe
 *     has room, which is the backpressure signal the encoder awaits — the same
 *     arrangement `render/framePipe.ts` uses for export frames.
 *  2. **The cursor track.** `screen.getCursorScreenPoint()` exists only in the
 *     main process. It needs no permission on any platform, which is what lets
 *     auto-zoom ship without the accessibility prompt a click hook would need.
 *  3. **FFmpeg.** One `-c:v copy` mux at the end. See `recordMux.ts`.
 *  4. **Delivering the result.** The finished path goes to the *editor* window,
 *     which imports it through the ordinary drop path. The editor is not
 *     otherwise involved in a recording at all.
 *
 * ## The recording clock
 *
 * Everything is timestamped in **media time**: milliseconds from the start of
 * the recording, with paused stretches removed, so the numbers index the file
 * that gets written rather than the wall clock it was written over. Main keeps
 * its own accounting here and the engine keeps an identical one from
 * `performance.now()`; they are two clocks agreeing on one origin rather than
 * one clock shared, which costs a few milliseconds of skew per pause. The zoom
 * planner works in units of hundreds of milliseconds, so that is immaterial —
 * and the alternative, an IPC round trip per cursor sample, is not.
 *
 * ## One at a time
 *
 * There is a single session, module-level. Two simultaneous recordings would
 * contend for the same hardware encoder and produce two takes that are each
 * missing frames, and the tray has no way to express which one a Stop applies
 * to.
 */

import { app, screen } from "electron";
import log from "electron-log";
import fs from "fs";
import * as fsp from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { ffmpegConfig } from "./ffmpeg.js";
import { muxRecording, type PcmInput } from "./recordMux.js";

/**
 * The files a session may write.
 *
 * A fixed map, and the renderer names a *key* rather than a path. Letting it
 * name the file would be a directory traversal straight out of a window that
 * loads remote-ish content; there is nothing to check because there is nothing
 * to pass.
 */
const FILE_NAMES = {
  /** The encoder's H.264 elementary stream. See `recordMux.ts` for why. */
  video: "video.h264",
  mic: "mic.pcm",
  system: "system.pcm",
} as const;

export type FileKey = keyof typeof FILE_NAMES;

/** 30Hz. Fine enough for dwell detection, half the cost of matching a display. */
const CURSOR_INTERVAL_MS = 33;

export type CursorSample = { t: number; x: number; y: number };

export type StartRequest = {
  /**
   * `Display.id` of the screen being captured, as a string — that is the form
   * `desktopCapturer`'s `display_id` comes in.
   */
  displayId: string;
  /** The capture's frame size, so cursor points land in frame pixels. */
  captureWidth: number;
  captureHeight: number;
};

type Session = {
  id: string;
  dir: string;
  request: StartRequest;
  streams: Map<FileKey, fs.WriteStream>;
  cursor: CursorSample[];
  strokes: unknown[];
  clicks: unknown[];
  timer: NodeJS.Timeout | null;
  startedAt: number;
  pausedTotalMs: number;
  pausedAt: number | null;
};

let session: Session | null = null;

export function currentSession(): { id: string; dir: string } | null {
  return session == null ? null : { id: session.id, dir: session.dir };
}

/** Media time now: wall clock since the start, less every paused stretch. */
function elapsedMs(active: Session): number {
  const paused =
    active.pausedAt == null ? 0 : Date.now() - active.pausedAt;
  return Date.now() - active.startedAt - active.pausedTotalMs - paused;
}

/**
 * Sample the pointer into the capture's own pixel space.
 *
 * Mapped through the display's *bounds* rather than through its scale factor:
 * bounds are in the same coordinate space `getCursorScreenPoint` answers in, so
 * `(point - origin) / size * captureSize` is exact whatever the display's
 * scaling is, and needs no separate case for a fractional Windows factor.
 *
 * A point outside the captured display is dropped rather than clamped. The
 * pointer is on another screen, and clamping would park a phantom dwell against
 * whichever edge it left by — zooming the recording onto a corner where nothing
 * is happening.
 */
function sampleCursor(active: Session): void {
  const display = screen
    .getAllDisplays()
    .find((candidate) => String(candidate.id) === active.request.displayId);

  if (display == null) {
    return;
  }

  const point = screen.getCursorScreenPoint();
  const { x, y, width, height } = display.bounds;

  if (
    width <= 0 ||
    height <= 0 ||
    point.x < x ||
    point.y < y ||
    point.x >= x + width ||
    point.y >= y + height
  ) {
    return;
  }

  active.cursor.push({
    t: elapsedMs(active),
    x: ((point.x - x) / width) * active.request.captureWidth,
    y: ((point.y - y) / height) * active.request.captureHeight,
  });
}

export async function startSession(
  request: StartRequest,
): Promise<{ id: string; dir: string }> {
  await cancelSession();

  const id = uuidv4();
  const dir = path.join(app.getPath("temp"), `cartcut-record-${id}`);
  await fsp.mkdir(dir, { recursive: true });

  const active: Session = {
    id,
    dir,
    request,
    streams: new Map(),
    cursor: [],
    strokes: [],
    clicks: [],
    timer: null,
    startedAt: Date.now(),
    pausedTotalMs: 0,
    pausedAt: null,
  };

  active.timer = setInterval(() => sampleCursor(active), CURSOR_INTERVAL_MS);
  session = active;

  return { id, dir };
}

function requireSession(sessionId: string): Session {
  if (session == null || session.id !== sessionId) {
    throw new Error("That recording is no longer running.");
  }
  return session;
}

function streamFor(active: Session, key: FileKey): fs.WriteStream {
  const existing = active.streams.get(key);
  if (existing != null) {
    return existing;
  }

  const stream = fs.createWriteStream(path.join(active.dir, FILE_NAMES[key]));
  active.streams.set(key, stream);
  return stream;
}

/**
 * Append one chunk, resolving when there is room for the next.
 *
 * The resolution *is* the backpressure. An encoder that awaited nothing would
 * outrun a slow disk and buffer the difference in the renderer's heap, which is
 * the very thing writing incrementally exists to avoid.
 */
export function appendChunk(
  sessionId: string,
  key: FileKey,
  chunk: Uint8Array,
): Promise<void> {
  const active = requireSession(sessionId);

  if (!(key in FILE_NAMES)) {
    return Promise.reject(new Error(`Unknown recording file: ${key}`));
  }

  const stream = streamFor(active, key);
  const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  return new Promise<void>((resolve, reject) => {
    const hasRoom = stream.write(buffer, (error) => {
      if (error != null) {
        reject(error);
      }
    });

    if (hasRoom) {
      resolve();
    } else {
      stream.once("drain", resolve);
    }
  });
}

/** Close one file. Resolves once the last byte is on disk, not before. */
export function finishFile(sessionId: string, key: FileKey): Promise<void> {
  const active = requireSession(sessionId);
  const stream = active.streams.get(key);

  if (stream == null) {
    return Promise.resolve();
  }

  active.streams.delete(key);

  return new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) =>
      error != null ? reject(error) : resolve(),
    );
  });
}

export function pauseSession(sessionId: string): void {
  const active = requireSession(sessionId);
  if (active.pausedAt == null) {
    active.pausedAt = Date.now();
  }
}

export function resumeSession(sessionId: string): void {
  const active = requireSession(sessionId);
  if (active.pausedAt != null) {
    active.pausedTotalMs += Date.now() - active.pausedAt;
    active.pausedAt = null;
  }
}

/** An annotation drawn on the overlay. Stored opaquely; the engine reads it. */
export function addStroke(sessionId: string, stroke: unknown): void {
  requireSession(sessionId).strokes.push(stroke);
}

export function addClick(sessionId: string, click: unknown): void {
  requireSession(sessionId).clicks.push(click);
}

export type SessionTracks = {
  cursor: CursorSample[];
  strokes: unknown[];
  clicks: unknown[];
  durationMs: number;
};

/**
 * Stop the clock and hand over everything main recorded.
 *
 * The session itself stays alive: the composite pass still has to read the temp
 * files, and `deliverSession` still has to mux them. Only the sampling stops.
 */
export function stopSession(sessionId: string): SessionTracks {
  const active = requireSession(sessionId);

  if (active.timer != null) {
    clearInterval(active.timer);
    active.timer = null;
  }

  const durationMs = elapsedMs(active);
  resumeSession(sessionId);

  return {
    cursor: active.cursor,
    strokes: active.strokes,
    clicks: active.clicks,
    durationMs,
  };
}

/**
 * Where finished recordings go.
 *
 * The user's Videos folder, not `app.getPath("temp")` — a `.ngt` that points at
 * a temp path silently empties the next time the OS sweeps it, which
 * `ipcFilesystem.ts` already documents. `getPath("videos")` is not guaranteed
 * to exist on every Linux desktop, so userData is the fallback: somewhere
 * unexpected beats nowhere.
 */
export async function recordingsDirectory(): Promise<string> {
  let root: string;

  try {
    root = app.getPath("videos");
  } catch {
    root = app.getPath("userData");
  }

  const dir = path.join(root, "Cartcut Recordings");
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** `Cartcut 2026-09-03 16.42.10.mp4` — sortable, and legal on every platform. */
function recordingFilename(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    "Cartcut ",
    when.getFullYear(),
    "-",
    pad(when.getMonth() + 1),
    "-",
    pad(when.getDate()),
    " ",
    pad(when.getHours()),
    ".",
    pad(when.getMinutes()),
    ".",
    pad(when.getSeconds()),
    ".mp4",
  ].join("");
}

export type DeliverRequest = {
  /** The rate the elementary stream was encoded at. */
  fps: number;
  audio: { key: FileKey; sampleRate: number; channels: number }[];
};

/**
 * Mux, move to the recordings folder, and clean up.
 *
 * The temp directory is removed only after the mux has succeeded. A failure
 * leaves every intermediate on disk and says where — a take that cost the user
 * ten minutes deserves better than being deleted because the last step of five
 * went wrong.
 */
export async function deliverSession(
  sessionId: string,
  request: DeliverRequest,
): Promise<string> {
  const active = requireSession(sessionId);

  for (const key of active.streams.keys()) {
    await finishFile(sessionId, key);
  }

  const outputPath = path.join(
    await recordingsDirectory(),
    recordingFilename(new Date()),
  );

  const audio: PcmInput[] = request.audio.map((input) => ({
    path: path.join(active.dir, FILE_NAMES[input.key]),
    sampleRate: input.sampleRate,
    channels: input.channels,
  }));

  await muxRecording(ffmpegConfig.FFMPEG_PATH, {
    videoPath: path.join(active.dir, FILE_NAMES.video),
    fps: request.fps,
    audio,
    outputPath,
  });

  session = null;
  await fsp.rm(active.dir, { recursive: true, force: true }).catch((error) => {
    log.warn("[record] could not clean up", active.dir, error);
  });

  return outputPath;
}

/** Throw the session away. Safe to call when there is none. */
export async function cancelSession(): Promise<void> {
  const active = session;
  if (active == null) {
    return;
  }

  session = null;

  if (active.timer != null) {
    clearInterval(active.timer);
  }

  for (const stream of active.streams.values()) {
    stream.destroy();
  }

  await fsp.rm(active.dir, { recursive: true, force: true }).catch(() => {
    // The directory may never have been created, or may already be gone.
    // Neither is worth a message during a cancel.
  });
}
