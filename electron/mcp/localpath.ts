/**
 * The one conversion between the renderer's paths and the filesystem's.
 *
 * A clip's `localpath` is usually a **`file://` URL**, not a path, and
 * deliberately so: `loadedAssetStore` reads it directly and in Electron the
 * loaders need a URL (`features/element/mediaProbe.ts#toLocalPath` is where it
 * is minted).
 *
 * It is **not** percent-encoded, despite looking like a URL. `functions/path.ts
 * #encode` escapes `#` and nothing else, so a space arrives as a space and a
 * file named `100%.mp4` arrives with a bare `%`.
 *
 * Which means `fileURLToPath` is not quite the right tool, and two filenames
 * defeat it — both pre-existing, neither fixed here:
 *
 *  - `100%.mp4` makes it throw `URI malformed`. The `catch` below hands the
 *    URL back, so `fs` is then asked for a path with `file://` on the front.
 *  - `a?b.mp4` it *truncates* to `/U/a`, silently and without throwing, so
 *    the caller stats a file that was never named.
 *
 * `features/project/assetPaths.ts#toFsPath` is the renderer's version of this
 * conversion and handles both, by doing the only decoding there is anything to
 * undo: `%23` → `#`. It cannot be shared — it is renderer-side and this is
 * main — but it is the reference for what the answer should be.
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
