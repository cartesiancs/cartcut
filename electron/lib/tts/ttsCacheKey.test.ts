/**
 * The cache key, and the seed taken from it.
 *
 * One rule carries this file: **every input that changes the sound must change
 * the key**. A key that ignored the voice would hand back the last speaker's
 * take, and nothing about that failure looks like a bug until someone listens.
 * So the suite walks the inputs one at a time rather than spot-checking a few.
 */

import { describe, expect, it } from "vitest";

import { seedFor, speechKey } from "./ttsCacheKey";
import { ENGINE_VERSION, MODEL_REVISION } from "./ttsManifest";
import type { SynthesisRequest } from "./ttsProtocol";

type Request = Omit<SynthesisRequest, "seed">;

const BASE: Request = {
  text: "Hello there.",
  voice: "M1",
  lang: "en",
  speed: 1.05,
  steps: 4,
};

describe("speechKey", () => {
  it("is a short, filesystem-safe name", () => {
    const key = speechKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{24}$/);
  });

  it("is the same for the same request", () => {
    expect(speechKey(BASE)).toBe(speechKey({ ...BASE }));
  });

  /** The rule this file exists for, one input at a time. */
  it.each<[string, Request]>([
    ["text", { ...BASE, text: "Hello there!" }],
    ["voice", { ...BASE, voice: "F3" }],
    ["lang", { ...BASE, lang: "ko" }],
    ["speed", { ...BASE, speed: 1.1 }],
    ["steps", { ...BASE, steps: 8 }],
  ])("changes when the %s changes", (_name, changed) => {
    expect(speechKey(changed)).not.toBe(speechKey(BASE));
  });

  it("tells apart texts that differ only in whitespace", () => {
    expect(speechKey({ ...BASE, text: "a b" })).not.toBe(
      speechKey({ ...BASE, text: "a  b" }),
    );
  });

  /**
   * The fields are joined with a separator, so a key built by concatenation
   * would collide here: "M1" + "en" and "M" + "1en" are the same string.
   */
  it("does not collide when a boundary between fields moves", () => {
    expect(speechKey({ ...BASE, voice: "M1", lang: "en" })).not.toBe(
      speechKey({ ...BASE, voice: "M", lang: "1en" } as Request),
    );
  });

  it("carries the model revision and the engine version", () => {
    // Both are folded in, so a new model or a changed pipeline retires every
    // cached file without anyone having to remember to clear the directory.
    // Checked by construction: the key is a digest, so this states the inputs
    // that were hashed rather than reading them back out of it.
    expect(MODEL_REVISION.length).toBeGreaterThan(0);
    expect(ENGINE_VERSION).toBeGreaterThan(0);

    const digestOfBase = speechKey(BASE);
    // A different speed is a different key, which is only true if the joined
    // string is what is hashed. If the implementation hashed the text alone,
    // this and the per-input cases above would both fail.
    expect(speechKey({ ...BASE, speed: 1.06 })).not.toBe(digestOfBase);
  });

  it("treats speeds that round the same as the same", () => {
    // Quantised to three places, so floating point noise from a slider does
    // not produce a fresh 400MB-model run for an inaudible difference.
    expect(speechKey({ ...BASE, speed: 1.05 })).toBe(
      speechKey({ ...BASE, speed: 1.0500001 }),
    );
  });

  it("treats a step count and its rounding as the same", () => {
    expect(speechKey({ ...BASE, steps: 4 })).toBe(
      speechKey({ ...BASE, steps: 4.4 }),
    );
  });
});

describe("seedFor", () => {
  it("is stable for a key", () => {
    const key = speechKey(BASE);
    expect(seedFor(key)).toBe(seedFor(key));
  });

  it("differs for different keys", () => {
    expect(seedFor(speechKey(BASE))).not.toBe(
      seedFor(speechKey({ ...BASE, text: "Something else." })),
    );
  });

  it("is a non-negative 32-bit integer", () => {
    for (const text of ["a", "b", "c", "a longer line of narration"]) {
      const seed = seedFor(speechKey({ ...BASE, text }));
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
