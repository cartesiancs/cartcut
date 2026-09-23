/**
 * Reading the small data files an extension contributes.
 *
 * Pure over an injected filesystem, the split `presetScan.ts` makes and for
 * the same reason: a module that imports `electron` cannot be loaded by
 * vitest, and the rules worth pinning are the ones about what is read.
 *
 * **Deliberately incurious.** It reads JSON files out of one folder and passes
 * their text along without parsing it. What an animation preset *means* lives
 * in `features/extension/animationPresets.ts`, which is where every other
 * format's meaning lives too: main would otherwise need a second copy of a
 * schema it cannot import.
 *
 * The three limits below are the whole of its judgement, and each is a real
 * failure rather than a tidy number: a folder with ten thousand files, a
 * single file that is a video somebody renamed, and a name that is a path.
 */

import path from "path";

import { isSafeRelativePath } from "./paths";

/** Extensions read as data. Anything else in the folder is ignored. */
export const DATA_EXTENSIONS = [".json"];

/**
 * Largest data file worth reading, in bytes.
 *
 * An animation preset is a few hundred bytes. This is not a limit any real one
 * meets; it is a cap so a 500MB file named `.json` cannot be pulled into
 * main's memory at startup.
 */
export const MAX_DATA_BYTES = 256 * 1024;

/** Most files read from one folder, so a mistake cannot become a stall. */
export const MAX_DATA_FILES = 200;

export type DataFsPorts = {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  sizeOf(file: string): Promise<number>;
};

export type ScannedDataFile = {
  fileName: string;
  /** The file's text, never parsed on this side. */
  text: string;
};

export type DataScanResult = {
  files: ScannedDataFile[];
  /** Files that were skipped, and why. Surfaced in the extension's log. */
  skipped: Array<{ fileName: string; reason: string }>;
};

/**
 * Every readable data file in one folder, not recursing.
 *
 * Flat on purpose. A preset is one file, so a folder of them has no structure
 * to walk, and every level of recursion is another place a symlink could point
 * somewhere else.
 */
export async function scanDataFolder(dir: string, ports: DataFsPorts): Promise<DataScanResult> {
  const files: ScannedDataFile[] = [];
  const skipped: Array<{ fileName: string; reason: string }> = [];

  let names: string[] = [];
  try {
    names = await ports.readdir(dir);
  } catch {
    // A folder the manifest declares and the extension did not ship. Not an
    // error: the extension simply contributes nothing of this kind.
    return { files, skipped };
  }

  const candidates = names
    .filter((name) => DATA_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort();

  for (const name of candidates.slice(0, MAX_DATA_FILES)) {
    // The name came off the disk rather than out of a manifest, but it is
    // about to be joined to a root, and a folder can contain anything
    // somebody put there.
    if (!isSafeRelativePath(name)) {
      skipped.push({ fileName: name, reason: "the file name is not one this app will open" });
      continue;
    }

    const file = path.join(dir, name);
    try {
      const size = await ports.sizeOf(file);
      if (size > MAX_DATA_BYTES) {
        skipped.push({
          fileName: name,
          reason: "is " + size + " bytes, over the " + MAX_DATA_BYTES + " byte cap",
        });
        continue;
      }
      files.push({ fileName: name, text: await ports.readFile(file) });
    } catch (error) {
      skipped.push({ fileName: name, reason: String(error) });
    }
  }

  if (candidates.length > MAX_DATA_FILES) {
    skipped.push({
      fileName: dir,
      reason: "holds " + candidates.length + " files, so only the first " + MAX_DATA_FILES + " were read",
    });
  }

  return { files, skipped };
}
