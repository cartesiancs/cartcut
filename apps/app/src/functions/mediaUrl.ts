/**
 * The URL a page loads a clip's `localpath` from.
 *
 * Only the self-hosted web build has anything to add: it serves files from the
 * machine it runs on through `/api/file?path=`, so a bare OS path has to go
 * through that route. Everything else is already a URL the page can load:
 * Electron's `file://`, the demo's same-origin `/sample/...`, and in every web
 * build a picked file's `blob:` URL.
 *
 * This used to be written out five times, each prefixing unconditionally on
 * the web, and `mediaProbe.ts#toLocalPath` had already converted the path on
 * the way in. So an image imported on the web build loaded from
 * `/api/file?path=/api/file?path=...`, and a picked file's object URL became a
 * server request for a path that does not exist. A path that is already a URL,
 * or already the route, passes through.
 *
 * `env` is a parameter so the rule can be tested without a `window`.
 */
export type LocationEnv = "web" | "electron" | "demo";

const ALREADY_LOADABLE = /^(?:blob|https?|data|file):/i;
const FILE_ROUTE = "/api/file?";

export function mediaUrlFor(localpath: string, env: LocationEnv): string {
  if (env !== "web") {
    return localpath;
  }
  if (ALREADY_LOADABLE.test(localpath) || localpath.startsWith(FILE_ROUTE)) {
    return localpath;
  }
  return `/api/file?path=${localpath}`;
}
