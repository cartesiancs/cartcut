/**
 * The Animator card's rules, run through the real op.
 *
 * The patches are only worth anything for what `setClipTextRevealFields` makes
 * of them, so most of these write a patch and read the document back. Declines
 * are asserted with `toBe`: `withCheckpoint` reads identity to mean "nothing
 * happened" and records no undo step.
 */

import { describe, expect, it } from "vitest";

import { easingNames, resolveEasing } from "../animation/easing";
import { textElement } from "../renderer/testing";
import {
  REVEAL_ANIMATE_DEFAULTS,
  REVEAL_ANIMATE_RANGES,
  animateOf,
  revealOf,
} from "../text/reveal";
import {
  revealRefOf,
  setClipTextReveal,
  setClipTextRevealFields,
} from "../timeline/textRevealOps";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  ANIMATOR_BOXES,
  animatorEasingOptions,
  animatorEasingPatch,
  animatorMovePatch,
  animatorValuesOf,
  animatorWindowPatch,
  hasAnimator,
  type AnimatorMoveKey,
} from "./revealAnimatorFields";

/** One text clip carrying a word reveal and no animator. */
function revealed(): TimelineDocument {
  const doc: TimelineDocument = {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t1", "text", 0)],
    elements: {
      a: textElement({ trackId: "t1", startTime: 0, duration: 1000 }),
    },
  };
  return setClipTextReveal(doc, "a", "word");
}

function write(
  doc: TimelineDocument,
  animate: Record<string, unknown>,
): TimelineDocument {
  return setClipTextRevealFields(doc, "a", { animate });
}

const MOVE_KEYS = Object.keys(REVEAL_ANIMATE_DEFAULTS) as AnimatorMoveKey[];

describe("animatorValuesOf", () => {
  it("shows every inert value for a reveal with no animator", () => {
    expect(animatorValuesOf(revealRefOf(revealed(), "a"))).toEqual({
      ...REVEAL_ANIMATE_DEFAULTS,
      window: 1,
      easing: "linear",
    });
    // A clip with no reveal at all reads the same, rather than throwing.
    expect(animatorValuesOf(null)).toEqual(
      animatorValuesOf(revealRefOf(revealed(), "a")),
    );
  });

  it("shows the window the renderer will use, not the 0 that means unset", () => {
    const soft = setClipTextRevealFields(revealed(), "a", { fade: 0.4 });
    const moving = write(soft, { scale: 140 });
    expect(animatorValuesOf(revealRefOf(moving, "a")).window).toBe(0.4);

    // An explicit window wins over the softness.
    const wide = write(moving, animatorWindowPatch(3));
    expect(animatorValuesOf(revealRefOf(wide, "a")).window).toBe(3);
  });

  it("reads a stored easing back, and falls back to linear for one it cannot resolve", () => {
    const snapped = write(write(revealed(), { scale: 140 }), {
      easing: "snap",
    });
    expect(animatorValuesOf(revealRefOf(snapped, "a")).easing).toBe("snap");
    expect(
      animatorValuesOf({
        unit: "word",
        progress: 100,
        animate: { scale: 140, easing: "swoosh" },
      }).easing,
    ).toBe("linear");
  });
});

describe("animatorMovePatch", () => {
  it("stores a moved value, and merges a second box over the first", () => {
    const first = write(revealed(), animatorMovePatch("scale", 140));
    expect(revealRefOf(first, "a")?.animate).toEqual({ scale: 140 });

    const second = write(first, animatorMovePatch("offsetY", 20));
    expect(revealRefOf(second, "a")?.animate).toEqual({
      scale: 140,
      offsetY: 20,
    });
  });

  it("deletes a key set back to its inert value instead of storing it", () => {
    const moving = write(
      write(revealed(), animatorMovePatch("scale", 140)),
      animatorMovePatch("offsetY", 20),
    );
    const back = write(moving, animatorMovePatch("scale", 100));

    const animate = (back.elements.a as any).reveal.animate;
    expect(animate).toEqual({ offsetY: 20 });
    expect("scale" in animate).toBe(false);
  });

  it("removes the animator outright when its last movement goes back to inert", () => {
    const moving = write(revealed(), animatorMovePatch("blur", 6));
    const back = write(moving, animatorMovePatch("blur", 0));

    expect(hasAnimator(revealRefOf(back, "a"))).toBe(false);
    expect("animate" in (back.elements.a as any).reveal).toBe(false);
    // And the reveal itself stays.
    expect(revealRefOf(back, "a")?.unit).toBe("word");
  });

  it("declines by identity when the box already says that", () => {
    const moving = write(revealed(), animatorMovePatch("rotation", -12));
    expect(write(moving, animatorMovePatch("rotation", -12))).toBe(moving);
    // An inert value on a clip with no animator is nothing to do either.
    const plain = revealed();
    expect(write(plain, animatorMovePatch("scale", 100))).toBe(plain);
  });

  it("covers every movement field the model has", () => {
    // Each one alone is enough to make an animator, which is what lets the
    // card's first edit be any of them.
    for (const key of MOVE_KEYS) {
      const off = REVEAL_ANIMATE_DEFAULTS[key] === 0 ? 30 : 140;
      const next = write(revealed(), animatorMovePatch(key, off));
      expect(revealRefOf(next, "a")?.animate).toEqual({ [key]: off });
    }
  });
});

describe("animatorWindowPatch and animatorEasingPatch", () => {
  it("cannot make an animator on their own, which is why the card dims them", () => {
    // A window or an easing says how a unit moves, not that it does, so a clip
    // with no movement declines both. The card would otherwise show a number
    // that the next render snaps back.
    const plain = revealed();
    expect(write(plain, animatorWindowPatch(3))).toBe(plain);
    expect(write(plain, animatorEasingPatch("snap"))).toBe(plain);
  });

  it("stores a window once something moves", () => {
    const moving = write(revealed(), animatorMovePatch("scale", 140));
    const wide = write(moving, animatorWindowPatch(3));
    expect(revealRefOf(wide, "a")?.animate).toEqual({ scale: 140, window: 3 });
  });

  it("stores a named easing, and deletes the key for linear, the default", () => {
    const moving = write(revealed(), animatorMovePatch("scale", 140));
    const snapped = write(moving, animatorEasingPatch("overshoot"));
    expect(revealRefOf(snapped, "a")?.animate).toEqual({
      scale: 140,
      easing: "overshoot",
    });

    const linear = write(snapped, animatorEasingPatch("linear"));
    expect(revealRefOf(linear, "a")?.animate).toEqual({ scale: 140 });
  });
});

describe("ANIMATOR_BOXES", () => {
  it("stops each box where the op clamps", () => {
    for (const key of MOVE_KEYS) {
      const { min, max } = ANIMATOR_BOXES[key];
      expect([min, max]).toEqual([...REVEAL_ANIMATE_RANGES[key]]);
      // Checked against the reader too, which shares no table with the boxes'
      // own numbers: past the bound, it reads the bound.
      const read = animateOf({ scale: 140, [key]: max + 1 }) as any;
      expect(read[key]).toBe(max);
      // And inside it, the value itself, so the check above measures a clamp
      // rather than a constant.
      const inside = animateOf({ scale: 140, [key]: max - 1 }) as any;
      expect(inside[key]).toBe(max - 1);
    }
  });

  it("keeps the window's floor off the 0 that means unset", () => {
    expect(ANIMATOR_BOXES.window.min).toBeGreaterThan(0);
    expect(ANIMATOR_BOXES.window.max).toBe(REVEAL_ANIMATE_RANGES.window[1]);
  });
});

describe("animatorEasingOptions", () => {
  it("offers every named easing, each one a curve the reader resolves", () => {
    const options = animatorEasingOptions();
    expect(options.map((option) => option.value)).toEqual(easingNames());
    for (const option of options) {
      expect(resolveEasing(option.value)).not.toBeNull();
      expect(option.label.length).toBeGreaterThan(0);
    }
    expect(options[0].value).toBe("linear");
  });
});

describe("revealOf after the card has written", () => {
  it("reads back exactly what the card wrote", () => {
    // The card reads through `revealOf`, so a write the reader normalised
    // differently would show the user a value they did not type.
    let doc = revealed();
    doc = write(doc, animatorMovePatch("scale", 130));
    doc = write(doc, animatorMovePatch("offsetX", -8));
    doc = write(doc, animatorMovePatch("opacity", 40));
    doc = write(doc, animatorWindowPatch(2.5));
    doc = write(doc, animatorEasingPatch("ease_out"));

    expect(animatorValuesOf(revealOf(doc.elements.a))).toEqual({
      ...REVEAL_ANIMATE_DEFAULTS,
      scale: 130,
      offsetX: -8,
      opacity: 40,
      window: 2.5,
      easing: "ease_out",
    });
  });
});
