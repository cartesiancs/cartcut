/**
 * What every media element should be doing right now.
 *
 * This is the layer that was missing. Playback decisions used to be scattered
 * across three places that each knew only part of the picture:
 *
 *   - `loadedAssetStore` seeded every `<video>` once at play time from a
 *     **snapshot** of the clip taken when the file loaded, so moving a clip
 *     shifted its playback position by exactly the drag distance;
 *   - `renderer/video.ts` decided audibility, but the compositor skips clips
 *     outside their window, so its "mute me" branch never actually ran and a
 *     clip that left the playhead kept sounding over whatever came next;
 *   - `elementControl.showAudio` did its own arithmetic that ignored `trim`
 *     and `speed` entirely, so a split audio clip replayed the deleted part.
 *
 * All three are the same question — *given the live clip and the playhead,
 * where should this handle be, and should it be heard?* — so it is answered
 * once, here, from the live element only. There is nowhere to put a snapshot.
 *
 * Pure and DOM-free: the only thing it knows about a media element is
 * `MediaHandle`, which a plain object satisfies. That is what finally makes
 * this layer testable under `environment: "node"`.
 */

import type { TimelineElement } from "../../@types/timeline";
import { isTimeInRange } from "../../utils/time";
import { isDynamicElement, sourceTimeAt, spanOf, speedOf } from "./geometry";
import type { TimelineDocument } from "./tracks";

/** Everything this layer touches on a `<video>` or `<audio>`. */
export interface MediaHandle {
  currentTime: number;
  muted: boolean;
  playbackRate: number;
  readonly paused: boolean;
  play(): void;
  pause(): void;
}

/**
 * A handle that can say when a seek has finished.
 *
 * Assigning `currentTime` only *requests* a frame; the decoded picture arrives
 * later, on `seeked`. Anything that paints straight after a seek paints the
 * previous frame, so the painter needs this to come back for the real one.
 */
export interface SeekableHandle extends MediaHandle {
  addEventListener(
    type: "seeked",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
}

function isSeekable(handle: MediaHandle): handle is SeekableHandle {
  return typeof (handle as SeekableHandle).addEventListener == "function";
}

/** A seek that was issued and whose frame has not arrived yet. */
export type SeekRequest = {
  elementId: string;
  /** Where the handle was asked to go, in seconds into the source. */
  sourceTimeSec: number;
};

/**
 * Call `onLanded` once, after the handles just seeked have produced their
 * frames.
 *
 * `alreadyAwaited` is the caller's memory of the target it last waited on per
 * element, and it is what keeps this from spinning. A browser may land a seek a
 * little off the requested time — `currentTime` is only guaranteed to be near a
 * keyframe — and the paused tolerance is exactly zero, so the next reconcile
 * re-issues the *same* seek. Repainting on each of those landings would loop at
 * frame rate forever. Waiting only when the target has actually moved makes
 * that unrepresentable.
 *
 * Handles that cannot report (no `addEventListener`, e.g. a plain test double)
 * are not waited on: `onLanded` never fires for them, rather than firing early
 * on a frame that is not there yet.
 */
export function whenSeeksLand(
  handles: Record<string, MediaHandle>,
  seeks: readonly SeekRequest[],
  onLanded: () => void,
  alreadyAwaited?: Map<string, number>,
): void {
  for (const seek of seeks) {
    if (alreadyAwaited?.get(seek.elementId) === seek.sourceTimeSec) {
      continue;
    }

    const handle = handles[seek.elementId];
    if (handle == null || !isSeekable(handle)) {
      continue;
    }

    alreadyAwaited?.set(seek.elementId, seek.sourceTimeSec);
    handle.addEventListener("seeked", onLanded, { once: true });
  }
}

export type PlaybackIntent = {
  /** Where the handle should be, in seconds into the source file. */
  sourceTimeSec: number;
  muted: boolean;
  playing: boolean;
  rate: number;
  /** Whether the playhead is inside this clip's window. */
  inWindow: boolean;
};

/**
 * How far a handle that is *already rolling* may sit from the playhead.
 *
 * Deliberately generous, and the reason matters. The timeline cursor runs on
 * the wall clock while the media element runs on its own decode clock, and
 * starting playback costs a few frames — so a healthy, perfectly smooth video
 * settles a constant ~40ms behind. That is an offset, not drift: both clocks
 * advance at the same rate, so it never grows.
 *
 * Treating it as drift is a trap. A one-frame tolerance made us seek roughly
 * 23 times a second: each correction starved the decoder, which put the video
 * further behind, which triggered another correction. The picture juddered
 * precisely because we kept trying to fix it. What actually needs correcting
 * is a real desync — a stall, a dropped chunk — and those are far bigger than
 * a quarter second.
 */
export const PLAYING_DRIFT_TOLERANCE_SEC = 0.25;

/**
 * How exactly a handle is positioned when it is *not* already rolling.
 *
 * Scrubbing must move the frame immediately, and a clip being entered has to
 * start on its first frame rather than wherever it was parked, so both are
 * placed exactly.
 */
export const DRIFT_TOLERANCE_SEC = 0;

/** Source window of a clip in seconds, for parking an out-of-window handle. */
function sourceBoundsSec(element: TimelineElement): [number, number] {
  if (!isDynamicElement(element)) {
    return [0, element.duration / 1000];
  }
  return [element.trim.startTime / 1000, element.trim.endTime / 1000];
}

/**
 * What this clip's handle should be doing at `cursorMs`.
 *
 * Takes the **live** element — never a cached copy — which is the structural
 * fix for the drift bug rather than a patch over it.
 */
export function intentFor(
  element: TimelineElement,
  cursorMs: number,
  isPlaying: boolean,
): PlaybackIntent {
  const { start, end } = spanOf(element);
  const inWindow = isTimeInRange(cursorMs, start, end);
  const [low, high] = sourceBoundsSec(element);

  const exact = isDynamicElement(element)
    ? sourceTimeAt(element, cursorMs) / 1000
    : low;

  // Outside its window a clip parks at whichever edge it is nearest: before it
  // that is the trim-in point, so entering plays the right frame immediately
  // instead of whatever the file happened to run on to. Clamping also removes
  // the negative seek that browsers silently pinned to 0 — which left a clip
  // wrong for the rest of the session.
  const sourceTimeSec = Math.min(Math.max(exact, low), high);

  return {
    sourceTimeSec,
    muted: !inWindow,
    playing: isPlaying && inWindow,
    rate: speedOf(element),
    inWindow,
  };
}

/**
 * Bring one handle in line with an intent.
 *
 * Seeks are conditional: while playing, only when drift exceeds the tolerance,
 * so normal playback is left alone; while paused, always, so scrubbing moves
 * the frame immediately.
 *
 * Returns whether a seek was issued, so the caller can wait for the frame
 * instead of painting the stale one that is still on the handle.
 */
export function applyIntent(
  handle: MediaHandle,
  intent: PlaybackIntent,
  playingToleranceSec: number = PLAYING_DRIFT_TOLERANCE_SEC,
): boolean {
  // Only write when the value actually changes. This runs on every animation
  // frame for every loaded clip, and a media element treats each assignment as
  // a real state change however redundant it is.
  if (handle.playbackRate !== intent.rate) {
    handle.playbackRate = intent.rate;
  }
  if (handle.muted !== intent.muted) {
    handle.muted = intent.muted;
  }

  // A handle already rolling gets the generous window; one that is parked,
  // scrubbing, or about to enter its clip is placed exactly.
  const rolling = intent.playing && !handle.paused;
  const tolerance = rolling ? playingToleranceSec : DRIFT_TOLERANCE_SEC;

  let seeked = false;
  if (Math.abs(handle.currentTime - intent.sourceTimeSec) > tolerance) {
    // Seek before starting playback, so a handle entering its window cannot
    // emit a burst of audio from wherever it had run on to.
    handle.currentTime = intent.sourceTimeSec;
    seeked = true;
  }

  if (intent.playing) {
    if (handle.paused) {
      handle.play();
    }
  } else if (!handle.paused) {
    handle.pause();
  }

  return seeked;
}

/**
 * Bring every handle in line with the document.
 *
 * A handle whose element has gone — deleted, undone, project switched — is
 * silenced rather than left running, since nothing else will ever visit it.
 *
 * Returns the seeks it issued. Those frames are not on the handles yet, so a
 * caller that paints needs to come back once they land — see `whenSeeksLand`.
 */
export function syncPlayback(
  doc: TimelineDocument,
  cursorMs: number,
  isPlaying: boolean,
  handles: Record<string, MediaHandle>,
  playingToleranceSec: number = PLAYING_DRIFT_TOLERANCE_SEC,
): SeekRequest[] {
  const seeks: SeekRequest[] = [];

  for (const [elementId, handle] of Object.entries(handles)) {
    const element = doc.elements[elementId];

    if (element == null) {
      handle.muted = true;
      if (!handle.paused) {
        handle.pause();
      }
      continue;
    }

    const intent = intentFor(element, cursorMs, isPlaying);
    if (applyIntent(handle, intent, playingToleranceSec)) {
      seeks.push({ elementId, sourceTimeSec: intent.sourceTimeSec });
    }
  }

  return seeks;
}
