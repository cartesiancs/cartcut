/**
 * Turning a `DataTransfer` full of `File` objects into absolute paths.
 *
 * The old handler read `e.dataTransfer.files[0].path`. That property was a
 * non-standard Electron extension, and Electron **removed it in v32**; this app
 * is on 33. So `path` came back `undefined`, `AssetController.add(undefined)`
 * threw inside `path.encode`, and an empty `catch` swallowed it. Dropping a
 * file did nothing at all, with nothing in the console to say why.
 *
 * The replacement, `webUtils.getPathForFile(file)`, has to run in the preload
 * — the renderer has `contextIsolation: true` and cannot reach it — and it has
 * to be called synchronously, inside the `drop` handler, with the real `File`.
 * A `File` cannot cross IPC, so there is no async version of this.
 *
 * Which is why the resolver is a parameter. It keeps the one thing that needs
 * Electron out of this module, and it is the seam a test uses to hand in a
 * `File` that has no `path` property at all — the shape that broke the app.
 */

/** The little of `File` this needs. `path` is deliberately absent. */
export type DroppedFile = { name: string };

export type CollectResult = {
  /** Absolute paths, sorted by filename. */
  paths: string[];
  /** Names the resolver could not turn into a path. */
  unresolved: string[];
};

/**
 * Read every dropped file's path, in a stable order.
 *
 * All of them, not just the first — the old handler indexed `files[0]` and lost
 * the rest of a multi-file drop silently.
 *
 * Sorting by name is what makes a multi-file drop land predictably: the files
 * are about to be laid end to end on the timeline, and `DataTransfer` ordering
 * is whatever the OS file manager felt like. `numeric` so `clip2` precedes
 * `clip10`, which is the whole point of sorting a folder of exports.
 *
 * Nothing is filtered by extension here. `probeMedia` already decides what the
 * editor can render, and it reports a reason — two places answering that
 * question is how they drift apart.
 */
export function collectDroppedPaths(
  files: readonly DroppedFile[] | null | undefined,
  resolvePath: (file: DroppedFile) => string | undefined | null,
): CollectResult {
  const paths: string[] = [];
  const unresolved: string[] = [];

  for (const file of files ?? []) {
    let resolved: string | undefined | null;
    try {
      resolved = resolvePath(file);
    } catch {
      // A resolver that throws is a resolver that failed, and one bad file must
      // not lose the rest of the drop.
      resolved = undefined;
    }

    if (typeof resolved === "string" && resolved !== "") {
      paths.push(resolved);
    } else {
      unresolved.push(file?.name ?? "");
    }
  }

  paths.sort((a, b) =>
    basename(a).localeCompare(basename(b), undefined, { numeric: true }),
  );

  return { paths, unresolved };
}

/** Last path segment, for either separator — drops come from both platforms. */
function basename(filepath: string): string {
  const cut = Math.max(filepath.lastIndexOf("/"), filepath.lastIndexOf("\\"));
  return cut === -1 ? filepath : filepath.slice(cut + 1);
}
