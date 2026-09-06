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

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { isTimeInRange } from "../../utils/time";
import { gainOf, isAudibleElement } from "./audio";
import {
  isDynamicElement,
  sourceDurationOf,
  sourceTimeAt,
  spanOf,
  speedOf,
} from "./geometry";
import { isVisibleThroughTransition } from "./transitionWindow";
import type { TimelineDocument } from "./tracks";

/** Everything this layer touches on a `<video>` or `<audio>`. */
export interface MediaHandle {
  currentTime: number;
  /**
   * Whether a seek is still in flight.
   *
   * Optional because a plain object satisfies this interface in the suites, and
   * absent reads as "not seeking" — which is what a test double that never
   * seeks asynchronously actually is.
   */
  readonly seeking?: boolean;
  muted: boolean;
  /**
   * Linear gain, 0..1 — the unit the DOM uses, **not** the element's
   * `volumeDb`. Convert with `audio.ts#gainOf`.
   */
  volume: number;
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
  /** Linear gain for the handle, 0..1 — not the element's `volumeDb`. */
  volume: number;
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
 *
 * This stays **zero**, and the redundant-seek problem it used to cause is
 * solved by remembering the request instead of by widening the window — see
 * `applyIntent`'s `lastRequestedSec`. Widening it would have been the obvious
 * fix and is the wrong one: the residual is up to one *source* frame, which is
 * 8ms in a 120fps screen recording and 42ms in 24fps footage, so any constant
 * big enough to work on the second is big enough to show the wrong frame on the
 * first. This layer has no way to learn a source's frame rate.
 */
export const DRIFT_TOLERANCE_SEC = 0;

/**
 * Source window of a clip in seconds, for parking an out-of-window handle.
 *
 * `extended` widens it to the whole source file, and is set only while a
 * transition is holding this clip on screen. Without that the clamp would
 * defeat the entire feature: a cross-dissolve asks the outgoing clip for frames
 * *past* `trim.endTime`, and pinning the seek back to the trim boundary would
 * show a frozen out-point for the length of the transition — the exact failure
 * the handle arithmetic exists to avoid.
 *
 * The full source is still a real bound. `maxTransitionMs` never grants a
 * window that runs off the end of the file, so in a well-formed document this
 * clamp does not bite; it is here because a document also arrives from `.ngt`
 * and from IPC, where the media may since have been replaced by a shorter file.
 */
function sourceBoundsSec(
  element: TimelineElement,
  extended: boolean,
): [number, number] {
  if (!isDynamicElement(element)) {
    return [0, element.duration / 1000];
  }
  if (extended) {
    return [0, sourceDurationOf(element) / 1000];
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
  /**
   * The document, so a clip held on screen by a transition keeps rolling.
   *
   * Optional because every existing caller and every existing test passes
   * three arguments, and a document with no transitions in it answers the same
   * either way. `syncPlayback` always supplies it.
   */
  elements?: Timeline,
): PlaybackIntent {
  const { start, end } = spanOf(element);
  const ownWindow = isTimeInRange(cursorMs, start, end);
  // Inside a transition the outgoing clip plays past its out-point and the
  // incoming clip before its in-point. Both handles have to be rolling and
  // positioned, or the blend mixes a frame that was never seeked.
  const throughTransition =
    !ownWindow &&
    elements != null &&
    isVisibleThroughTransition(cursorMs, elements, element);
  const inWindow = ownWindow || throughTransition;

  const [low, high] = sourceBoundsSec(element, throughTransition);

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
    // Two ways to be silent, and they are not the same thing. Outside its
    // window a clip is merely not being heard yet; a video whose audio has
    // been detached must stay silent *inside* its window too, or the preview
    // plays it twice — once from this handle and once from the audio clip that
    // now owns the sound.
    //
    // `playing` deliberately does not follow. A silenced `<video>` still has
    // to roll, because the picture comes off the same handle: muting it and
    // pausing it would freeze the frame the moment its audio was detached.
    muted: !inWindow || !isAudibleElement(element),
    // Deliberately independent of `inWindow`, and orthogonal to `muted`.
    // `muted` is positional — am I being heard yet — and flips as the playhead
    // moves; the level is document state and changes only when the user edits
    // it. Keeping them apart means crossing a clip boundary writes no volume
    // at all, and it is why mute is not implemented as `volume = 0`: there
    // would be nowhere to keep the level the user actually chose.
    volume: gainOf(element),
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
  /**
   * The source time this handle was last *asked* for, if the caller remembers.
   *
   * Not the same as `handle.currentTime`, and the difference is the whole point.
   * A seek lands on a frame boundary, so a handle asked for 18.933s reports
   * back the timestamp of the frame containing it — 18.925s in a 120fps source.
   * Comparing the two then finds a residual of one source frame, forever, and
   * with a tolerance of zero that re-issues the identical seek on every single
   * repaint. Measured on a real project: twelve video clips, ten of them parked
   * off the playhead, sixty repaints a second — some six hundred redundant
   * seeks per second, each one flushing a decoder that then had to decode
   * forward from a keyframe up to eight seconds back.
   *
   * Comparing the *request* instead is exact and needs no knowledge of the
   * source's frame rate. Only consulted for a handle that is paused, since a
   * rolling one moves on its own and the generous tolerance governs it.
   */
  lastRequestedSec?: number,
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
  // `gainOf` is deterministic and pre-rounded, so at steady state this compares
  // two identical doubles and never fires — which is the point of rounding it.
  if (handle.volume !== intent.volume) {
    handle.volume = intent.volume;
  }

  // A handle already rolling gets the generous window; one that is parked,
  // scrubbing, or about to enter its clip is placed exactly.
  // "Rolling" is about what this handle has been *asked* to do, not about
  // whether it has managed it yet.
  //
  // It used to be `intent.playing && !handle.paused`, which reads correctly and
  // behaves badly on footage the decoder cannot keep up with. Such a handle
  // stays `paused` — `play()` on a starved element does not take — so it took
  // the exact branch forever, and its target moves with the cursor, so it was
  // re-placed as fast as seeks could land. All of its decode budget went on
  // seeking and none on playing, which is self-sustaining: the picture it was
  // being asked for kept moving away from the one it was decoding.
  //
  // `lastRequestedSec != null` is the record that this handle has been placed
  // at least once since it was loaded, and placement while parked leaves it at
  // the clip's trim-in point — which is exactly where entering the clip should
  // start. So one exact placement, then leave it alone and let the generous
  // tolerance govern, which is ffplay's rule too: do not correct small drift,
  // because the correction costs more than the drift.
  const placed = lastRequestedSec != null;
  const rolling = intent.playing && (!handle.paused || placed);
  const tolerance = rolling ? playingToleranceSec : DRIFT_TOLERANCE_SEC;

  // A paused handle cannot have moved since we placed it, so asking again for
  // the position we already asked for can only cost a decoder flush. The moment
  // the target actually changes — a scrub, or the playhead entering the clip —
  // this is false and the exact placement above applies as it always did.
  const alreadyThere =
    handle.paused &&
    lastRequestedSec != null &&
    lastRequestedSec === intent.sourceTimeSec;

  // **Never interrupt a seek that has not landed.**
  //
  // This is the case `alreadyThere` cannot cover, and on heavy footage it was
  // the worse of the two. A clip the playhead has just entered is `playing` in
  // intent but still `paused` in fact, so it takes the exact tolerance — and
  // its target moves with the cursor, so it is a *different* exact target on
  // every repaint. Each one flushed the decoder that was still working on the
  // last, which is a live feedback loop: the handle can never buffer, so it
  // never un-pauses, so it never stops being seeked. Measured on 3600x2338
  // 120fps footage, two handles sat at `readyState 1` — metadata and no frames
  // — issuing sixty seeks a second each, indefinitely.
  //
  // `seeking` is the same fact `whenSeeksLand` waits for, read directly, and it
  // needs no threshold to be tuned. A handle that genuinely cannot keep up
  // simply stays here rather than being asked again.
  const seekInFlight = handle.seeking === true;

  let seeked = false;
  if (
    !alreadyThere &&
    !seekInFlight &&
    Math.abs(handle.currentTime - intent.sourceTimeSec) > tolerance
  ) {
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
  /**
   * The caller's memory of the last seek asked of each handle.
   *
   * Optional so every existing caller and test compiles unchanged; the preview
   * supplies one, and without it the behaviour is exactly what it was. Written
   * here rather than by the caller so the record cannot drift from the seeks
   * actually issued.
   */
  lastRequests?: Map<string, number>,
): SeekRequest[] {
  const seeks: SeekRequest[] = [];

  for (const [elementId, handle] of Object.entries(handles)) {
    const element = doc.elements[elementId];

    if (element == null) {
      lastRequests?.delete(elementId);
      // Volume is deliberately left alone. Muted and paused is already
      // completely silent, and this branch has no change guard — it writes
      // every frame — so a volume assignment here would cost one pointless
      // write per frame per orphan, forever. The level lives in the document
      // anyway, so an undo that brings the element back re-derives it.
      handle.muted = true;
      if (!handle.paused) {
        handle.pause();
      }
      continue;
    }

    const intent = intentFor(element, cursorMs, isPlaying, doc.elements);
    if (
      applyIntent(
        handle,
        intent,
        playingToleranceSec,
        lastRequests?.get(elementId),
      )
    ) {
      lastRequests?.set(elementId, intent.sourceTimeSec);
      seeks.push({ elementId, sourceTimeSec: intent.sourceTimeSec });
    }
  }

  return seeks;
}
