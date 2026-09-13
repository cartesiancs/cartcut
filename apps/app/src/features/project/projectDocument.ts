/**
 * Reading a `.ngt`'s entries into a document. The one load order.
 *
 * Three callers need it — `functions/project.ts#load`, Auto Save recovery, and
 * `template/templateDocument.ts` — and the order is load-bearing in ways that
 * are invisible if you get them wrong, so a second implementation would drift
 * and the drift would be silent. It lives here rather than in `project.ts`
 * because that module reaches for `document.querySelector`,
 * `window.electronAPI` and JSZip within a few lines of every branch, so a
 * question like "does a recovered autosave relink the same way a project
 * does" had no way to be asked of it. The argument `assetsFile.ts` and
 * `renderOptionsFile.ts` already make for themselves.
 *
 * Everything with an effect on the outside world is a parameter: the entries
 * arrive as text and the existence probe is injected, which is what lets this
 * run under `environment: "node"`.
 *
 * **It returns an outcome rather than throwing**, the arrangement
 * `caption/transcribeSession.ts` states: the caller performs it. The three
 * callers want three different things from a schema mismatch — a modal, a
 * recorded-once registry message, and a refusal that touches nothing — and a
 * throw would make each of them reconstruct which failure it was from a string.
 *
 * It returns the **whole `TimelineDocument`, tracks included.** That is the
 * one thing `readTemplateDocument` could not be reused for: a template has no
 * rows of its own so it keeps `document.elements` and drops
 * `document.tracks`, and a recovery that dropped tracks would drop the user's
 * row layout and, through `derivePriorities`, their z-order.
 */

import type { Timeline } from "../../@types/timeline";
import {
  SCHEMA_VERSION,
  normalizeDocument,
  type TimelineDocument,
  type TimelineTrack,
} from "../timeline/tracks";
import { relinkAssets, type ExistsFn } from "./assetsFile";
import type { NgtEntries } from "./projectEntries";

export type ReadProjectResult =
  | {
      ok: true;
      document: TimelineDocument;
      /** Raw `renderOptions.json`, for `deserializeRenderOptions`. */
      renderOptions: unknown;
      /** Asset fields pointed somewhere new by the relink. */
      relinked: number;
      /** Distinct files not found — counted in files, never in clips. */
      missing: number;
    }
  | { ok: false; reason: "schema"; found: unknown; expected: typeof SCHEMA_VERSION }
  | { ok: false; reason: "unreadable"; message: string };

function parse(raw: string | null): unknown {
  if (raw == null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the entries of a `.ngt` into a document ready for `patchDocument`.
 *
 * `anchor` is the path the project considers itself to live at, which the
 * relink resolves `assetPaths.json`'s relative entries against. For a project
 * opened from disk that is the file itself; for a recovered autosave it is the
 * `.ngt` the autosave stands in for, **not** the autosave's own location.
 */
export async function readProjectDocument(
  entries: NgtEntries,
  anchor: string,
  exists: ExistsFn,
): Promise<ReadProjectResult> {
  // Projects written before tracks existed have no `project.json` and no
  // `tracks.json`; their elements carry a hand-assigned `priority` that
  // doubled as a row index. Absent therefore means version 1, the reading
  // `project.ts` has always taken.
  const project = parse(entries.project) as { schemaVersion?: unknown } | null;
  const schemaVersion = project?.schemaVersion ?? 1;

  // A compatibility check, not a migrator. Saying so plainly beats opening
  // something that would look subtly wrong and export differently.
  if (schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "schema",
      found: schemaVersion,
      expected: SCHEMA_VERSION,
    };
  }

  // `Array.isArray` as well as the `typeof` check: an array *is* an object,
  // so `[{...}]` would otherwise be read as an element map keyed "0", "1", …
  // and produce garbage clips rather than a refusal. (The same hole is still
  // open in `templateDocument.ts`, which this module is extracted from.)
  const rawElements = parse(entries.timeline);
  if (
    rawElements == null ||
    typeof rawElements !== "object" ||
    Array.isArray(rawElements)
  ) {
    return {
      ok: false,
      reason: "unreadable",
      message: "the project's timeline.json is missing or unreadable",
    };
  }

  // An absent or malformed `tracks.json` is not a failure — a project written
  // before tracks existed simply has none, and `normalizeDocument` will derive
  // what it needs.
  const rawTracks = parse(entries.tracks);
  const tracks = (Array.isArray(rawTracks) ? rawTracks : []) as TimelineTrack[];

  // Point every asset at a file that is actually there: the path recorded
  // relative to this copy of the project folder first, then the absolute one
  // the document already carried. A project written by an older build has no
  // entry and comes through untouched.
  //
  // Before `normalizeDocument`, and before anything reads a path, so nothing
  // ever sees the author's machine.
  const relink = await relinkAssets(
    rawElements as Record<string, never>,
    parse(entries.assetPaths),
    anchor,
    exists,
  );

  // Through `normalizeDocument` so `priority` is the one the compositor would
  // see and the parent graph is repaired. A hand-built map would let a project
  // render here and not in the app.
  const document = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks,
    elements: relink.elements as Timeline,
  });

  return {
    ok: true,
    document,
    renderOptions: parse(entries.renderOptions),
    relinked: relink.relinked,
    missing: relink.missing,
  };
}

/**
 * The message to show for a failed read.
 *
 * Here rather than at each call site so the two surfaces that can show it —
 * File → Open and Auto Save recovery — say the same thing about the same file.
 */
export function readProjectFailureMessage(
  result: Extract<ReadProjectResult, { ok: false }>,
): string {
  if (result.reason === "schema") {
    return (
      `This project was made with a different version of Cartcut ` +
      `(format v${String(result.found)}) and cannot be opened by this one ` +
      `(format v${result.expected}).`
    );
  }
  return `This project could not be read — ${result.message}.`;
}
