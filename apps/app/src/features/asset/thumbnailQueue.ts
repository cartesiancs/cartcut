/**
 * How many asset thumbnails may be decoding at once.
 *
 * The asset grid used to start a capture per video from inside `render()`, so a
 * folder of two hundred recordings meant two hundred simultaneous decodes.
 * Chromium blocks the 76th `WebMediaPlayer` and the timeline draws its own
 * handles from the same pool, so a big folder did not merely make the panel
 * slow, it starved playback.
 *
 * Pure and DOM-free: it takes the capture as a parameter, which is what lets a
 * node suite drive it with a fake and assert the bound actually holds.
 */

/**
 * Two at a time.
 *
 * One in-flight capture holds one `WebMediaPlayer`, and the work is a seek plus
 * a decode across a long GOP, so it is bound by IO and the decoder rather than
 * by latency: raising this does not fill the visible grid any sooner, it only
 * takes more of the 75 away from the timeline. Two keeps the pipe full while
 * one is seeking.
 */
export const THUMBNAIL_CONCURRENCY = 2;

/**
 * How many times one file may fail before the queue stops offering it.
 *
 * Without a ceiling, a file that cannot be decoded is retried on every scroll
 * that brings its tile back, and each attempt occupies a slot for the full
 * capture timeout. One retry covers a capture that lost its race under load;
 * anything beyond that is a file that is not going to work.
 */
export const MAX_ATTEMPTS = 2;

export interface ThumbnailQueue<T> {
  /** Ask for `key`, or move it to the front if it is already waiting. */
  request(key: string): void;
  /** Withdraw a waiting request. A running one is left to finish. */
  cancel(key: string): void;
  running(): number;
  waiting(): number;
}

export function createThumbnailQueue<T>(options: {
  concurrency: number;
  capture: (key: string) => Promise<T>;
  onLoaded: (key: string, value: T) => void;
  /**
   * Reported so a caller holding per-key state can let it go.
   *
   * Without this the only signal is a capture that never lands, which is
   * indistinguishable from one still queued: anything waiting on the key would
   * wait for the life of the session.
   */
  onFailed?: (key: string) => void;
}): ThumbnailQueue<T> {
  const { concurrency, capture, onLoaded, onFailed } = options;

  /**
   * A stack, not a FIFO.
   *
   * Scrolling is what fills this, and the tiles that just came into view are
   * the ones somebody is looking at. A queue would make them wait behind every
   * tile already scrolled past.
   */
  const pending: string[] = [];
  const running = new Set<string>();
  const attempts = new Map<string, number>();

  function drop(key: string) {
    const at = pending.indexOf(key);
    if (at >= 0) {
      pending.splice(at, 1);
    }
  }

  function pump() {
    while (running.size < concurrency && pending.length > 0) {
      const key = pending.pop();
      if (key == undefined) {
        return;
      }

      running.add(key);
      capture(key).then(
        (value) => {
          running.delete(key);
          attempts.delete(key);
          onLoaded(key, value);
          pump();
        },
        () => {
          // Never rethrown. A capture that fails is one tile without a
          // thumbnail, and taking the queue down with it would cost every
          // other file in the folder its own.
          running.delete(key);
          attempts.set(key, (attempts.get(key) ?? 0) + 1);
          onFailed?.(key);
          pump();
        },
      );
    }
  }

  return {
    request(key: string) {
      if (running.has(key)) {
        return;
      }
      if ((attempts.get(key) ?? 0) >= MAX_ATTEMPTS) {
        return;
      }

      drop(key);
      pending.push(key);
      pump();
    },

    cancel(key: string) {
      // Only the waiting half. A running capture already holds its decoder and
      // is most of the way through the seek that cost the time, so abandoning
      // it gives nothing back and throws away a thumbnail the user is about to
      // scroll to again.
      drop(key);
    },

    running: () => running.size,
    waiting: () => pending.length,
  };
}
