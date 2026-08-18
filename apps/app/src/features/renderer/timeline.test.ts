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
} from "./testing";
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
