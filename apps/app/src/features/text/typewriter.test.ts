/**
 * The one-click typewriter.
 *
 * What is pinned here is that it is a *composition*: it leaves behind exactly
 * the reveal and the two keyframes a user could have placed by hand, so that
 * the curve editor, the stopwatch and undo all work on it without knowing it
 * came from a button.
 */

import { describe, expect, it } from "vitest";

import { imageElement, textElement } from "../renderer/testing";
import { sampleBaked } from "../animation/keyframes";
import { addKeyframe } from "../animation/keyframeOps";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "../timeline/tracks";
import { revealRefOf, setClipTextReveal } from "../timeline/textRevealOps";
import {
  DEFAULT_TYPEWRITER_UNITS_PER_SECOND,
  applyTypewriter,
  typewriterUnitCount,
} from "./typewriter";

function doc(text = "hello world"): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      a: textElement({ trackId: "v1", startTime: 4000, duration: 2000, text }),
      picture: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
    },
  };
}

const keys = (d: TimelineDocument, id = "a") =>
  (d.elements[id] as any).animation.revealProgress.x.map((k: any) => k.p);

describe("applyTypewriter", () => {
  it("leaves a reveal and exactly two keyframes", () => {
    const next = applyTypewriter(doc(), "a", { durationMs: 900 });
    expect(revealRefOf(next, "a")?.unit).toBe("character");
    expect(keys(next)).toEqual([
      [0, 0],
      [900, 100],
    ]);
  });

  it("switches the track on, so the keyframes are what is drawn", () => {
    const next = applyTypewriter(doc(), "a", { durationMs: 900 });
    expect((next.elements.a as any).animation.revealProgress.isActivate).toBe(
      true,
    );
  });

  it("times keyframes element-locally, not from the timeline", () => {
    // The clip starts at 4000ms; `0` here is the clip's own start, which is the
    // convention every op in `keyframeOps` works in.
    const next = applyTypewriter(doc(), "a", { durationMs: 500 });
    expect(keys(next)[0][0]).toBe(0);
  });

  it("starts where it is anchored", () => {
    const next = applyTypewriter(doc(), "a", {
      durationMs: 500,
      startAtMs: 300,
    });
    expect(keys(next)).toEqual([
      [300, 0],
      [800, 100],
    ]);
  });

  it("compresses near the clip's end rather than sliding back", () => {
    // Sliding the anchor would start the typing somewhere nobody clicked, which
    // is the one thing an anchor is for. `applyPreset` makes the same choice.
    const next = applyTypewriter(doc(), "a", {
      durationMs: 5000,
      startAtMs: 1500,
    });
    expect(keys(next)).toEqual([
      [1500, 0],
      [2000, 100],
    ]);
  });

  it("types at a constant speed by default", () => {
    // Not decoration: `addKeyframe` gives every anchor a 100ms handle, so two
    // keyframes with nothing written over them describe an ease-in-out — typing
    // that starts slow, races, then dawdles. Asserted on the baked lane rather
    // than on the handles, because constant speed is the thing that matters and
    // a linear curve's handles collapse onto its anchors.
    const next = applyTypewriter(doc(), "a", { durationMs: 1000 });
    const baked = (next.elements.a as any).animation.revealProgress.ax;
    for (const at of [250, 500, 750]) {
      expect(sampleBaked(baked, at, 0)).toBeCloseTo(at / 10, 0);
    }
  });

  it("curves the one segment when asked to", () => {
    const next = applyTypewriter(doc(), "a", {
      durationMs: 1000,
      easing: "ease_in",
    });
    const baked = (next.elements.a as any).animation.revealProgress.ax;
    // Ease-in is behind the straight line at the half-way mark, which is what
    // proves the easing reached the curve rather than being dropped.
    expect(sampleBaked(baked, 500, 0)).toBeLessThan(45);
    expect(sampleBaked(baked, 1000, 0)).toBeCloseTo(100, 5);
  });

  it("derives a duration from a speed when given one", () => {
    // "hello world" is eleven characters, so six per second is 11/6 seconds.
    const next = applyTypewriter(doc(), "a", { unitsPerSecond: 6 });
    expect(keys(next)[1][0]).toBeCloseTo((11 / 6) * 1000, 5);
  });

  it("falls back to a readable typing speed", () => {
    const next = applyTypewriter(doc(), "a", {});
    expect(keys(next)[1][0]).toBeCloseTo(
      (11 / DEFAULT_TYPEWRITER_UNITS_PER_SECOND) * 1000,
      5,
    );
  });

  it("counts in whatever unit it was asked for", () => {
    const next = applyTypewriter(doc(), "a", {
      unit: "word",
      unitsPerSecond: 2,
    });
    expect(revealRefOf(next, "a")?.unit).toBe("word");
    expect(keys(next)[1][0]).toBeCloseTo(1000, 5);
  });

  it("keeps a unit already chosen when none is named", () => {
    const before = setClipTextReveal(doc(), "a", "line");
    const next = applyTypewriter(before, "a", { durationMs: 400 });
    expect(revealRefOf(next, "a")?.unit).toBe("line");
  });

  it("replaces what the track held rather than adding to it", () => {
    // A second click on "Typewriter" gives a clean one, not two moves fighting.
    let next = applyTypewriter(doc(), "a", { durationMs: 900 });
    next = addKeyframe(next, "a", "revealProgress", "x", 450, 30);
    expect(keys(next)).toHaveLength(3);
    next = applyTypewriter(next, "a", { durationMs: 600 });
    expect(keys(next)).toEqual([
      [0, 0],
      [600, 100],
    ]);
  });

  it("declines by identity for a clip it cannot type", () => {
    const d = doc();
    expect(applyTypewriter(d, "picture", { durationMs: 100 })).toBe(d);
    expect(applyTypewriter(d, "nope", { durationMs: 100 })).toBe(d);
  });
});

describe("typewriterUnitCount", () => {
  it("counts across hard line breaks", () => {
    const element = textElement({ text: "ab\ncd" });
    expect(typewriterUnitCount(element, "character")).toBe(4);
    expect(typewriterUnitCount(element, "line")).toBe(2);
  });

  it("counts what will be drawn, not what was typed", () => {
    // `displayTextOf` applies `textTransform` before measurement, and the same
    // string is what the renderer segments.
    const element = textElement({
      text: "ab",
      options: { ...textElement().options, textTransform: "uppercase" },
    });
    expect(typewriterUnitCount(element, "character")).toBe(2);
  });

  it("answers zero for anything that is not text", () => {
    expect(typewriterUnitCount(imageElement(), "character")).toBe(0);
    expect(typewriterUnitCount(null, "character")).toBe(0);
  });
});
