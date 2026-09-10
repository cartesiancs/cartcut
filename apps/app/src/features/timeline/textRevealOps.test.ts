/**
 * The reveal's document-level ops.
 *
 * Two things are load-bearing and neither is visible in the picture.
 *
 * **Declining returns the document by identity.** `withCheckpoint` reads
 * identity to mean "nothing happened" and records no undo step, so every
 * decline is asserted with `toBe`, never `toEqual`.
 *
 * **The reveal and its keyframe track are one thing.** `animatableProperties`
 * gates `revealProgress` on `element.reveal` existing, so a track without a
 * reveal is invisible to `resolve`, `setTrackActive`, `rebakeElement`, the
 * curve editor and the diamond lane — while still riding along in every
 * duplicate and every save. A reveal without a track is the mirror failure:
 * the stopwatch clicks and nothing happens.
 */

import { describe, expect, it } from "vitest";

import { animatableProperties } from "../../@types/timeline";
import { emptyAnimation, normalizeAnimation } from "../animation/keyframes";
import { addKeyframe } from "../animation/keyframeOps";
import {
  audioElement,
  imageElement,
  shapeElement,
  textElement,
} from "../renderer/testing";
import { DEFAULT_REVEAL_PROGRESS, revealOf } from "../text/reveal";
import { pasteClips, splitClip, trimClipStart } from "./clipOps";
import {
  REVEALABLE_FILETYPES,
  isRevealable,
  revealRefOf,
  setClipTextReveal,
  setClipTextRevealFields,
  setClipTextRevealFieldsMany,
  setClipTextRevealMany,
} from "./textRevealOps";
import { SCHEMA_VERSION, createTrack, type TimelineDocument } from "./tracks";

function doc(elements: Record<string, any>): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  };
}

const plain = () =>
  doc({
    a: textElement({ trackId: "v1", startTime: 0, duration: 1000 }),
    b: textElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
    picture: imageElement({ trackId: "v1", startTime: 2000, duration: 1000 }),
    sound: audioElement({ trackId: "v1", startTime: 3000, duration: 1000 }),
  });

describe("isRevealable", () => {
  it("covers text and nothing else", () => {
    // A reveal counts units of *text*. A picture has none, and wiping one on is
    // what a mask is for.
    expect([...REVEALABLE_FILETYPES]).toEqual(["text"]);
    expect(isRevealable(textElement())).toBe(true);
    expect(isRevealable(imageElement())).toBe(false);
    expect(isRevealable(shapeElement())).toBe(false);
    expect(isRevealable(audioElement())).toBe(false);
    expect(isRevealable(null)).toBe(false);
    expect(isRevealable(undefined)).toBe(false);
  });
});

describe("setClipTextReveal", () => {
  it("stores the unit and an inert progress", () => {
    const next = setClipTextReveal(plain(), "a", "character");
    expect(revealRefOf(next, "a")).toEqual({
      unit: "character",
      progress: DEFAULT_REVEAL_PROGRESS,
    });
  });

  it("seeds the progress track, empty and switched off", () => {
    const next = setClipTextReveal(plain(), "a", "word");
    expect((next.elements.a as any).animation.revealProgress).toEqual({
      isActivate: false,
      x: [],
      ax: [],
    });
  });

  it("offers the property only once the reveal exists", () => {
    const before = plain();
    expect(animatableProperties(before.elements.a)).not.toContain(
      "revealProgress",
    );
    const after = setClipTextReveal(before, "a", "line");
    expect(animatableProperties(after.elements.a)).toContain("revealProgress");
  });

  it("leaves the clip's own five tracks exactly as they were", () => {
    const before = plain();
    const after = setClipTextReveal(before, "a", "character");
    for (const property of ["position", "opacity", "scale", "rotation", "size"]) {
      expect((after.elements.a as any).animation[property]).toBe(
        (before.elements.a as any).animation[property],
      );
    }
  });

  it("removes the key and the track when cleared", () => {
    const withReveal = setClipTextReveal(plain(), "a", "character");
    const cleared = setClipTextReveal(withReveal, "a", null);
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined, so
    // the saved project and the one in memory would otherwise disagree.
    expect("reveal" in (cleared.elements.a as object)).toBe(false);
    expect((cleared.elements.a as any).animation.revealProgress).toBeUndefined();
  });

  it("carries the progress and the fade across a unit change", () => {
    let next = setClipTextReveal(plain(), "a", "character");
    next = setClipTextRevealFields(next, "a", { progress: 40, fade: 0.5 });
    next = setClipTextReveal(next, "a", "word");
    expect(revealRefOf(next, "a")).toEqual({
      unit: "word",
      progress: 40,
      fade: 0.5,
    });
  });

  it("keeps curves the user already drew when the unit changes", () => {
    let next = setClipTextReveal(plain(), "a", "character");
    next = addKeyframe(next, "a", "revealProgress", "x", 100, 0);
    const drawn = (next.elements.a as any).animation.revealProgress.x;
    next = setClipTextReveal(next, "a", "line");
    expect((next.elements.a as any).animation.revealProgress.x).toEqual(drawn);
  });

  it("shares nothing with the reveal it was handed", () => {
    const first = setClipTextReveal(plain(), "a", "character");
    const second = setClipTextRevealFields(first, "a", { progress: 10 });
    expect(revealRefOf(first, "a")?.progress).toBe(DEFAULT_REVEAL_PROGRESS);
    expect(revealRefOf(second, "a")?.progress).toBe(10);
  });
});

describe("setClipTextReveal — declining by identity", () => {
  it("declines for an id that is not in the document", () => {
    const d = plain();
    expect(setClipTextReveal(d, "nope", "character")).toBe(d);
  });

  it.each(["picture", "sound"])("declines for a %s", (id) => {
    const d = plain();
    expect(setClipTextReveal(d, id, "character")).toBe(d);
  });

  it("declines for a unit it does not know", () => {
    const d = plain();
    expect(setClipTextReveal(d, "a", "syllable" as any)).toBe(d);
  });

  it("declines when the clip already has that unit", () => {
    const d = setClipTextReveal(plain(), "a", "word");
    expect(setClipTextReveal(d, "a", "word")).toBe(d);
  });

  it("declines when clearing a clip that has no reveal", () => {
    const d = plain();
    expect(setClipTextReveal(d, "a", null)).toBe(d);
  });
});

describe("setClipTextRevealFields", () => {
  it("writes the numbers it can read", () => {
    let next = setClipTextReveal(plain(), "a", "character");
    next = setClipTextRevealFields(next, "a", { progress: 25, fade: 0.25 });
    expect(revealRefOf(next, "a")).toEqual({
      unit: "character",
      progress: 25,
      fade: 0.25,
    });
  });

  it("deletes the fade rather than storing a zero", () => {
    let next = setClipTextReveal(plain(), "a", "character");
    next = setClipTextRevealFields(next, "a", { fade: 0.5 });
    next = setClipTextRevealFields(next, "a", { fade: 0 });
    expect("fade" in (revealRefOf(next, "a") as object)).toBe(false);
  });

  it("declines on a clip with no reveal", () => {
    const d = plain();
    // A progress with nothing to progress through is a field nothing reads.
    expect(setClipTextRevealFields(d, "a", { progress: 10 })).toBe(d);
  });

  it("declines on an empty patch and on one that changes nothing", () => {
    const d = setClipTextReveal(plain(), "a", "character");
    expect(setClipTextRevealFields(d, "a", {})).toBe(d);
    expect(
      setClipTextRevealFields(d, "a", { progress: DEFAULT_REVEAL_PROGRESS }),
    ).toBe(d);
  });

  it("drops a number it cannot read instead of storing it", () => {
    const d = setClipTextReveal(plain(), "a", "character");
    expect(setClipTextRevealFields(d, "a", { progress: NaN })).toBe(d);
    expect(setClipTextRevealFields(d, "a", { fade: Infinity })).toBe(d);
  });
});

describe("the *Many folds", () => {
  it("applies to every eligible clip", () => {
    const next = setClipTextRevealMany(plain(), ["a", "b"], "word");
    expect(revealRefOf(next, "a")?.unit).toBe("word");
    expect(revealRefOf(next, "b")?.unit).toBe("word");
  });

  it("declines for an all-ineligible list and for an empty one", () => {
    const d = plain();
    expect(setClipTextRevealMany(d, ["picture", "sound"], "word")).toBe(d);
    expect(setClipTextRevealMany(d, [], "word")).toBe(d);
    expect(setClipTextRevealFieldsMany(d, [], { progress: 1 })).toBe(d);
  });

  it("skips the ineligible and still writes the rest", () => {
    const next = setClipTextRevealMany(plain(), ["picture", "a"], "line");
    expect(revealRefOf(next, "a")?.unit).toBe("line");
    expect(revealOf(next.elements.picture)).toBeNull();
  });
});

describe("the track travels with the clip", () => {
  const typed = () => {
    let next = setClipTextReveal(plain(), "a", "character");
    next = addKeyframe(next, "a", "revealProgress", "x", 0, 0);
    next = addKeyframe(next, "a", "revealProgress", "x", 800, 100);
    return next;
  };

  it("survives a split, on both halves", () => {
    const next = splitClip(typed(), "a", 500, "a2");
    for (const id of ["a", "a2"]) {
      expect(revealRefOf(next, id)?.unit).toBe("character");
      expect((next.elements[id] as any).animation.revealProgress).toBeDefined();
    }
  });

  it("is rebased by a trim rather than left where it was", () => {
    // The whole reason the timing lives in the animation block: `trimClipStart`
    // knows how to move keyframes and knows nothing about reveals.
    const before = typed();
    const after = trimClipStart(before, "a", 200);
    const times = (after.elements.a as any).animation.revealProgress.x.map(
      (k: any) => k.p[0],
    );
    expect(times).toEqual([-200, 600]);
  });

  it("survives a paste, sharing no array with its original", () => {
    const source = typed();
    const pasted = pasteClips(
      source,
      { a: source.elements.a },
      2000,
      () => "copy",
    );
    const original = (source.elements.a as any).animation.revealProgress.x;
    const copy = (pasted.elements.copy as any).animation.revealProgress.x;
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
  });
});

describe("normalizeAnimation and the orphan track", () => {
  it("drops a progress track on a clip with no reveal", () => {
    const orphan = textElement({
      animation: {
        ...emptyAnimation("text"),
        revealProgress: { isActivate: true, x: [], ax: [] },
      },
    } as any);
    expect(
      (normalizeAnimation(orphan) as any).animation.revealProgress,
    ).toBeUndefined();
  });

  it("keeps it on a clip that has one", () => {
    const kept = setClipTextReveal(plain(), "a", "character").elements.a;
    expect(
      (normalizeAnimation(kept as any) as any).animation.revealProgress,
    ).toBeDefined();
  });

  it("leaves an unrevealed clip's block byte-identical", () => {
    // No `SCHEMA_VERSION` move, and a project nobody has revealed saves exactly
    // as it did before the feature existed.
    const before = textElement();
    expect(JSON.stringify(normalizeAnimation(before))).toBe(
      JSON.stringify(before),
    );
    expect("revealProgress" in (before as any).animation).toBe(false);
  });
});
