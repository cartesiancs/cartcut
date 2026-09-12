/**
 * Caption lines, and the editor operations on them.
 *
 * The auto-caption panel used to keep two parallel arrays — the recognised
 * words, and the strings the user had typed — with nothing holding them
 * together but a shared index. They drifted immediately: editing a line never
 * reached the words, and splitting *rebuilt every line's text from the words*,
 * so one Enter discarded every correction made so far. The line that would have
 * restored the edit was in the source, commented out.
 *
 * One list fixes that, and one field does most of the work:
 *
 * > **The line owns its span.** `start`/`end` are the line's, not
 * > `words[0].start` and `words.at(-1).end`.
 *
 * That is what makes an edited line, a line split inside a word, and a line
 * whose words were all deleted still have valid timing. Reading the span off
 * the words is what used to throw on `element[0].start` for an empty line the
 * split path had just created.
 *
 * Every operation is pure and **declines by returning its input by identity**,
 * the convention `features/timeline/` states — which is also what lets the
 * panel's undo stack skip a gesture that did nothing.
 *
 * Times are **seconds**, in the source file's own clock, because that is what a
 * transcript timestamps and what the panel's media element counts in.
 * `caption/timing.ts#captionToTimeline` converts to timeline ms at the boundary.
 */

/** One recognised word. */
export type CaptionWord = {
  word: string;
  start: number;
  end: number;
  /** 0..1, when the back end reported one. */
  score?: number;
};

export type CaptionLine = {
  /** The words this line covers: the timing ribbon, and the seek targets. */
  words: CaptionWord[];
  /** Seconds. The line's own span — survives an edit and a mid-word split. */
  start: number;
  end: number;
  /** What will be placed. Starts as the words joined; diverges once edited. */
  text: string;
};

/** A caption ready for the timeline, in **milliseconds**. */
export type CaptionOut = {
  text: string;
  startTime: number;
  duration: number;
};

/** The shortest caption worth placing, in ms. */
const MIN_DURATION_MS = 1;

/** Build from what the transcriber returned, already grouped into lines. */
export function linesFromWordGroups(groups: CaptionWord[][]): CaptionLine[] {
  return groups
    .filter((words) => words.length > 0)
    .map((words) => ({
      words,
      start: words[0].start,
      end: words[words.length - 1].end,
      text: joinWords(words),
    }));
}

/**
 * One word as the transcriber reports it, across the IPC boundary.
 *
 * Milliseconds, and `confidence` rather than `score` — the shape
 * `electron/mcp/analysis/segments.ts#TranscriptWord` sends. Restated
 * structurally rather than imported, because `apps/app` must not reach into
 * `electron/`, and because the panel is a *consumer* of that shape: declaring
 * it here is what makes a change on the far side a type error on this one.
 */
export type TranscribedWord = {
  word: string;
  startMs: number;
  endMs: number;
  /** 0..1. Absent for the OpenAI back end, which reports none per word. */
  confidence?: number;
  /** A diarisation label. Used by main to break lines; nothing here shows it. */
  speaker?: string;
};

/**
 * Build from the transcriber's own grouping, converting units on the way in.
 *
 * **The two clocks meet here and nowhere else.** Main counts in milliseconds
 * because that is what a media timestamp is; this module counts in seconds
 * because that is what a media element's `currentTime` gives, which is what the
 * panel compares against sixty times a second. Converting at the boundary keeps
 * a single unit inside each side instead of a field-by-field mixture, which is
 * the defect `captionLayout` was lifted out of the panel to fix.
 *
 * `confidence` becomes `score` **only when it is there**, so a word the back end
 * said nothing about has no key rather than an explicit `undefined` — the rule
 * `toSegment` already keeps on the other side of the wire. The guard is
 * `!= null`, not truthiness, so a reported confidence of exactly `0` survives.
 *
 * `speaker` is dropped. A change of speaker still breaks a line, in main, but
 * the panel has nowhere to show the label and inventing a chip for it here would
 * put the vocabulary in two places.
 */
export function linesFromTranscript(
  groups: TranscribedWord[][] | null | undefined,
): CaptionLine[] {
  return linesFromWordGroups(
    (groups ?? []).map((group) =>
      group.map((word) => ({
        word: word.word,
        start: word.startMs / 1000,
        end: word.endMs / 1000,
        ...(word.confidence != null ? { score: word.confidence } : {}),
      })),
    ),
  );
}

/**
 * Split a line at a caret position in its text.
 *
 * **Picks a cut *time*, then partitions the words by it** — one rule, two ways
 * of choosing the time. Counting the whitespace-delimited tokens before the
 * caret gives a word index; when that lands strictly inside the word list, the
 * cut is that word's `start`.
 *
 * A fragment counts as a whole token, so a caret *inside* a word snaps to that
 * word's far edge rather than halving its second. That is deliberate: a caption
 * boundary in the middle of a word is a time that corresponds to nothing
 * audible, and the text the user asked to split at is preserved either way.
 *
 * Only when no boundary is reachable — a single-word line, or text rewritten
 * until it has more tokens than the line has words — does the cut become
 * proportional to the caret's position in the string.
 *
 * Partitioning by midpoint then reduces to `words[0..n)` / `words[n..)` for the
 * boundary case, so the common path is exact and the awkward one degrades
 * rather than throwing. No arrangement of edits can make this fail.
 *
 * Declines when either side would be empty: a caption with no text is not
 * something a user can see or fix, and an editor that silently makes one is
 * worse than one that does nothing.
 */
export function splitLineAt(
  lines: CaptionLine[],
  index: number,
  caretOffset: number,
): CaptionLine[] {
  const line = lines[index];
  if (line == null) {
    return lines;
  }

  const head = line.text.slice(0, caretOffset).trimEnd();
  const tail = line.text.slice(caretOffset).trimStart();
  if (head.length === 0 || tail.length === 0) {
    return lines;
  }

  const cut = cutTimeFor(line, head, caretOffset);
  const before: CaptionWord[] = [];
  const after: CaptionWord[] = [];
  for (const word of line.words) {
    (midpoint(word) < cut ? before : after).push(word);
  }

  const first: CaptionLine = {
    words: before,
    start: line.start,
    end: cut,
    text: head,
  };
  const second: CaptionLine = {
    words: after,
    start: cut,
    end: line.end,
    text: tail,
  };

  return [...lines.slice(0, index), first, second, ...lines.slice(index + 1)];
}

/**
 * Merge a line into the one above it.
 *
 * The gesture behind Backspace at the start of a line, and behind the merge-up
 * button. Declines at the top of the list, where there is nothing to merge into.
 */
export function mergeLineWithPrevious(
  lines: CaptionLine[],
  index: number,
): CaptionLine[] {
  if (index <= 0 || index >= lines.length) {
    return lines;
  }

  const previous = lines[index - 1];
  const current = lines[index];

  const merged: CaptionLine = {
    words: [...previous.words, ...current.words],
    start: Math.min(previous.start, current.start),
    end: Math.max(previous.end, current.end),
    text: joinText(previous.text, current.text),
  };

  return [...lines.slice(0, index - 1), merged, ...lines.slice(index + 1)];
}

/**
 * The caret offset a merge leaves the user at.
 *
 * The join point, so Backspace-then-typing continues where the text was cut —
 * what a text editor does. Computed here because it is the same `joinText` rule
 * the merge uses, and a second copy in the panel would drift the moment the
 * separator changed.
 */
export function mergeCaretOffset(
  lines: CaptionLine[],
  index: number,
): number {
  return lines[index - 1]?.text.trimEnd().length ?? 0;
}

/** Replace a line's text, leaving its timing alone. */
export function setLineText(
  lines: CaptionLine[],
  index: number,
  text: string,
): CaptionLine[] {
  const line = lines[index];
  if (line == null || line.text === text) {
    return lines;
  }
  return [
    ...lines.slice(0, index),
    { ...line, text },
    ...lines.slice(index + 1),
  ];
}

/**
 * Which line is on screen at `timeSec`, or null when none is.
 *
 * Half-open `[start, end)`, the convention the timeline uses, so the panel and
 * the placed captions agree at a boundary. Null rather than a fallback index:
 * the previous version defaulted to line 0, which drew the first caption before
 * the first word had been spoken and again after the last one had finished.
 */
export function lineIndexAt(
  lines: CaptionLine[],
  timeSec: number,
): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    if (timeSec >= lines[index].start && timeSec < lines[index].end) {
      return index;
    }
  }
  return null;
}

/** Which word inside a line is being spoken, or null. */
export function wordIndexAt(
  line: CaptionLine | undefined,
  timeSec: number,
): number | null {
  if (line == null) {
    return null;
  }
  for (let index = 0; index < line.words.length; index += 1) {
    const word = line.words[index];
    if (timeSec >= word.start && timeSec < word.end) {
      return index;
    }
  }
  return null;
}

/**
 * Which line, and which word inside it, at `timeSec`.
 *
 * The pair every caller actually wants, written once. The panel computed it
 * twice — in its 60Hz re-render gate and again in `render()` — from two
 * independent copies of the same three lines, and the gate keyed on a string
 * derived from only one of them. Two answers to "what is highlighted" is one
 * too many, and the one that drifts is the one nothing is watching.
 *
 * `wordIndex` is null whenever `lineIndex` is, and also inside a line during a
 * gap between its words, which is a real state: a caption is on screen for its
 * whole span, and nobody is speaking between two of its words.
 */
export function activeAt(
  lines: CaptionLine[],
  timeSec: number,
): { lineIndex: number | null; wordIndex: number | null } {
  const lineIndex = lineIndexAt(lines, timeSec);
  return {
    lineIndex,
    wordIndex: wordIndexAt(
      lineIndex == null ? undefined : lines[lineIndex],
      timeSec,
    ),
  };
}

/**
 * The lines as captions, in milliseconds.
 *
 * Empty lines are dropped rather than placed: a split cannot make one, but a
 * user can empty a line's input, and an empty text element on the timeline is
 * invisible and unfindable.
 */
export function captionsFrom(lines: CaptionLine[]): CaptionOut[] {
  return lines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => ({
      text: line.text.trim(),
      startTime: Math.max(0, Math.round(line.start * 1000)),
      duration: Math.max(
        MIN_DURATION_MS,
        Math.round((line.end - line.start) * 1000),
      ),
    }));
}

function cutTimeFor(
  line: CaptionLine,
  head: string,
  caretOffset: number,
): number {
  const tokens = head.split(/\s+/).filter(Boolean).length;
  if (tokens > 0 && tokens < line.words.length) {
    return line.words[tokens].start;
  }

  // The caret is inside the first or the last word, or the text no longer has
  // as many tokens as the line has words because it has been rewritten. Fall
  // back to where the caret sits in the string.
  const fraction =
    line.text.length > 0
      ? Math.min(1, Math.max(0, caretOffset / line.text.length))
      : 0.5;
  return line.start + (line.end - line.start) * fraction;
}

function midpoint(word: CaptionWord): number {
  return (word.start + word.end) / 2;
}

function joinWords(words: CaptionWord[]): string {
  return words
    .map((word) => word.word)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinText(before: string, after: string): string {
  const left = before.trimEnd();
  const right = after.trimStart();
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  return `${left} ${right}`;
}
