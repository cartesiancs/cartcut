/**
 * Splitting lettering into words and letters, so CSS can move each one.
 *
 * What a script would do in a web page (GSAP's SplitText and its many copies),
 * done here by trusted code over the sanitised tree, so an HTML graphic gets
 * per-letter motion without running a line of anyone's JavaScript.
 *
 * An element carrying `data-split="chars"`, `"words"` or `"lines"` (any
 * combination) has every text node below it replaced by spans:
 *
 *   <span class="word" style="--word-index:0;--rand:..;--from-center:1">
 *     <span class="char" style="--char-index:0;--char-in-word:0;--rand:..">H</span>...
 *   </span>
 *
 * and gets `--char-count` and `--word-count` itself. Custom properties inherit,
 * so a letter reads its word's `--word-index` (and, after the host measures
 * lines, `--line-index`) with nothing set on it twice.
 *
 * Three rules, each preventing something specific:
 *
 *  - **Whitespace stays outside the spans**, as a plain text node. A word span
 *    is `inline-block`, and a space at the end of an inline-block collapses, so
 *    a word that owned its trailing space (the rule `text/reveal.ts` uses for
 *    cuts) would run into the next one.
 *  - **Letters always sit inside a word span**, even when only `chars` was
 *    asked for. Two inline-blocks side by side are a line-break opportunity, so
 *    bare letter spans could break a word in the middle.
 *  - **A word in a joining script is not split into letters.** Arabic, Syriac,
 *    N'Ko, Mongolian and the rest join their letters into one shape; a span
 *    between two of them breaks the join, which reads as a broken font.
 *
 * Grapheme boundaries come from `text/reveal.ts#unitBoundaries`, the same
 * pinned-locale `Intl.Segmenter` the reveal uses, so an emoji or a decomposed
 * Hangul syllable is one letter here as it is there.
 *
 * `--rand` is a digest of the program, the split root, the unit and the seed:
 * never of the element id, so a split or a duplicate of the clip draws the same
 * scatter. DOM-free and store-free.
 */

import { unitBoundaries } from "../text/reveal";
import { digest64 } from "../project/projectDigest";
import type { SafeNode } from "./sanitizeHtml";

export type SplitRequest = { chars: boolean; words: boolean; lines: boolean };

/** `data-split`'s value, or `null` when it asks for nothing this module knows. */
export function parseSplit(value: string | null | undefined): SplitRequest | null {
  if (typeof value !== "string") {
    return null;
  }
  const parts = new Set(value.toLowerCase().split(/[\s,]+/).filter(Boolean));
  const request = {
    chars: parts.has("chars") || parts.has("char") || parts.has("letters"),
    words: parts.has("words") || parts.has("word"),
    lines: parts.has("lines") || parts.has("line"),
  };
  return request.chars || request.words || request.lines ? request : null;
}

/** Scripts whose letters join, where a letter span would break the shape. */
const JOINING =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Adlam}\p{Script=Mandaic}\p{Script=Hanifi_Rohingya}\p{Script=Manichaean}\p{Script=Psalter_Pahlavi}]/u;

export function joinsLetters(word: string): boolean {
  return JOINING.test(word);
}

type Segment = { segment: string; isWordLike?: boolean };
type SegmenterLike = { segment(input: string): Iterable<Segment> };

let wordSegmenter: SegmenterLike | null | undefined;

function segmenter(): SegmenterLike | null {
  if (wordSegmenter !== undefined) {
    return wordSegmenter;
  }
  try {
    const ctor = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    wordSegmenter =
      typeof ctor === "function"
        ? new (ctor as new (l: string, o: { granularity: string }) => SegmenterLike)("en", {
            granularity: "word",
          })
        : null;
  } catch {
    wordSegmenter = null;
  }
  return wordSegmenter;
}

/**
 * A run of text as alternating words and whitespace, in order.
 *
 * Punctuation joins the word before it ("Hello," is one word), so a comma does
 * not fly in on its own. Words with no space between them, as in Chinese and
 * Japanese, stay separate, which is what lets the line still break between them.
 */
export function tokenize(text: string): Array<{ word: boolean; text: string }> {
  const out: Array<{ word: boolean; text: string }> = [];
  const push = (word: boolean, piece: string) => {
    const last = out[out.length - 1];
    if (!word && last != null && !last.word) {
      last.text += piece;
      return;
    }
    out.push({ word, text: piece });
  };
  const seg = segmenter();
  const pieces: Segment[] =
    seg != null
      ? [...seg.segment(text)]
      : (text.match(/\s+|[^\s]+/g) ?? []).map((piece) => ({
          segment: piece,
          isWordLike: /\S/.test(piece),
        }));
  for (const piece of pieces) {
    if (/^\s+$/u.test(piece.segment)) {
      push(false, piece.segment);
      continue;
    }
    const last = out[out.length - 1];
    // Punctuation and symbols ride with the word before them.
    if (piece.isWordLike !== true && last != null && last.word) {
      last.text += piece.segment;
      continue;
    }
    push(true, piece.segment);
  }
  return out;
}

/** The letters of one word, by grapheme. */
export function graphemes(word: string): string[] {
  const ends = unitBoundaries(word, "character");
  const out: string[] = [];
  let at = 0;
  for (const end of ends) {
    out.push(word.slice(at, end));
    at = end;
  }
  return out;
}

/** A deterministic 0..1 from a string. Four digits, enough for motion. */
export function randOf(key: string): number {
  const hex = digest64(key).slice(0, 8);
  const value = parseInt(hex, 16) / 0x100000000;
  return Math.round(value * 10000) / 10000;
}

/** 0 at the centre of a run of `count`, 1 at either end. */
export function fromCenter(index: number, count: number): number {
  if (count <= 1) {
    return 0;
  }
  const half = (count - 1) / 2;
  return Math.round((Math.abs(index - half) / half) * 10000) / 10000;
}

function attr(node: SafeNode & { kind: "element" }, name: string): string | null {
  for (const [key, value] of node.attrs) {
    if (key === name) {
      return value;
    }
  }
  return null;
}

function styleOf(vars: Record<string, string | number>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

export type SplitContext = {
  /** The program's hash, so `--rand` belongs to the program. */
  programHash: string;
  /** The `seed` parameter, or 0. */
  seed: number;
};

type Counters = {
  words: Array<{ node: SafeNode & { kind: "element" }; chars: Array<SafeNode & { kind: "element" }> }>;
};

/**
 * One split root's text, replaced. Walks every descendant so nested `<strong>`
 * or `<em>` keep their styling; counters run across the whole root.
 */
function splitRoot(
  root: SafeNode & { kind: "element" },
  request: SplitRequest,
  rootIndex: number,
  context: SplitContext,
): SafeNode & { kind: "element" } {
  const counters: Counters = { words: [] };
  const wantChars = request.chars;

  const walk = (node: SafeNode): SafeNode[] => {
    if (node.kind === "text") {
      const out: SafeNode[] = [];
      for (const token of tokenize(node.text)) {
        if (!token.word) {
          out.push({ kind: "text", text: token.text });
          continue;
        }
        const chars: Array<SafeNode & { kind: "element" }> = [];
        const children: SafeNode[] =
          wantChars && !joinsLetters(token.text)
            ? graphemes(token.text).map((letter) => {
                const span: SafeNode & { kind: "element" } = {
                  kind: "element",
                  tag: "span",
                  ns: "html",
                  attrs: [["class", "char"]],
                  children: [{ kind: "text", text: letter }],
                };
                chars.push(span);
                return span;
              })
            : [{ kind: "text", text: token.text }];
        const word: SafeNode & { kind: "element" } = {
          kind: "element",
          tag: "span",
          ns: "html",
          attrs: [["class", "word"]],
          children,
        };
        counters.words.push({ node: word, chars });
        out.push(word);
      }
      return out;
    }
    if (node.ns === "svg") {
      // Inside SVG a span means nothing; `<text>` takes `<tspan>`, which does
      // not lay out as a box. Left whole rather than split badly.
      return [node];
    }
    return [{ ...node, children: node.children.flatMap(walk) }];
  };

  const children = root.children.flatMap(walk);
  const wordCount = counters.words.length;
  const charCount = counters.words.reduce((sum, w) => sum + w.chars.length, 0);

  let charIndex = 0;
  counters.words.forEach((entry, wordIndex) => {
    entry.node.attrs.push([
      "style",
      styleOf({
        "--word-index": wordIndex,
        "--rand": randOf(`${context.programHash}|${rootIndex}|word|${wordIndex}|${context.seed}`),
        "--from-center": fromCenter(wordIndex, wordCount),
      }),
    ]);
    entry.chars.forEach((span, inWord) => {
      span.attrs.push([
        "style",
        styleOf({
          "--char-index": charIndex,
          "--char-in-word": inWord,
          "--rand": randOf(`${context.programHash}|${rootIndex}|char|${charIndex}|${context.seed}`),
          "--from-center": fromCenter(charIndex, charCount),
        }),
      ]);
      charIndex += 1;
    });
  });

  const existing = attr(root, "style");
  const counts = styleOf({ "--char-count": charCount, "--word-count": wordCount });
  const attrs = root.attrs.filter(([name]) => name !== "style");
  attrs.push(["style", existing == null || existing.trim() === "" ? counts : `${existing.replace(/;\s*$/, "")};${counts}`]);
  return { ...root, attrs, children };
}

/**
 * Apply every `data-split` in the tree. Returns new nodes; the input is never
 * mutated, so a mounted program can keep its base tree and re-split it when a
 * text parameter changes.
 */
export function splitTree(nodes: SafeNode[], context: SplitContext): SafeNode[] {
  let rootIndex = 0;
  const visit = (node: SafeNode): SafeNode => {
    if (node.kind === "text") {
      return node;
    }
    const request = node.ns === "html" ? parseSplit(attr(node, "data-split")) : null;
    if (request != null) {
      const index = rootIndex;
      rootIndex += 1;
      return splitRoot({ ...node, attrs: node.attrs.map((a) => [a[0], a[1]] as [string, string]) }, request, index, context);
    }
    return { ...node, children: node.children.map(visit) };
  };
  return nodes.map(visit);
}

/** Whether any element in the tree asks for lines, which the host has to measure. */
export function wantsLines(nodes: SafeNode[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "element") {
      continue;
    }
    if (node.ns === "html" && parseSplit(attr(node, "data-split"))?.lines === true) {
      return true;
    }
    if (wantsLines(node.children)) {
      return true;
    }
  }
  return false;
}

/**
 * Put each text parameter's value into its `[data-param]` element, replacing
 * whatever placeholder text the markup carried. Elements the program did not
 * mark are untouched.
 */
export function fillTextSlots(nodes: SafeNode[], texts: Record<string, string>): SafeNode[] {
  const visit = (node: SafeNode): SafeNode => {
    if (node.kind === "text") {
      return node;
    }
    const key = attr(node, "data-param");
    if (key != null && Object.hasOwnProperty.call(texts, key)) {
      return { ...node, children: [{ kind: "text", text: texts[key] }] };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return nodes.map(visit);
}
