/**
 * Putting an `<audio>`/`<video>` element on a time and knowing when it got there.
 *
 * Assigning `currentTime` only **requests** a frame; the decoded picture arrives
 * later, on `seeked`. Anything that paints straight after a seek paints the
 * previous frame — which is what the auto-caption panel did on every reset and
 * every click on a word, so the canvas showed the frame before the one the
 * caption belonged to.
 *
 * `features/track/frameSource.ts` learned all of this first and documents the
 * two ways of writing it that **hang**. Both are restated below, because they
 * are the reason this is twenty lines rather than two. That module's copies are
 * private to it and it has no suite of its own; rather than move code out of the
 * tracking stack for a caption fix, this is the shared, tested version and the
 * two should converge when something else needs to touch `frameSource.ts`.
 */

/** Anything with a decoder behind it. `<audio>` and `<video>` both qualify. */
export type SeekableMedia = Pick<
  HTMLMediaElement,
  "readyState" | "currentTime" | "addEventListener" | "removeEventListener"
>;

/** Close enough that no seek is worth performing, in seconds. */
const ALREADY_THERE_SEC = 1e-4;

/** How often to re-check `readyState`, in ms. */
const READY_POLL_MS = 50;

/**
 * Resolve once there is a decoded frame to read.
 *
 * `HAVE_CURRENT_DATA` (2) is the first `readyState` at which `drawImage` paints
 * anything; `loadedmetadata` only says the container was parsed. The poll
 * alongside the listener is a backstop rather than belt-and-braces:
 * `loadeddata` may fire between the `readyState` check and the listener being
 * attached, and it does not fire twice.
 */
export function whenReady(media: SeekableMedia): Promise<void> {
  if (media.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearInterval(timer);
      media.removeEventListener("loadeddata", onReady);
      media.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The media could not be read (error)."));
    };
    const timer = setInterval(() => {
      if (media.readyState >= 2) {
        onReady();
      }
    }, READY_POLL_MS);
    media.addEventListener("loadeddata", onReady);
    media.addEventListener("error", onError);
  });
}

/** Resolve on the next `event`, reject on `errorEvent`. Neither listener leaks. */
export function once(
  media: SeekableMedia,
  event: string,
  errorEvent = "error",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener(event, onDone);
      media.removeEventListener(errorEvent, onError);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`The media could not be read (${errorEvent}).`));
    };
    media.addEventListener(event, onDone);
    media.addEventListener(errorEvent, onError);
  });
}

/**
 * Seek, and resolve when there is a frame at that time.
 *
 * Two ways of writing this hang, and both were written in `frameSource.ts`
 * first:
 *
 * - **Assign `currentTime`, then await `seeked`.** The target is very often the
 *   time the element is already on — resetting a paused clip to 0 is the common
 *   case — so the assignment is a no-op, no seek is performed, and no `seeked`
 *   ever arrives. Hence the early return, which is only safe once readiness is
 *   known: before that, `currentTime` is 0 because nothing has loaded, not
 *   because the decoder is there.
 * - **Await one `requestVideoFrameCallback`, to be sure the frame is painted.**
 *   `rVFC` fires when a frame is *presented*, and a paused video sitting on the
 *   frame it already showed presents nothing ever again. Measured in this app:
 *   it does not fire, while `drawImage` of that same element at `readyState` 4
 *   returns the picture. Readiness is the whole condition.
 */
export async function seekMedia(
  media: SeekableMedia,
  timeSec: number,
): Promise<void> {
  await whenReady(media);

  const target = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  if (Math.abs(media.currentTime - target) <= ALREADY_THERE_SEC) {
    return;
  }

  media.currentTime = target;
  await once(media, "seeked");
}
