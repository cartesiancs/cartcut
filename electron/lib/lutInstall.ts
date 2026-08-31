/**
 * Turning an imported LUT into a preset folder, minus the filesystem.
 *
 * Separated from `preset.ts` for the reason `presetScan.ts` is: `preset.ts`
 * imports `electron` and `electron-is-dev` and cannot be loaded by a test,
 * while the decisions worth testing here are pure. And they are worth testing,
 * because one of them is a **security boundary**: the folder name is derived
 * from a filename that arrived with a file someone downloaded, and a folder
 * name is a path.
 *
 * `slugify` is aggressive on purpose. `..`, a path separator, a colon on
 * Windows, a leading dot, a NUL — each turns a copy into a write somewhere it
 * was not meant to go. Reducing to `[a-z0-9-]` makes all of them
 * unrepresentable rather than checked for, which is the same rule
 * `presetValidate.ts#isSafeRelativePath` follows from the other direction.
 */

/** Extensions an imported LUT keeps. Anything else is stored as `.cube`. */
export const LUT_INSTALL_EXTENSIONS = ["cube", "3dl", "png"];

/** Longest folder-name slug. Long enough for any real LUT name. */
export const MAX_SLUG_LENGTH = 64;

/**
 * A folder name from a LUT's display name.
 *
 * Returns `""` when nothing usable survives, which the caller must treat as a
 * refusal — an empty slug would otherwise install into the presets root itself.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** The extension the copied file gets. Unknown ones become `.cube`. */
export function installExtension(extension: string): string {
  const lowered = extension.toLowerCase();
  return LUT_INSTALL_EXTENSIONS.includes(lowered) ? lowered : "cube";
}

export type LutInstallPlan = {
  /** Folder name under `userData/presets`. */
  folder: string;
  /** The preset id the manifest will carry. */
  id: string;
  /** The filename the LUT is copied to, and what `render.source` names. */
  source: string;
  /** The manifest, ready to write. */
  manifest: string;
};

/**
 * Everything `installLut` needs to write, decided.
 *
 * `category: "utility"` rather than a guess from the name: the panel puts user
 * presets in their own "My LUTs" section, so the category is never the heading
 * an imported LUT appears under, and inferring one from a filename would be
 * wrong often and invisibly.
 *
 * Throws when the name yields no usable slug. That is the caller's cue to
 * report it, and it is why `slugify` returning `""` is not silently tolerated.
 */
export function planLutInstall(
  name: string,
  extension: string,
): LutInstallPlan {
  const slug = slugify(name);
  if (slug === "") {
    throw new Error("that LUT's name has no usable characters in it");
  }
  const source = `lut.${installExtension(extension)}`;
  const id = `com.user.lut.${slug}`;
  return {
    folder: `lut-${slug}`,
    id,
    source,
    manifest: `${JSON.stringify(
      {
        schema: 1,
        id,
        kind: "lut",
        name,
        category: "utility",
        author: "Imported",
        version: "1.0.0",
        render: { type: "lut", source },
      },
      null,
      2,
    )}\n`,
  };
}
