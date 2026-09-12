/**
 * The sidecar protocol, tested without the sidecar.
 *
 * `speechStt.ts` has no Electron in it precisely so this can run under
 * `environment: "node"` — the split `lib/reverse.ts` and `reversePipeline.ts`
 * state. What is worth pinning is the parsing, not the spawning: a pipe that
 * splits mid-word, and the difference between a model download and the
 * transcription, are both invisible in the app until someone watches a first
 * run in a new language.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyEvent,
  createLineReader,
  SpeechError,
  type SpeechStage,
  type SpeechWord,
} from "./speechStt";

describe("createLineReader", () => {
  it("emits whole lines and keeps the tail", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push('{"a":1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);

    reader.push(":3}\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("survives a split inside a multi-byte word", () => {
    // The whole point of the feature is non-ASCII speech, and a pipe will split
    // wherever it likes. Buffering the tail as a string means the decoder has
    // already reassembled it.
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    const payload = JSON.stringify({ type: "word", word: "안녕하세요" });
    reader.push(payload.slice(0, 20));
    expect(lines).toEqual([]);
    reader.push(payload.slice(20) + "\n");

    expect(JSON.parse(lines[0]).word).toBe("안녕하세요");
  });

  it("ignores blank lines and flushes an unterminated one", () => {
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line));

    reader.push("\n\n  \n{}\n{\"last\":1}");
    expect(lines).toEqual(["{}"]);

    reader.flush();
    expect(lines).toEqual(["{}", '{"last":1}']);

    // Flushing twice must not re-emit.
    reader.flush();
    expect(lines).toHaveLength(2);
  });
});

describe("applyEvent", () => {
  it("reads a word with its time range and confidence", () => {
    const words: SpeechWord[] = [];
    applyEvent(
      { type: "word", word: "안녕하세요.", startMs: 0, endMs: 840, confidence: 0.94899999 },
      { onWord: (word) => words.push(word) },
    );

    expect(words).toEqual([
      { word: "안녕하세요.", startMs: 0, endMs: 840, confidence: 0.95 },
    ]);
  });

  it("omits confidence rather than inventing one", () => {
    // The same rule `segments.ts` states: a fabricated confidence cannot be told
    // apart from a measured one.
    const words: SpeechWord[] = [];
    applyEvent({ type: "word", word: "one", startMs: 0, endMs: 100 }, { onWord: (w) => words.push(w) });

    expect(words[0]).not.toHaveProperty("confidence");
  });

  it("drops a word with no text", () => {
    const onWord = vi.fn();
    applyEvent({ type: "word", word: "", startMs: 0, endMs: 10 }, { onWord });
    expect(onWord).not.toHaveBeenCalled();
  });

  it("separates a model download from the transcription", () => {
    const seen: Array<[number, SpeechStage]> = [];
    const sink = { onProgress: (f: number, s: SpeechStage) => seen.push([f, s]) };

    applyEvent({ type: "assets", phase: "downloading", fraction: 0.42 }, sink);
    applyEvent({ type: "progress", fraction: 0.5 }, sink);

    expect(seen).toEqual([
      [0.42, "downloading"],
      [0.5, "transcribing"],
    ]);
  });

  it("keeps the sidecar's error code", () => {
    let caught: SpeechError | null = null;
    applyEvent(
      { type: "error", code: "unsupported_locale", message: "xx-XX is not supported" },
      { onError: (error) => (caught = error) },
    );

    expect(caught).toBeInstanceOf(SpeechError);
    expect(caught!.code).toBe("unsupported_locale");
  });

  it("ignores an event type it does not know", () => {
    const sink = { onWord: vi.fn(), onProgress: vi.fn(), onError: vi.fn(), onDone: vi.fn() };
    applyEvent({ type: "something-new" }, sink);
    applyEvent(null, sink);

    expect(sink.onWord).not.toHaveBeenCalled();
    expect(sink.onError).not.toHaveBeenCalled();
  });
});
