/**
 * The files a browser build was handed through Import, listed in the asset
 * panel until the tab closes.
 *
 * A browser build has no folder of the user's own to browse, so without this
 * a picked file went straight to the timeline at the playhead and was gone
 * from view the moment it was deleted there: using it a second time meant
 * finding it in the picker again. Listed here, it is an asset like any other:
 * a click or a drag onto the timeline goes through `importPathsAt` by its
 * `blob:` path, the way a file in a folder goes by its absolute one.
 *
 * Session only, by necessity: an object URL dies with the page, so a list
 * that outlived it would be a list of tiles that load nothing.
 *
 * DOM-free apart from the registry's default `URL.createObjectURL`, which
 * exists in Node too, so the suite runs under `environment: "node"`.
 */

import { createStore } from "zustand/vanilla";
import type { AssetEntry } from "../directoryEntries";
import { registerPickedFile } from "./mediaRegistry";

/** An asset panel entry that knows its own path, a `blob:` one. */
export type ImportedMedia = AssetEntry & {
  isDirectory: false;
  path: string;
  /** Name, size and modification time: what makes two picks the same file. */
  identity: string;
};

/** The little of `File` the pure half reads. */
export type PickedFile = {
  file: Pick<File, "name" | "size" | "lastModified" | "type">;
  handle?: unknown;
};

export function identityOf(file: PickedFile["file"]): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

/**
 * Append what is new, and answer every pick's path in pick order.
 *
 * A file picked twice keeps its first entry and its first path: a second
 * object URL for the same bytes would be a second tile showing the same clip,
 * and the clips already on the timeline name the first one. `register` is
 * called only for a file that is new.
 *
 * Returns `list` by identity when nothing was added, so a subscriber that
 * compares references sees no change.
 */
export function mergeImported(
  list: readonly ImportedMedia[],
  picked: readonly PickedFile[],
  register: (picked: PickedFile) => string,
): { list: readonly ImportedMedia[]; paths: string[] } {
  const byIdentity = new Map(list.map((entry) => [entry.identity, entry]));
  const added: ImportedMedia[] = [];
  const paths: string[] = [];

  for (const one of picked) {
    const identity = identityOf(one.file);
    let entry = byIdentity.get(identity);
    if (entry == null) {
      const path = register(one);
      entry = {
        name: nameOf(path, one.file.name),
        isDirectory: false,
        path,
        identity,
        ...(Number.isFinite(one.file.size) && one.file.size >= 0
          ? { size: one.file.size }
          : {}),
        ...(Number.isFinite(one.file.lastModified) && one.file.lastModified > 0
          ? { modifiedMs: one.file.lastModified }
          : {}),
      };
      byIdentity.set(identity, entry);
      added.push(entry);
    }
    paths.push(entry.path);
  }

  return { list: added.length === 0 ? list : [...list, ...added], paths };
}

/**
 * The name a tile shows: the fragment `pickedMediaPath` wrote, which carries
 * the extension a nameless phone pick was given. The tile decides from it
 * whether it is a video, a still or a sound, so it has to be the same name
 * `probeMedia` reads.
 */
function nameOf(path: string, fallback: string): string {
  const hash = path.indexOf("#");
  return hash === -1 ? fallback : path.slice(hash + 1);
}

export interface IImportedMediaStore {
  items: readonly ImportedMedia[];
  /** Register and list every file, and answer their paths in pick order. */
  add: (picked: readonly { file: File; handle?: unknown }[]) => string[];
}

export const importedMediaStore = createStore<IImportedMediaStore>((set, get) => ({
  items: [],
  add: (picked) => {
    // Each pick is registered with the `File` it came with, which is what an
    // export reads its bytes from.
    const { list, paths } = mergeImported(get().items, picked, (one) => {
      const { file, handle } = one as { file: File; handle?: unknown };
      return registerPickedFile(file, handle);
    });
    if (list !== get().items) {
      set({ items: list });
    }
    return paths;
  },
}));
