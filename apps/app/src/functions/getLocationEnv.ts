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
