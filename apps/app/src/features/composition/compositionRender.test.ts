import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ImageElementType,
  TemplateElementType,
  Timeline,
} from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import {
  compositionDataOf,
  snapshotTemplateResolver,
} from "../../states/timelineWorkspace";
import { renderElement } from "../renderer/element";
import {
  resetLayers,
  setSurfaceFactory,
  type Surface,
} from "../renderer/surface";
import {
  installTemplateResolver,
  renderTemplate,
  templateCompositionAt,
  withTemplateResolver,
} from "../renderer/template";
import { imageElement, pixel, scene } from "../renderer/testing";
import type { TimelineRenderers } from "../renderer/timeline";
import {
  installProjectTemplates,
  loadTemplate,
  resetTemplateRegistry,
  setTemplateReader,
  templateFor,
} from "../template/templateRegistry";
import { createTemplateElement } from "../timeline/templateOps";
import { createTrack } from "../timeline/tracks";
import { MAIN_TIMELINE, projectTemplateId } from "./project";

/**
 * A composition reaching the picture, asserted on bytes through the real
 * `renderElement`: an edit made in its own timeline shows in main's
 * composite, and a composite inside `withTemplateResolver` shows the project
 * as it was captured, not as it is.
 */

const skiaFactory = (width: number, height: number): Surface => {
  const canvas = createCanvas(width, height);
  return {
    canvas: canvas as unknown as Surface["canvas"],
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
};

const fillBox =
  (color: string) =>
  (ctx: CanvasRenderingContext2D, _id: string, element: ImageElementType) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, element.width, element.height);
  };

const innerRenderers = {
  image: fillBox("#ff0000"),
  video: () => {},
  gif: () => {},
  text: () => {},
  shape: () => {},
  template: () => {},
} as unknown as TimelineRenderers;

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

const store = () => useTimelineStore.getState();

/** Main holds one template clip naming composition `c1`, red on its left half. */
function seed() {
  const clip = {
    ...createTemplateElement({
      templateId: projectTemplateId("c1"),
      name: "C",
      durationMs: 2000,
      size: { w: 100, h: 100 },
      frame: { w: 100, h: 100 },
    }),
    key: "tpl",
    trackId: "v",
  } as TemplateElementType;
  store().clearTimeline();
  store().loadProject({
    main: { tracks: [createTrack("v", "video", 0)], elements: { tpl: clip } },
    compositions: {
      c1: {
        id: "c1",
        name: "C",
        size: { w: 100, h: 100 },
        tracks: [createTrack("cv", "video", 0)],
        elements: {
          box: imageElement({
            key: "box",
            trackId: "cv",
            startTime: 0,
            duration: 2000,
            width: 50,
            height: 100,
            location: { x: 0, y: 0 },
          }),
        } as Timeline,
      },
    },
  });
}

/** Main's template clip on a blue 100x100 scene. */
function drawMain() {
  const clip = (
    store().activeTimelineId === MAIN_TIMELINE
      ? store().timeline
      : store().parked[MAIN_TIMELINE].elements
  ).tpl as TemplateElementType;
  const { ctx, canvas } = scene(100, 100);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(0, 0, 100, 100);
  renderElement(ctx, "tpl", clip as any, 0, false, renderTemplate as any, {
    elements: { tpl: clip } as Timeline,
  });
  return canvas;
}

/** Move the composition's box to the right half, from inside its own timeline. */
function moveBoxRight() {
  store().switchTimeline("c1");
  store().withCheckpoint((doc) => ({
    ...doc,
    elements: {
      ...doc.elements,
      box: { ...doc.elements.box, location: { x: 50, y: 0 } },
    },
  }));
  store().switchTimeline(MAIN_TIMELINE);
}

beforeEach(() => {
  setSurfaceFactory(skiaFactory);
  installTemplateResolver(templateFor, innerRenderers);
  installProjectTemplates((id) => compositionDataOf(store(), id));
  seed();
});

afterEach(() => {
  resetLayers();
  resetTemplateRegistry();
  installTemplateResolver(() => null, innerRenderers);
});

describe("a composition in main's picture", () => {
  it("draws through the registry, from the store", () => {
    const canvas = drawMain();
    expect(pixel(canvas, 25, 50)).toEqual(RED);
    expect(pixel(canvas, 75, 50)).toEqual(BLUE);
  });

  it("shows an edit made in its own timeline", () => {
    moveBoxRight();
    const canvas = drawMain();
    expect(pixel(canvas, 25, 50)).toEqual(BLUE);
    expect(pixel(canvas, 75, 50)).toEqual(RED);
  });

  it("is read from the store without touching the disk", async () => {
    let reads = 0;
    setTemplateReader(async () => {
      reads += 1;
      throw new Error("no disk here");
    });
    expect(await loadTemplate(projectTemplateId("c1"))).toBe(
      templateFor(projectTemplateId("c1")),
    );
    expect(templateFor(projectTemplateId("c1"))).not.toBeNull();
    expect(reads).toBe(0);
  });

  it("answers nothing for a composition the project does not have", () => {
    expect(templateFor(projectTemplateId("ghost"))).toBeNull();
  });
});

describe("a composite inside withTemplateResolver", () => {
  it("draws the project as captured, while the store moves on", () => {
    const captured = snapshotTemplateResolver(store(), templateFor);
    moveBoxRight();

    // Outside the scope: the live project, with the box on the right.
    const live = drawMain();
    expect(pixel(live, 75, 50)).toEqual(RED);

    // Inside it: as it was at the capture, on the left. The two differing is
    // what shows this measures anything.
    const held = withTemplateResolver(captured, () => drawMain());
    expect(pixel(held, 25, 50)).toEqual(RED);
    expect(pixel(held, 75, 50)).toEqual(BLUE);
  });

  it("gives the installed resolver back afterwards, even on a throw", () => {
    const captured = snapshotTemplateResolver(store(), templateFor);
    moveBoxRight();
    expect(() =>
      withTemplateResolver(captured, () => {
        throw new Error("mid-composite");
      }),
    ).toThrow();
    expect(pixel(drawMain(), 75, 50)).toEqual(RED);
  });

  it("hands the graphic planner the captured contents too", () => {
    const captured = snapshotTemplateResolver(store(), templateFor);
    moveBoxRight();
    const clip = store().timeline.tpl as TemplateElementType;
    const held = templateCompositionAt("tpl", clip, 0, captured)!;
    const live = templateCompositionAt("tpl", clip, 0)!;
    expect((held.elements["tpl::box"] as any).location.x).toBe(0);
    expect((live.elements["tpl::box"] as any).location.x).toBe(50);
  });

  it("delegates an installed template to the resolver it was given", () => {
    const installed = { id: "neon" } as any;
    const captured = snapshotTemplateResolver(store(), (id) =>
      id === "neon" ? installed : null,
    );
    expect(captured("neon")).toBe(installed);
    expect(captured("other")).toBeNull();
  });
});
