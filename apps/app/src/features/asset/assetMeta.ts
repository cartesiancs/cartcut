/**
 * The value a list row shows beside its name: whatever the panel is sorted by,
 * which is Finder's list view with one column. Sorting by size or date is
 * opaque without it, since nothing else says why a row is where it is.
 *
 * Pure. The words come in from the component's `LocaleController`, because
 * there is no synchronous app-wide language to read here, and the clock and
 * the time zone come in as arguments so every case is a node assertion.
 *
 * Dates are formatted by hand rather than through `toLocaleString`, whose
 * output moves with the ICU version (ICU 72 put a U+202F before "AM") and
 * which nothing here could pin.
 */

import mime from "../../functions/mime";
import type { AssetSortKey } from "./assetSort";
import { extensionOf } from "./assetSort";
import type { AssetEntry } from "./directoryEntries";

export type AssetMetaWords = {
  today: string;
  yesterday: string;
  folder: string;
  video: string;
  image: string;
  audio: string;
  file: string;
};

/** What Finder writes for a value it does not have, a folder's size above all. */
export const NO_VALUE = "--";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Bytes as Finder writes them: base 10, so a 2,100,000,000-byte file is
 * "2.1 GB" as it is in Finder and on the drive's box. One decimal under 100 and
 * none from 100 up, the rule `mediaInfoView.ts#bitrateLabel` uses for bitrates.
 */
export function formatAssetSize(bytes?: number): string {
  if (typeof bytes != "number" || !Number.isFinite(bytes) || bytes < 0) {
    return NO_VALUE;
  }

  let unit = 0;
  let value = bytes;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }

  if (unit == 0) {
    return `${Math.round(value)} B`;
  }

  let shown = value >= 100 ? Math.round(value) : roundTo1(value);
  // 999,500 bytes rounds to "1000 KB", which is a megabyte written the long
  // way. Carry into the next unit instead.
  if (shown >= 1000 && unit < UNITS.length - 1) {
    unit++;
    shown = roundTo1(shown / 1000);
  }
  return `${shown} ${UNITS[unit]}`;
}

/** One decimal with a trailing zero dropped: 1.0 is "1", 1.25 is "1.3". */
function roundTo1(value: number): number {
  return Number(value.toFixed(1));
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Minutes east of UTC at the instant `ms`, which is what `getTimezoneOffset` answers with the sign flipped. */
export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/**
 * "Today 14:03", "Yesterday 09:12", or "2026-09-13" for anything older or in
 * the future. A 24-hour clock, and an ISO date because it reads the same in
 * both languages and cannot be mistaken for day-month.
 *
 * The offset is asked for at each instant rather than once, so a file written
 * the day before a daylight-saving change lands on the right calendar day.
 */
export function formatAssetDate(
  ms: number | undefined,
  nowMs: number,
  words: Pick<AssetMetaWords, "today" | "yesterday">,
  offsetMinutesAt: (ms: number) => number = localOffsetMinutes,
): string {
  if (typeof ms != "number" || !Number.isFinite(ms)) {
    return NO_VALUE;
  }

  const thenLocal = ms + offsetMinutesAt(ms) * MINUTE;
  const nowLocal = nowMs + offsetMinutesAt(nowMs) * MINUTE;
  const thenDay = Math.floor(thenLocal / DAY);
  const today = Math.floor(nowLocal / DAY);

  const shifted = new Date(thenLocal);
  const clock = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;

  if (thenDay == today) {
    return `${words.today} ${clock}`;
  }
  if (thenDay == today - 1) {
    return `${words.yesterday} ${clock}`;
  }
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}`;
}

/**
 * "MP4 Video", "PNG Image", "SRT File", "Folder": the extension and what the
 * panel treats the file as, which is how Finder's Kind column reads. A file
 * with no extension is just "File".
 */
export function kindLabel(entry: AssetEntry, words: AssetMetaWords): string {
  if (entry.isDirectory) {
    return words.folder;
  }

  const type = mime.lookup(entry.name).type;
  const word =
    type == "video"
      ? words.video
      : type == "image" || type == "gif"
        ? words.image
        : type == "audio"
          ? words.audio
          : words.file;

  const extension = extensionOf(entry.name);
  return extension == "" ? word : `${extension.toUpperCase()} ${word}`;
}

/** The row's value for `key`, or "" for Name, where the name already is the value. */
export function assetMetaFor(
  entry: AssetEntry,
  key: AssetSortKey,
  nowMs: number,
  words: AssetMetaWords,
  offsetMinutesAt: (ms: number) => number = localOffsetMinutes,
): string {
  switch (key) {
    case "name":
      return "";
    case "kind":
      return kindLabel(entry, words);
    case "modified":
      return formatAssetDate(entry.modifiedMs, nowMs, words, offsetMinutesAt);
    case "created":
      return formatAssetDate(entry.createdMs, nowMs, words, offsetMinutesAt);
    case "size":
      return formatAssetSize(entry.size);
  }
}
