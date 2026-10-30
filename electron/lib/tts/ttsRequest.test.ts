/**
 * The request rule both builds apply where a request is received.
 *
 * Each case is a value the engine must never see: a voice with no style file,
 * a step count that clips, a speed that lays a sentence into no time at all.
 */

import { describe, expect, it } from "vitest";

import { MAX_STEPS, MIN_STEPS, coerceRequest } from "./ttsRequest";

describe("coerceRequest", () => {
  it("passes a usable request through unchanged", () => {
    expect(
      coerceRequest({ text: "Hi.", voice: "F2", lang: "ko", speed: 1.2, steps: 8 }),
    ).toEqual({ text: "Hi.", voice: "F2", lang: "ko", speed: 1.2, steps: 8 });
  });

  it("answers defaults for an empty request rather than throwing", () => {
    expect(coerceRequest({})).toEqual({
      text: "",
      voice: "M1",
      lang: "na",
      speed: 1.05,
      steps: MIN_STEPS,
    });
  });

  it("refuses a voice there is no style file for", () => {
    expect(coerceRequest({ voice: "../../etc/passwd" }).voice).toBe("M1");
    expect(coerceRequest({ voice: "M6" }).voice).toBe("M1");
  });

  it("keeps the step count inside the range the model behaves in", () => {
    expect(coerceRequest({ steps: 2 }).steps).toBe(MIN_STEPS);
    expect(coerceRequest({ steps: 40 }).steps).toBe(MAX_STEPS);
    expect(coerceRequest({ steps: 5.4 }).steps).toBe(5);
    expect(coerceRequest({ steps: Number.NaN }).steps).toBe(MIN_STEPS);
  });

  it("clamps the speed and ignores one that is not a number", () => {
    expect(coerceRequest({ speed: 0 }).speed).toBe(0.5);
    expect(coerceRequest({ speed: 9 }).speed).toBe(2);
    expect(coerceRequest({ speed: "fast" }).speed).toBe(1.05);
    expect(coerceRequest({ speed: Number.POSITIVE_INFINITY }).speed).toBe(1.05);
  });

  it("takes a language from a locale", () => {
    expect(coerceRequest({ lang: "ko-KR" }).lang).toBe("ko");
  });
});
