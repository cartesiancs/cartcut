/**
 * Which clips can be transcribed, and how to name them in a picker.
 *
 * Lifted out of the auto-caption panel because `apps/automatic-caption/` is
 * outside every vitest include pattern, and both of these have real edge cases:
 * a `localpath` is a `file://` URL with its own escaping rules, and the row list
 * is what the Select button acts on.
 */

/** One row of the clip picker. */
export type CaptionSource = {
  /** 1-based, in timeline order. */
  id: number;
  /** The element key. Identifies the row *and* the clip the captions belong to. */
  key: string;
  /** The clip's `localpath` — a `file://` URL, not a filesystem path. */
  localpath: string;
  filetype: "video" | "audio";
  /**
   * How much of the source file the clip plays, in **source** ms: the
   * element's `duration`, which is `trim.endTime - trim.startTime`. Not the
   * file's length, and not the timeline length either once the clip is sped
   * up; that is `spanMs`.
   */
  durationMs: number;
  /** Where the clip begins on the timeline, in ms. */
  startMs: number;
  /** How much timeline the clip covers, in ms: `durationMs / speed`. */
  spanMs: number;
  /** The clip's window into its file, in source ms. */
  trimStartMs: number;
  trimEndMs: number;
  speed: number;
  /** Width over height of the picture, for a thumbnail. 16/9 when unknown. */
  aspect: number;
  /** The row the clip sits on, or an empty string for a malformed element. */
  trackId: string;
};

/** Filetypes with speech in them. */
const TRANSCRIBABLE = new Set(["video", "audio"]);

/**
 * The transcribable clips on a timeline, in timeline order.
 *
 * Sorted by where they start, so the picker's grid reads left to right the way
 * the timeline does. The sort is stable, so clips starting together keep the
 * element map's own order.
 *
 * Keyed rather than pathed: two clips cut from one file share a `localpath`, and
 * identifying a row by path selected both of them and transcribed whichever came
 * first. The key is also what `caption/timing.ts#captionToTimeline` needs, to
 * map a transcript's source times through that clip's own trim and speed.
 */
export function captionSources(timeline: unknown): CaptionSource[] {
  if (timeline == null || typeof timeline !== "object") {
    return [];
  }

  const rows: Omit<CaptionSource, "id">[] = [];
  for (const [key, value] of Object.entries(timeline as Record<string, any>)) {
    const filetype = value?.filetype;
    if (!TRANSCRIBABLE.has(filetype)) {
      continue;
    }
    const localpath = typeof value?.localpath === "string" ? value.localpath : "";
    if (localpath.length === 0) {
      // A clip with no source cannot be transcribed, and offering it would end
      // in "No such media file" after the user had chosen it.
      continue;
    }
    const durationMs = finite(value?.duration, 0);
    const speed = positive(value?.speed, 1);
    const trimStartMs = finite(value?.trim?.startTime, 0);
    rows.push({
      key,
      localpath,
      filetype,
      durationMs,
      startMs: finite(value?.startTime, 0),
      spanMs: durationMs / speed,
      trimStartMs,
      trimEndMs: finite(value?.trim?.endTime, trimStartMs + durationMs),
      speed,
      aspect: aspectOf(value),
      trackId: typeof value?.trackId === "string" ? value.trackId : "",
    });
  }
  return rows
    .sort((a, b) => a.startMs - b.startMs)
    .map((row, index) => ({ id: index + 1, ...row }));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  const n = finite(value, fallback);
  return n > 0 ? n : fallback;
}

/**
 * The picture's shape. `origin` is the decoded frame, which is what a
 * thumbnail shows; `width`/`height` are the box on the canvas, which a user
 * may have squashed.
 */
function aspectOf(value: any): number {
  for (const [w, h] of [
    [value?.origin?.width, value?.origin?.height],
    [value?.width, value?.height],
  ]) {
    const width = positive(w, 0);
    const height = positive(h, 0);
    if (width > 0 && height > 0) {
      return width / height;
    }
  }
  return 16 / 9;
}

/**
 * A clip's file name, for the picker.
 *
 * The full `localpath` used to be rendered whole into a cell with no width,
 * which widened the table past its 800px dialog and pushed the Select button
 * off the side. It is also not what anyone reads: the file name identifies the
 * clip and the full path belongs in a tooltip.
 *
 * **Only `#` is ever escaped** in a `localpath` — `functions/path.ts#encode`
 * replaces that and nothing else — so that is the only thing to put back.
 * `decodeURIComponent` is the wrong tool twice over: it would throw on a file
 * called `100%.mp4`, and it would wrongly decode a literal `%20` in a name.
 *
 * Both separators are split on because a Windows `localpath` is
 * `file://C:\Users\me\a.mp4` — the malformed form CLAUDE.md describes, with
 * backslashes surviving into what is otherwise a URL.
 */
export function sourceDisplayName(localpath: string): string {
  const full = typeof localpath === "string" ? localpath : "";
  const last = full.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const name = last.replace(/%23/g, "#");
  return name.length > 0 ? name : full;
}
