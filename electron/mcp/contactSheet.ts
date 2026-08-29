/**
 * Where a contact sheet goes, and which instants it shows.
 *
 * The renderer draws it (`features/agent/commands/contactSheet.ts`) because
 * only the renderer can composite a frame; this side owns the two decisions
 * that are not about drawing — which times to sample, and where the file
 * lands — plus the reason the image comes back as a path rather than as pixels:
 * tool output is capped at 25,000 tokens, and a PNG is orders of magnitude past
 * that as base64. A path costs a dozen tokens and the agent can read the image.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

/** Most frames one sheet will draw. Mirrors the renderer's own cap. */
export const MAX_FRAMES = 16;

/**
 * How long the renderer gets to draw a sheet.
 *
 * Well past the bridge's 20s default: sixteen video seeks on a large file is
 * genuinely slow, and the failure mode of too short a budget here is a tool
 * error on work that was about to succeed.
 */
export const CONTACT_SHEET_TIMEOUT_MS = 180_000;

/**
 * Instants to sample across `[startMs, endMs)`.
 *
 * Spaced so the first sample sits half a step in rather than exactly on
 * `startMs`. A cut boundary is the usual reason to ask, and a frame taken
 * exactly on one is ambiguous by construction — it is the first frame of the
 * incoming clip or the last of the outgoing depending on rounding, which is the
 * one thing the caller is trying to find out.
 */
export function sampleTimes(
  startMs: number,
  endMs: number,
  count: number,
): number[] {
  const from = Math.max(0, Math.round(startMs));
  const to = Math.max(from, Math.round(endMs));
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));

  if (to === from) {
    return [from];
  }

  const step = (to - from) / n;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(Math.round(from + step * (i + 0.5)));
  }
  return times;
}

function sheetDir(): string {
  const dir = path.join(app.getPath("userData"), "contact-sheets");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write one sheet and return its path.
 *
 * The filename carries the range so a directory of them is readable, and
 * `index` disambiguates two sheets over the same range in one session. Old
 * sheets are not swept: they are small, a user may want to look at one, and a
 * tool that deletes files it did not create is a worse trade than a few
 * kilobytes.
 */
export function writeSheet(
  pngBase64: string,
  startMs: number,
  endMs: number,
  index: number,
): string {
  const name = `sheet-${Math.round(startMs)}-${Math.round(endMs)}-${index}.png`;
  const file = path.join(sheetDir(), name);
  fs.writeFileSync(file, Buffer.from(pngBase64, "base64"));
  return file;
}

/** Bumped per sheet so two calls over the same range do not overwrite. */
let counter = 0;
export function nextIndex(): number {
  counter += 1;
  return counter;
}
