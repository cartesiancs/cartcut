/**
 * The asset panel's one thumbnail pipeline: queue, capture, cache.
 *
 * A single instance for the app, keyed by the encoded file URL, so two tiles
 * standing for one file share a capture instead of racing for two decoders.
 * Kept apart from its three parts so each of those stays node-testable without
 * constructing a queue at import.
 */

import { captureThumbnail } from "./thumbnailCapture";
import { thumbnailCache, type Thumbnail } from "./thumbnailCache";
import { createThumbnailQueue, THUMBNAIL_CONCURRENCY } from "./thumbnailQueue";

/**
 * Who to tell when a given file's thumbnail lands.
 *
 * Keyed rather than one list for everything: a folder of four hundred tiles
 * would otherwise wake all four hundred on every capture, and each tile only
 * ever cares about its own file.
 */
const waiting = new Map<string, Set<() => void>>();

function wake(key: string) {
  const listeners = waiting.get(key);
  if (listeners == undefined) {
    return;
  }

  waiting.delete(key);
  for (const listener of listeners) {
    listener();
  }
}

const queue = createThumbnailQueue<Thumbnail>({
  concurrency: THUMBNAIL_CONCURRENCY,
  capture: captureThumbnail,

  onLoaded: (key, thumbnail) => {
    // Cached before anyone is told, so every listener woken below finds it.
    thumbnailCache.set(key, thumbnail);
    wake(key);
  },

  // A failure wakes them too. They get no thumbnail either way, and leaving
  // them registered would hold this map's entry, and each tile's own record of
  // an outstanding request, for the life of the session.
  onFailed: wake,
});

/** Ask for `fileUrl`'s thumbnail. `onLoaded` fires once, if one arrives. */
export function requestThumbnail(fileUrl: string, onLoaded: () => void): void {
  let listeners = waiting.get(fileUrl);
  if (listeners == undefined) {
    listeners = new Set();
    waiting.set(fileUrl, listeners);
  }
  listeners.add(onLoaded);

  queue.request(fileUrl);
}

/**
 * Withdraw one request.
 *
 * The capture itself is only dropped once nobody is left waiting for it, so a
 * tile scrolling away does not cancel the file another tile still wants.
 */
export function cancelThumbnail(fileUrl: string, onLoaded: () => void): void {
  const listeners = waiting.get(fileUrl);
  if (listeners == undefined) {
    return;
  }

  listeners.delete(onLoaded);
  if (listeners.size > 0) {
    return;
  }

  waiting.delete(fileUrl);
  queue.cancel(fileUrl);
}
