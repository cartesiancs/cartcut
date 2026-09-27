/**
 * The `.cartcut-input.json` beside a recording: what the mouse did during a take.
 *
 * A recording used to be one file. This is the second, and it exists so that
 * auto-zoom can be **re-run** (with a different strength, or after the planner
 * improves) rather than being a decision baked once at import and then
 * unrecoverable. Main writes it (`electron/lib/recordInputFile.ts`), the editor
 * reads it, and `electron/lib/recordInputFile.test.ts` pins the two together
 * across a boundary neither side may import across.
 *
 * **No imports at all**, for `features/project/assetPaths.ts`'s reason: this is
 * the one description of an on-disk format, it is read by an `electron/` suite
 * as well as by the app, and a dependency here would drag the renderer tree into
 * that suite.
 *
 * Rows are tuples rather than objects because a ten-minute take is 18,000 cursor
 * samples and `{"t":…,"x":…,"y":…}` would be most of the file.
 *
 * Coordinates are **capture frame pixels** and times are **media milliseconds**:
 * from the start of the recording with paused stretches removed, so they index
 * the MP4 that was written rather than the wall clock it was written over. Both
 * are `recordSession.ts`'s conventions, unchanged, because it produces them.
 */

/** The format. Bumped only for a change an older reader would misread. */
export const INPUT_LOG_VERSION = 1;

/** What the pointer did. `move` is not here: that is the cursor track. */
export type PointerKind = "down" | "up" | "drag" | "scroll";

const KINDS: readonly string[] = ["down", "up", "drag", "scroll"];

export type CursorSample = { t: number; x: number; y: number };

export type PointerMark = { t: number; x: number; y: number; kind: PointerKind };

export type InputLog = {
  capture: { width: number; height: number; fps: number };
  durationMs: number;
  cursor: CursorSample[];
  pointer: PointerMark[];
};

export const emptyInputLog: InputLog = {
  capture: { width: 0, height: 0, fps: 0 },
  durationMs: 0,
  cursor: [],
  pointer: [],
};

function finite(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/**
 * Read a log, keeping whatever is usable.
 *
 * `normalizeX` rather than `coerceX`: this runs on a file the user may have
 * edited, moved or half-written when the machine lost power, and it must never
 * throw. An unreadable row is dropped rather than defaulted: a cursor sample invented
 * at (0,0) would be a phantom dwell in the top-left corner, which is exactly the
 * mistake `sampleCursor` avoids by dropping off-screen points rather than
 * clamping them.
 *
 * A **version from the future reads as nothing**, deliberately. Guessing at a
 * format written by a newer build is how you get zooms in the wrong places with
 * no way to tell; no plan at all is an honest answer and leaves the clip plain.
 */
export function normalizeInputLog(raw: unknown): InputLog {
  if (raw == null || typeof raw !== "object") {
    return emptyInputLog;
  }

  const source = raw as Record<string, unknown>;
  const version = finite(source.version);
  if (version == null || version > INPUT_LOG_VERSION) {
    return emptyInputLog;
  }

  const capture = (source.capture ?? {}) as Record<string, unknown>;
  const width = finite(capture.width) ?? 0;
  const height = finite(capture.height) ?? 0;
  const fps = finite(capture.fps) ?? 0;

  if (width <= 0 || height <= 0) {
    // Without the frame size nothing downstream can normalise a coordinate, and
    // a plan built against a guessed frame is worse than no plan.
    return emptyInputLog;
  }

  const cursor: CursorSample[] = [];
  if (Array.isArray(source.cursor)) {
    for (const row of source.cursor) {
      if (!Array.isArray(row)) continue;
      const t = finite(row[0]);
      const x = finite(row[1]);
      const y = finite(row[2]);
      if (t == null || x == null || y == null) continue;
      cursor.push({ t, x, y });
    }
  }

  const pointer: PointerMark[] = [];
  if (Array.isArray(source.pointer)) {
    for (const row of source.pointer) {
      if (!Array.isArray(row)) continue;
      const t = finite(row[0]);
      const x = finite(row[1]);
      const y = finite(row[2]);
      const kind = row[3];
      if (t == null || x == null || y == null) continue;
      if (typeof kind !== "string" || !KINDS.includes(kind)) continue;
      pointer.push({ t, x, y, kind: kind as PointerKind });
    }
  }

  cursor.sort((a, b) => a.t - b.t);
  pointer.sort((a, b) => a.t - b.t);

  return {
    capture: { width, height, fps },
    durationMs: finite(source.durationMs) ?? 0,
    cursor,
    pointer,
  };
}

/**
 * The file's own bytes, for the one writer and for the suite that pins it.
 *
 * Exported from here rather than lived in `electron/` so there is exactly one
 * statement of the format. Main cannot import this module, so it carries its own
 * copy of the packing and `recordInputFile.test.ts` requires the two to agree.
 */
export function encodeInputLog(log: InputLog): string {
  return JSON.stringify({
    version: INPUT_LOG_VERSION,
    capture: log.capture,
    durationMs: log.durationMs,
    cursor: log.cursor.map((sample) => [
      Math.round(sample.t),
      Math.round(sample.x),
      Math.round(sample.y),
    ]),
    pointer: log.pointer.map((mark) => [
      Math.round(mark.t),
      Math.round(mark.x),
      Math.round(mark.y),
      mark.kind,
    ]),
  });
}

/** The name beside `Cartcut 2026-09-27 16.42.10.mp4`. */
export function inputLogPathFor(videoPath: string): string {
  return videoPath.replace(/\.mp4$/i, "") + ".cartcut-input.json";
}
