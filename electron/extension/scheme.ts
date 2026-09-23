/**
 * Serving an extension's own files to its views, and nothing else.
 *
 * A custom scheme rather than `file://` for three reasons, each of which would
 * otherwise be a hole: a `file://` page has the whole disk as its origin, so
 * two extensions' views would be same-origin with each other and with every
 * file the user owns; `file://` carries no response headers, so there is
 * nowhere to put the CSP; and a `file://` URL has no host component, so there
 * would be nothing in the URL naming which extension a page belongs to, which
 * is what `webviewPolicy.ts` decides on.
 *
 * The resolution itself is in `schemeResolve.ts`, which imports no Electron
 * and is tested directly. This file is the wiring.
 */

import * as fsp from "fs/promises";
import { pathToFileURL } from "url";
import { net, protocol, session, type Session } from "electron";

import {
  EXTENSION_SCHEME,
  extensionResponseHeaders,
  resolveExtensionRequest,
} from "./schemeResolve";

let dirResolver: (extId: string) => string | null = () => null;

/** Set by `main.ts` from the host's listing, so a disabled extension stops serving. */
export function setExtensionDirResolver(resolver: (extId: string) => string | null): void {
  dirResolver = resolver;
}

/**
 * Must run before `app.whenReady()`.
 *
 * `standard: true` is what gives the scheme a host component and a real
 * origin; without it `cartcut-ext://acme.hello/x` parses with an empty host
 * and every view shares one opaque origin. `secure: true` keeps the page out
 * of the mixed-content and "not secure" paths that would otherwise disable
 * parts of the platform inside a panel.
 */
export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
      },
    },
  ]);
}

/**
 * The handler, as a function, so it can be installed on more than one session.
 *
 * That it has to be is the whole point of this shape. `protocol.handle`
 * registers on `session.defaultSession` and **only** there, and every
 * extension view runs in its own `persist:ext:<id>` partition, which is a
 * different session with no handler at all. A request from a panel therefore
 * reached nothing: no 404, no error, no `did-fail-load`, just a load that
 * started and never finished. Installing per partition is what makes a panel
 * able to read its own files.
 */
function handleExtensionRequest(request: Request): Promise<Response> {
  return serve(request.url);
}

async function serve(url: string): Promise<Response> {
  const resolved = resolveExtensionRequest(url, dirResolver);
  if (resolved == null) {
    // Logged, because the symptom an extension author sees is a blank panel
    // and there is otherwise nothing anywhere to tell them their `page` is
    // misspelled, their extension is disabled, or the file type is one this
    // scheme does not serve.
    console.warn("[extension] refused " + url);
    return new Response("Not found", { status: 404 });
  }

  try {
    // `lstat` rather than `stat`: a symlink inside an extension folder is the
    // one way a contained path can still point outside it, and following it is
    // exactly what `resolveContained` cannot see.
    const info = await fsp.lstat(resolved.file);
    if (!info.isFile()) {
      console.warn("[extension] not a file: " + resolved.file);
      return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    console.warn("[extension] cannot read " + resolved.file + ": " + String(error));
    return new Response("Not found", { status: 404 });
  }

  try {
    // `pathToFileURL`, never string concatenation: a space, a `#` or a
    // non-ASCII character in the path produces a URL that names a different
    // file or no file at all, and the failure is a blank page.
    const response = await net.fetch(pathToFileURL(resolved.file).toString());
    return new Response(response.body, {
      status: 200,
      headers: extensionResponseHeaders(resolved.mime),
    });
  } catch (error) {
    console.warn("[extension] could not serve " + resolved.file + ": " + String(error));
    return new Response("Not found", { status: 404 });
  }
}

/** Sessions the handler is already on, so a second install is a no-op. */
const served = new Set<string>();

export function installExtensionProtocol(): void {
  installExtensionProtocolOn(session.defaultSession, "default");
}

/**
 * Install on one partition's session.
 *
 * Called from `will-attach-webview`, which is the last moment before the guest
 * navigates and the first at which the partition is known. `protocol.handle`
 * throws when a scheme is already registered on that session, so the set is
 * checked first: a partition is reused every time its panel is reopened.
 */
export function installExtensionProtocolOn(target: Session, key: string): void {
  if (served.has(key)) {
    return;
  }
  served.add(key);
  try {
    target.protocol.handle(EXTENSION_SCHEME, handleExtensionRequest);
  } catch (error) {
    console.warn("[extension] could not serve " + EXTENSION_SCHEME + " on " + key + ": " + String(error));
    served.delete(key);
  }
}
