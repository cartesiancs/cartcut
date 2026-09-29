import type { Stats } from "fs";
import * as fsp from "fs/promises";
import path from "path";

/**
 * One row of `filesystem:getDirectory`, keyed by its filename in the listing.
 *
 * The three numbers are what the asset panel's Sort By reads. They are raw
 * `Stats` values and nothing here judges them: `birthtimeMs` is 0 on a Linux
 * filesystem without statx support, and the renderer's
 * `normalizeDirectoryEntries` is the one place that decides a value is usable.
 */
export type DirectoryEntryInfo = {
  isDirectory: boolean;
  title: string;
  /** Bytes, for a regular file only. A folder's `size` is its inode's, not its contents'. */
  size?: number;
  mtimeMs?: number;
  birthtimeMs?: number;
};

/**
 * Reads one folder, one level deep, with what each entry is and how big and
 * how old it is.
 *
 * Shared by the IPC handler and the web shim's Express route, which used to
 * carry the same loop twice. No `electron` import, so the server can use it.
 *
 * A symbolic link is followed: `lstat` alone reports the link itself, so a
 * linked 2 GB video listed as 38 bytes and a linked folder listed as a file
 * that could not be opened. A link whose target is gone falls back to the
 * link's own stat and stays listed, as Finder lists it.
 *
 * Only `readdir` can reject. An entry that cannot be stat'd (deleted between
 * the two calls, or unreadable) is left out rather than failing the folder.
 *
 * The result has no prototype, so a file called `__proto__` is a key like any
 * other instead of silently replacing the object's prototype.
 */
export async function listDirectory(
  dir: string,
): Promise<Record<string, DirectoryEntryInfo>> {
  const names = await fsp.readdir(dir);
  const lists: Record<string, DirectoryEntryInfo> = Object.create(null);

  await Promise.all(
    names.map(async (name) => {
      const stat = await statFollowingLinks(path.join(dir, name));
      if (stat == null) {
        return;
      }

      const info: DirectoryEntryInfo = {
        isDirectory: stat.isDirectory(),
        title: name,
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
      };
      if (stat.isFile()) {
        info.size = stat.size;
      }
      lists[name] = info;
    }),
  );

  return lists;
}

async function statFollowingLinks(fullPath: string): Promise<Stats | null> {
  let own: Stats;
  try {
    own = await fsp.lstat(fullPath);
  } catch {
    return null;
  }

  if (!own.isSymbolicLink()) {
    return own;
  }

  try {
    return await fsp.stat(fullPath);
  } catch {
    return own;
  }
}
