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
  /**
   * The line's own name, stable across every edit that keeps it the same line.
   *
   * The line owns its span, and it owns this for the same kind of reason. A
   * caption session holds one timeline element per line and has to find that
   * element again after each edit; position cannot do it, because the row a
   * caption occupies comes from `captionsFrom`, which drops empty and
   * struck-out lines. Striking line three out shifts every line after it by
   * one, and an id keyed on position would move every later caption's element
   * with it: the next keystroke would then edit the wrong clip.
   *
   * A split keeps it on the head and names the tail; a merge keeps the upper
   * line's. The split takes that name as an argument, defaulting to
   * `mintLineId`, so a caller that has to control identity can and one that
   * does not need not.
   */
  id: string;
  /** The words this line covers: the timing ribbon, and the seek targets. */
  words: CaptionWord[];
  /** Seconds. The line's own span — survives an edit and a mid-word split. */
  start: number;
  end: number;
  /** What will be placed. Starts as the words joined; diverges once edited. */
  text: string;
  /**
   * Struck out by the user, and therefore cut from the picture too.
   *
   * A flag rather than removal from the array, for two reasons. The undo stack
   * in `editor.ts` snapshots `lines` whole, so a delete is undoable with no new
   * machinery. And a struck-out line stays on screen, which is the only way to
   * see what was deleted and put it back; a line that vanishes from the list
   * takes with it any way of naming what just went.
   *
   * Absent means kept, so nothing about an untouched transcript changes shape.
   */
  removed?: boolean;
};

/** A caption ready for the timeline, in **milliseconds**. */
export type CaptionOut = {
  /** The line this came from. What a session keys its element id by. */
  lineId: string;
  text: string;
  startTime: number;
  duration: number;
};

/** The shortest caption worth placing, in ms. */
const MIN_DURATION_MS = 1;

let nextLineId = 0;

/**
 * The default source of line ids.
 *
 * A counter rather than a uuid, and that is not a shortcut. A line id has to be
 * unique among the lines **one session is holding**, and nothing else: it is
 * never written to a `.ngt`, never crosses IPC, and never names a timeline
 * element directly. A process-wide counter satisfies that outright, and it
 * gives a suite ids it can print rather than thirty-six characters to assert
 * around.
 *
 * It stays injectable anyway, so a caller that wants control has it:
 * `TranscribeSession` passes the same minter it names jobs with.
 */
export function mintLineId(): string {
  nextLineId += 1;
  return `line-${nextLineId}`;
}

/** Build from what the transcriber returned, already grouped into lines. */
export function linesFromWordGroups(
  groups: CaptionWord[][],
  mintId: () => string = mintLineId,
): CaptionLine[] {
  return groups
    .filter((words) => words.length > 0)
    .map((words) => ({
      id: mintId(),
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
  mintId: () => string = mintLineId,
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
    mintId,
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
 *
 * **The head keeps the line's id and the tail takes `newId`.** So a session
 * holding one timeline element per line keeps the element it already placed for
 * the text above the caret, and creates exactly one. Handing the id to the tail
 * instead would make every split look like a delete and an insert.
 */
export function splitLineAt(
  lines: CaptionLine[],
  index: number,
  caretOffset: number,
  newId: string = mintLineId(),
): CaptionLine[] {
  const line = lines[index];
  if (line == null) {
    return lines;
  }

  // A struck-out line has no split worth making: both halves would be struck
  // out too, and the range about to be cut is the same either way. It declines
  // rather than spreading `removed` onto the halves because the halves are
  // built as fresh literals below, and any field added to `CaptionLine` later
  // would be dropped by them in exactly the same silent way. Refusing is one
  // line, and it is the one a test can see.
  if (line.removed === true) {
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
    id: line.id,
    words: before,
    start: line.start,
    end: cut,
    text: head,
  };
  const second: CaptionLine = {
    id: newId,
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
 *
 * The merged line keeps the **upper** line's id, which is the half the caret
 * ends up in. No id is minted, so unlike `splitLineAt` this needs no pool: a
 * merge only ever destroys one.
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

  // Joining a kept line to a struck-out one has no answer: the merged line is
  // either placed, losing the deletion, or not, losing text the user kept. The
  // literal below would silently choose "placed" by dropping the flag.
  if (previous.removed === true || current.removed === true) {
    return lines;
  }

  const merged: CaptionLine = {
    id: previous.id,
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
 * Strike a line out, so it is neither placed nor left in the picture.
 *
 * The gesture behind the per-line delete button. It writes no time anywhere:
 * the range to cut is the line's own `start`/`end`, read back by
 * `caption/cuts.ts#planCuts` when the user confirms. Storing a cut here instead
 * would put the same fact in two places and let them disagree the moment a
 * split or a merge moved the line's span.
 *
 * Declines by identity on a line that is already struck out, which is what lets
 * the panel skip a repaint and keeps a repeated click off the undo stack.
 */
export function removeLine(
  lines: CaptionLine[],
  index: number,
): CaptionLine[] {
  const line = lines[index];
  if (line == null || line.removed === true) {
    return lines;
  }
  return [
    ...lines.slice(0, index),
    { ...line, removed: true },
    ...lines.slice(index + 1),
  ];
}

/**
 * Put a struck-out line back.
 *
 * The key is deleted rather than set to `false`, so a restored line is
 * indistinguishable from one nobody touched. That is the rule `blend`, `lut`
 * and `replaceable` all follow, and here it keeps `removed` from accumulating
 * on every line of a transcript the user only looked at.
 */
export function restoreLine(
  lines: CaptionLine[],
  index: number,
): CaptionLine[] {
  const line = lines[index];
  if (line == null || line.removed !== true) {
    return lines;
  }
  const { removed, ...rest } = line;
  return [...lines.slice(0, index), rest, ...lines.slice(index + 1)];
}

/**
 * The source-millisecond spans of every struck-out line.
 *
 * The conversion lives here for the reason `linesFromTranscript` gives about
 * the other direction: this module counts in seconds because a media element's
 * `currentTime` does, and everything downstream of it counts in milliseconds.
 * One place where the two clocks meet beats a `* 1000` at each call site.
 */
export function removedSpans(
  lines: CaptionLine[],
): Array<{ startMs: number; endMs: number }> {
  return lines
    .filter((line) => line.removed === true)
    .map((line) => ({ startMs: line.start * 1000, endMs: line.end * 1000 }));
}

/** Whether anything is struck out. What the panel's summary line asks. */
export function hasRemovedLines(lines: CaptionLine[]): boolean {
  return lines.some((line) => line.removed === true);
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
 *
 * A struck-out line is dropped for a different reason and by the same filter:
 * its footage is about to be cut, so a caption over it would be a caption over
 * nothing. `rows.ts` needs no change for either, because its style is computed
 * once rather than per index.
 */
export function captionsFrom(lines: CaptionLine[]): CaptionOut[] {
  return lines
    .filter((line) => line.removed !== true && line.text.trim().length > 0)
    .map((line) => ({
      lineId: line.id,
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
