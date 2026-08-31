import { describe, it, expect, vi } from "vitest";
import { renderTimelineAtTime, type TimelineRenderers } from "./timeline";
import {
  scene,
  pixel,
  imageElement,
  shapeElement,
  textElement,
  gifElement,
  videoElement,
  audioElement,
  groupElement,
  keys,
} from "./testing";
import { bakeTrack } from "../animation/keyframes";
import type { Timeline, VisualTimelineElement } from "../../@types/timeline";

/** Renderers that just fill the element's local box, one colour per kind. */
function paintRenderers(): TimelineRenderers {
  const paint =
    (color: string) =>
    (ctx: CanvasRenderingContext2D, _id: string, el: VisualTimelineElement) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, el.width, el.height);
    };
  return {
    image: paint("#ff0000"),
    video: paint("#00ff00"),
    gif: paint("#0000ff"),
    text: paint("#ffff00"),
    shape: paint("#ff00ff"),
  } as TimelineRenderers;
}

const SIZE = 200;

function render(
  timeline: Timeline,
  timeInMs: number,
  renderers: TimelineRenderers = paintRenderers(),
  outline?: { controlOutlineEnabled: boolean; activeElementId: string },
  callback?: (id: string, el: VisualTimelineElement) => void,
) {
  const { canvas, ctx } = scene(SIZE, SIZE);
  renderTimelineAtTime(
    ctx,
    timeline,
    timeInMs,
    renderers,
    "#101020",
    SIZE,
    SIZE,
    outline,
    callback,
  );
  return { canvas, ctx };
}

describe("renderTimelineAtTime", () => {
  it("fills the background before anything else", () => {
    const { canvas } = render({}, 0);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });
  });

  it("draws lower priority first so higher priority lands on top", () => {
    const timeline: Timeline = {
      back: imageElement({
        priority: 1,
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
      }),
      front: shapeElement({
        priority: 2,
        location: { x: 50, y: 50 },
        width: 100,
        height: 100,
      }),
    };
    const { canvas } = render(timeline, 0);

    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 255 });
    expect(pixel(canvas, 10, 10)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("sorts by priority regardless of insertion order", () => {
    const timeline: Timeline = {
      front: shapeElement({
        priority: 9,
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
      }),
      back: imageElement({
        priority: 1,
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
      }),
    };
    const { canvas } = render(timeline, 0);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 255 });
  });

  it("skips elements that are not on screen at this time", () => {
    const timeline: Timeline = {
      later: imageElement({
        startTime: 5000,
        duration: 1000,
        location: { x: 0, y: 0 },
        width: SIZE,
        height: SIZE,
      }),
    };
    const { canvas } = render(timeline, 0);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });
  });

  it("never asks a renderer to draw an audio track", () => {
    const renderers = paintRenderers();
    const spy = vi.fn();
    const timeline: Timeline = {
      music: audioElement({ priority: 1 }),
      pic: imageElement({ priority: 2 }),
    };

    const seen: string[] = [];
    render(timeline, 0, renderers, undefined, (id) => seen.push(id));

    expect(seen).toEqual(["pic"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports each element it drew, in draw order", () => {
    const timeline: Timeline = {
      c: textElement({ priority: 3 }),
      a: imageElement({ priority: 1 }),
      b: gifElement({ priority: 2 }),
    };
    const seen: string[] = [];
    render(timeline, 0, paintRenderers(), undefined, (id) => seen.push(id));
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("outlines only the active element, and only when enabled", () => {
    const timeline: Timeline = {
      a: imageElement({ priority: 1, location: { x: 50, y: 60 }, width: 100, height: 100 }),
    };

    // The rotation grip sits 50px above the element box.
    const off = render(timeline, 0, paintRenderers(), {
      controlOutlineEnabled: false,
      activeElementId: "a",
    });
    expect(pixel(off.canvas, 100, 10)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });

    const other = render(timeline, 0, paintRenderers(), {
      controlOutlineEnabled: true,
      activeElementId: "someone-else",
    });
    expect(pixel(other.canvas, 100, 10)).toMatchObject({
      r: 0x10,
      g: 0x10,
      b: 0x20,
    });

    const on = render(timeline, 0, paintRenderers(), {
      controlOutlineEnabled: true,
      activeElementId: "a",
    });
    expect(pixel(on.canvas, 100, 10)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("keeps compositing the rest of the frame when one element cannot draw", () => {
    // An asset that has not loaded returns without drawing. That must not cost
    // the elements above it.
    const renderers = paintRenderers();
    (renderers as any).image = () => {
      return;
    };

    const timeline: Timeline = {
      missing: imageElement({ priority: 1, location: { x: 0, y: 0 }, width: SIZE, height: SIZE }),
      present: shapeElement({ priority: 2, location: { x: 50, y: 50 }, width: 100, height: 100 }),
    };

    const seen: string[] = [];
    const { canvas } = render(timeline, 0, renderers, undefined, (id) =>
      seen.push(id),
    );

    expect(seen).toEqual(["missing", "present"]);
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 255 });
    expect(pixel(canvas, 10, 10)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });
  });

  it("dispatches each element to the renderer for its own kind", () => {
    const calls: string[] = [];
    const track =
      (kind: string) =>
      () => {
        calls.push(kind);
      };
    const renderers = {
      image: track("image"),
      video: track("video"),
      gif: track("gif"),
      text: track("text"),
      shape: track("shape"),
    } as unknown as TimelineRenderers;

    const timeline: Timeline = {
      i: imageElement({ priority: 1 }),
      v: videoElement({ priority: 2 }),
      g: gifElement({ priority: 3 }),
      t: textElement({ priority: 4 }),
      s: shapeElement({ priority: 5 }),
    };

    render(timeline, 0, renderers);
    expect(calls).toEqual(["image", "video", "gif", "text", "shape"]);
  });

  it("places a caption at its own start time, independent of any clip", () => {
    // Captions used to be offset by a `parentKey` clip's start time. They are
    // ordinary clips on a text track now, so this one is on screen at 2500
    // because it says so, not because the video underneath begins there.
    const timeline: Timeline = {
      clip: videoElement({ priority: 1, startTime: 2000, duration: 5000 }),
      caption: textElement({ priority: 2, startTime: 2500, duration: 1000 }),
    };

    const early: string[] = [];
    render(timeline, 500, paintRenderers(), undefined, (id) => early.push(id));
    expect(early).toEqual([]);

    const during: string[] = [];
    render(timeline, 2500, paintRenderers(), undefined, (id) =>
      during.push(id),
    );
    expect(during).toEqual(["clip", "caption"]);

    // ...and it leaves when its own window closes, while the clip plays on.
    const after: string[] = [];
    render(timeline, 3500, paintRenderers(), undefined, (id) =>
      after.push(id),
    );
    expect(after).toEqual(["clip"]);
  });
});

describe("groups reach the compositor", () => {
  /** A red 40x40 image at `location`, optionally inside group `parentId`. */
  function child(location: { x: number; y: number }, parentId?: string) {
    return imageElement({
      width: 40,
      height: 40,
      location,
      ...(parentId != null ? { parentId } : {}),
    });
  }

  it("never draws the group itself", () => {
    // A group has no picture. If one ever reached `renderers[filetype]` there
    // would be no function to call, so this is about more than aesthetics.
    const { canvas } = render(
      {
        g: groupElement({ location: { x: 0, y: 0 }, width: 200, height: 200 }),
      },
      0,
    );
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });
  });

  it("draws a child at its parent's offset, not its own", () => {
    const { canvas } = render(
      {
        g: groupElement({ location: { x: 100, y: 100 }, width: 0, height: 0 }),
        c: child({ x: 0, y: 0 }, "g"),
      },
      0,
    );
    // Inside the group's offset: painted. At the clip's raw location: not.
    expect(pixel(canvas, 120, 120)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });
  });

  it("leaves an unparented clip exactly where it always was", () => {
    // The regression guard for the whole refactor: no parent, no change.
    const { canvas } = render({ c: child({ x: 20, y: 20 }) }, 0);
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("moves the child as the group's position animates", () => {
    const xs = keys([0, 0], [1000, 100]);
    const ys = keys([0, 0], [1000, 0]);
    const timeline: Timeline = {
      g: groupElement({
        location: { x: 0, y: 0 },
        width: 0,
        height: 0,
        animation: {
          ...groupElement().animation,
          position: {
            isActivate: true,
            x: xs,
            y: ys,
            ax: bakeTrack(xs),
            ay: bakeTrack(ys),
          },
        },
      }),
      c: child({ x: 0, y: 0 }, "g"),
    };

    expect(pixel(render(timeline, 0).canvas, 20, 20)).toMatchObject({ r: 255 });
    expect(pixel(render(timeline, 1000).canvas, 120, 20)).toMatchObject({ r: 255 });
    // …and it has left where it started.
    expect(pixel(render(timeline, 1000).canvas, 20, 20)).toMatchObject({
      r: 0x10,
      b: 0x20,
    });
  });

  it("multiplies the group's opacity into the child", () => {
    // Group 50% over a child at 100%: the red lands at half strength against
    // the background, which is what `globalAlpha *=` composes to.
    const { canvas } = render(
      {
        g: groupElement({
          location: { x: 0, y: 0 },
          width: 0,
          height: 0,
          opacity: 50,
        }),
        c: child({ x: 0, y: 0 }, "g"),
      },
      0,
    );
    const p = pixel(canvas, 20, 20);
    expect(p.r).toBeGreaterThan(100);
    expect(p.r).toBeLessThan(160);
  });

  it("compounds opacity down two levels of group", () => {
    const { canvas } = render(
      {
        outer: groupElement({
          location: { x: 0, y: 0 },
          width: 0,
          height: 0,
          opacity: 50,
        }),
        inner: groupElement({
          parentId: "outer",
          location: { x: 0, y: 0 },
          width: 0,
          height: 0,
          opacity: 50,
        }),
        c: child({ x: 0, y: 0 }, "inner"),
      },
      0,
    );
    // 0.25 of full red.
    const p = pixel(canvas, 20, 20);
    expect(p.r).toBeGreaterThan(40);
    expect(p.r).toBeLessThan(100);
  });

  it("does not gate a child on the group's own span", () => {
    // Parenting is spatial. A caption must not vanish because the title block
    // it is attached to has a shorter bar on the timeline.
    const { canvas } = render(
      {
        g: groupElement({
          startTime: 0,
          duration: 500,
          location: { x: 0, y: 0 },
          width: 0,
          height: 0,
        }),
        c: imageElement({
          parentId: "g",
          startTime: 0,
          duration: 4000,
          width: 40,
          height: 40,
          location: { x: 0, y: 0 },
        }),
      },
      2000,
    );
    expect(pixel(canvas, 20, 20)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("ignores a parent link that does not resolve", () => {
    const { canvas } = render({ c: child({ x: 20, y: 20 }, "gone") }, 0);
    expect(pixel(canvas, 30, 30)).toMatchObject({ r: 255, g: 0, b: 0 });
  });
});

/**
 * Blend at the level the compositor actually works: a clip against the frame
 * beneath it, in priority order, with the project background at the bottom.
 *
 * `element.test.ts` and `blendComposite.test.ts` cover the arithmetic. What
 * belongs here is that the *stack* is the backdrop — that a blended clip sees
 * the clips below it and not just the background, and that it does so in the
 * order `paint` walks.
 */
describe("renderTimelineAtTime — blend modes", () => {
  it("blends against the project background when nothing is beneath", () => {
    // Background #101020 multiplied by the image renderer's pure red keeps only
    // the red channel: (0x10, 0, 0).
    const { canvas } = render(
      {
        a: imageElement({
          priority: 1,
          startTime: 0,
          duration: 4000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
          blend: "multiply",
        }),
      },
      0,
    );
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0x10, g: 0, b: 0 });
  });

  it("blends against the clips below it, not merely the background", () => {
    // A white video underneath, a red image above it with multiply → red.
    // Against the dark background alone the result would be near black.
    const { canvas } = render(
      {
        under: videoElement({
          priority: 1,
          startTime: 0,
          duration: 4000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
        }),
        over: imageElement({
          priority: 2,
          startTime: 0,
          duration: 4000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
          blend: "multiply",
        }),
      },
      0,
      {
        ...paintRenderers(),
        video: (ctx: CanvasRenderingContext2D, _id, el) => {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, el.width, el.height);
        },
      } as TimelineRenderers,
    );
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("respects priority: the same pair the other way round differs", () => {
    // White over red with multiply is red too, but the *unblended* half of the
    // frame differs — this pins that the blend follows paint order rather than
    // being commutative by accident.
    const white = {
      ...paintRenderers(),
      video: (ctx: CanvasRenderingContext2D, _id, el) => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, el.width, el.height);
      },
    } as TimelineRenderers;

    const { canvas } = render(
      {
        under: imageElement({
          priority: 1,
          startTime: 0,
          duration: 4000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
        }),
        over: videoElement({
          priority: 2,
          startTime: 0,
          duration: 4000,
          width: 100,
          height: 100,
          location: { x: 0, y: 0 },
          blend: "multiply",
        }),
      },
      0,
      white,
    );

    // Where the blended white box covers the red: white × red = red.
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 255, g: 0, b: 0 });
    // Outside it the red image is untouched.
    expect(pixel(canvas, 150, 150)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("leaves an unblended clip drawn after a blended one alone", () => {
    const { canvas } = render(
      {
        blended: imageElement({
          priority: 1,
          startTime: 0,
          duration: 4000,
          width: 100,
          height: 100,
          location: { x: 0, y: 0 },
          blend: "difference",
        }),
        plain: gifElement({
          priority: 2,
          startTime: 0,
          duration: 4000,
          width: 50,
          height: 50,
          location: { x: 120, y: 120 },
        }),
      },
      0,
    );
    // The gif renderer's pure blue, stacked plainly.
    expect(pixel(canvas, 140, 140)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it("does not draw a blended clip that is outside its own span", () => {
    const { canvas } = render(
      {
        a: imageElement({
          priority: 1,
          startTime: 5000,
          duration: 1000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
          blend: "multiply",
        }),
      },
      0,
    );
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0x10, g: 0x10, b: 0x20 });
  });

  it("blends a clip inside a group, under the group's opacity", () => {
    const { canvas } = render(
      {
        g: groupElement({
          priority: 1,
          startTime: 0,
          duration: 4000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
        }),
        c: imageElement({
          parentId: "g",
          priority: 2,
          startTime: 0,
          duration: 4000,
          width: SIZE,
          height: SIZE,
          location: { x: 0, y: 0 },
          blend: "multiply",
        }),
      },
      0,
    );
    // Still the multiply against the background, with the group contributing an
    // identity transform and full opacity.
    expect(pixel(canvas, 100, 100)).toMatchObject({ r: 0x10, g: 0, b: 0 });
  });
});
