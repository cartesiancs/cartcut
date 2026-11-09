import type { LocationEnv } from "./mediaUrl";

/**
 * Which build the page is: the desktop app, the public browser build
 * ("demo"), or a self-hosted copy ("web") with `electron/server/` behind it.
 *
 * Every `*.pages.dev` address is the public build too. Those are Cloudflare
 * Pages deployments of the same static site (the project's own name, and each
 * preview's `<hash>.` or `<branch>.` prefix on it), and a static host has no
 * `/api` routes: as "web", a linked template's thumbnail and fonts went to
 * `/api/file?path=...` and came back as index.html.
 *
 * Takes the location as an argument so the rule can be tested without a
 * `window`; `getLocationEnv` reads the real one.
 */
export function locationEnvOf(location: {
  protocol: string;
  hostname: string;
}): LocationEnv {
  const host = location.hostname.toLowerCase();
  if (
    host === "cartcut.cartesiancs.com" ||
    host === "pages.dev" ||
    host.endsWith(".pages.dev")
  ) {
    return "demo";
  }

  if (["http:", "https:"].includes(location.protocol)) {
    return "web";
  }
  return "electron";
}

export function getLocationEnv(): LocationEnv {
  return locationEnvOf(window.location);
}

/**
 * Whether this is a browser build (demo or self-hosted), safely: `false` where
 * there is no `window` at all, so a module a node suite imports can ask.
 */
export function isBrowserBuild(): boolean {
  return typeof window !== "undefined" && window.location != null && getLocationEnv() !== "electron";
}
