import { describe, it, expect } from "vitest";
import {
  animatableProperties,
  canAnimate,
  isVisualTimelineElement,
} from "./timeline";
import {
  imageElement,
  videoElement,
  gifElement,
  textElement,
  shapeElement,
  effectElement,
  audioElement,
} from "../features/renderer/testing";

/**
 * The renderer walks the whole timeline, so this guard is what keeps audio —
 * the one element with no width, height or position — out of the drawing path
 * and off the canvas.
 */
describe("isVisualTimelineElement", () => {
  it("accepts every element kind that has pixels", () => {
    expect(isVisualTimelineElement(imageElement())).toBe(true);
    expect(isVisualTimelineElement(videoElement())).toBe(true);
    expect(isVisualTimelineElement(gifElement())).toBe(true);
    expect(isVisualTimelineElement(textElement())).toBe(true);
    expect(isVisualTimelineElement(shapeElement())).toBe(true);
  });

  it("rejects audio", () => {
    expect(isVisualTimelineElement(audioElement())).toBe(false);
  });

  it("narrows the type so visual-only fields become reachable", () => {
    const element = imageElement({ width: 320, height: 180 });
    if (isVisualTimelineElement(element)) {
      // A compile-time assertion as much as a runtime one: `width` does not
      // exist on the union until the guard narrows it.
      expect(element.width).toBe(320);
      expect(element.height).toBe(180);
    } else {
      throw new Error("image should be visual");
    }
  });
});

describe("canAnimate / animatableProperties", () => {
  it("includes the element types that carry an animation block", () => {
    expect(canAnimate(imageElement({}))).toBe(true);
    expect(canAnimate(videoElement({}))).toBe(true);
    expect(canAnimate(textElement({}))).toBe(true);
    expect(canAnimate(shapeElement({}))).toBe(true);
  });

  it("excludes GIF, which has no animation field", () => {
    // The old gate was "static and not text", which let GIF in (it has no
    // `animation` at all) and kept video out, which does.
    expect(canAnimate(gifElement({}))).toBe(false);
  });

  it("includes audio, which carries a level envelope and nothing else", () => {
    // Audio was excluded here until its level became keyframable. The
    // predicate means no more than "may carry an `animation` block"; what it
    // may put in one is `animatableProperties`' answer, and for audio that is
    // one track.
    expect(canAnimate(audioElement({}))).toBe(true);
  });

  it("offers all five properties where the type supports them", () => {
    expect(animatableProperties(imageElement({}))).toEqual([
      "position",
      "opacity",
      "scale",
      "rotation",
      "size",
    ]);
  });

  it("offers all five for a shape, which animates like any other visual", () => {
    expect(animatableProperties(shapeElement({}))).toEqual([
      "position",
      "opacity",
      "scale",
      "rotation",
      "size",
    ]);
  });

  it("offers size on every type that has a box, and on no other", () => {
    // `size` is the one property whose two lanes are a width and a height
    // rather than an x and a y. It is offered wherever `Visual` is — an
    // effect covers the whole frame and has no box to resize, and gif and
    // audio carry no animation block at all.
    for (const element of [
      imageElement({}),
      videoElement({}),
      textElement({}),
      shapeElement({}),
    ]) {
      expect(animatableProperties(element)).toContain("size");
    }
    expect(animatableProperties(effectElement({}))).not.toContain("size");
    expect(animatableProperties(gifElement({}))).not.toContain("size");
    expect(animatableProperties(audioElement({}))).not.toContain("size");
  });

  it("offers intensity for an effect, and not the opacity nothing reads", () => {
    // It covers the whole frame, so there is no box to move. `intensity` is the
    // one number every effect has whatever preset is behind it; `opacity` is
    // still in the block for shape's sake and is deliberately not offered,
    // because no renderer has ever read an effect's.
    expect(animatableProperties(effectElement({}))).toEqual(["intensity"]);
  });

  it("offers a track per numeric preset parameter, named from the element", () => {
    const element = effectElement({
      params: { amount: 0.6, radius: 0.75, tint: "#000000", centre: [0.5, 0.5] },
    } as any);
    // The keys come from a manifest on disk, so this file cannot check them
    // against one. A stored number can carry a curve; a colour and a point
    // cannot, and are simply not offered.
    expect(animatableProperties(element)).toEqual([
      "intensity",
      "fx:amount",
      "fx:radius",
    ]);
  });

  it("offers nothing for an element that cannot animate", () => {
    expect(animatableProperties(gifElement({}))).toEqual([]);
  });

  it("offers an audio clip its level and nothing else", () => {
    // Not the transform five. An audio clip has no box, no opacity and no
    // rotation, so offering them would put five tracks in the curve editor
    // that nothing reads.
    expect(animatableProperties(audioElement({}))).toEqual(["volumeDb"]);
  });

  it("offers a video its level, and takes it away when the audio is detached", () => {
    // Gated on audibility rather than on the filetype, which is the same
    // condition the waveform is drawn under. A video with no audio stream at
    // all never had a level to animate either.
    expect(animatableProperties(videoElement({ isExistAudio: true }))).toContain(
      "volumeDb",
    );
    expect(
      animatableProperties(
        videoElement({ isExistAudio: true, audioDetached: true }),
      ),
    ).not.toContain("volumeDb");
    expect(
      animatableProperties(videoElement({ isExistAudio: false })),
    ).not.toContain("volumeDb");
  });
});
