/**
 * Finding extensions, without deciding anything about them.
 *
 * Pure over an injected filesystem for the reason `presetScan.ts` is split
 * from `preset.ts`: a module that imports `electron` cannot be loaded by
 * vitest, and the rules worth pinning are all here. It reads exactly one file
 * per folder, `package.json`, and never opens the entry point: loading code is
 * the extension host's job, in a process where a throw costs nothing.
 *
 * Two roots, in one list, because a developer working on an extension has the
 * installed copy and the unpacked one at the same time and needs to know which
 * one the app is running.
 */

import path from "path";

import { validateManifest, type ExtensionManifest } from "./manifest";

export type FsPorts = {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  isDirectory(target: string): Promise<boolean>;
};

export type Discovered = {
  id: string;
  dir: string;
  origin: "installed" | "unpacked";
  manifest: ExtensionManifest | null;
  /** Why it will not load. Shown in the Extensions panel, never thrown. */
  errors: string[];
};

/**
 * Names that are never an extension.
 *
 * `__MACOSX` is what an archive made on a Mac carries beside the real folder,
 * and a leading dot is every tool's scratch directory. Both would otherwise be
 * reported as extensions with an unreadable manifest, once per launch.
 */
function isCandidateName(name: string): boolean {
  return !name.startsWith(".") && name !== "__MACOSX" && name !== "node_modules";
}

async function readOne(
  dir: string,
  origin: Discovered["origin"],
  expectedId: string | null,
  ports: FsPorts,
): Promise<Discovered> {
  const id = expectedId ?? path.basename(dir);
  try {
    const text = await ports.readFile(path.join(dir, "package.json"));
    const json = JSON.parse(text) as unknown;
    // An unpacked folder is named by the developer, not by us, so its name
    // carries no claim about the id and the manifest's own id wins. An
    // installed folder is named by `install.ts` from the manifest it
    // validated, so a mismatch there means the directory was tampered with.
    const result = validateManifest(json, origin === "installed" ? id : "");
    if (!result.ok) {
      return { id, dir, origin, manifest: null, errors: result.errors };
    }
    return { id: result.manifest.id, dir, origin, manifest: result.manifest, errors: [] };
  } catch (error) {
    return {
      id,
      dir,
      origin,
      manifest: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Everything installed, plus everything loaded unpacked.
 *
 * An unpacked folder wins an id clash, and the loser is reported rather than
 * dropped silently: that is the one thing a developer needs to see when the
 * code they are editing is not the code that is running. `presetRegistry.ts`
 * makes the same choice in the other direction, and for the same reason.
 */
export async function scanExtensionRoots(
  installedRoot: string,
  unpackedPaths: readonly string[],
  ports: FsPorts,
): Promise<Discovered[]> {
  const found: Discovered[] = [];

  let names: string[] = [];
  try {
    names = await ports.readdir(installedRoot);
  } catch {
    // A missing root is an empty list, not an error. It does not exist until
    // the first install, and every launch before that would otherwise log.
    names = [];
  }

  for (const name of names.filter(isCandidateName).sort()) {
    const dir = path.join(installedRoot, name);
    if (!(await ports.isDirectory(dir))) {
      continue;
    }
    found.push(await readOne(dir, "installed", name, ports));
  }

  for (const dir of unpackedPaths) {
    if (!(await ports.isDirectory(dir))) {
      found.push({
        id: path.basename(dir),
        dir,
        origin: "unpacked",
        manifest: null,
        errors: ["the folder is gone: " + dir],
      });
      continue;
    }
    found.push(await readOne(dir, "unpacked", null, ports));
  }

  const byId = new Map<string, Discovered>();
  const shadowed: Discovered[] = [];
  for (const entry of found) {
    const existing = byId.get(entry.id);
    if (existing == null) {
      byId.set(entry.id, entry);
      continue;
    }
    if (existing.origin === "installed" && entry.origin === "unpacked") {
      byId.set(entry.id, entry);
      shadowed.push({ ...existing, errors: [...existing.errors, "shadowed by the unpacked copy at " + entry.dir] });
      continue;
    }
    shadowed.push({ ...entry, errors: [...entry.errors, "another copy of `" + entry.id + "` is already loaded"] });
  }

  return [...byId.values(), ...shadowed.map((entry) => ({ ...entry, manifest: null }))];
}
