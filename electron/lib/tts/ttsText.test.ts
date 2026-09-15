/**
 * The text side of synthesis: normalisation, chunking, and the token table.
 *
 * All of it is decidable from its arguments, so none of these load a model.
 * The cases that matter most are the ones written against defects in the MIT
 * reference this was ported from, each named in the suite below.
 */

import { describe, expect, it } from "vitest";

import {
  chunkText,
  coerceLang,
  encodeBatch,
  encodeChunk,
  maxChunkChars,
  normalizeForTts,
  TTS_LANGS,
  type UnicodeIndexer,
} from "./ttsText";

/**
 * A stand-in for `unicode_indexer.json`: the real thing is a dense array of
 * 65,536 entries indexed by UTF-16 code unit, with `-1` for "no token".
 */
function fakeIndexer(known: string): UnicodeIndexer {
  const table = new Array<number>(65536).fill(-1);
  Array.from(known).forEach((char, index) => {
    table[char.charCodeAt(0)] = index + 1;
  });
  return table;
}

/** Every character the tagged form of a Latin sentence can contain. */
const LATIN = fakeIndexer("<>/enkoabcdefghijklmnpqrstuvwxyz .,!?'\"-");

/** The three conjoining jamo NFKD gives for the syllable U+C548. */
const JAMO_IEUNG = "ᄋ";
const JAMO_A = "ᅡ";
const JAMO_NIEUN = "ᆫ";

describe("coerceLang", () => {
  it("takes the primary subtag of a BCP 47 locale", () => {
    expect(coerceLang("ko-KR")).toBe("ko");
    expect(coerceLang("en_US")).toBe("en");
    expect(coerceLang("KO")).toBe("ko");
  });

  it("answers na rather than throwing on anything unusable", () => {
    expect(coerceLang("klingon")).toBe("na");
    expect(coerceLang(undefined)).toBe("na");
    expect(coerceLang(42)).toBe("na");
    expect(coerceLang("")).toBe("na");
  });

  it("accepts every language the model states", () => {
    for (const lang of TTS_LANGS) {
      expect(coerceLang(lang)).toBe(lang);
    }
  });
});

describe("maxChunkChars", () => {
  /**
   * Not a preference. NFKD splits one Hangul syllable into two or three jamo,
   * so 300 written characters of Korean is far more than 300 tokens and the
   * model silently truncates the tail.
   */
  it("gives Korean and Japanese a shorter window than Latin scripts", () => {
    expect(maxChunkChars("ko")).toBe(120);
    expect(maxChunkChars("ja")).toBe(120);
    expect(maxChunkChars("en")).toBe(300);
    expect(maxChunkChars("na")).toBe(300);
  });
});

describe("normalizeForTts", () => {
  it("wraps the text in its language tag", () => {
    expect(normalizeForTts("Hello.", "en")).toBe("<en>Hello.</en>");
  });

  it("closes a sentence that does not close itself", () => {
    expect(normalizeForTts("Hello", "en")).toBe("<en>Hello.</en>");
    expect(normalizeForTts("Hello!", "en")).toBe("<en>Hello!</en>");
  });

  it("decomposes Hangul, which is what gives Korean its tokens", () => {
    const out = normalizeForTts("안", "ko");
    // U+C548 has no slot of its own in the table; its three jamo do.
    expect(out).not.toContain("안");
    expect(out).toContain(JAMO_IEUNG);
    expect(out).toContain(JAMO_A);
    expect(out).toContain(JAMO_NIEUN);
  });

  it("strips emoji and folds typographic punctuation", () => {
    expect(normalizeForTts("hi \u{1F600} there", "en")).toBe("<en>hi there.</en>");
    expect(normalizeForTts("“quoted”", "en")).toBe('<en>"quoted"</en>');
    expect(normalizeForTts("it’s", "en")).toBe("<en>it's.</en>");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeForTts("a   b\n\nc", "en")).toBe("<en>a b c.</en>");
  });

  it("never throws on input it cannot represent", () => {
    expect(() => normalizeForTts("", "en")).not.toThrow();
    expect(() => normalizeForTts("\u{10FFFF} ", "na")).not.toThrow();
  });
});

describe("chunkText", () => {
  it("keeps a short script whole", () => {
    expect(chunkText("One. Two.", 300)).toEqual(["One. Two."]);
  });

  it("breaks on sentence boundaries before the limit", () => {
    const chunks = chunkText("Aaaa aaaa. Bbbb bbbb. Cccc cccc.", 22);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(22);
    }
  });

  it("does not split on an abbreviation's full stop", () => {
    expect(chunkText("Dr. Kim arrived.", 300)).toEqual(["Dr. Kim arrived."]);
  });

  /**
   * The reference's defect. Its loop only starts a new chunk when the *next*
   * sentence will not fit, so a single sentence longer than the window came
   * back whole and the model truncated it with nothing said.
   */
  it("hard splits one sentence that is longer than a whole pass", () => {
    const long = "word ".repeat(80).trim();
    const chunks = chunkText(long, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    expect(chunks.join(" ").split(/\s+/)).toEqual(long.split(/\s+/));
  });

  it("splits a run with no spaces at all rather than looping forever", () => {
    const chunks = chunkText("x".repeat(250), 100);
    expect(chunks).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });

  it("answers nothing for text with nothing in it", () => {
    expect(chunkText("", 300)).toEqual([]);
    expect(chunkText("   \n\n  ", 300)).toEqual([]);
  });
});

describe("encodeChunk", () => {
  it("maps each character through the table", () => {
    const ids = encodeChunk("ok", "en", LATIN);
    expect(ids.length).toBe("<en>ok.</en>".length);
    expect(ids.every((id) => id > 0)).toBe(true);
  });

  /**
   * The reference's defect. It wrote the table's answer straight into the row,
   * so a character with no token put `-1` into an int64 tensor that the model
   * then used as an embedding index.
   */
  it("drops a character the table has no token for", () => {
    const sparse = fakeIndexer("<>/enab.");
    const ids = encodeChunk("azb", "en", sparse);
    expect(ids).not.toContain(-1);
    expect(ids.every((id) => id >= 0)).toBe(true);
    expect(ids.length).toBe("<en>ab.</en>".length);
  });

  it("drops an astral character rather than reading past the table", () => {
    const ids = encodeChunk("a\u{1D400}b", "en", LATIN);
    expect(ids.every((id) => id >= 0)).toBe(true);
  });
});

describe("encodeBatch", () => {
  it("pads to the longest row and marks only the real tokens", () => {
    const batch = encodeBatch(["ok", "a much longer line"], ["en", "en"], LATIN);
    const [rows, maxLen] = batch.textIdsDims;
    expect(rows).toBe(2);
    expect(batch.textIds.length).toBe(rows * maxLen);
    expect(batch.textMask.length).toBe(rows * maxLen);
    expect(batch.textMaskDims).toEqual([2, 1, maxLen]);

    const firstLen = encodeChunk("ok", "en", LATIN).length;
    expect(batch.textMask[0]).toBe(1);
    expect(batch.textMask[firstLen - 1]).toBe(1);
    expect(batch.textMask[firstLen]).toBe(0);
    expect(batch.textMask[maxLen - 1]).toBe(0);
  });

  /**
   * The reference's defect. It measured the mask from the string's UTF-16
   * length but built the row from a codepoint walk, so a dropped or astral
   * character left the mask one longer than the ids and marked a padding slot
   * as speech.
   */
  it("measures the mask from the ids it actually wrote", () => {
    const sparse = fakeIndexer("<>/enab.");
    const batch = encodeBatch(["azzzb"], ["en"], sparse);
    const written = encodeChunk("azzzb", "en", sparse).length;
    const marked = batch.textMask.reduce((sum, v) => sum + v, 0);
    expect(marked).toBe(written);
  });
});
