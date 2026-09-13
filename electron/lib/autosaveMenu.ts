/**
 * The File → Auto Save submenu, as data.
 *
 * A **type-only** Electron import, the `recordTrayMenu.ts` arrangement, so
 * this whole module runs under vitest — the labels, the ordering, the empty
 * state and the rebuild gate are the parts with invariants and the parts a
 * mistake in is silent.
 *
 * ## Always two levels
 *
 * ```
 * File ▸ Auto Save ▸ Film.ngt               ▸ Today 14:25:30
 *                                             Today 14:24:12
 *                    Untitled (13 Sep 09:12) ▸ 13 Sep 09:41:02
 * ```
 *
 * Even for a single ring. A flat list of bare times with no project name is
 * Premiere's arrangement and is the single most confusing thing about its
 * recovery: you cannot tell which project a time belongs to. Keeping it
 * uniform also means the shape the suite drives is the shape that ships.
 *
 * ## The empty state is a disabled row, never an empty flyout
 *
 * `recordTrayMenu.ts` states the rule and this reuses it as a rule rather than
 * copying the code — its leaf carries one opaque `id: string`, and a pick here
 * needs `(key, file)`. Encoding both into `"autosave:key:file"` would add a
 * stringly-typed parse as a new way to fail, so twenty lines are duplicated
 * instead.
 *
 * ## The timezone is a parameter
 *
 * The same rule `assetPaths.ts` states for `PathFlavour` and
 * `utils/platform.ts` for `isMac`, for the same reason: the host's answer is
 * the wrong one half the time, and both branches have to be coverable on one
 * CI machine.
 */

import type { MenuItemConstructorOptions } from "electron";

export type AutosaveMenuEntry = {
  /** Absolute path of the `.ngt`. */
  file: string;
  writtenAtMs: number;
};

export type AutosaveMenuRing = {
  key: string;
  label: string;
  entries: AutosaveMenuEntry[];
};

const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Local calendar day of an instant, given an offset in minutes east of UTC. */
function dayNumber(atMs: number, tzOffsetMinutes: number): number {
  return Math.floor((atMs + tzOffsetMinutes * MINUTE) / DAY);
}

function localParts(
  atMs: number,
  tzOffsetMinutes: number,
): { hour: number; minute: number; second: number; day: number; month: number } {
  const shifted = new Date(atMs + tzOffsetMinutes * MINUTE);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth(),
  };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * What one recovery point is called.
 *
 * Seconds are included deliberately: at a five-second cadence two entries a
 * minute apart is common and two in the same minute is possible, and a
 * recovery list whose rows cannot be told apart is worse than no list.
 */
export function entryLabel(
  atMs: number,
  nowMs: number,
  tzOffsetMinutes: number,
): string {
  const today = dayNumber(nowMs, tzOffsetMinutes);
  const then = dayNumber(atMs, tzOffsetMinutes);
  const { hour, minute, second, day, month } = localParts(atMs, tzOffsetMinutes);
  const clock = `${pad(hour)}:${pad(minute)}:${pad(second)}`;

  if (then === today) {
    return `Today ${clock}`;
  }
  if (then === today - 1) {
    return `Yesterday ${clock}`;
  }
  return `${day} ${MONTHS[month]} ${clock}`;
}

/**
 * The Auto Save row, with its submenu.
 *
 * `onPick` receives `(key, file)` unaltered — the key names the ring the entry
 * came from and the file is what recovery reads. Neither is parsed out of a
 * label or an id.
 */
export function autosaveSubmenu(
  rings: AutosaveMenuRing[],
  onPick: (key: string, file: string) => void,
  nowMs: number,
  tzOffsetMinutes: number,
): MenuItemConstructorOptions {
  // A ring with no entries is a bug rather than a state, and a row that
  // recovers nothing is worse than no row.
  const usable = rings.filter((ring) => ring.entries.length > 0);

  if (usable.length === 0) {
    return {
      label: "Auto Save",
      enabled: false,
      toolTip:
        "No recovery points. Auto Save keeps a copy of unsaved work here; " +
        "an empty list means everything is saved.",
    };
  }

  // Sorted defensively rather than trusting the caller: the order *is* the
  // information in a recovery list, and the newest is what someone reaches
  // for first.
  const byRecency = [...usable].sort(
    (a, b) => newestOf(b) - newestOf(a),
  );

  return {
    label: "Auto Save",
    submenu: byRecency.map((ring) => ({
      label: ring.label,
      submenu: [...ring.entries]
        .sort((a, b) => b.writtenAtMs - a.writtenAtMs)
        .map((entry) => ({
          label: entryLabel(entry.writtenAtMs, nowMs, tzOffsetMinutes),
          // No accelerator, ever. A recovery replaces the whole timeline and
          // must never be one keystroke away.
          click: () => onPick(ring.key, entry.file),
        })),
    })),
  };
}

function newestOf(ring: AutosaveMenuRing): number {
  return ring.entries.reduce(
    (newest, entry) => Math.max(newest, entry.writtenAtMs),
    Number.NEGATIVE_INFINITY,
  );
}

/**
 * Whether to rebuild the application menu for a new list.
 *
 * Two reasons to decline, and the second is the interesting one:
 *
 * - the model is unchanged, so a rebuild would achieve nothing;
 * - **a menu is open.** `Menu.setApplicationMenu` closes an open menu on
 *   macOS, so an autosave landing while someone is reading the File menu
 *   would snap it shut under them. The caller remembers the pending rebuild
 *   and flushes it on close.
 */
export function shouldRebuild(
  current: AutosaveMenuRing[],
  next: AutosaveMenuRing[],
  menuOpen: boolean,
): boolean {
  if (menuOpen) {
    return false;
  }
  return signatureOf(current) !== signatureOf(next);
}

/** Everything the submenu draws, as one comparable string. */
export function signatureOf(rings: AutosaveMenuRing[]): string {
  return rings
    .map(
      (ring) =>
        `${ring.key}|${ring.label}|${ring.entries
          .map((entry) => `${entry.writtenAtMs}:${entry.file}`)
          .join(",")}`,
    )
    .join(";");
}
