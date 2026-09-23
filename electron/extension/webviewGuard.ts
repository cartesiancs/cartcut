/**
 * Every `<webview>` in this app, forced into shape before it exists.
 *
 * `will-attach-webview` is the only moment at which the guest's preferences
 * can still be changed; after `did-attach-webview` the process is up and a
 * preload it should not have has already run. So the decision is made here,
 * from `webviewPolicy.ts`, and applied to the preferences object in place,
 * which is how Electron's API takes an answer.
 *
 * The second half is what the guest may do once it exists. A view is a panel,
 * not a browser: it may not navigate away from its own extension, may not open
 * a window, and is denied every device permission outright. Each of those is
 * default-allow in Electron, so each needs a line here.
 */

import type { WebContents, WebPreferences } from "electron";
import { app, session } from "electron";
import path from "path";

import { decideAttach, STRIPPED_ATTRIBUTES } from "./webviewPolicy";
import { EXTENSION_SCHEME } from "./schemeResolve";
import { installExtensionProtocolOn } from "./scheme";

let enabledIds: () => string[] = () => [];
let onAttached: ((webContents: WebContents, extId: string, viewId: string) => void) | null = null;

export function setWebviewExtensionIds(getter: () => string[]): void {
  enabledIds = getter;
}

export function onWebviewAttached(
  handler: (webContents: WebContents, extId: string, viewId: string) => void,
): void {
  onAttached = handler;
}

function preloadPath(): string {
  // Compiled beside this file, inside the asar. A guest preload is loaded by
  // path, and this is our own output rather than an extra resource, so it
  // needs no `process.resourcesPath` dance.
  return path.join(__dirname, "webviewPreload.js");
}

/** The view id a panel put in the query string, for routing messages back. */
function viewIdOf(src: string): string {
  try {
    return new URL(src).searchParams.get("view") ?? "";
  } catch {
    return "";
  }
}

export function guardWebviews(webContents: WebContents): void {
  webContents.on("will-attach-webview", (event, preferences: WebPreferences, params) => {
    const decision = decideAttach(params.src, enabledIds(), preloadPath());

    if (!decision.ok) {
      event.preventDefault();
      console.warn("[extension] refused a webview:", decision.reason);
      return;
    }

    for (const attribute of STRIPPED_ATTRIBUTES) {
      delete (params as unknown as Record<string, unknown>)[attribute];
    }

    // Assigned onto the object Electron handed over rather than replaced:
    // returning a new object does nothing, and any key left behind from the
    // tag is a key the guest keeps.
    Object.assign(preferences, decision.preferences);
    (params as unknown as Record<string, unknown>).partition = decision.preferences.partition;

    // The last moment before the guest navigates, and the first at which the
    // partition is known. A custom protocol is registered per session, and a
    // guest in `persist:ext:<id>` is in a different session from the default
    // one, so without this its own pages simply never load.
    installExtensionProtocolOn(
      session.fromPartition(decision.preferences.partition),
      decision.preferences.partition,
    );
  });

  webContents.on("did-attach-webview", (_event, guest) => {
    // `guest.getURL()` is **empty here**. `did-attach-webview` fires before the
    // guest navigates to its `src`, so an extension id read from the URL at
    // this moment is the empty string, and a navigation guard built on it
    // blocks the panel's own first load. That is not hypothetical: it is what
    // this code did until the fixture extension showed a blank rectangle with
    // nothing in any log to explain it.
    //
    // So the guest is bound to an extension by the first page it actually
    // loads, and only to one.
    let boundExtId: string | null = null;

    const hostOf = (url: string): string | null => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === EXTENSION_SCHEME + ":" ? parsed.hostname : null;
      } catch {
        return null;
      }
    };

    guest.on("will-navigate", (navigationEvent, url) => {
      const host = hostOf(url);
      // Anything that is not one of our own pages, or is a different
      // extension's page than the one this guest already showed. A panel
      // navigating itself elsewhere would keep our preload and its partition
      // while displaying somebody else's document.
      if (host == null || !enabledIds().includes(host) || (boundExtId != null && host !== boundExtId)) {
        navigationEvent.preventDefault();
        console.warn("[extension] refused a navigation to " + url);
      }
    });

    guest.on("did-navigate", (_navigateEvent, url) => {
      const host = hostOf(url);
      if (host == null) {
        return;
      }
      if (boundExtId == null) {
        boundExtId = host;
        const partition = "persist:ext:" + host;
        const guestSession = session.fromPartition(partition);
        // Denied outright rather than prompted. A panel is a panel; there is
        // no arrangement in which it should be asking for the camera.
        guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        guestSession.setPermissionCheckHandler(() => false);
      }
      // Re-registered on every navigation, because the view id lives in the
      // query string and a panel may move between its own pages.
      onAttached?.(guest, host, viewIdOf(url));
    });

    guest.setWindowOpenHandler(() => ({ action: "deny" }));

    // A panel that fails to load is a blank rectangle with nothing anywhere to
    // say why. This is the only place the reason exists.
    guest.on("did-fail-load", (_failEvent, errorCode, errorDescription, validatedURL) => {
      console.warn(
        "[extension] could not load " + validatedURL + ": " + errorDescription + " (" + errorCode + ")",
      );
    });
    guest.on("preload-error", (_preloadEvent, failedPath, error) => {
      console.warn("[extension] preload failed at " + failedPath + ": " + String(error));
    });
  });
}

/**
 * Nothing else in this app embeds a guest, so nothing else may.
 *
 * `guardWebviews` covers the editor window, which is the only one with
 * `webviewTag` enabled. This is the belt for the braces: a window added later
 * that turns the tag on inherits a refusal rather than an open door.
 */
export function denyWebviewsElsewhere(allowed: () => WebContents | null): void {
  app.on("web-contents-created", (_event, contents) => {
    if (contents === allowed()) {
      return;
    }
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });
}
