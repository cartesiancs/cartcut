/**
 * Animated text, as the Text panel's tiles apply it.
 *
 * What is pinned here is that an animated tile leaves nothing a user could not
 * have built by hand: a reveal, its animator, a linear progress curve and, for
 * one of them, an ordinary whole-clip move. The drawing is the renderer's and
 * is pinned in `textTile.render.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { TextElementType } from "../../@types/timeline";
import { presetLabel, presetNames } from "../animation/presets";
import { createTextElement } from "../element/textElement";
import { DEFAULT_FONT } from "../font/fontFaces";
import { textOptionsFor } from "../font/textPresetOptions";
import { buildTextPresets, lookPreset, presetFontFiles } from "../font/textPresets";
import { imageElement } from "../renderer/testing";
import { revealRefOf } from "../timeline/textRevealOps";
import { SCHEMA_VERSION, createTrack, type TimelineDocument } from "../timeline/tracks";
import { revealOf, sampledRevealProgress } from "./reveal";
import {
  ANIMATED_TEXT_MS,
  TEXT_ANIMATIONS,
  animatorFor,
  applyTextAnimation,
  progressStops,
  sampleTextFor,
  textAnimationById,
  type TextAnimation,
} from "./textAnimations";

const presets = buildTextPresets(
  presetFontFiles().map((file) => ({
    path: `/Resources/assets/fonts/google/${file}`,
    name: file.slice(0, file.lastIndexOf(".")),
    type: "ttf",
  })),
);

const HD = { w: 1920, h: 1080 };
const FRAME_MS = 1000 / 30;
const OPTIONS = { bakeHz: 240, frameMs: FRAME_MS };
const START = 2000;

function docFor(animation: TextAnimation, duration = ANIMATED_TEXT_MS): TimelineDocument {
  const look = lookPreset(animation.look, presets, DEFAULT_FONT)!;
  const element = createTextElement({
    ...textOptionsFor(look, HD, sampleTextFor(animation)),
    startTime: START,
    duration,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t", "text", 0)],
    elements: { a: { ...element, trackId: "t", priority: 1 } as TextElementType },
  };
}

const keys = (d: TimelineDocument) =>
  (d.elements.a as any).animation.revealProgress.x.map((k: any) => k.p);

/** The progress the renderer would draw at clip-local `ms`. */
function progressAt(d: TimelineDocument, ms: number): number {
  const element = d.elements.a;
  return sampledRevealProgress(element, revealOf(element)!, START + ms);
}

describe("the animation list", () => {
  it("is sixteen animations with distinct ids and names", () => {
    expect(TEXT_ANIMATIONS).toHaveLength(16);
    expect(new Set(TEXT_ANIMATIONS.map((a) => a.id)).size).toBe(16);
    expect(new Set(TEXT_ANIMATIONS.map((a) => a.name)).size).toBe(16);
  });

  it("borrows no name from the whole-clip moves", () => {
    const moves = new Set(presetNames().map((name) => presetLabel(name)));
    for (const animation of TEXT_ANIMATIONS) {
      expect(moves.has(animation.name), animation.name).toBe(false);
    }
  });

  it("dresses every animation in a preset the panel lists", () => {
    for (const animation of TEXT_ANIMATIONS) {
      expect(
        presets.some((preset) => preset.id === animation.look),
        animation.look,
      ).toBe(true);
    }
  });

  it("finds an animation by id, and nothing for an unknown one", () => {
    expect(textAnimationById("letter-rise")?.name).toBe("Letter Rise");
    expect(textAnimationById("nope")).toBeNull();
  });

  it("gives a word animation more than one word to stagger", () => {
    for (const animation of TEXT_ANIMATIONS) {
      if (animation.unit === "word") {
        expect(sampleTextFor(animation).split(" ").length).toBeGreaterThan(1);
      }
    }
  });
});

describe("applyTextAnimation", () => {
  it("animates every one of them, in a new document", () => {
    for (const animation of TEXT_ANIMATIONS) {
      const before = docFor(animation);
      const after = applyTextAnimation(before, "a", animation, OPTIONS);
      expect(after, animation.id).not.toBe(before);
      expect(revealRefOf(after, "a")?.unit).toBe(animation.unit);
      expect((after.elements.a as any).animation.revealProgress.isActivate).toBe(true);
    }
  });

  it("arrives from nothing to everything over `inMs`", () => {
    for (const animation of TEXT_ANIMATIONS.filter((a) => a.outMs == null)) {
      const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
      expect(keys(after), animation.id).toEqual([
        [0, 0],
        [animation.inMs, 100],
      ]);
    }
  });

  it("moves the progress at one speed, not in an ease", () => {
    // `addKeyframe`'s default handles are an ease-in-out; the midpoint of a
    // linear segment is exactly half, of an eased one is not.
    const animation = textAnimationById("letter-rise")!;
    const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
    expect(progressAt(after, animation.inMs / 4)).toBeCloseTo(25, 0);
    expect(progressAt(after, animation.inMs / 2)).toBeCloseTo(50, 0);
  });

  it("leaves an in-and-out animation empty on the clip's last frame", () => {
    const animation = textAnimationById("rise-and-sink")!;
    const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
    const last = Math.floor(ANIMATED_TEXT_MS - FRAME_MS);

    expect(keys(after)).toEqual([
      [0, 0],
      [animation.inMs, 100],
      [last - animation.outMs!, 100],
      [last, 0],
    ]);
    expect(progressAt(after, last)).toBe(0);
    expect(progressAt(after, ANIMATED_TEXT_MS / 2)).toBe(100);
    // The exit is linear too.
    expect(progressAt(after, last - animation.outMs! / 2)).toBeCloseTo(50, 0);
  });

  it("writes offsets and blur in the clip's pixels, from ems", () => {
    expect(animatorFor(textAnimationById("letter-rise")!, 100)).toMatchObject({
      offsetY: 60,
    });
    expect(animatorFor(textAnimationById("blur-in")!, 100)).toMatchObject({
      blur: 35,
      scale: 115,
    });

    const animation = textAnimationById("letter-rise")!;
    const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
    const fontsize = (after.elements.a as TextElementType).fontsize;
    expect(revealRefOf(after, "a")?.animate?.offsetY).toBeCloseTo(0.6 * fontsize, 2);
  });

  it("settles every animator, so the last letters do not jump", () => {
    for (const animation of TEXT_ANIMATIONS) {
      const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
      const animate = revealRefOf(after, "a")?.animate;
      if (animation.animate != null) {
        expect(animate?.settle, animation.id).toBe(true);
      } else {
        expect(animate, animation.id).toBeUndefined();
      }
    }
  });

  it("keeps a soft fade where there is no animator", () => {
    const animation = textAnimationById("letter-fade")!;
    const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
    expect(revealRefOf(after, "a")?.fade).toBe(1);
  });

  it("lays the whole-clip move over the reveal", () => {
    const animation = textAnimationById("slow-reveal")!;
    expect(animation.move).toBe("drift");
    const after = applyTextAnimation(docFor(animation), "a", animation, OPTIONS);
    expect((after.elements.a as any).animation.scale?.isActivate).toBe(true);
  });

  it("clamps the arrival into a clip shorter than it", () => {
    const animation = textAnimationById("blur-in")!;
    const after = applyTextAnimation(docFor(animation, 500), "a", animation, OPTIONS);
    expect(keys(after)).toEqual([
      [0, 0],
      [500, 100],
    ]);
  });

  it("declines anything that is not a text clip, before any step", () => {
    // Slow Reveal's drift would otherwise land a scale track on a picture the
    // reveal had already refused.
    const picture: TimelineDocument = {
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v", "video", 0)],
      elements: { a: imageElement({ trackId: "v", startTime: 0, duration: 3000 }) },
    };
    for (const animation of TEXT_ANIMATIONS) {
      expect(applyTextAnimation(picture, "a", animation, OPTIONS)).toBe(picture);
    }
    expect(applyTextAnimation(picture, "missing", TEXT_ANIMATIONS[0], OPTIONS)).toBe(picture);
  });
});

describe("progressStops", () => {
  it("never puts two stops at one time", () => {
    for (const span of [2, 10, 400, 1000, 3000]) {
      for (const animation of TEXT_ANIMATIONS) {
        const { times } = progressStops(animation, span, FRAME_MS);
        for (let i = 1; i < times.length; i += 1) {
          expect(times[i], `${animation.id} @${span}`).toBeGreaterThan(times[i - 1]);
        }
      }
    }
  });

  it("drops the rest when an in-and-out clip is too short to hold one", () => {
    const { times, values } = progressStops({ inMs: 700, outMs: 600 }, 1000, FRAME_MS);
    expect(values).toEqual([0, 100, 0]);
    expect(times[2]).toBe(Math.floor(1000 - FRAME_MS));
  });
});
