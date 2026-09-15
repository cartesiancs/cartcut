/**
 * Turning a piece of writing into the token ids Supertonic was trained on.
 *
 * No imports, on purpose, for the reason `features/project/assetPaths.ts` has
 * none: everything here is decidable from its arguments, so it runs under
 * `environment: "node"` with no Electron and no filesystem behind it.
 *
 * The model has no phonemizer. Text is normalised, wrapped in a language tag
 * and mapped codepoint by codepoint through `unicode_indexer.json`. That is
 * what lets Korean work without a G2P, and it is also why the normalisation
 * below has to match the training pipeline exactly: a stray character that
 * indexes differently is not a crash, it is a mispronunciation.
 *
 * Ported from the MIT reference at supertone-oss-archive/supertonic
 * (`nodejs/helper.js`, Copyright (c) 2025 Supertone Inc.). Three deliberate
 * departures from it are marked below, each one a defect in the original.
 */

/** The 31 languages the model states, plus `na` for "do not assume one". */
export const TTS_LANGS = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi",
  "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro",
  "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
] as const;

export type TtsLang = (typeof TTS_LANGS)[number];

/**
 * Validate a language on the way in, the `coerceX` half of the house rule.
 *
 * Answers `na` rather than throwing. An unknown tag reaching the tensor would
 * index to nothing and synthesise silence, which is a far worse way to learn
 * that a locale string was passed where a language code belonged.
 */
export function coerceLang(value: unknown): TtsLang {
  if (typeof value !== "string") {
    return "na";
  }
  // Accept a BCP 47 locale by taking its primary subtag, so "ko-KR" from the
  // transcript side does not have to be trimmed by every caller.
  const primary = value.toLowerCase().split(/[-_]/)[0];
  return (TTS_LANGS as readonly string[]).includes(primary)
    ? (primary as TtsLang)
    : "na";
}

/**
 * How much text goes into one forward pass.
 *
 * Korean and Japanese get 120 rather than 300 because NFKD decomposes their
 * syllables into jamo and kana marks, so one written character becomes two or
 * three token ids. Counting the written characters at 300 would overrun the
 * length the model was trained on.
 */
export function maxChunkChars(lang: TtsLang): number {
  return lang === "ko" || lang === "ja" ? 120 : 300;
}

const EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

/** Characters the model was never shown, mapped to something it was. */
const SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["–", "-"], ["‑", "-"], ["—", "-"],
  ["_", " "],
  ["“", '"'], ["”", '"'],
  ["‘", "'"], ["’", "'"],
  ["´", "'"], ["`", "'"],
  ["[", " "], ["]", " "], ["|", " "], ["/", " "], ["#", " "],
  ["→", " "], ["←", " "],
];

const EXPANSIONS: ReadonlyArray<readonly [string, string]> = [
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];

/** Anything that already closes a sentence. Nothing is appended after these. */
const TERMINAL = /[.!?;:,'")\]}…。」』】〉》›»]$/;

/**
 * Normalise one chunk and wrap it in its language tag.
 *
 * Never throws. This runs on every synthesis and an unusable character has to
 * degrade to a sound, not to an exception, which is the `normalizeX` half of
 * the house rule.
 */
export function normalizeForTts(text: string, lang: TtsLang): string {
  let out = text.normalize("NFKD").replace(EMOJI, "");

  for (const [from, to] of SUBSTITUTIONS) {
    out = out.split(from).join(to);
  }
  out = out.replace(/[♥☆♡©\\]/g, "");
  for (const [from, to] of EXPANSIONS) {
    out = out.split(from).join(to);
  }

  out = out
    .replace(/ ,/g, ",")
    .replace(/ \./g, ".")
    .replace(/ !/g, "!")
    .replace(/ \?/g, "?")
    .replace(/ ;/g, ";")
    .replace(/ :/g, ":")
    .replace(/ '/g, "'");

  out = out.replace(/""+/g, '"').replace(/''+/g, "'").replace(/``+/g, "`");
  out = out.replace(/\s+/g, " ").trim();

  // A chunk with no final punctuation is read as if it runs on, and the last
  // word loses its cadence. The reference appends a period for this reason.
  if (out.length > 0 && !TERMINAL.test(out)) {
    out += ".";
  }

  return `<${lang}>${out}</${lang}>`;
}

/**
 * Split writing into pieces that each fit one forward pass.
 *
 * Paragraphs first, then sentences, then a hard cut.
 *
 * **Departure from the reference.** Its loop starts a new chunk when the next
 * sentence would not fit, but never splits a sentence that does not fit on its
 * own, so one unpunctuated paragraph came back as a single oversized chunk and
 * the model truncated it without saying so. The hard cut below is that case.
 */
export function chunkText(text: string, maxLen: number): string[] {
  const limit = Math.max(1, Math.floor(maxLen));
  const chunks: string[] = [];

  for (const paragraph of text.trim().split(/\n\s*\n+/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const sentences = trimmed.split(
      /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/,
    );

    let current = "";
    const flush = () => {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
    };

    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= limit) {
        current += (current.length > 0 ? " " : "") + sentence;
        continue;
      }
      flush();
      // One sentence longer than a whole pass. Cut it on a space where there
      // is one so a word is not severed, and mid-word only as a last resort.
      let rest = sentence.trim();
      while (rest.length > limit) {
        const window = rest.slice(0, limit + 1);
        const space = window.lastIndexOf(" ");
        const cut = space > limit * 0.5 ? space : limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
    }
    flush();
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * `unicode_indexer.json` as it is read back: codepoint to token id.
 *

/**
 * `unicode_indexer.json` as it is read back.
 *
 * Not a map. It is a dense array of 65,536 entries indexed by **UTF-16 code
 * unit**, which is why the reference reads `charCodeAt(0)` rather than a
 * codepoint: the table is the whole Basic Multilingual Plane, one slot each.
 * A character the model has no token for holds `-1`.
 */
export type UnicodeIndexer = readonly number[];

/** The table covers exactly the BMP, so anything above it has no slot. */
const INDEXER_SIZE = 65536;

/**
 * Read one character's token id, or `-1` if it has none.
 *
 * Bounds-checked because an astral character surviving emoji stripping reads
 * past the end of the table, and `undefined < 0` is false, so an unchecked
 * read would let `undefined` through into the tensor.
 */
function idOf(indexer: UnicodeIndexer, unit: number): number {
  if (unit < 0 || unit >= INDEXER_SIZE) {
    return -1;
  }
  const id = indexer[unit];
  return typeof id === "number" ? id : -1;
}

export type EncodedBatch = {
  /** `[batch, maxLen]`, row-major, ready for an int64 tensor. */
  textIds: number[];
  textIdsDims: readonly number[];
  /** `[batch, 1, maxLen]`, 1 where a token is real. */
  textMask: Float32Array;
  textMaskDims: readonly number[];
};

/**
 * One normalised chunk as token ids.
 *
 * **Departure from the reference.** It writes the table's answer straight into
 * the row, so a character with no token put `-1` into an int64 tensor that the
 * model then uses as an embedding index. Unrepresentable characters are
 * dropped here instead: they carry no sound the model can make, and dropping
 * them keeps the mask describing tokens that actually exist.
 *
 * Normalising first is what makes this rare. Precomposed Hangul has no slot of
 * its own, so without the NFKD pass in `normalizeForTts` every Korean syllable
 * would be dropped and the result would be silence.
 */
export function encodeChunk(
  text: string,
  lang: TtsLang,
  indexer: UnicodeIndexer,
): number[] {
  const normalized = normalizeForTts(text, lang);
  const ids: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const id = idOf(indexer, normalized.charCodeAt(i));
    if (id >= 0) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Pad a batch of chunks to one rectangle, with the mask that says where the
 * real tokens stop.
 *
 * **Departure from the reference.** It measured the mask from the string's
 * UTF-16 `.length` but built the row from a codepoint walk, so a surviving
 * astral character made the mask one longer than the ids and marked a padding
 * slot as real speech. Both come from the ids here.
 *
 * Padding is 0, which is also a real token id. That is safe only because the
 * mask is what the model reads to find the end, so the padding is never
 * attended to. Do not change one without the other.
 */
export function encodeBatch(
  texts: readonly string[],
  langs: readonly TtsLang[],
  indexer: UnicodeIndexer,
): EncodedBatch {
  const rows = texts.map((text, index) =>
    encodeChunk(text, langs[index] ?? "na", indexer),
  );
  const batch = rows.length;
  const maxLen = rows.reduce((longest, row) => Math.max(longest, row.length), 0);

  const textIds = new Array<number>(batch * maxLen).fill(0);
  const textMask = new Float32Array(batch * maxLen);

  rows.forEach((row, b) => {
    const offset = b * maxLen;
    for (let i = 0; i < row.length; i++) {
      textIds[offset + i] = row[i];
      textMask[offset + i] = 1;
    }
  });

  return {
    textIds,
    textIdsDims: [batch, maxLen],
    textMask,
    textMaskDims: [batch, 1, maxLen],
  };
}
