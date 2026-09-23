/**
 * What the editor tells extensions, and how often.
 *
 * Every one of these is a store subscription, and every one of them fires at a
 * rate no extension can usefully consume. The playhead moves at the display
 * rate. The document changes on every frame of a drag. The lesson
 * `cartcut-store-noop-writes` and `previewLoop.ts` both record applies here:
 * the cost of an event is not the listener, it is the structured clone and the
 * wake-up on the other side, paid at 60Hz, on the thread compositing the
 * preview.
 *
 * So each event is coalesced at the source:
 *
 * - **`document.changed`** carries a version counter and fires once per
 *   document identity change, which for a checkpoint means once per undo step.
 * - **`playhead.changed`** fires at most once per animation frame, latest
 *   wins, and is skipped entirely when the value has not moved.
 * - **`selection.changed`** fires on an identity change of the id list, which
 *   is what `selectionStore` already guarantees.
 *
 * Pure over ports, so the coalescing can be asserted with a fake scheduler
 * rather than hoped for.
 */

import type { FrameScheduler } from "../caption/previewLoop";

export type EventSink = (event: string, params: unknown) => void;

export type EventSources = {
  subscribeDocument(listener: (elements: unknown, tracks: unknown) => void): () => void;
  subscribeCursor(listener: (ms: number) => void): () => void;
  subscribeSelection(listener: (ids: string[]) => void): () => void;
  subscribePlayback(listener: (isPlay: boolean) => void): () => void;
  subscribeLock(listener: (reason: string | null) => void): () => void;
  scheduler: FrameScheduler;
};

export type EventPublisher = {
  /** Called by the project layer, which knows when a load or a save finished. */
  projectOpened(path: string | null, dir: string | null): void;
  projectSaved(path: string): void;
  stop(): void;
  /** The version the last `document.changed` carried, for tests. */
  documentVersion(): number;
};

/**
 * Start publishing. Returns the handle that stops it.
 *
 * Every subscription is returned so a host that goes away takes its listeners
 * with it: an extension host restarts on every save of an unpacked extension,
 * and subscriptions that outlived their sink would accumulate one set per
 * restart, each still serialising the document on every drag frame.
 */
export function publishEditorEvents(sink: EventSink, sources: EventSources): EventPublisher {
  let version = 0;
  let frame: number | null = null;
  let pendingCursor: number | null = null;
  let lastCursor: number | null = null;
  let stopped = false;

  const unsubscribes: Array<() => void> = [];

  unsubscribes.push(
    sources.subscribeDocument((elements, tracks) => {
      version += 1;
      // The ids are not sent. A caller that needs them asks, and sending the
      // document's shape on every edit is exactly the cost this file exists to
      // avoid: `serialize.ts` is the only thing allowed to decide what an
      // element looks like on the wire.
      sink("document.changed", {
        version,
        clipCount: Object.keys((elements ?? {}) as Record<string, unknown>).length,
        trackCount: Array.isArray(tracks) ? tracks.length : 0,
      });
    }),
  );

  unsubscribes.push(
    sources.subscribeCursor((ms) => {
      pendingCursor = ms;
      if (frame != null) {
        return;
      }
      frame = sources.scheduler.request(() => {
        frame = null;
        const value = pendingCursor;
        pendingCursor = null;
        if (stopped || value == null || value === lastCursor) {
          return;
        }
        lastCursor = value;
        sink("playhead.changed", { ms: Math.round(value) });
      });
    }),
  );

  unsubscribes.push(
    sources.subscribeSelection((ids) => {
      sink("selection.changed", { ids });
    }),
  );

  unsubscribes.push(
    sources.subscribePlayback((isPlay) => {
      sink("playback.changed", { isPlay });
    }),
  );

  unsubscribes.push(
    sources.subscribeLock((reason) => {
      sink("lock.changed", { reason });
    }),
  );

  return {
    projectOpened: (path, dir) => sink("project.opened", { path, dir }),
    projectSaved: (path) => sink("project.saved", { path }),
    documentVersion: () => version,
    stop() {
      stopped = true;
      if (frame != null) {
        sources.scheduler.cancel(frame);
        frame = null;
      }
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;
    },
  };
}
