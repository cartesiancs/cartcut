/**
 * The caption panel's list, in the order it is drawn: clip headers, caption
 * lines, and the silent gaps between them.
 *
 * The gaps are the reason this exists. A session no longer cuts them on its
 * own (`silenceButton.ts#SILENCE_CUT_ON_START`), so the panel shows each one as
 * a row of empty space where it sits, and the footer's button removes them all.
 * Where a row sits is the kind of rule that disappears into a Lit template and
 * stops being checkable, which is why the headers moved here with it:
 * `apps/automatic-caption/` is outside every vitest include pattern, and the
 * two have to agree about one position (a clip's last gap comes before the
 * next clip's header, not after it).
 *
 * The rows are `silenceByKey` exactly as the sweep left it, the ranges
 * `silence.ts#silenceCuts` agreed on with the breath already taken off. That is
 * the list the button cuts with, so a row is never a different span from the
 * footage it stands for.
 */

import type { TimeRange } from "../timeline/clipOps";
import { clipSections } from "./clips";
import type { CaptionLine } from "./lines";

export type CaptionListItem =
  /** A clip's header. `at` is the index of the line it is drawn before. */
  | { kind: "section"; key: string; number: number; at: number }
  | { kind: "line"; index: number }
  /** Source ms. `cut` when the gap is gone from the timeline. */
  | { kind: "silence"; key: string; startMs: number; endMs: number; cut: boolean };

export type CaptionListInput = {
  lines: readonly CaptionLine[];
  /**
   * The keys of the clips that own lines, in the chosen order. A twin is not
   * one: it follows its leader's lines and its leader's cuts (`clips.ts`).
   */
  leaders: readonly string[];
  /** Source ms per clip, ascending, from the sweep. */
  silenceByKey: Readonly<Record<string, readonly TimeRange[]>>;
  /** Whether the gaps are currently cut out of the timeline. */
  silenceOn: boolean;
};

type Section = { key: string; from: number; to: number };
type Placed = Section & {
  silences: (Extract<CaptionListItem, { kind: "silence" }> & { before: number })[];
};

/**
 * Every row, in order.
 *
 * A gap is drawn before the first line of its own clip that starts at or after
 * it, and after the clip's last line when none does. That one rule covers the
 * pause before the first word, a pause between two lines, a pause between two
 * words of one line (drawn after that line), and the dead room after the last
 * word.
 *
 * At one position the order is: the gaps that end the clip before it, the next
 * clip's header, the gaps before that clip's first line, then the line. A clip
 * with no speech has its gaps right under its header.
 *
 * Headers appear only when more than one clip owns lines, as they always have.
 */
export function captionListItems(input: CaptionListInput): CaptionListItem[] {
  const { lines, leaders } = input;
  const headers = leaders.length > 1;
  const placed = sectionsOf(lines, leaders).map((section) =>
    placeSilences(section, input),
  );

  const out: CaptionListItem[] = [];
  for (let at = 0; at <= lines.length; at += 1) {
    for (const section of placed) {
      if (section.from < section.to && section.to === at) {
        pushSilences(out, section, at);
      }
    }
    placed.forEach((section, order) => {
      if (section.from !== at) {
        return;
      }
      if (headers) {
        out.push({ kind: "section", key: section.key, number: order + 1, at });
      }
      pushSilences(out, section, at);
    });
    for (const section of placed) {
      if (section.from < at && at < section.to) {
        pushSilences(out, section, at);
      }
    }
    if (at < lines.length) {
      out.push({ kind: "line", index: at });
    }
  }
  return out;
}

/** What a gap's row says, and what its tooltip adds. */
export function silenceRow(item: { startMs: number; endMs: number; cut: boolean }): {
  label: string;
  title: string;
} {
  const seconds = (Math.max(0, item.endMs - item.startMs) / 1000).toFixed(1);
  return {
    label: `${seconds}s silence`,
    title: item.cut
      ? "Cut from the timeline"
      : "Nobody speaks here. The silence button below removes every gap.",
  };
}

/**
 * Where each clip's lines are. One clip owns the whole list, tagged or not,
 * which is the rule `_keyOfLine` keeps for an untagged line.
 */
function sectionsOf(
  lines: readonly CaptionLine[],
  leaders: readonly string[],
): Section[] {
  if (leaders.length === 0) {
    return [];
  }
  if (leaders.length === 1) {
    return [{ key: leaders[0], from: 0, to: lines.length }];
  }
  return clipSections(lines, leaders);
}

function placeSilences(section: Section, input: CaptionListInput): Placed {
  const { lines, silenceOn } = input;
  const own = lines.slice(section.from, section.to);
  const ranges = [...(input.silenceByKey[section.key] ?? [])]
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const silences = ranges.map((range) => {
    let before = section.to;
    for (let index = section.from; index < section.to; index += 1) {
      if (lines[index].start * 1000 >= range.startMs) {
        before = index;
        break;
      }
    }
    return {
      kind: "silence" as const,
      key: section.key,
      startMs: range.startMs,
      endMs: range.endMs,
      // A gap inside a struck-out line is cut with the line whatever the
      // button says. Showing it as empty space that is still there would be
      // showing footage that is not.
      cut: silenceOn || insideRemovedLine(range, own),
      before,
    };
  });

  return { ...section, silences };
}

function insideRemovedLine(range: TimeRange, lines: readonly CaptionLine[]): boolean {
  return lines.some(
    (line) =>
      line.removed === true &&
      line.start * 1000 <= range.startMs &&
      line.end * 1000 >= range.endMs,
  );
}

function pushSilences(out: CaptionListItem[], section: Placed, at: number): void {
  for (const { before, ...silence } of section.silences) {
    if (before === at) {
      out.push(silence);
    }
  }
}
