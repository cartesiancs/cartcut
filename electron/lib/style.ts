/**
 * Where style profiles live, and how they are read.
 *
 * The same builtin-then-user shape `lib/preset.ts` uses, and for the same
 * reason: a profile is data a user is meant to be able to write. Drop a JSON
 * file in the user directory and the agent will use it.
 *
 * Its own root rather than `assets/presets/`, because
 * `features/fx/presetValidate.ts` rejects any manifest whose `kind` is not
 * `effect` or `transition` — a style profile in that tree would show up in the
 * user's preset browser as a broken preset.
 *
 * A broken profile is skipped and reported, never thrown: one bad file a user
 * is mid-way through writing must not take the whole library with it.
 */

import path from "path";
import fs from "fs";
import * as fsp from "fs/promises";
import isDev from "electron-is-dev";
import { app } from "electron";
import { validateStyle, type StyleProfile } from "../mcp/analysis/style";

/**
 * The shipped profiles.
 *
 * `getAppPath()` rather than the process's working directory, so this is right
 * however the app was launched — the mistake `lib/ffmpeg.ts` made and paid for.
 * Computed per call because `app` is not reliably populated at module load.
 */
function builtinStylePath(): string {
  const root = isDev === true ? app.getAppPath() : process.resourcesPath;
  return path.join(root, "assets", "styles");
}

/** Where a user's own profiles go. Created on demand, never assumed. */
export function userStylePath(): string {
  return path.join(app.getPath("userData"), "styles");
}

export type StyleLoad = {
  profiles: StyleProfile[];
  /** One entry per file that could not be used, so a typo is visible. */
  broken: Array<{ file: string; errors: string[] }>;
};

async function readRoot(dir: string): Promise<StyleLoad> {
  const profiles: StyleProfile[] = [];
  const broken: StyleLoad["broken"] = [];

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    // No such directory is the ordinary case for the user root.
    return { profiles, broken };
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(dir, entry);
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      const result = validateStyle(raw);
      if (result.ok && result.profile != null) {
        profiles.push(result.profile);
      } else {
        broken.push({ file: entry, errors: result.errors });
      }
    } catch (error) {
      broken.push({
        file: entry,
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return { profiles, broken };
}

/**
 * Every profile, shipped ones first.
 *
 * First wins on a duplicate id, so a shipped profile cannot be shadowed by
 * accident — a user replacing one does it by giving theirs a different id and a
 * `fit` that matches, which is a decision rather than a collision.
 */
export async function loadStyles(): Promise<StyleLoad> {
  const builtin = await readRoot(builtinStylePath());
  const user = await readRoot(userStylePath());

  const seen = new Set(builtin.profiles.map((p) => p.id));
  const profiles = [
    ...builtin.profiles,
    ...user.profiles.filter((p) => !seen.has(p.id)),
  ];

  return {
    profiles,
    broken: [
      ...builtin.broken,
      ...user.broken.map((b) => ({ ...b, file: `user/${b.file}` })),
    ],
  };
}

/** The folder to point a user at when they ask where to put one. */
export async function ensureUserStyleDir(): Promise<string> {
  const dir = userStylePath();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Synchronous existence check, for a startup log rather than a tool call. */
export function builtinStylesExist(): boolean {
  return fs.existsSync(builtinStylePath());
}
