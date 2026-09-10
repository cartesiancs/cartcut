/**
 * One drag of a numeric field, with the pointer nailed in place.
 *
 * The arithmetic is `numberScrub.ts`; this is the half that owns the listeners
 * and the pointer lock. It takes its `ScrubHost` as an argument so the whole
 * state machine — engagement, cancellation, teardown — is exercised under
 * `environment: "node"` against a fake, the way `gestureCommit.test.ts` already
 * stands in for `window`.
 *
 * Five things here are load-bearing and none of them is obvious:
 *
 * - **`movementX` is accumulated whether or not the lock was granted.** It is
 *   reported for an ordinary mousemove too, so the pointer lock is purely the
 *   affordance — the cursor stays put and can never run off the screen — and a
 *   refusal degrades to the drag this app had before, with the same numbers.
 *   Nothing is logged when it is refused: Chromium declines to re-lock for about
 *   a second after the *user* exits with Escape, so the drag straight after a
 *   cancel legitimately runs unlocked.
 *
 * - **The lock is asked for on the press, not when the drag is recognised.**
 *   That costs a cursor blink on a plain click, and it is not a preference.
 *   Measured in this app: a request issued from a `mousemove` handler, as the
 *   first request of the process's life, is refused — and the refusal is
 *   *sticky*. Every later request is then refused too, from a `mousedown` and
 *   across a page reload, until the app restarts. Asking on `mousedown`
 *   succeeds, and once one lock has been granted a `mousemove` request works
 *   for the rest of the session. Waiting for the threshold therefore does not
 *   mean "locked a moment later", it means "never locked again".
 *
 * - **Cancelling needs two channels.** Under the lock Chromium swallows Escape
 *   to release the lock and the page never sees the keydown, so cancellation
 *   arrives as `pointerlockchange`. With no lock there is no `pointerlockchange`
 *   and it arrives as the keydown. Neither covers the other.
 *
 * - **Cancelling emits no value.** `withCheckpoint` cannot decline a document it
 *   did not build, so re-emitting the start value would record a real undo step
 *   — and leave behind the keyframe the scrub's first move created. The consumer
 *   is told to cancel and does the reverting; see `GestureCommit.cancel`.
 *
 * - **`mouseup` is neither cancelled nor stopped.** `GestureCommit` listens for
 *   that same event on `window` to fold the drag into one undo step.
 */

import {
  beginScrub,
  modifiersOf,
  scrubMove,
  scrubValueOf,
  type ScrubOptions,
  type ScrubState,
} from "./numberScrub";

export type ScrubHost = {
  addListener(type: string, fn: (event: any) => void, capture?: boolean): void;
  removeListener(type: string, fn: (event: any) => void, capture?: boolean): void;
  /** Best-effort. A refusal is not an error anything can act on. */
  requestLock(): void;
  exitLock(): void;
  isLocked(): boolean;
  /** Marks the document so the fallback cursor and the selection guard apply. */
  setScrubbing(on: boolean): void;
};

export type ScrubEnd = {
  /** Whether the press ever became a drag, so a caller can treat it as a click. */
  dragged: boolean;
  cancelled: boolean;
};

export type ScrubCallbacks = {
  onDragStart?(): void;
  onValue(value: number): void;
  /** Carries no value on a cancel: reverting is the consumer's job. */
  onEnd?(info: ScrubEnd): void;
};

export type ScrubSession = {
  /** End the drag as a cancel. Safe to call after it has already ended. */
  cancel(): void;
};

/**
 * Does this press begin a scrub?
 *
 * Only the left button. Today a right-click starts a drag and the context menu
 * then eats the mouseup, leaving the field following the pointer with no button
 * held.
 */
export function isScrubStart(event: { button?: number }): boolean {
  return (event.button ?? 0) === 0;
}

export function startScrub(
  startValue: number,
  options: ScrubOptions,
  callbacks: ScrubCallbacks,
  host: ScrubHost,
): ScrubSession {
  let state: ScrubState = beginScrub(startValue);
  let shown = scrubValueOf(state, options);
  /** Our own `exitLock`, so releasing the lock does not read as the user's Escape. */
  let exitingSelf = false;
  let done = false;

  const onMouseMove = (event: any) => {
    // A button released outside the window delivers no mouseup to the renderer,
    // so without this the drag never ends and the next stray move resumes it.
    if (event.buttons === 0) {
      finish(false);
      return;
    }

    const next = scrubMove(state, event.movementX ?? 0, modifiersOf(event), options);
    if (next === state) {
      return;
    }
    const engaged = !state.dragging && next.dragging;
    state = next;

    if (engaged) {
      callbacks.onDragStart?.();
    }
    if (!state.dragging) {
      return;
    }

    const value = scrubValueOf(state, options);
    // A write that changes nothing still wakes every store subscriber.
    if (value === shown) {
      return;
    }
    shown = value;
    callbacks.onValue(value);
  };

  const onMouseUp = () => finish(false);

  const onKeyDown = (event: any) => {
    if (event.key !== "Escape") {
      return;
    }
    // Capture phase and stopped here: `elementTimelineCanvas` binds Escape on
    // `window` as well, and for an event dispatched at `window` both listeners
    // fire in registration order — the timeline mounts first and would cancel
    // its own gesture instead of this one.
    event.stopPropagation?.();
    event.preventDefault?.();
    finish(true);
  };

  const onPointerLockChange = () => {
    // Losing a lock we did not release is the user pressing Escape: under the
    // lock Chromium consumes that key itself and the page never sees it.
    // Gaining one is the grant arriving, which is not news.
    if (exitingSelf || host.isLocked()) {
      return;
    }
    finish(true);
  };

  const onBlur = () => finish(false);

  function finish(cancelled: boolean) {
    if (done) {
      return;
    }
    done = true;
    host.removeListener("mousemove", onMouseMove);
    host.removeListener("mouseup", onMouseUp);
    host.removeListener("keydown", onKeyDown, true);
    host.removeListener("pointerlockchange", onPointerLockChange);
    host.removeListener("blur", onBlur);

    exitingSelf = true;
    host.exitLock();
    host.setScrubbing(false);
    callbacks.onEnd?.({ dragged: state.dragging, cancelled });
  }

  host.addListener("mousemove", onMouseMove);
  host.addListener("mouseup", onMouseUp);
  host.addListener("keydown", onKeyDown, true);
  host.addListener("pointerlockchange", onPointerLockChange);
  host.addListener("blur", onBlur);

  // On the press, for the reason in the header. `setScrubbing` goes with it so
  // the watchdog can tell a lock this session owns from an orphan.
  host.setScrubbing(true);
  host.requestLock();

  return { cancel: () => finish(true) };
}

/**
 * `document.body` is the lock target, deliberately.
 *
 * `document.pointerLockElement` is retargeted across a shadow boundary, so
 * locking the span inside `<number-input>` would report the *host* back and
 * every `isLocked` comparison against the span would be false forever. Locking
 * the body sidesteps that, and survives the dragged element being re-rendered
 * out from under the gesture.
 */
export function windowScrubHost(): ScrubHost {
  installPointerLockWatchdog();

  const targetFor = (type: string): any =>
    type === "pointerlockchange" || type === "pointerlockerror"
      ? document
      : window;

  return {
    addListener: (type, fn, capture) =>
      targetFor(type).addEventListener(type, fn, capture === true),
    removeListener: (type, fn, capture) =>
      targetFor(type).removeEventListener(type, fn, capture === true),
    requestLock: () => {
      try {
        const pending: any = document.body.requestPointerLock?.();
        // Chromium 113+ answers with a promise; a refusal is expected and there
        // is nothing useful to say about it.
        pending?.catch?.(() => {});
      } catch {
        // Degrade to an unlocked drag.
      }
    },
    exitLock: () => {
      if (document.pointerLockElement != null) {
        document.exitPointerLock();
      }
    },
    isLocked: () => document.pointerLockElement != null,
    setScrubbing: (on) => document.body.classList.toggle("is-scrubbing", on),
  };
}

let watchdogInstalled = false;

/**
 * Last resort against a lock nobody released.
 *
 * Missing one `exitLock` hides the cursor across the whole app, and nothing on
 * screen tells the user that Escape is the way out.
 *
 * The reachable way to get one is a drag shorter than the lock takes to be
 * granted. `requestPointerLock` is asynchronous, so a press that engages and
 * releases inside that window leaves `exitLock` with nothing to release — and
 * the lock then arrives for a session that has already ended. `pointerlockchange`
 * is what catches that: a lock that engages while nothing is scrubbing is a lock
 * nobody is going to release.
 *
 * `exitPointerLock` is deliberately never called against a *pending* request.
 * Doing so puts Chromium's controller into a state where every later request is
 * rejected with `WrongDocumentError` until the page is reloaded — which is why
 * every path here tests `pointerLockElement` first rather than releasing
 * blindly.
 */
function installPointerLockWatchdog(): void {
  if (watchdogInstalled || typeof window === "undefined") {
    return;
  }
  watchdogInstalled = true;

  const release = () => {
    if (
      document.pointerLockElement != null &&
      document.body.classList.contains("is-scrubbing") === false
    ) {
      document.exitPointerLock();
    }
  };
  window.addEventListener("blur", release);
  window.addEventListener("mouseup", release);
  document.addEventListener("pointerlockchange", release);
}
