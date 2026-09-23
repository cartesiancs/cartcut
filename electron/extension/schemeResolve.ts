/**
 * Turning a `cartcut-ext://` URL into a file to serve, or into a 404.
 *
 * Pure and Electron-free, because it is a security boundary and a security
 * boundary that cannot be tested is a hope. Every rule here is one an attacker
 * would otherwise use: a host that names an extension that is not loaded, a
 * percent-encoded traversal, a path that resolves outside the folder, a file
 * type the page could execute.
 */

import { EXTENSION_ID_PATTERN } from "./protocol";
import { resolveContained } from "./paths";

export const EXTENSION_SCHEME = "cartcut-ext";

/**
 * What a view page is allowed to do.
 *
 * `default-src 'none'` and then only what a panel genuinely needs. The two
 * worth explaining: `connect-src 'none'` means a view cannot reach the network
 * at all, because anything it needs from outside should go through its
 * extension, where the `net` permission was disclosed and can be revoked;
 * `frame-src 'none'` means it cannot nest another page, which is what would
 * otherwise let a view smuggle in a remote document that inherits its origin.
 */
export const EXTENSION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The only types a view is served.
 *
 * A closed table rather than a lookup by extension, so that a file an author
 * drops into `views/` cannot be served as something the browser will run in a
 * way nobody intended. Anything absent is a 404, not `application/octet-stream`.
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

export type ResolvedRequest = { file: string; mime: string; extId: string };

/**
 * Resolve one request against the folder of whichever extension it names.
 *
 * `dirFor` returns `null` for an extension that is not loaded or is disabled,
 * which is what stops a page that was open when an extension was switched off
 * from continuing to read its files.
 */
export function resolveExtensionRequest(
  rawUrl: string,
  dirFor: (extId: string) => string | null,
): ResolvedRequest | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== EXTENSION_SCHEME + ":") {
    return null;
  }

  const extId = url.hostname;
  if (!EXTENSION_ID_PATTERN.test(extId)) {
    return null;
  }

  const dir = dirFor(extId);
  if (dir == null) {
    return null;
  }

  let pathname: string;
  try {
    // Decoded before it is checked, never after. `%2e%2e%2f` is `../`, and a
    // containment check run on the encoded form would pass it happily.
    pathname = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }

  if (pathname === "") {
    return null;
  }

  const file = resolveContained(dir, pathname);
  if (file == null) {
    return null;
  }

  const dot = file.lastIndexOf(".");
  const mime = dot === -1 ? null : MIME[file.slice(dot).toLowerCase()];
  if (mime == null) {
    return null;
  }

  return { file, mime, extId };
}

/** The headers every served file carries. */
export function extensionResponseHeaders(mime: string): Record<string, string> {
  return {
    "content-type": mime,
    "content-security-policy": EXTENSION_CSP,
    // Without this a `.txt` an extension serves can still be sniffed into
    // something executable by the renderer's content type guessing.
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  };
}
