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
  /** 1-based, for the `#` column. */
  id: number;
  /** The element key. Identifies the row *and* the clip the captions belong to. */
  key: string;
  /** The clip's `localpath` — a `file://` URL, not a filesystem path. */
  localpath: string;
  filetype: "video" | "audio";
  /** The clip's span in ms. **Not** the file's length; see `media/playback.ts`. */
  durationMs: number;
};

/** Filetypes with speech in them. */
const TRANSCRIBABLE = new Set(["video", "audio"]);

/**
 * The transcribable clips on a timeline, in picker order.
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

  const rows: CaptionSource[] = [];
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
    rows.push({
      id: rows.length + 1,
      key,
      localpath,
      filetype,
      durationMs: Number.isFinite(value?.duration) ? value.duration : 0,
    });
  }
  return rows;
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
