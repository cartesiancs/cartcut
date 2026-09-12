import { describe, expect, it } from "vitest";
import {
  audioElement,
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { captionToTimeline } from "./timing";

/**
 * The conversion a caption makes on its way out of the auto-caption panel.
 *
 * This is the one extracted caption module that had no suite, and it is the
 * half the preview cannot check: `preview.test.ts` proves the panel *paints*
 * what gets placed, and this proves it gets placed at the right *time*. Between
 * them they cover the two ways a caption can be wrong.
 *
 * Every case here is expressed as "a word spoken at source time X appears at
 * timeline time Y", because that is the only sentence the conversion is trying
 * to make true.
 */

/** A caption in the source file's own clock, which is what a transcript gives. */
const at = (startTime: number, duration: number) => ({ startTime, duration });

describe("captionToTimeline without a source window", () => {
  it("rounds and clamps when there is no source at all", () => {
    // `sourceKey` resolved to nothing — a clip deleted while the panel was open.
    // The timings are already timeline times as far as anything here can tell.
    expect(captionToTimeline(at(1234.6, 500.4), undefined)).toEqual({
      startTime: 1235,
      duration: 500,
    });
  });

  it("takes the same branch for a static element, which has no trim", () => {
    // text/image/shape/group/effect/transition/template are all "static" in
    // `utils/element.ts`'s sense: no `trim` window and no `speed`, so there is
    // no source clock to convert out of.
    for (const source of [textElement(), imageElement()]) {
      expect(captionToTimeline(at(1000, 500), source)).toEqual({
        startTime: 1000,
        duration: 500,
      });
    }
  });
});

describe("captionToTimeline through a dynamic clip", () => {
  it("is the identity for an untrimmed 1x clip at the start of the timeline", () => {
    const source = videoElement({
      startTime: 0,
      trim: { startTime: 0, endTime: 4000 },
      speed: 1,
    });

    expect(captionToTimeline(at(1000, 500), source)).toEqual({
      startTime: 1000,
      duration: 500,
    });
  });

  it("subtracts the trim offset", () => {
    // The clip shows source 2000..6000. A word at source 3000 is one second
    // into the clip, so it lands at timeline 1000 — not at 3000, which is what
    // a conversion missing the trim term would give.
    const source = videoElement({
      startTime: 0,
      trim: { startTime: 2000, endTime: 6000 },
    });

    expect(captionToTimeline(at(3000, 1000), source)).toEqual({
      startTime: 1000,
      duration: 1000,
    });
  });

  it("adds where the clip itself sits on the timeline", () => {
    const source = videoElement({
      startTime: 5000,
      trim: { startTime: 0, endTime: 4000 },
    });

    expect(captionToTimeline(at(1000, 500), source)).toEqual({
      startTime: 6000,
      duration: 500,
    });
  });

  it("adds the offset and subtracts the trim together", () => {
    const source = videoElement({
      startTime: 5000,
      trim: { startTime: 2000, endTime: 6000 },
    });

    // Source 3000 is 1000 into the window, and the window starts at 5000.
    expect(captionToTimeline(at(3000, 1000), source)).toEqual({
      startTime: 6000,
      duration: 1000,
    });
  });

  it("takes an audio clip through the same branch as a video one", () => {
    // The panel transcribes detached sound too, and audio is "dynamic".
    const source = audioElement({
      startTime: 1000,
      trim: { startTime: 500, endTime: 4000 },
    });

    expect(captionToTimeline(at(1500, 500), source)).toEqual({
      startTime: 2000,
      duration: 500,
    });
  });
});

describe("captionToTimeline and speed", () => {
  it("compresses a caption on a sped-up clip", () => {
    // At 2x, one second of speech occupies half a second of timeline. A
    // conversion that moved the start but left the duration alone would leave
    // every caption twice as long as the words it covers.
    const source = videoElement({ speed: 2, trim: { startTime: 0, endTime: 8000 } });

    expect(captionToTimeline(at(1000, 1000), source)).toEqual({
      startTime: 500,
      duration: 500,
    });
  });

  it("stretches a caption on a slowed clip", () => {
    const source = videoElement({ speed: 0.5, trim: { startTime: 0, endTime: 4000 } });

    expect(captionToTimeline(at(1000, 1000), source)).toEqual({
      startTime: 2000,
      duration: 2000,
    });
  });

  it("converts both edges rather than scaling the duration", () => {
    // `timing.ts` converts start and end separately and subtracts. The result
    // agrees with duration/speed for this linear map, which is the point: the
    // edges are what have to line up with the words, and deriving the duration
    // from them cannot drift from where they landed.
    const source = videoElement({
      startTime: 7000,
      speed: 4,
      trim: { startTime: 1000, endTime: 20000 },
    });
    const result = captionToTimeline(at(5000, 2000), source);

    // start = 7000 + (5000-1000)/4 = 8000;  end = 7000 + (7000-1000)/4 = 8500
    expect(result).toEqual({ startTime: 8000, duration: 500 });
  });

  it("treats a speed of zero, a negative speed and a missing one as 1x", () => {
    // `geometry.ts#speedOf` guards this, and a zero would otherwise divide by
    // zero and put the caption at Infinity.
    for (const speed of [0, -2, undefined, NaN] as const) {
      const source = videoElement({
        trim: { startTime: 0, endTime: 4000 },
        speed: speed as number,
      });
      expect(captionToTimeline(at(1000, 500), source)).toEqual({
        startTime: 1000,
        duration: 500,
      });
    }
  });
});

describe("captionToTimeline clamps", () => {
  it("pins a caption that starts before the trim window to zero", () => {
    // The transcript covers the whole file, so a clip trimmed to start at 2s
    // has words at source 0 that belong nowhere on the timeline. Clamping is
    // what stops a negative `startTime` reaching the store.
    const source = videoElement({
      startTime: 0,
      trim: { startTime: 2000, endTime: 6000 },
    });

    expect(captionToTimeline(at(0, 500), source).startTime).toBe(0);
  });

  it("never emits a duration below 1ms", () => {
    const source = videoElement({ trim: { startTime: 0, endTime: 4000 } });

    expect(captionToTimeline(at(1000, 0), source).duration).toBe(1);
    expect(captionToTimeline(at(1000, 0), undefined).duration).toBe(1);
    // 1ms of speech at 8x rounds to nothing, and still has to be placeable.
    const fast = videoElement({ speed: 8, trim: { startTime: 0, endTime: 32000 } });
    expect(captionToTimeline(at(1000, 1), fast).duration).toBe(1);
  });

  it("rounds to whole milliseconds on both fields", () => {
    // Timeline times are integer ms everywhere else, so a third of a
    // millisecond must not survive into the document.
    const source = videoElement({ speed: 3, trim: { startTime: 0, endTime: 12000 } });
    const result = captionToTimeline(at(1000, 1000), source);

    // start = 1000/3 = 333.33 -> 333;  end = 2000/3 = 666.67;  end-start -> 333
    expect(result).toEqual({ startTime: 333, duration: 333 });
    expect(Number.isInteger(result.startTime)).toBe(true);
    expect(Number.isInteger(result.duration)).toBe(true);
  });

  it("rounds the start and the length independently", () => {
    // `duration` is `round(end - start)`, not `round(end) - round(start)`, so
    // `startTime + duration` is not guaranteed to be `round(end)`. Pinned
    // because it looks like an inconsistency and is the behaviour today.
    const source = videoElement({ speed: 3, trim: { startTime: 0, endTime: 12000 } });
    const { startTime, duration } = captionToTimeline(at(1000, 1000), source);

    expect(startTime + duration).toBe(666);
    expect(Math.round((1000 + 1000) / 3)).toBe(667);
  });
});
