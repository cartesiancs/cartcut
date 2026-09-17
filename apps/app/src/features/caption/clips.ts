/**
 * Captioning several clips as one edit: what each clip contributes.
 *
 * The session takes one list of lines for every chosen clip, in the order the
 * user chose them, with each line tagged by the clip it was spoken in
 * (`lines.ts#CaptionLine.sourceKey`). This module turns the per-clip work into
 * that list and back: running the transcriptions one after another, trimming
 * each transcript to the clip's own window, sweeping each clip's silences
 * against its own words, and handing the session one list of source ranges per
 * clip.
 *
 * ## Why a transcript is trimmed to its clip
 *
 * Main transcribes the whole file, and a clip is a window into it. Words outside
 * that window used to be captioned anyway and placed wherever the clip's
 * mapping put them, which is before the clip or after it. With one clip that
 * was a stray caption; with two clips cut from one file it is every caption
 * twice, because both clips receive the same cached transcript.
 *
 * ## Twins
 *
 * A video and its detached audio are two clips of one recording, sitting at the
 * same place on the timeline with the same window. Choosing both should not
 * transcribe the speech twice or caption it twice, and it must still cut both,
 * or the sound drifts away from the picture. So the later of the two
 * **follows** the earlier: it contributes no lines and takes its cuts from the
 * clip it follows.
 */

import type { TimeRange } from "../timeline/clipOps";
import {
  joinWords,
  midpoint,
  mintLineId,
  removedSpans,
  type CaptionLine,
  type CaptionWord,
} from "./lines";
import {
  DEFAULT_SILENCE_OPTIONS,
  silenceCuts,
  wordGaps,
  type SilenceOptions,
} from "./silence";
import type { CaptionSource } from "./sources";
import type { JobOutcome } from "./transcribeSession";

export type CaptionClip = {
  key: string;
  /** The clip's window into its file, in source ms. Null keeps every word. */
  window: TimeRange | null;
  /** The key of the chosen clip this one is a twin of. See the header. */
  follows?: string;
};

/** A clip, with the file to transcribe. */
export type ClipJob = CaptionClip & { localpath: string };

/** One clip's ranges to cut, in source ms, for the session. */
export type ClipRanges = { key: string; sourceRanges: TimeRange[] };

/**
 * One transcript, as lines of one clip.
 *
 * A word is kept when its midpoint lies inside the window, the rule
 * `splitLineAt` uses to share words between two halves, and its edges are then
 * clamped to the window so no caption reaches outside the clip. A line that
 * lost words takes its span and its text from the words it kept; one that lost
 * none keeps its own.
 *
 * Every line gets a new id. Two clips cut from one file receive one cached
 * transcript, and a session keys a caption's element by its line's id.
 */
export function clipLines(
  lines: readonly CaptionLine[],
  clip: CaptionClip,
  mintId: () => string = mintLineId,
): CaptionLine[] {
  const window = clip.window;
  const out: CaptionLine[] = [];

  for (const line of lines) {
    if (window == null) {
      out.push(tag(line, clip.key, mintId(), line.words, line.start, line.end, line.text));
      continue;
    }

    const from = window.startMs / 1000;
    const to = window.endMs / 1000;
    const kept: CaptionWord[] = line.words
      .filter((word) => {
        const at = midpoint(word);
        return at >= from && at < to;
      })
      .map((word) => clampWord(word, from, to));

    if (kept.length === 0) {
      continue;
    }

    if (kept.length === line.words.length) {
      out.push(
        tag(
          line,
          clip.key,
          mintId(),
          kept,
          Math.max(from, line.start),
          Math.min(to, line.end),
          line.text,
        ),
      );
      continue;
    }

    out.push(
      tag(
        line,
        clip.key,
        mintId(),
        kept,
        kept[0].start,
        kept[kept.length - 1].end,
        joinWords(kept),
      ),
    );
  }

  return out;
}

/**
 * Every clip's transcript, as one list in the chosen order.
 *
 * `byKey` is what `transcribeClips` answered; `clips` carries the windows,
 * which are read after the last transcript lands rather than before the first.
 */
export function joinClipLines(
  byKey: readonly { key: string; lines: readonly CaptionLine[] }[],
  clips: readonly CaptionClip[],
  mintId: () => string = mintLineId,
): CaptionLine[] {
  const windows = new Map(clips.map((clip) => [clip.key, clip]));
  return byKey.flatMap((entry) => {
    const clip = windows.get(entry.key);
    return clip == null ? [] : clipLines(entry.lines, clip, mintId);
  });
}

/**
 * What each clip asks the session to cut, in the chosen order.
 *
 * A clip's own struck-out lines and, while the toggle is on, its own silences.
 * A twin takes both from the clip it follows, so the two are cut identically.
 */
export function clipRanges(
  lines: readonly CaptionLine[],
  clips: readonly CaptionClip[],
  silenceByKey: Readonly<Record<string, readonly TimeRange[]>>,
  silenceOn: boolean,
): ClipRanges[] {
  return clips.map((clip) => {
    const basis = clip.follows ?? clip.key;
    const own = removedSpans(lines.filter((line) => line.sourceKey === basis));
    const silence = silenceOn ? (silenceByKey[basis] ?? []) : [];
    return { key: clip.key, sourceRanges: [...own, ...silence] };
  });
}

/** What every range adds up to, in ms. The footer's summary. */
export function removedTotalOf(ranges: readonly ClipRanges[]): number {
  let total = 0;
  for (const clip of ranges) {
    for (const range of clip.sourceRanges) {
      total += Math.max(0, range.endMs - range.startMs);
    }
  }
  return total;
}

/**
 * Where each clip's lines sit in the list: `[from, to)`.
 *
 * A clip with no speech has an empty section at the place it would have had,
 * so the list can still show its header. Lines stay contiguous by clip because
 * the list is built that way and no edit moves a line across a boundary: a
 * split keeps the key and a merge across two keys is refused.
 */
export function clipSections(
  lines: readonly CaptionLine[],
  keys: readonly string[],
): { key: string; from: number; to: number }[] {
  const sections: { key: string; from: number; to: number }[] = [];
  let cursor = 0;
  for (const key of keys) {
    let from = -1;
    let to = -1;
    lines.forEach((line, index) => {
      if (line.sourceKey === key) {
        if (from < 0) {
          from = index;
        }
        to = index + 1;
      }
    });
    if (from < 0) {
      sections.push({ key, from: cursor, to: cursor });
      continue;
    }
    sections.push({ key, from, to });
    cursor = to;
  }
  return sections;
}

/**
 * The shape two clips must share to be one recording.
 *
 * The file, the place on the timeline, the window and the speed. Rounded to the
 * millisecond, because a detached twin is written by the same code as the clip
 * it came from and is either equal or unrelated.
 */
function twinSignature(row: CaptionSource): string {
  return [
    row.localpath,
    Math.round(row.startMs),
    Math.round(row.trimStartMs),
    Math.round(row.trimEndMs),
    row.speed,
  ].join("|");
}

/** Keys of every row that has a twin among `rows`. For the picker's link icon. */
export function clipTwins(rows: readonly CaptionSource[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const signature = twinSignature(row);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return new Set(
    rows
      .filter((row) => (counts.get(twinSignature(row)) ?? 0) > 1)
      .map((row) => row.key),
  );
}

/**
 * Which chosen clip each twin follows: the first of its recording, in the
 * chosen order. Clips with no chosen twin are absent.
 */
export function clipFollows(
  picked: readonly CaptionSource[],
): Map<string, string> {
  const leaders = new Map<string, string>();
  const follows = new Map<string, string>();
  for (const row of picked) {
    const signature = twinSignature(row);
    const leader = leaders.get(signature);
    if (leader == null) {
      leaders.set(signature, row.key);
    } else {
      follows.set(row.key, leader);
    }
  }
  return follows;
}

export type TranscribeClipsOutcome =
  | { kind: "lines"; byKey: { key: string; lines: CaptionLine[] }[] }
  | { kind: "cancelled" }
  | { kind: "failed"; key: string; message: string };

export type TranscribeClipsPorts = {
  /** Transcribe one clip. `index` and `total` count only the clips that run. */
  run(clip: ClipJob, index: number, total: number): Promise<JobOutcome>;
  /**
   * Whether the user has asked to stop.
   *
   * Read between clips as well as after each. `TranscribeSession.requestCancel`
   * only reaches a job that is running, and between two jobs there is none, so
   * a Cancel pressed in that instant would otherwise start the next clip.
   */
  cancelled(): boolean;
};

/**
 * Transcribe the chosen clips, one after another, in the chosen order.
 *
 * Never two at once. `TranscribeSession` has one job slot, and main runs one job
 * at a time anyway, so a second job in flight would only be queued behind the
 * first while the panel lost track of which one its progress belonged to.
 *
 * The first failure ends the run and names the clip. A caption list that
 * silently lacks one of the clips the user chose is worse than a failure screen
 * that says which one.
 */
export async function transcribeClips(
  clips: readonly ClipJob[],
  ports: TranscribeClipsPorts,
): Promise<TranscribeClipsOutcome> {
  const jobs = clips.filter((clip) => clip.follows == null);
  const byKey: { key: string; lines: CaptionLine[] }[] = [];

  for (let index = 0; index < jobs.length; index += 1) {
    if (ports.cancelled()) {
      return { kind: "cancelled" };
    }
    const clip = jobs[index];
    const outcome = await ports.run(clip, index, jobs.length);
    if (outcome.kind === "cancelled" || ports.cancelled()) {
      return { kind: "cancelled" };
    }
    if (outcome.kind === "failed") {
      return { kind: "failed", key: clip.key, message: outcome.message };
    }
    // No speech is an answer, not a failure: the clip still gets its section.
    byKey.push({ key: clip.key, lines: outcome.lines });
  }

  return { kind: "lines", byKey };
}

export type SweepClipsOutcome = {
  byKey: Record<string, TimeRange[]>;
  /** Why a clip's sweep found nothing. The others are unaffected. */
  errors: Record<string, string>;
};

/**
 * Find each chosen clip's silences, against its own words only.
 *
 * One decode per distinct file, one after another. Two clips cut from one file
 * share it, and main caches the result on disk as well; decoding several
 * gigabyte-sized recordings at once is what this avoids.
 *
 * A twin is not swept: it takes its leader's cuts in `clipRanges`.
 */
export async function sweepClips(
  clips: readonly ClipJob[],
  lines: readonly CaptionLine[],
  silences: (localpath: string) => Promise<unknown>,
  options: SilenceOptions = DEFAULT_SILENCE_OPTIONS,
): Promise<SweepClipsOutcome> {
  const byKey: Record<string, TimeRange[]> = {};
  const errors: Record<string, string> = {};
  const decoded = new Map<string, unknown>();

  for (const clip of clips) {
    if (clip.follows != null || clip.window == null) {
      continue;
    }

    let response: unknown;
    try {
      if (!decoded.has(clip.localpath)) {
        decoded.set(clip.localpath, await silences(clip.localpath));
      }
      response = decoded.get(clip.localpath);
    } catch (error) {
      errors[clip.key] = error instanceof Error ? error.message : String(error);
      continue;
    }

    const answer = response as
      | { ok?: boolean; silences?: unknown; error?: unknown }
      | null
      | undefined;
    if (answer?.ok !== true || !Array.isArray(answer.silences)) {
      errors[clip.key] =
        typeof answer?.error === "string" && answer.error.length > 0
          ? answer.error
          : "Could not read the audio for this clip.";
      continue;
    }

    const own = lines.filter((line) => line.sourceKey === clip.key);
    byKey[clip.key] = silenceCuts(
      answer.silences as TimeRange[],
      wordGaps(own, clip.window),
      options,
    );
  }

  return { byKey, errors };
}

function tag(
  line: CaptionLine,
  key: string,
  id: string,
  words: CaptionWord[],
  start: number,
  end: number,
  text: string,
): CaptionLine {
  return {
    id,
    words,
    start,
    end,
    text,
    ...(line.removed === true ? { removed: true } : {}),
    sourceKey: key,
  };
}

function clampWord(word: CaptionWord, from: number, to: number): CaptionWord {
  const start = Math.max(from, word.start);
  const end = Math.min(to, word.end);
  if (start === word.start && end === word.end) {
    return word;
  }
  return { ...word, start, end };
}
