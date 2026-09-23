/**
 * What a `<webview>` is allowed to be, decided before it attaches.
 *
 * `webviewTag: true` has been on for the editor window since the first
 * extension prototype, with no `will-attach-webview` anywhere. That is the
 * hole this closes: without a guard, anything that can put markup on the page
 * can attach a guest with its own preload and `nodeIntegration`, and a webview
 * inherits nothing from the embedder that would stop it.
 *
 * Pure, so the policy can be asserted rather than trusted. The wiring is
 * `webviewGuard.ts`.
 */

import { EXTENSION_SCHEME } from "./schemeResolve";
import { EXTENSION_ID_PATTERN } from "./protocol";

/** The parts of `WebPreferences` this decides, as plain data. */
export type ForcedPreferences = {
  nodeIntegration: false;
  nodeIntegrationInSubFrames: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  allowRunningInsecureContent: false;
  webviewTag: false;
  preload: string;
  partition: string;
};

export type AttachDecision =
  | { ok: true; extId: string; preferences: ForcedPreferences }
  | { ok: false; reason: string };

/**
 * Attributes an embedder may not set, whatever it asked for.
 *
 * Deleted rather than overridden, because `will-attach-webview` hands over the
 * tag's own attributes as well as the preferences, and a leftover
 * `nodeintegration` attribute is read again later.
 */
export const STRIPPED_ATTRIBUTES = [
  "preload",
  "nodeintegration",
  "nodeintegrationinsubframes",
  "webpreferences",
  "enableblinkfeatures",
  "disableblinkfeatures",
  "allowpopups",
  "disablewebsecurity",
] as const;

/**
 * Whether this guest may attach, and with what.
 *
 * The `src` check is the load-bearing half. A guest is admitted only when it
 * is serving one loaded extension's own files over our scheme, so there is no
 * arrangement in which a remote page ends up inside the editor window with a
 * preload of ours attached to it.
 */
export function decideAttach(
  src: unknown,
  enabledIds: readonly string[],
  preloadPath: string,
): AttachDecision {
  if (typeof src !== "string" || src === "") {
    return { ok: false, reason: "a webview with no src" };
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return { ok: false, reason: "a webview whose src is not a URL: " + src };
  }

  if (url.protocol !== EXTENSION_SCHEME + ":") {
    return {
      ok: false,
      reason: "only " + EXTENSION_SCHEME + ":// pages may be embedded, not " + url.protocol + "//",
    };
  }

  const extId = url.hostname;
  if (!EXTENSION_ID_PATTERN.test(extId) || !enabledIds.includes(extId)) {
    return { ok: false, reason: "`" + extId + "` is not a loaded extension" };
  }

  return {
    ok: true,
    extId,
    preferences: {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // A guest that could attach its own guest would be a way around this
      // whole decision, one level down.
      webviewTag: false,
      preload: preloadPath,
      // One partition per extension, so two extensions cannot read each
      // other's localStorage, cookies or cache. `persist:` because a panel
      // that forgot its state on every open would be useless.
      partition: "persist:ext:" + extId,
    },
  };
}
