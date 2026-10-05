/**
 * One line for every caller of an HTML host.
 *
 * Each caller prepares on a host of its own (`graphicPipeline.ts`), so no
 * caller can redraw a canvas another one is showing; this queue is not what
 * keeps their rasters apart. It keeps the preview, an export and a contact
 * sheet to one prepare at a time (the preset tiles run beside it, so a tile
 * waiting on a font cannot stall playback), and while an export or a contact
 * sheet holds it the preview does not prepare at all, so the frame loop is not
 * competing with the preview for paints.
 *
 * A preview request made while held is not lost: the latest one is replayed
 * when the last hold ends. Dropped, a graphic scrubbed to during an export
 * kept its old raster until something else happened to repaint the preview.
 */

let chain: Promise<unknown> = Promise.resolve();
let exportsHolding = 0;
let deferred: (() => void) | null = null;

/** Run `task` after every task queued before it. */
export function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

export function beginExportGraphics(): void {
  exportsHolding += 1;
}

export function endExportGraphics(): void {
  exportsHolding = Math.max(0, exportsHolding - 1);
  if (exportsHolding === 0 && deferred != null) {
    const retry = deferred;
    deferred = null;
    // After the caller's own cleanup, never inside it.
    queueMicrotask(() => {
      try {
        retry();
      } catch (error) {
        console.warn("graphic: deferred preview request failed", error);
      }
    });
  }
}

/** Whether the preview may queue a prepare now. */
export function previewMayPrepare(): boolean {
  return exportsHolding === 0;
}

/** Run `retry` once the last hold ends. Only the latest one is kept. */
export function whenPreviewMayPrepare(retry: () => void): void {
  deferred = retry;
}
