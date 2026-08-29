/**
 * The shape of a transcript, and how words become caption-sized lines.
 *
 * Pure, and here rather than in `../transcribe.ts` for the same reason
 * `signal.ts` is: that module constructs an `electron-store` and reaches
 * `electron-is-dev` at load, so nothing in it can be unit tested. The grouping
 * rule is the part with judgement in it — where a caption breaks decides how
 * every subtitle in a project reads — so it is the part that has to be cheap to
 * test.
 *
 * Times throughout are **source-file** milliseconds. Putting them on the
 * timeline is the renderer's job (`map_transcript`), because only it knows the
 * clip's trim and speed.
 */

/** One recognised word. */
export type TranscriptWord = {
  word: string;
  startMs: number;
  endMs: number;
  /**
   * 0..1, when the back end reports one.
   *
   * WhisperX returns a per-word `score` and the OpenAI API does not, so this is
   * absent rather than invented for the latter — a fabricated confidence is
   * worse than none, because a caller cannot tell it apart from a measured one.
   */
  confidence?: number;
  /** Diarisation label, when the back end does diarisation. */
  speaker?: string;
};

/** A run of words. */
export type TranscriptSegment = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  speaker?: string;
};

/** A caption line stops growing at any of these. */
export const MAX_CHARS = 42;
export const MAX_MS = 6000;
/** A pause this long reads as a sentence boundary. */
export const GAP_MS = 700;

/** Mean of the confidences that exist, or undefined if none do. */
function meanConfidence(words: TranscriptWord[]): number | undefined {
  const scored = words.filter((w) => typeof w.confidence === "number");
  if (scored.length === 0) {
    return undefined;
  }
  const total = scored.reduce((sum, w) => sum + (w.confidence ?? 0), 0);
  return Math.round((total / scored.length) * 100) / 100;
}

/**
 * Group words into caption-sized lines.
 *
 * Breaks on a long pause, on length, on duration, on sentence-final
 * punctuation — and on a **change of speaker**, which is not a nicety: a line
 * carrying two people's words is wrong as a caption however well it fits, and a
 * segment list that cannot be attributed is no use for cutting between takes.
 */
export function segmentWords(words: TranscriptWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const confidence = meanConfidence(current);
    const speaker = current[0].speaker;
    segments.push({
      text: current
        .map((w) => w.word)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      ...(confidence != null ? { confidence } : {}),
      ...(speaker != null ? { speaker } : {}),
    });
    current = [];
  };

  for (const word of words) {
    if (current.length > 0) {
      const previous = current[current.length - 1];
      const gap = word.startMs - previous.endMs;
      const chars = current.reduce((n, w) => n + w.word.length + 1, 0);
      const span = word.endMs - current[0].startMs;
      const endsSentence = /[.!?。？！]$/.test(previous.word);
      const speakerChanged = word.speaker !== previous.speaker;

      if (
        speakerChanged ||
        gap >= GAP_MS ||
        chars >= MAX_CHARS ||
        span >= MAX_MS ||
        endsSentence
      ) {
        flush();
      }
    }
    current.push(word);
  }
  flush();

  return segments;
}

/**
 * A Whisper segment's `avg_logprob` as a rough 0..1 confidence.
 *
 * The OpenAI API reports no per-word score, only this per-segment mean log
 * probability, so exponentiating it is the only confidence available there.
 * It is a coarser thing than WhisperX's per-word score and lives on the segment
 * for exactly that reason — spreading it across the words would dress a
 * sentence-level number up as a word-level one.
 */
export function confidenceFromLogProb(
  avgLogProb: unknown,
): number | undefined {
  if (typeof avgLogProb !== "number" || !Number.isFinite(avgLogProb)) {
    return undefined;
  }
  const value = Math.exp(avgLogProb);
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}
