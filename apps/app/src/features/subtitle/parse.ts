/**
 * Reading a SubRip or WebVTT file.
 *
 * **One scanner for both formats.** The block structure is identical: cues
 * separated by blank lines, each holding a `-->` line and some text. Everything
 * that differs between them is something to skip or something to throw away, so
 * a second parser would be the same hundred lines with four conditions moved.
 *
 * Lenient throughout, because a subtitle file is almost never written by the
 * tool that will read it. `skipped` counts the blocks that could not be made
 * sense of, and the caller reports the number; a reason per block would be a
 * paragraph of toast about a file the user is about to look at anyway.
 *
 * ## What is thrown away, and why nothing is kept
 *
 * Cue settings (`align:start line:90%`), region and style blocks, inline tags
 * (`<i>`, `<c.yellow>`, `<v Bob>`, karaoke timestamps) and cue identifiers all
 * go. A `TextElementType` has no per-run formatting, so there is nowhere to put
 * an `<i>` that covers half a line, and a cue identifier names nothing on the
 * timeline. Keeping any of it would mean inventing a representation for it.
 *
 * ## Markup is read per flavour, and that is not a detail
 *
 * WebVTT's cue text **is** markup: `<` opens a tag and `&` opens an entity, so
 * both are stripped and decoded. SubRip's is not. It has no entity syntax at
 * all, so `&amp;` in a `.srt` is five characters somebody typed, and decoding it
 * would corrupt their caption. It does have a de facto set of formatting tags,
 * inherited from the players that read it: `<i>`, `<b>`, `<u>` and `<font>`.
 * Only those are stripped, so a `<` that is not one of them survives.
 *
 * The consequence, and it is worth stating because a round-trip suite runs into
 * it: **a literal `<i>` cannot survive a SubRip round trip.** The format has one
 * spelling for the tag and the literal, and this reads it as the tag, because a
 * file with italics in it is overwhelmingly more likely than a caption about
 * HTML. WebVTT has escaping and so round trips everything.
 *
 * Within WebVTT, tags are stripped **before** entities are decoded. The other
 * way round, `&lt;i&gt;` becomes `<i>` and is then deleted as a tag, so a file
 * that escaped a literal on purpose loses it. And `&amp;` decodes last for the
 * same reason at one remove: `&amp;lt;` must come out as the four characters
 * `&lt;`, not as `<`.
 */

import {
  normalizeCues,
  type SubtitleCue,
  type SubtitleFlavour,
} from "./cues";
import { parseTimecode } from "./timecode";

export type SubtitleParse = {
  flavour: SubtitleFlavour;
  cues: SubtitleCue[];
  /** Blocks that held no readable timing. Not an error, just a count. */
  skipped: number;
};

/**
 * Which format this is.
 *
 * The content decides: a `WEBVTT` signature is mandatory in a WebVTT file, so
 * its presence is proof and its absence very nearly is. The filename breaks the
 * tie only when the content says nothing, which happens for a `.vtt` whose
 * header somebody stripped.
 */
export function sniffFlavour(text: string, filename?: string): SubtitleFlavour {
  if (/^WEBVTT/.test(firstNonBlankLine(normalizeNewlines(stripBom(text))))) {
    return "vtt";
  }
  if (filename != null && /\.vtt$/i.test(filename)) {
    return "vtt";
  }
  return "srt";
}

export function parseSubtitles(text: string, filename?: string): SubtitleParse {
  const body = normalizeNewlines(stripBom(text));
  const flavour = sniffFlavour(body, filename);

  const cues: SubtitleCue[] = [];
  let skipped = 0;
  let first = true;

  for (const block of blocksOf(body)) {
    const isFirst = first;
    first = false;

    // The signature block carries no cue, and counting it as skipped would
    // report every well-formed WebVTT file as having one bad block.
    if (isFirst && flavour === "vtt" && /^WEBVTT/.test(block)) {
      continue;
    }
    // Comments, styles and regions likewise. A comment may not contain `-->`,
    // so testing for the keyword first can never swallow a real cue.
    if (flavour === "vtt" && isMetadataBlock(block)) {
      continue;
    }

    const chunks = cueChunks(block.split("\n"));
    if (chunks.length === 0) {
      skipped += 1;
      continue;
    }

    for (const chunk of chunks) {
      const timing = parseTiming(chunk[0]);
      if (timing == null) {
        skipped += 1;
        continue;
      }

      // A cue whose text is blank is dropped by `normalizeCues` rather than
      // counted here: it parsed fine, it just has nothing to say.
      cues.push({
        ...timing,
        text: chunk
          .slice(1)
          .map((line) => stripMarkup(line, flavour))
          .join("\n"),
      });
    }
  }

  return { flavour, cues: normalizeCues(cues), skipped };
}

/**
 * One block's cues, each as the lines from its timing line onwards.
 *
 * Normally there is exactly one, and the SubRip index or WebVTT identifier
 * above the timing is left behind by starting at the arrow. The loop exists for
 * the other case: **a file whose blank-line separators went missing.** That is
 * common enough to be worth surviving, and without this the whole file reads as
 * one cue whose text is every remaining line of the transcript.
 *
 * Splitting at each timing line is safe for a well-formed file because it only
 * ever finds one. The bare-index heuristic is confined here for that reason: a
 * line of digits immediately above a timing line is that cue's SubRip index, and
 * dropping it stops it becoming the previous cue's last line. In a well-formed
 * file the branch is never reached, so a caption that really is just "2" cannot
 * be eaten by it.
 */
function cueChunks(lines: string[]): string[][] {
  const arrows: number[] = [];
  lines.forEach((line, index) => {
    if (line.includes("-->")) {
      arrows.push(index);
    }
  });

  return arrows.map((arrow, n) => {
    const next = arrows[n + 1];
    if (next == null) {
      return lines.slice(arrow);
    }
    const end = /^[ \t]*\d+[ \t]*$/.test(lines[next - 1]) ? next - 1 : next;
    return lines.slice(arrow, end);
  });
}

/**
 * The two timestamps on a `-->` line, or null.
 *
 * The **last** token before the arrow and the **first** after it. That asymmetry
 * is what drops WebVTT's cue settings, which only ever follow the end time, and
 * what survives a file whose index landed on the timing line instead of above
 * it. `indexOf` rather than `split`, so a stray second arrow in the settings
 * cannot change which halves are read.
 */
function parseTiming(line: string): { startMs: number; endMs: number } | null {
  const at = line.indexOf("-->");
  const startMs = parseTimecode(lastToken(line.slice(0, at)));
  const endMs = parseTimecode(firstToken(line.slice(at + 3)));

  if (startMs == null || endMs == null) {
    return null;
  }
  return { startMs, endMs };
}

/**
 * The formatting tags SubRip picked up from the players that read it.
 *
 * A closed list, unlike WebVTT's `<[^>]*>`, because SubRip has no tag syntax to
 * appeal to: anything not on this list is a `<` the user typed.
 */
const SRT_TAG = /<\/?(?:i|b|u|font)(?:\s[^>]*)?>/gi;

/** See the header. The flavour decides what counts as markup at all. */
function stripMarkup(line: string, flavour: SubtitleFlavour): string {
  if (flavour === "srt") {
    return line.replace(SRT_TAG, "");
  }
  return decodeEntities(line.replace(/<[^>]*>/g, ""));
}

const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&nbsp;/g, " "],
  [/&lrm;/g, "‎"],
  [/&rlm;/g, "‏"],
  // Last. Decoding `&amp;` first would turn `&amp;lt;` into `&lt;` and then
  // into `<`, losing a literal the file escaped on purpose.
  [/&amp;/g, "&"],
];

function decodeEntities(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ENTITIES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * A WebVTT block that is not a cue.
 *
 * `NOTE` may carry its comment on the same line; `STYLE` and `REGION` put theirs
 * on the lines below. So the keyword has to be followed by **any** whitespace,
 * the newline included, or the end of the block: `[ \t]` alone leaves a `STYLE`
 * block looking like a cue that failed to parse, which is worse than not
 * recognising it at all because it reports a well-formed file as damaged.
 *
 * A cue's identifier cannot collide. `NOTES` is not matched (the keyword must
 * end), and a real identifier line is followed by a timing line in the same
 * block, which this is tested before.
 */
function isMetadataBlock(block: string): boolean {
  return /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block);
}

/**
 * Blocks, separated by a blank line.
 *
 * A "blank" line may hold spaces or tabs: plenty of editors leave trailing
 * whitespace behind, and a separator that stopped working because of it would
 * fuse two cues into one block.
 */
function blocksOf(text: string): string[] {
  return text
    .split(/\n[ \t]*(?:\n[ \t]*)+/)
    .map((block) => trimBlankLines(block))
    .filter((block) => block.length > 0);
}

/** Leading and trailing blank lines off, inner ones kept. */
function trimBlankLines(block: string): string {
  return block.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

function firstNonBlankLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function firstToken(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

function lastToken(text: string): string {
  const tokens = text.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? "";
}

/**
 * A BOM survives a UTF-8 decode and poisons whatever reads the first line.
 * `lut/cube.ts` was bitten by exactly this; `.srt` files carry one constantly.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}
