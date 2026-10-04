/**
 * One line for every caller of the HTML host.
 *
 * The host's DOM is shared, and a prepare is not atomic: it applies state,
 * waits for a paint, then reads the paint back. An export runs while the
 * preview goes on repainting (the export button has no modal), so without this
 * the preview could apply its frame between an export's apply and its read,
 * and the delivered file would carry the preview's frame.
 *
 * So every prepare runs one at a time, and while an export holds the host the
 * preview does not queue at all: it keeps showing the rasters it has.
 */

let chain: Promise<unknown> = Promise.resolve();
let exportsHolding = 0;

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
}

/** Whether the preview may queue a prepare now. */
export function previewMayPrepare(): boolean {
  return exportsHolding === 0;
}
