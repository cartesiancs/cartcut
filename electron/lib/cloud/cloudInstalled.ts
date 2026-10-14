/**
 * Everything the cloud put on disk, counted and removed. Plain `fs`, no
 * Electron.
 *
 * Only the folders `cloudPaths.ts` names are read or removed. What the user
 * made or installed themselves lives in `userData/presets` and
 * `userData/templates`, extensions in their own folder and built-ins in the
 * app bundle, and none of those is under `userData/cloud`. Nothing here takes
 * a path from the renderer: the one argument is main's own `userData`.
 */

import * as fsp from "fs/promises";
import path from "path";

import {
  cloudAssetRoot,
  cloudGifRoot,
  cloudPresetRoot,
  cloudStagingRoot,
  cloudTemplateRoot,
} from "./cloudPaths";

export type CloudInstallSummary = { items: number; bytes: number };

/** The roots a download installs into, one folder per item. */
function installRoots(userData: string): string[] {
  return [
    cloudPresetRoot(userData),
    cloudTemplateRoot(userData),
    cloudAssetRoot(userData),
    cloudGifRoot(userData),
  ];
}

async function entriesOf(root: string) {
  try {
    return await fsp.readdir(root, { withFileTypes: true });
  } catch {
    // Nothing downloaded of this kind yet: the folder is created on install.
    return [];
  }
}

/** Bytes under a folder. Links are not followed, so nothing outside is counted. */
async function bytesUnder(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await entriesOf(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await bytesUnder(full);
    } else if (entry.isFile()) {
      total += (await fsp.lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** How many items are installed from the cloud, and their size on disk. */
export async function summarizeCloudInstalls(userData: string): Promise<CloudInstallSummary> {
  let items = 0;
  let bytes = 0;
  for (const root of installRoots(userData)) {
    for (const entry of await entriesOf(root)) {
      if (entry.isDirectory()) {
        items += 1;
        bytes += await bytesUnder(path.join(root, entry.name));
      }
    }
  }
  return { items, bytes };
}

/**
 * Remove every installed cloud item, and staging.
 *
 * Item by item rather than each root at once, so one that cannot go (a media
 * file Windows holds open while a clip plays it) is counted as failed and the
 * rest still go.
 */
export async function removeCloudInstalls(
  userData: string,
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const root of installRoots(userData)) {
    for (const entry of await entriesOf(root)) {
      try {
        await fsp.rm(path.join(root, entry.name), { recursive: true, force: true, maxRetries: 2 });
        if (entry.isDirectory()) {
          removed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }
  await fsp.rm(cloudStagingRoot(userData), { recursive: true, force: true }).catch(() => {});
  return { removed, failed };
}
