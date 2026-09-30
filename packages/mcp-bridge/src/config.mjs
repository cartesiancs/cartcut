/**
 * Where the bridge finds CartCut's MCP endpoint and the bearer token it wants.
 *
 * The app keeps its token in electron-store's plain `config.json` under
 * `userData`, whose folder is named after the app's package, `cartcut-app`, in
 * the packaged build and in a dev checkout alike. Reading it is what lets
 * `npx -y cartcut-mcp` connect with nothing configured. It grants nothing new:
 * any process running as this user can read that file already, and the token
 * exists to keep browser pages out, not the user's own programs.
 *
 * Path flavour is chosen from the `platform` argument instead of taken from
 * `node:path`, which only answers for the host, so every branch runs in a suite
 * on one machine.
 */

import path from "node:path";

export const DEFAULT_URL = "http://127.0.0.1:9826/mcp";

/** Electron's `userData` folder name for CartCut: `app.name`, the package name. */
export const APP_DIR = "cartcut-app";

/** Where Electron puts CartCut's `config.json` on `platform`. */
export function configPath({ platform, env, home }) {
  if (platform === "win32") {
    const appData = env.APPDATA || path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, APP_DIR, "config.json");
  }
  if (platform === "darwin") {
    return path.posix.join(
      home,
      "Library",
      "Application Support",
      APP_DIR,
      "config.json",
    );
  }
  const base = env.XDG_CONFIG_HOME || path.posix.join(home, ".config");
  return path.posix.join(base, APP_DIR, "config.json");
}

/**
 * A variable's value, or null when it is effectively unset.
 *
 * A client installing from a registry entry may pass an optional variable the
 * user never filled in as an empty string, or as its own unexpanded
 * `${CARTCUT_MCP_TOKEN}`. Taken literally, either would be sent as the token
 * and refused, when the token in the app's config would have worked.
 */
export function present(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || /^\$\{[^}]*\}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function resolveUrl(env) {
  return present(env.CARTCUT_MCP_URL) ?? DEFAULT_URL;
}

/**
 * The token, and where it came from so a refusal can say which one was wrong.
 *
 * `readFile` is `(path) => string` and may throw.
 */
export function resolveToken({ env, platform, home, readFile }) {
  const fromEnv = present(env.CARTCUT_MCP_TOKEN);
  if (fromEnv != null) {
    return { token: fromEnv, source: "CARTCUT_MCP_TOKEN" };
  }

  const file = configPath({ platform, env, home });
  let raw;
  try {
    raw = readFile(file);
  } catch {
    return { token: null, source: file, reason: "missing" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { token: null, source: file, reason: "unreadable" };
  }

  const token = present(parsed?.mcp_token);
  if (token == null) {
    return { token: null, source: file, reason: "absent" };
  }
  return { token, source: file };
}

/** What to tell the user when there is no token to send. */
export function noTokenMessage(result) {
  const cause =
    result.reason === "unreadable"
      ? `${result.source} is not valid JSON.`
      : `There is no CartCut token in ${result.source}.`;
  return [
    cause,
    "Open CartCut once so it creates one, or set CARTCUT_MCP_TOKEN to the token",
    "shown under the lightning icon at the bottom right of the CartCut window.",
  ].join(" ");
}
