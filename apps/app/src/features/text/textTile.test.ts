import { describe, expect, it } from "vitest";

import type { TextElementType } from "../../@types/timeline";
import { createTextElement } from "../element/textElement";
import { DEFAULT_FONT } from "../font/fontFaces";
import { textOptionsFor } from "../font/textPresetOptions";
import { buildTextPresets, lookPreset, presetFontFiles } from "../font/textPresets";
import {
  ANIMATED_TEXT_MS,
  TEXT_ANIMATIONS,
  sampleTextFor,
  textAnimationById,
} from "./textAnimations";
import {
  LOOP_EMPTY_MS,
  LOOP_HOLD_MS,
  LOOP_SHOWN_MS,
  TILE_ASPECT,
  loopClipTime,
  loopOf,
  presetElement,
  restMsOf,
  tileSpecFor,
  tileViewOf,
} from "./textTile";

const presets = buildTextPresets(
  presetFontFiles().map((file) => ({
    path: `/Resources/assets/fonts/google/${file}`,
    name: file.slice(0, file.lastIndexOf(".")),
    type: "ttf",
  })),
);
const HD = { w: 1920, h: 1080 };
const preset = (id: string) => presets.find((p) => p.id === id)!;

describe("presetElement", () => {
  it("is the element the old click made for a style tile", () => {
    const style = preset("Bangers-Regular/comic");
    expect(presetElement(style, null, HD)).toEqual(
      createTextElement(textOptionsFor(style, HD)),
    );
  });

  it("gives an animated tile its own text and a longer clip", () => {
    const animation = textAnimationById("word-rise")!;
    const look = lookPreset(animation.look, presets, DEFAULT_FONT)!;
    const element = presetElement(look, animation, HD);
    expect(element.text).toBe(sampleTextFor(animation));
    expect(element.duration).toBe(ANIMATED_TEXT_MS);
  });
});

describe("tileSpecFor", () => {
  it("draws a style tile as a still, at the clip's start", () => {
    const spec = tileSpecFor(preset("Inter-Bold/glass"), null, HD);
    expect(spec.loop).toBeNull();
    expect(spec.restMs).toBe(0);
    expect(Object.values(spec.timeline)).toEqual([spec.element]);
    expect(spec.frame).toEqual(HD);
  });

  it("animates an animated tile exactly as the click would", () => {
    const animation = textAnimationById("letter-drop")!;
    const look = lookPreset(animation.look, presets, DEFAULT_FONT)!;
    const spec = tileSpecFor(look, animation, HD);
    expect(spec.element.reveal?.unit).toBe("character");
    expect(spec.element.reveal?.animate?.settle).toBe(true);
    expect((spec.element as any).animation.revealProgress.isActivate).toBe(true);
    expect(spec.restMs).toBe(restMsOf(animation));
    expect(spec.restMs).toBeGreaterThan(0);
    expect(spec.restMs).toBeLessThan(animation.inMs);
  });

  it("puts the clip on a track, as the compositor expects", () => {
    const spec = tileSpecFor(preset("Inter-Bold/glass"), null, HD);
    expect(spec.element.trackId).toBeTruthy();
    expect(spec.element.priority).toBe(1);
  });
});

describe("the hover loop", () => {
  it("plays an arrival, then rests on the finished text", () => {
    const animation = textAnimationById("letter-rise")!;
    const loop = loopOf(animation, ANIMATED_TEXT_MS);
    expect(loop).toEqual([
      { from: 0, to: animation.inMs, ms: animation.inMs },
      { from: animation.inMs, to: animation.inMs, ms: LOOP_HOLD_MS },
    ]);

    expect(loopClipTime(loop, 0)).toBe(0);
    expect(loopClipTime(loop, animation.inMs / 2)).toBe(animation.inMs / 2);
    expect(loopClipTime(loop, animation.inMs + 10)).toBe(animation.inMs);
    // And round again.
    const length = animation.inMs + LOOP_HOLD_MS;
    expect(loopClipTime(loop, length + 100)).toBe(100);
  });

  it("plays a whole-clip move to its end, inside the clip", () => {
    const animation = textAnimationById("slow-reveal")!;
    const [play] = loopOf(animation, ANIMATED_TEXT_MS);
    expect(play.to).toBe(ANIMATED_TEXT_MS - 1);
  });

  it("plays an exit after a rest, then a moment of nothing", () => {
    const animation = textAnimationById("rise-and-sink")!;
    const loop = loopOf(animation, ANIMATED_TEXT_MS);
    expect(loop.map((segment) => segment.ms)).toEqual([
      animation.inMs,
      LOOP_SHOWN_MS,
      animation.outMs,
      LOOP_EMPTY_MS,
    ]);
    // The rest sits on the finished text, the end on the empty last frame.
    expect(loop[1].from).toBe(animation.inMs);
    expect(loop[3].from).toBeGreaterThan(ANIMATED_TEXT_MS - 100);
  });

  it("never runs backwards inside a segment", () => {
    for (const animation of TEXT_ANIMATIONS) {
      const loop = loopOf(animation, ANIMATED_TEXT_MS);
      const length = loop.reduce((sum, s) => sum + s.ms, 0);
      let previous = -1;
      let segmentEnd = 0;
      let index = 0;
      for (let at = 0; at < length; at += 5) {
        while (at >= segmentEnd + loop[index].ms) {
          segmentEnd += loop[index].ms;
          index += 1;
          previous = -1;
        }
        const clip = loopClipTime(loop, at);
        expect(clip, animation.id).toBeGreaterThanOrEqual(previous);
        previous = clip;
      }
    }
  });

  it("answers the start for a loop with no length", () => {
    expect(loopClipTime([{ from: 40, to: 40, ms: 0 }], 123)).toBe(40);
  });
});

describe("tileViewOf", () => {
  const plain = (over: Partial<TextElementType> = {}) =>
    ({ ...createTextElement(textOptionsFor(preset("Roboto-Bold/clean"), HD)), ...over }) as TextElementType;

  it("is the well's aspect, centred on the text", () => {
    const element = plain();
    const view = tileViewOf(element, { blockWidth: 300, blockHeight: 60 });
    expect(view.w / view.h).toBeCloseTo(TILE_ASPECT, 6);
    expect(view.x + view.w / 2).toBeCloseTo(element.location.x + element.width / 2, 6);
    expect(view.y + view.h / 2).toBeCloseTo(element.location.y + 30, 6);
  });

  it("holds the whole block, with room to spare", () => {
    const view = tileViewOf(plain(), { blockWidth: 900, blockHeight: 60 });
    expect(view.w).toBeGreaterThan(900);
  });

  it("is never narrower than a few ems, so a short word is not a wall", () => {
    const element = plain();
    const view = tileViewOf(element, { blockWidth: 10, blockHeight: 10 });
    expect(view.w).toBeGreaterThanOrEqual(element.fontsize * 3.4);
  });

  it("widens for what the style draws past the glyphs", () => {
    const block = { blockWidth: 400, blockHeight: 60 };
    const base = tileViewOf(plain(), block).w;
    const glowing = plain({
      options: { ...plain().options, glow: { enable: true, size: 60, color: "#ffffff", opacity: 100 } },
    });
    expect(tileViewOf(glowing, block).w).toBeGreaterThan(base);
  });

  it("frames the settled text alike whatever the animation starts from", () => {
    // Letters that start far away enter from past the well's edge, so a
    // dropping title is as large on its tile as a fading one.
    const block = { blockWidth: 400, blockHeight: 60 };
    const dropping = plain({
      reveal: { unit: "character", progress: 100, animate: { offsetY: -200, window: 2 } },
    });
    expect(tileViewOf(dropping, block)).toEqual(tileViewOf(plain(), block));
  });
});
