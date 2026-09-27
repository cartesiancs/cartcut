/**
 * Fitting a finished recording into the frame, and giving it its zooms.
 *
 * The one impure module in `features/record`'s auto-zoom half: it reads the project
 * frame and the bake rate from stores, reads the sidecar over IPC, and hands the
 * result to the import as a pure transform. Everything it decides is decided by
 * `recordFit`, `zoomPlan`, `zoomCamera` and `zoomKeyframes`, which take their inputs
 * as arguments and are node-testable; this is the wiring between them and the app.
 *
 * Two things it is careful about.
 *
 * **The fit happens whether or not anything zooms.** `buildVideo` gives every video
 * its native pixel size at (0,0), deliberately, and its comment says why, so a
 * 3024-wide capture would otherwise sit a quarter visible against the top left
 * corner. Auto-zoom being off is a reason to write no keyframes, never a reason to
 * leave the clip unplaced.
 *
 * **A failure anywhere leaves the recording on the timeline.** The take is what the
 * user spent their time on. Losing its zooms because a sidecar was unreadable is a
 * disappointment; losing the take would not be acceptable, so every step here
 * degrades to "the clip, fitted" rather than throwing.
 */

import { bakeRateFor } from "../animation/keyframes";
import { normalizeFps } from "../timeline/frames";
import { spanLength, spanStart } from "../timeline/geometry";
import type { TimelineDocument } from "../timeline/tracks";
import { renderOptionStore } from "../../states/renderOptionStore";
import {
  applyWrites,
  prepareWrites,
  type KeyframeWrite,
} from "../agent/commands/keyframeWrites";
import { clearTrack } from "../agent/commands/keyframeWrites";
import { normalizeInputLog, type InputLog } from "./inputLog";
import { recordFit, type Size } from "./recordFit";
import { runCamera } from "./zoomCamera";
import { planZoom } from "./zoomPlan";
import { restingBox, zoomKeyframeWrites } from "./zoomKeyframes";
import type { ZoomStrength } from "./recordSettings";

/** The project frame, which is what the recording is being fitted into. */
export function projectFrame(): Size {
  const size = renderOptionStore.getState().options?.previewSize;
  return {
    width: Number(size?.w) > 0 ? Number(size?.w) : 1920,
    height: Number(size?.h) > 0 ? Number(size?.h) : 1080,
  };
}

function projectBakeHz(): number {
  return bakeRateFor(normalizeFps(renderOptionStore.getState().options?.fps));
}

/**
 * Read the sidecar, or answer `null`.
 *
 * `null` for a missing path, a missing file, unreadable bytes and a log from a newer
 * build alike. See `inputLog.ts#normalizeInputLog` for why a version from the
 * future reads as nothing rather than as a guess.
 */
export async function readInputLog(path: string | null | undefined): Promise<InputLog | null> {
  if (path == null || path.length === 0) {
    return null;
  }

  const api = (window as any).electronAPI?.req?.filesystem;
  if (api?.readFile == null) {
    return null;
  }

  try {
    const bytes = await api.readFile(path);
    if (bytes == null) {
      return null;
    }
    const text = asText(bytes);
    if (text == null) {
      return null;
    }
    const log = normalizeInputLog(JSON.parse(text));
    return log.capture.width > 0 ? log : null;
  } catch (error) {
    console.warn("[record] could not read the input log", path, error);
    return null;
  }
}

/**
 * Whatever `filesystem:readFile` handed back, as a string.
 *
 * It reads a `Buffer` in main, and Electron's structured clone turns that into a
 * `Uint8Array` on the way across. The other shapes are cheap to accept and the
 * alternative is not an error: `new Uint8Array({type: "Buffer", data: [...]})` is
 * an empty array, so a mis-guessed shape would decode to `""`, fail to parse, and
 * report "no zooms" on a recording that had plenty.
 */
function asText(bytes: unknown): string | null {
  if (typeof bytes === "string") {
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    return new TextDecoder().decode(bytes);
  }
  if (bytes instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  const data = (bytes as { data?: unknown })?.data;
  if (Array.isArray(data)) {
    return new TextDecoder().decode(Uint8Array.from(data as number[]));
  }
  return null;
}

export type AutoZoomPlan = {
  /** The pure transform to run inside the import's own checkpoint. */
  transform: (doc: TimelineDocument, createdIds: readonly string[]) => TimelineDocument;
  /**
   * How many zoom moves it found. Zero is an ordinary outcome, not a failure.
   *
   * Filled in by `transform`, because the moves cannot be laid out until the clip
   * exists: they have to be planned against the clip's **own** span and not the
   * recording's. Read it after the import, which is the only time anything does.
   */
  moves: number;
};

/**
 * Everything that can be decided before the clip exists.
 *
 * Deliberately split this way: the planning is the slow part and it needs no
 * document, so it happens while the dialog is still showing "Planning", and the
 * transform that runs inside `withCheckpoint` is then pure arithmetic on a document
 * it is handed. A plan built from a `null` log still fits the clip.
 */
export function planAutoZoom(
  log: InputLog | null,
  strength: ZoomStrength,
  frame: Size = projectFrame(),
  bakeHz: number = projectBakeHz(),
): AutoZoomPlan {
  const capture: Size =
    log == null
      ? { width: 0, height: 0 }
      : { width: log.capture.width, height: log.capture.height };

  const plan: AutoZoomPlan = {
    moves: 0,
    transform: (doc, createdIds) => {
      const elementId = createdIds[0];
      const element = elementId == null ? null : doc.elements[elementId];
      if (element == null) {
        return doc;
      }

      // The clip's own box, not the log's: a probe and a capture request can
      // disagree, and what has to be fitted is what the decoder reports.
      const source: Size = {
        width: Number((element as any).width) || capture.width,
        height: Number((element as any).height) || capture.height,
      };
      if (source.width <= 0 || source.height <= 0) {
        return doc;
      }

      const fit = recordFit(source, frame);
      const span = spanLength(element);
      const start = spanStart(element);

      // **Planned against the clip's span, not the recording's.** Main's media
      // clock and the muxed container disagree by a few hundred milliseconds, and
      // planning against the longer of the two put the release past the end of the
      // clip, where `zoomKeyframeWrites` dropped it: measured on a real take, the
      // clip ended still fully zoomed instead of on the whole screen.
      const length = log == null ? span : Math.min(log.durationMs, span);

      const segments =
        log == null
          ? []
          : planZoom(
              { cursor: log.cursor, pointer: log.pointer },
              capture,
              strength,
              length,
            );

      plan.moves = segments.length;

      const instants =
        segments.length === 0 || log == null
          ? []
          : runCamera(segments, log.cursor, capture, fit, frame, length);

      const writes = zoomKeyframeWrites(elementId, instants, fit, frame, start, span);

      // Fitted first, and always. The static box is what a clip with no keyframes
      // draws at, and it is also the fallback the sampled track falls back to for a
      // cursor before the clip starts.
      const resting = restingBox(fit, frame);
      let next = withBox(doc, elementId, resting);

      if (writes.length === 0) {
        return next;
      }

      try {
        const prepared = prepareWrites(
          next,
          writes as unknown as KeyframeWrite[],
          (id) => {
            const found = next.elements[id];
            if (found == null) {
              throw new Error(`No clip ${id}`);
            }
            return found;
          },
          (index) => `zoom[${index}]`,
        );

        // `replace` on both tracks, so re-running auto-zoom is idempotent rather
        // than additive. `prepareWrites` validated first, so a refusal costs nothing.
        for (const write of writes) {
          next = clearTrack(next, write.elementId, write.property, bakeHz);
        }

        return applyWrites(next, prepared, bakeHz);
      } catch (error) {
        // The clip stays, fitted, with no animation. Losing the zooms is the right
        // price for keeping the take.
        console.warn("[record] could not write the zoom keyframes", error);
        plan.moves = 0;
        return next;
      }
    },
  };

  return plan;
}

/** Set the static box and location, leaving everything else alone. */
function withBox(
  doc: TimelineDocument,
  elementId: string,
  box: { width: number; height: number; x: number; y: number },
): TimelineDocument {
  const element = doc.elements[elementId];
  if (element == null) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: {
        ...element,
        width: box.width,
        height: box.height,
        location: { x: box.x, y: box.y },
      } as typeof element,
    },
  };
}
