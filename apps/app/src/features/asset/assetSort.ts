/**
 * The asset panel's Sort By: which order a folder's entries are shown in.
 *
 * Pure, and the only place the order is decided. `<asset-browser>` calls
 * `sortAssetEntries` whenever the listing or the choice changes, so a new sort
 * never re-reads the disk, and `<asset-list>` draws whatever it is handed.
 *
 * Finder's rules, where they apply to a folder read with `stat`:
 *
 * - Folders stay on top in every key and both directions, which is what the
 *   panel always did and what keeps navigation where the eye expects it.
 * - A key starts in its natural direction, Finder's column-header default:
 *   names A to Z, dates newest first, sizes largest first.
 * - An entry with no value for the key (a folder's size, a date the platform
 *   cannot report, the web demo's listing) goes last in both directions. A
 *   missing size is not a small size.
 * - The direction reverses the key and nothing else. Ties fall back to the
 *   name, A to Z, so two clips rendered in the same second do not swap places
 *   when the dates are flipped.
 *
 * Finder's Date Added, Date Last Opened and Tags are Spotlight metadata, not
 * anything `fs.stat` reports, so they are not offered.
 */

import mime from "../../functions/mime";
import type { AssetEntry } from "./directoryEntries";

export type AssetSortKey = "name" | "kind" | "modified" | "created" | "size";
export type SortDirection = "asc" | "desc";
export type AssetSort = { key: AssetSortKey; direction: SortDirection };

/** Menu order, which is Finder's. */
export const ASSET_SORT_KEYS: readonly AssetSortKey[] = [
  "name",
  "kind",
  "modified",
  "created",
  "size",
];

export const NATURAL_DIRECTION: Readonly<Record<AssetSortKey, SortDirection>> = {
  name: "asc",
  kind: "asc",
  modified: "desc",
  created: "desc",
  size: "desc",
};

export const DEFAULT_ASSET_SORT: AssetSort = Object.freeze({
  key: "name",
  direction: "asc",
});

/** Locale keys, read through `LocaleController.t`. */
export const SORT_KEY_LABEL: Readonly<Record<AssetSortKey, string>> = {
  name: "setting.sort_name",
  kind: "setting.sort_kind",
  modified: "setting.sort_modified",
  created: "setting.sort_created",
  size: "setting.sort_size",
};

export type DirectionRow = { direction: SortDirection; labelKey: string };

/**
 * Each key names its two directions in its own terms. "Ascending" says nothing
 * about whether the newest render is at the top; "Newest First" does.
 */
const DIRECTION_LABEL: Readonly<
  Record<AssetSortKey, Record<SortDirection, string>>
> = {
  name: { asc: "setting.sort_a_to_z", desc: "setting.sort_z_to_a" },
  kind: { asc: "setting.sort_ascending", desc: "setting.sort_descending" },
  modified: {
    desc: "setting.sort_newest_first",
    asc: "setting.sort_oldest_first",
  },
  created: {
    desc: "setting.sort_newest_first",
    asc: "setting.sort_oldest_first",
  },
  size: {
    desc: "setting.sort_largest_first",
    asc: "setting.sort_smallest_first",
  },
};

/** The two direction rows for `key`, its natural direction first. */
export function directionRows(
  key: AssetSortKey,
): readonly [DirectionRow, DirectionRow] {
  const natural = NATURAL_DIRECTION[key];
  const other: SortDirection = natural == "asc" ? "desc" : "asc";
  return [
    { direction: natural, labelKey: DIRECTION_LABEL[key][natural] },
    { direction: other, labelKey: DIRECTION_LABEL[key][other] },
  ];
}

// ------------------------------------------------------------------ choosing

/**
 * Choose a key. A new key starts in its natural direction; the key already
 * chosen returns `current` itself, so the store sees no change and wakes no
 * subscriber.
 *
 * Re-choosing the checked key does not flip the direction, as clicking a
 * Finder column header would: in a menu the key is a checked radio row, and a
 * checked row that quietly toggles something else reads as broken. The two
 * direction rows sit directly under it.
 */
export function withSortKey(current: AssetSort, key: AssetSortKey): AssetSort {
  if (current.key == key) {
    return current;
  }
  return { key, direction: NATURAL_DIRECTION[key] };
}

/** Choose a direction, returning `current` itself when it is already that. */
export function withSortDirection(
  current: AssetSort,
  direction: SortDirection,
): AssetSort {
  if (current.direction == direction) {
    return current;
  }
  return { key: current.key, direction };
}

function isSortKey(value: unknown): value is AssetSortKey {
  return (
    typeof value == "string" &&
    (ASSET_SORT_KEYS as readonly string[]).includes(value)
  );
}

/**
 * A sort from anything, for the value read back from storage. An unknown key
 * is the default; a known key with a bad direction keeps the key and takes its
 * natural direction.
 */
export function coerceAssetSort(raw: unknown): AssetSort {
  if (raw == null || typeof raw != "object") {
    return DEFAULT_ASSET_SORT;
  }

  const { key, direction } = raw as { key?: unknown; direction?: unknown };
  if (!isSortKey(key)) {
    return DEFAULT_ASSET_SORT;
  }
  if (direction === "asc" || direction === "desc") {
    return { key, direction };
  }
  return { key, direction: NATURAL_DIRECTION[key] };
}

// ------------------------------------------------------------------ ordering

/**
 * Built once. `localeCompare` with options builds an equivalent collator on
 * every call, which in a sort is n log n of them. `numeric` puts clip2.mp4
 * before clip10.mp4; `base` keeps casing from splitting an alphabetical run.
 */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** The extension, lowercased, or "" for none. A leading dot is a hidden file's name, not an extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Kind order for an editor: what goes on a timeline first, in the order it is
 * most often reached for. A GIF is a picture here, as `assetList` draws it.
 */
const KIND_RANK: Readonly<Record<string, number>> = {
  video: 1,
  image: 2,
  gif: 2,
  audio: 3,
};
const OTHER_RANK = 4;

export function kindRank(entry: AssetEntry): number {
  if (entry.isDirectory) {
    return 0;
  }
  return KIND_RANK[mime.lookup(entry.name).type] ?? OTHER_RANK;
}

/** An entry with its key computed once, rather than once per comparison. */
type Keyed = {
  entry: AssetEntry;
  value: number | undefined;
  extension: string;
};

function valueOf(entry: AssetEntry, key: AssetSortKey): number | undefined {
  switch (key) {
    case "kind":
      return kindRank(entry);
    case "modified":
      return entry.modifiedMs;
    case "created":
      return entry.createdMs;
    case "size":
      return entry.size;
    case "name":
      return undefined;
  }
}

function compareNames(a: string, b: string): number {
  const natural = collator.compare(a, b);
  if (natural != 0) {
    return natural;
  }
  // "A.mp4" and "a.mp4" are equal to the collator and can both exist on a
  // case-sensitive disk. Without a last resort their order would be whatever
  // `readdir` happened to answer.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `entries` in the order `sort` asks for. Never mutates its input.
 */
export function sortAssetEntries(
  entries: readonly AssetEntry[],
  sort: AssetSort,
): AssetEntry[] {
  const sign = sort.direction == "asc" ? 1 : -1;
  const keyed: Keyed[] = entries.map((entry) => ({
    entry,
    value: valueOf(entry, sort.key),
    extension: sort.key == "kind" ? extensionOf(entry.name) : "",
  }));

  keyed.sort((a, b) => {
    if (a.entry.isDirectory != b.entry.isDirectory) {
      return a.entry.isDirectory ? -1 : 1;
    }

    if (sort.key == "name") {
      return sign * compareNames(a.entry.name, b.entry.name);
    }

    // Missing last, in both directions: outside the sign on purpose.
    if (a.value == null || b.value == null) {
      if (a.value != b.value) {
        return a.value == null ? 1 : -1;
      }
    } else if (a.value != b.value) {
      return sign * (a.value - b.value);
    }

    if (sort.key == "kind" && a.extension != b.extension) {
      return sign * collator.compare(a.extension, b.extension);
    }

    return compareNames(a.entry.name, b.entry.name);
  });

  return keyed.map((k) => k.entry);
}
