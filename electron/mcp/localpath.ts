/**
 * The one conversion between the renderer's paths and the filesystem's.
 *
 * A clip's `localpath` is a **`file://` URL**, not a path, and deliberately so:
 * `loadedAssetStore` reads it directly and in Electron the loaders need a URL
 * (`features/element/mediaProbe.ts#toLocalPath` is where it is minted). It is
 * also percent-encoded, so a file with a space in its name arrives as `%20`.
 *
 * Main-process code that takes a `localpath` and hands it to `fs` therefore has
 * to convert, and the failure when it does not is quiet in an unhelpful way:
 * `fs.statSync` throws ENOENT naming a path that visibly exists, because the
 * name it printed has `file://` on the front. Both `analyze.ts` and
 * `transcribe.ts` reach `fs` this way, so the conversion lives here rather than
 * being remembered twice.
 *
 * ffmpeg itself accepts either form, which is exactly why this went unnoticed:
 * the decode works and only the cache lookup beside it fails.
 */

import { fileURLToPath } from "url";

/** A `localpath` as something `fs` will accept. Plain paths pass through. */
export function toFsPath(pathOrUrl: string): string {
  if (!/^file:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  try {
    return fileURLToPath(pathOrUrl);
  } catch {
    // A malformed URL is more useful left alone: the caller's own error names
    // what it was given, rather than this throwing something less specific.
    return pathOrUrl;
  }
}
