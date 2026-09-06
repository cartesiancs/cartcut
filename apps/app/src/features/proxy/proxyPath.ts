/**
 * Crossing between the renderer's `file://` paths and main's OS paths.
 *
 * Two functions, and they must stay exact inverses of each other and of
 * `functions/path.ts#encode`, which escapes `#` **and nothing else**. That
 * asymmetry is deliberate and is the trap `features/project/assetPaths.ts`
 * documents at length: `localpath` looks like a URL but is not
 * percent-encoded, so `decodeURIComponent` throws on a file named `100%.mp4`
 * and `new URL` truncates `a?b.mp4` at the `?`. A macOS screen recording is
 * called `Screen Recording 2026-09-05 at 3.02.07 PM.mov` — with a narrow
 * no-break space before the PM — which passes through untouched here and would
 * not survive a general-purpose encoder.
 *
 * Its own module rather than living on the panel, so `proxyBridge` does not
 * have to import a Lit component to convert a string.
 */

/** `file:///Users/me/a#b.mp4` → `/Users/me/a#b.mp4`. */
export function toOsPath(localpath: string): string {
  return localpath.replace(/^file:\/\//, "").replace(/%23/g, "#");
}

/**
 * The inverse, so a result from main can be looked up by `localpath`.
 *
 * On Windows this mints `file://C:\Users\me\a.mp4` — a drive letter where a URL
 * host belongs. That is malformed, Chromium accepts it, and it is what
 * `mediaProbe.toLocalPath` already produces; minting the tidy form instead
 * would give one file two spellings and the lookup would miss.
 */
export function toLocalPathKey(osPath: string): string {
  return `file://${osPath.replace(/#/g, "%23")}`;
}
