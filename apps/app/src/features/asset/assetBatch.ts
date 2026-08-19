/**
 * Starting a batch of asset loads without letting one bad file sink the rest.
 *
 * The preview repaints when this reports that something new arrived. Two things
 * used to break that promise, and both showed up as "the clip I just added is
 * invisible until I scrub":
 *
 *   - the loads were awaited with a bare `Promise.all`, so a single rejecting
 *     image took the whole batch down and cancelled the repaint that every
 *     *successful* load in it had earned;
 *   - images and gifs had no in-flight guard, so a slow decode was restarted on
 *     every repaint and the batch never settled.
 *
 * Kept free of the DOM so it can be tested under `environment: "node"`, which
 * `loadedAssetStore` itself cannot be — it builds canvases at module load.
 */

export interface AssetLoadTask {
  /** Identity for the in-flight guard: a path, or an element id for video. */
  key: string;
  /**
   * The caller's own live set for this kind of asset, so the guard survives
   * across calls. Passing a copy would make every repaint start the load again.
   */
  inFlight: Set<string>;
  start: () => Promise<unknown>;
}

/**
 * Start every task that is not already running, and wait for them.
 *
 * Resolves true when at least one task was started, which is the caller's cue
 * that the cache changed and a repaint is due. Never rejects: a task that fails
 * is simply one that did not contribute a new asset.
 */
export async function runAssetBatch(
  tasks: readonly AssetLoadTask[],
): Promise<boolean> {
  const started: Promise<unknown>[] = [];

  for (const task of tasks) {
    if (task.inFlight.has(task.key)) {
      continue;
    }

    task.inFlight.add(task.key);
    started.push(
      task
        .start()
        .catch(() => {})
        .finally(() => task.inFlight.delete(task.key)),
    );
  }

  await Promise.all(started);
  return started.length > 0;
}
