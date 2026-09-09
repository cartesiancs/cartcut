/**
 * What is inside a `.cttpl`, decided from the entry names alone.
 *
 * A `.cttpl` is a zip. The one thing that makes it a template rather than some
 * other zip is an entry called `template.ngt` **at its root** — a real `.ngt`,
 * openable on its own, holding the edit. Its media sits beside it at whatever
 * depth the author chose, named from inside the `.ngt` by the relative paths
 * `assetPaths.json` already records. That is the whole format, and it is why it
 * needs almost no new path code: installation extracts the archive and hands
 * the extracted `template.ngt` to `features/project/assetsFile.ts#relinkAssets`,
 * which resolves those relatives against the `.ngt`'s own folder exactly as it
 * does for a project someone was handed as a folder.
 *
 * This module reads **names, never bytes**, which is what keeps it pure and
 * node-testable and lets the whole rule be pinned without building a zip. The
 * caller has a `JSZip` and asks this what to do with it.
 *
 * Two of its jobs are a trust boundary rather than a convenience. Entry names
 * come from a file someone else wrote and are about to become paths on disk, so
 * `../`, an absolute name and a backslash are **refused outright** rather than
 * sanitised — the same choice `assetPaths.ts#resolveInside` makes, and for the
 * same reason: a sanitised path is a guess about what the writer meant, and the
 * guess is wrong exactly when it matters. Refusing the whole archive rather
 * than the entry is deliberate too. An archive containing one hostile name is
 * not an archive with a bad file in it; it is a hostile archive.
 */

/** The optional sidecar. Presentation only — the slot list is never in here. */
export type TemplateManifest = {
  name: string | null;
  author: string | null;
  thumbnail: string | null;
};

export type TemplateArchiveLayout =
  | {
      ok: true;
      /** The entry name, exactly as the archive spells it. */
      ngt: string;
      manifest: string | null;
      thumbnail: string | null;
      /** Everything else worth extracting, in the order the archive lists it. */
      assets: string[];
    }
  | { ok: false; reason: string };

const NGT_NAME = "template.ngt";
const MANIFEST_NAME = "template.json";
const THUMBNAIL_NAMES = ["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];

/**
 * Junk that is not content and must not be extracted.
 *
 * `__MACOSX` is Archive Utility's resource fork: one entry shadowing every real
 * one. Extracted blindly it doubles the install and scatters `._` files where
 * nothing looks for them. `.DS_Store` is the same idea one file at a time.
 */
function isNoise(name: string): boolean {
  if (name.startsWith("__MACOSX/")) {
    return true;
  }
  const last = name.slice(name.lastIndexOf("/") + 1);
  return last === ".DS_Store" || last === "";
}

/** A zip name with the `./` some writers prefix, removed for comparison only. */
function normalise(name: string): string {
  return name.startsWith("./") ? name.slice(2) : name;
}

/**
 * Whether this name is safe to turn into a path under the install directory.
 *
 * Refuses what `resolveInside` refuses, for the reasons its header gives: a
 * climb, an absolute path, a drive letter, a backslash and an embedded NUL.
 */
function isSafeEntryName(name: string): boolean {
  if (name === "" || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    return false;
  }
  return !name.split("/").some((seg) => seg === ".." || seg === ".");
}

export function readArchiveLayout(
  names: readonly string[],
): TemplateArchiveLayout {
  const real: { raw: string; key: string }[] = [];

  for (const raw of names) {
    if (typeof raw !== "string") {
      return { ok: false, reason: "The archive has an unreadable entry name." };
    }
    const key = normalise(raw);
    if (isNoise(key)) {
      continue;
    }
    if (!isSafeEntryName(key)) {
      return {
        ok: false,
        reason: `The archive contains an unsafe entry name: ${raw}`,
      };
    }
    real.push({ raw, key });
  }

  // Case-insensitively, because the tools that write zips are not consistent
  // about it and refusing `Template.ngt` would read as corruption. Two entries
  // claiming the name is ambiguous rather than lenient: either could be the
  // document, and opening the wrong half of an archive is worse than refusing.
  const candidates = real.filter(
    (entry) => entry.key.toLowerCase() === NGT_NAME,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "Not a template: the archive has no template.ngt at its root.",
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "Not a template: the archive has more than one template.ngt.",
    };
  }

  const ngt = candidates[0];
  const manifest =
    real.find((entry) => entry.key.toLowerCase() === MANIFEST_NAME) ?? null;
  const thumbnail =
    real.find((entry) => THUMBNAIL_NAMES.includes(entry.key.toLowerCase())) ??
    null;

  const claimed = new Set([ngt.raw, manifest?.raw, thumbnail?.raw]);

  return {
    ok: true,
    ngt: ngt.raw,
    manifest: manifest?.raw ?? null,
    thumbnail: thumbnail?.raw ?? null,
    assets: real
      .filter((entry) => !claimed.has(entry.raw))
      .map((entry) => entry.raw),
  };
}

/** Whether a manifest may point at this file, by the entry-name rules above. */
function safeRelative(value: unknown): string | null {
  return typeof value === "string" &&
    value !== "" &&
    isSafeEntryName(normalise(value))
    ? value
    : null;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * Read `template.json`, answering nulls for everything it cannot use.
 *
 * Never throws and never refuses the template: `template.ngt` is what makes an
 * archive a template, so an unusable manifest costs a display name and nothing
 * else. The caller falls back to the installed folder's own name.
 *
 * There is deliberately no slot list here. Slots are derived from the document
 * by `slots.ts#slotsOf`, so there is one source of truth and nothing to drift.
 */
export function parseTemplateManifest(raw: unknown): TemplateManifest {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { name: null, author: null, thumbnail: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    name: trimmed(record.name),
    author: trimmed(record.author),
    thumbnail: safeRelative(record.thumbnail),
  };
}
