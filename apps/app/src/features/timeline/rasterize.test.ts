import { describe, it, expect } from "vitest";
import { canRasterize, imageTwinOf, rasterizeTextInDoc } from "./rasterize";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { imageElement, textElement, videoElement } from "../renderer/testing";

const BOX = { x: -8, y: 42, width: 516, height: 100 };

function title(over = {}) {
  return textElement({
    trackId: "v1",
    startTime: 3000,
    duration: 2500,
    location: { x: 0, y: 50 },
    width: 500,
    height: 84,
    opacity: 70,
    rotation: 15,
    ...over,
  });
}

function doc(
  elements: Record<string, any>,
  tracks = [createTrack("v1", "video", 0)],
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks,
    elements,
  });
}

describe("imageTwinOf", () => {
  it("becomes an image", () => {
    expect(imageTwinOf(title(), "/tmp/a.png", BOX).filetype).toBe("image");
  });

  it("occupies exactly the span the text did", () => {
    const text = title();
    const twin = imageTwinOf(text, "/tmp/a.png", BOX);

    expect(twin.startTime).toBe(text.startTime);
    expect(twin.duration).toBe(text.duration);
  });

  it("stays on the same track", () => {
    // The image replaces the text in place, so it must not be re-placed onto
    // whatever row `chooseTrackFor` would have picked.
    expect(imageTwinOf(title(), "/tmp/a.png", BOX).trackId).toBe("v1");
  });

  it("takes its box from the bleed-expanded raster, not the text box", () => {
    // The text sat at (0, 50) and was 500 wide; the PNG is bigger on every
    // side because the shadow paints outside the box.
    const twin = imageTwinOf(title(), "/tmp/a.png", BOX);

    expect(twin.location).toEqual({ x: -8, y: 42 });
    expect(twin.width).toBe(516);
    expect(twin.height).toBe(100);
  });

  it("carries opacity and rotation across", () => {
    const twin = imageTwinOf(title(), "/tmp/a.png", BOX);

    expect(twin.opacity).toBe(70);
    expect(twin.rotation).toBe(15);
  });

  it("points at the file it was given", () => {
    expect(imageTwinOf(title(), "/var/x/y.png", BOX).localpath).toBe(
      "/var/x/y.png",
    );
  });

  it("leaves blob empty, since nothing reads it for an image", () => {
    expect(imageTwinOf(title(), "/tmp/a.png", BOX).blob).toBe("");
  });

  it("derives ratio from the raster box", () => {
    expect(imageTwinOf(title(), "/tmp/a.png", BOX).ratio).toBeCloseTo(5.16);
  });

  it("does not divide by zero on a degenerate box", () => {
    const twin = imageTwinOf(title(), "/tmp/a.png", {
      x: 0,
      y: 0,
      width: 10,
      height: 0,
    });
    expect(Number.isFinite(twin.ratio)).toBe(true);
  });

  it("keeps the group it belonged to", () => {
    // Unlike an audio twin: a group is a spatial transform parent, and an
    // image has a location for it to transform.
    const twin = imageTwinOf(title({ parentId: "g1" }), "/tmp/a.png", BOX);
    expect(twin.parentId).toBe("g1");
  });

  it("omits parentId when the text had none", () => {
    expect("parentId" in imageTwinOf(title(), "/tmp/a.png", BOX)).toBe(false);
  });

  it("deep-copies the animation rather than sharing its arrays", () => {
    // The text element stays in the undo history; a shared array would let a
    // later keyframe edit reach backwards and change it.
    const text = title();
    text.animation.position.isActivate = true;
    text.animation.position.ax = [[0, 1]];

    const twin = imageTwinOf(text, "/tmp/a.png", BOX);

    expect(twin.animation.position.isActivate).toBe(true);
    expect(twin.animation.position.ax).not.toBe(text.animation.position.ax);
  });

  it("carries no text properties into the image", () => {
    const twin = imageTwinOf(title(), "/tmp/a.png", BOX) as Record<
      string,
      unknown
    >;

    for (const key of ["text", "fontname", "fontsize", "textcolor", "options"]) {
      expect(twin[key]).toBeUndefined();
    }
  });
});

describe("canRasterize", () => {
  it("accepts text", () => {
    expect(canRasterize(title())).toBe(true);
  });

  it("rejects other element kinds", () => {
    expect(canRasterize(videoElement({}))).toBe(false);
    expect(canRasterize(imageElement({}))).toBe(false);
  });

  it("rejects a missing element", () => {
    expect(canRasterize(undefined)).toBe(false);
  });
});

describe("rasterizeTextInDoc", () => {
  it("replaces the text at the same element id", () => {
    // Selection, keyframes and group membership are all keyed on the id, so
    // reusing it is what makes the swap invisible to them.
    const before = doc({ t1: title() });
    const after = rasterizeTextInDoc(before, "t1", "/tmp/a.png", BOX);

    expect(Object.keys(after.elements)).toEqual(["t1"]);
    expect(after.elements.t1.filetype).toBe("image");
  });

  it("leaves other clips alone", () => {
    const before = doc({ t1: title(), v1: videoElement({ trackId: "v1" }) });
    const after = rasterizeTextInDoc(before, "t1", "/tmp/a.png", BOX);

    expect(after.elements.v1).toEqual(before.elements.v1);
  });

  it("declines by identity for a non-text clip", () => {
    // `withCheckpoint` reads the identity to decide whether an undo step
    // happened; a new object here would cost the user a wasted Cmd+Z.
    const before = doc({ v1: videoElement({ trackId: "v1" }) });

    expect(rasterizeTextInDoc(before, "v1", "/tmp/a.png", BOX)).toBe(before);
  });

  it("declines by identity for an id that is not in the document", () => {
    const before = doc({ t1: title() });

    expect(rasterizeTextInDoc(before, "nope", "/tmp/a.png", BOX)).toBe(before);
  });

  it("does not mutate the document it was given", () => {
    const before = doc({ t1: title() });
    rasterizeTextInDoc(before, "t1", "/tmp/a.png", BOX);

    expect(before.elements.t1.filetype).toBe("text");
  });
});

describe("the mask survives rasterising", () => {
  /**
   * A mask covering the left half of the title, in its own local pixels: centre
   * at (125, 42), extent 250 x 84.
   */
  const halfMask = {
    shape: "rectangle" as const,
    location: { x: 25, y: 50 },
    size: { width: 50, height: 100 },
    rotation: 0,
    feather: 6,
    roundness: 0,
  };

  /** Where a mask lands, in the twin's own pixels. */
  function inPixels(twin: any) {
    const mask = twin.mask;
    return {
      centreX: (mask.location.x / 100) * twin.width,
      centreY: (mask.location.y / 100) * twin.height,
      width: (mask.size.width / 100) * twin.width,
      height: (mask.size.height / 100) * twin.height,
    };
  }

  it("keeps cutting the same pixels, despite the box growing", () => {
    const text = title({ mask: halfMask });
    const twin = imageTwinOf(text, "/tmp/a.png", BOX);

    // The raster box starts 8px left and 8px above the text's own origin, so
    // the same point on the picture is 8px further into it.
    const placed = inPixels(twin);
    expect(placed.centreX).toBeCloseTo(125 + (text.location.x - BOX.x), 6);
    expect(placed.centreY).toBeCloseTo(42 + (text.location.y - BOX.y), 6);
    expect(placed.width).toBeCloseTo(250, 6);
    expect(placed.height).toBeCloseTo(84, 6);
  });

  // Copying the percentages straight across is the obvious implementation and
  // the wrong one: it would slide the mask by the bleed and shrink it by the
  // growth, cropping the glow this feature exists to bake in.
  it("does not simply copy the percentages", () => {
    const twin = imageTwinOf(title({ mask: halfMask }), "/tmp/a.png", BOX);
    expect(twin.mask!.location).not.toEqual(halfMask.location);
    expect(twin.mask!.size).not.toEqual(halfMask.size);
  });

  // Feather is in element-local pixels, not percent, so it is already correct.
  it("leaves the feather alone", () => {
    const twin = imageTwinOf(title({ mask: halfMask }), "/tmp/a.png", BOX);
    expect(twin.mask!.feather).toBe(6);
  });

  it("carries a drawn path without sharing it", () => {
    const path = [{ p: [-0.5, -0.5] }, { p: [0.5, -0.5] }, { p: [0, 0.5] }];
    const source = title({ mask: { ...halfMask, shape: "pen", path } });
    const twin = imageTwinOf(source, "/tmp/a.png", BOX);
    expect(twin.mask!.path).toEqual(path);
    expect(twin.mask!.path).not.toBe(path);
    expect(twin.mask!.path![0]).not.toBe(path[0]);
  });

  it("leaves an unmasked title with no mask key at all", () => {
    expect("mask" in imageTwinOf(title(), "/tmp/a.png", BOX)).toBe(false);
  });

  // A mask that cannot be placed is dropped rather than placed wrongly: the
  // division would otherwise put NaN percentages into the document.
  it("drops the mask when the raster box has no extent", () => {
    const twin = imageTwinOf(title({ mask: halfMask }), "/tmp/a.png", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect("mask" in twin).toBe(false);
  });
});
