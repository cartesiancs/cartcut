import { describe, expect, it } from "vitest";
import { unitBoundaries } from "../text/reveal";
import { sanitizeHtml, serializeSafeNodes, type SafeNode } from "./sanitizeHtml";
import {
  fillTextSlots,
  fromCenter,
  graphemes,
  joinsLetters,
  parseSplit,
  randOf,
  splitTree,
  tokenize,
  wantsLines,
} from "./split";

const CONTEXT = { programHash: "abc", seed: 0 };

function nodes(html: string): SafeNode[] {
  return sanitizeHtml(html, { assetNames: new Set() }).nodes;
}

function spans(tree: SafeNode[], className: string): Array<SafeNode & { kind: "element" }> {
  const out: Array<SafeNode & { kind: "element" }> = [];
  const visit = (node: SafeNode) => {
    if (node.kind !== "element") return;
    if (node.attrs.some(([n, v]) => n === "class" && v === className)) out.push(node);
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return out;
}

function textOf(node: SafeNode): string {
  return node.kind === "text" ? node.text : node.children.map(textOf).join("");
}

function style(node: SafeNode & { kind: "element" }): string {
  return node.attrs.find(([n]) => n === "style")?.[1] ?? "";
}

describe("parseSplit", () => {
  it("reads any combination and ignores the rest", () => {
    expect(parseSplit("chars")).toEqual({ chars: true, words: false, lines: false });
    expect(parseSplit("lines words chars")).toEqual({ chars: true, words: true, lines: true });
    expect(parseSplit("nothing")).toBeNull();
    expect(parseSplit(null)).toBeNull();
  });
});

describe("tokenize", () => {
  it("keeps whitespace out of words and punctuation with the word before it", () => {
    expect(tokenize("Hello, big  world!")).toEqual([
      { word: true, text: "Hello," },
      { word: false, text: " " },
      { word: true, text: "big" },
      { word: false, text: "  " },
      { word: true, text: "world!" },
    ]);
  });

  it("takes Korean words by the space between them", () => {
    expect(tokenize("안녕하세요 세계").filter((t) => t.word).map((t) => t.text)).toEqual([
      "안녕하세요",
      "세계",
    ]);
  });
});

describe("graphemes", () => {
  it("never splits an emoji or a combining mark, and agrees with the reveal", () => {
    const word = "e\u0301👍🏽한";
    expect(graphemes(word)).toEqual(["e\u0301", "👍🏽", "한"]);
    const ends = unitBoundaries(word, "character");
    expect(graphemes(word).map((g) => g.length).reduce((a, b) => a + b, 0)).toBe(
      ends[ends.length - 1],
    );
  });
});

describe("splitTree", () => {
  it("wraps letters in words, with indices, counts and a stable rand", () => {
    const tree = splitTree(nodes('<h1 data-split="chars">Hi you</h1>'), CONTEXT);
    const words = spans(tree, "word");
    const chars = spans(tree, "char");
    expect(words.map(textOf)).toEqual(["Hi", "you"]);
    expect(chars.map(textOf)).toEqual(["H", "i", "y", "o", "u"]);
    expect(style(chars[2])).toMatch(/--char-index:2;--char-in-word:0;--rand:[0-9.]+;--from-center:0(;|$)/);
    expect(style(tree[0] as any)).toMatch(/--char-count:5;--word-count:2/);
    // The space is a text node between the word spans, not inside one.
    expect(serializeSafeNodes(tree)).toMatch(/<\/span><\/span> <span class="word"/);
  });

  it("is deterministic and depends on the seed, not on anything else", () => {
    const a = splitTree(nodes('<p data-split="chars">abc</p>'), CONTEXT);
    const b = splitTree(nodes('<p data-split="chars">abc</p>'), CONTEXT);
    const c = splitTree(nodes('<p data-split="chars">abc</p>'), { ...CONTEXT, seed: 1 });
    expect(serializeSafeNodes(a)).toBe(serializeSafeNodes(b));
    expect(serializeSafeNodes(a)).not.toBe(serializeSafeNodes(c));
  });

  it("splits words only when asked for words only", () => {
    const tree = splitTree(nodes('<p data-split="words">a b</p>'), CONTEXT);
    expect(spans(tree, "word")).toHaveLength(2);
    expect(spans(tree, "char")).toHaveLength(0);
  });

  it("does not split an Arabic word into letters", () => {
    expect(joinsLetters("مرحبا")).toBe(true);
    const tree = splitTree(nodes('<p data-split="chars">مرحبا hi</p>'), CONTEXT);
    expect(spans(tree, "char").map(textOf)).toEqual(["h", "i"]);
    expect(spans(tree, "word").map(textOf)).toEqual(["مرحبا", "hi"]);
  });

  it("keeps a nested element's styling and runs the counters across it", () => {
    const tree = splitTree(nodes('<p data-split="chars">a<strong>bc</strong></p>'), CONTEXT);
    const chars = spans(tree, "char");
    expect(chars.map(textOf)).toEqual(["a", "b", "c"]);
    expect(style(chars[2])).toMatch(/--char-index:2/);
    expect(serializeSafeNodes(tree)).toMatch(/<strong>/);
  });

  it("leaves SVG text whole", () => {
    const tree = splitTree(nodes('<div data-split="chars"><svg><text>abc</text></svg></div>'), CONTEXT);
    expect(spans(tree, "char")).toHaveLength(0);
  });

  it("does not mutate its input", () => {
    const input = nodes('<p data-split="chars">ab</p>');
    const before = JSON.stringify(input);
    splitTree(input, CONTEXT);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("fillTextSlots and wantsLines", () => {
  it("replaces a slot's placeholder and leaves everything else", () => {
    const tree = fillTextSlots(nodes('<h1 data-param="title">Placeholder</h1><p>keep</p>'), {
      title: "Real <b>text</b>",
    });
    expect(serializeSafeNodes(tree)).toBe(
      '<h1 data-param="title">Real &lt;b&gt;text&lt;/b&gt;</h1><p>keep</p>',
    );
  });

  it("reports whether the host has to measure lines", () => {
    expect(wantsLines(nodes('<p data-split="lines words">a</p>'))).toBe(true);
    expect(wantsLines(nodes('<p data-split="chars">a</p>'))).toBe(false);
  });
});

describe("randOf and fromCenter", () => {
  it("are in range", () => {
    for (let i = 0; i < 50; i += 1) {
      const r = randOf("k" + i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
    expect(fromCenter(0, 5)).toBe(1);
    expect(fromCenter(2, 5)).toBe(0);
    expect(fromCenter(0, 1)).toBe(0);
  });
});
