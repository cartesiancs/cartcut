/**
 * An HTML graphic inside a template, through the real composition, the real
 * planner and the real renderer.
 *
 * The prepare step rasterises a template's inner graphics before the composite
 * reaches them, so it has to plan under exactly the ids and at exactly the
 * clamped inner time the template renderer will use. Both sides are asked here
 * rather than assumed: the plan comes from `templateCompositionAt`, the raster
 * is filed under the plan's id, and the pixels say whether the renderer found
 * it. Filing it under the inner key instead must draw nothing, which is what
 * proves the id is being checked at all.
 */

import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GraphicElementType,
  TemplateElementType,
  Timeline,
} from "../../@types/timeline";
import { createGraphicElement } from "../element/graphicElement";
import { coerceInlineProgram, toRawPayload } from "../fx/inlineProgram";
import type { FxPreset } from "../fx/presetTypes";
import { validatePreset } from "../fx/presetValidate";
import { renderElement } from "../renderer/element";
import { installGraphicRuntime, renderGraphic } from "../renderer/graphic";
import {
  installTemplateResolver,
  renderTemplate,
  templateCompositionAt,
} from "../renderer/template";
import { pixel, scene } from "../renderer/testing";
import type { TimelineRenderers } from "../renderer/timeline";
import type { TemplateData } from "../template/compose";
import { slotsOf } from "../template/slots";
import { createTemplateElement } from "../timeline/templateOps";
import { createGraphicScope, withGraphicScope } from "./graphicScope";
import { planGraphics } from "./planGraphics";

function htmlProgram() {
  const result = coerceInlineProgram({
    kind: "graphic",
    name: "Inner",
    render: {
      type: "html",
      html: '<h1 data-param="title"></h1>',
      css: "h1 { animation: in 1s both } @keyframes in { from { opacity: 0 } }",
    },
    params: [{ key: "title", label: "T", type: "text", default: "Hi" }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const validated = validatePreset(toRawPayload(result.program));
  if (!validated.ok) throw new Error(validated.errors.join("\n"));
  return { program: result.program, preset: validated.preset };
}

const INNER = htmlProgram();

/** A 100x100 template holding one graphic over its whole frame, inner time 0 to 2000. */
function templateData(): TemplateData {
  const graphic: GraphicElementType = {
    ...createGraphicElement({
      program: INNER.program,
      params: { title: "Hi" },
      name: "Inner",
      startTime: 0,
      duration: 2000,
      width: 100,
      height: 100,
    }),
    key: "title",
    trackId: "inner",
    priority: 1,
  };
  const elements = { title: graphic } as Timeline;
  return {
    id: "with-graphic",
    name: "With graphic",
    size: { w: 100, h: 100 },
    durationMs: 2000,
    elements,
    slots: slotsOf(elements),
  };
}

const DATA = templateData();

function placed(): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: "with-graphic",
      name: "With graphic",
      durationMs: 2000,
      size: { w: 100, h: 100 },
      frame: { w: 100, h: 100 },
    }),
    key: "tpl",
    startTime: 1000,
    trackId: "t",
    priority: 1,
  } as TemplateElementType;
}

const table = {
  graphic: renderGraphic,
  image: () => {},
  video: () => {},
  gif: () => {},
  text: () => {},
  shape: () => {},
  template: () => {},
} as unknown as TimelineRenderers;

function install() {
  installTemplateResolver((id) => (id === DATA.id ? DATA : null), table);
  installGraphicRuntime({
    presetOf: (element) => (element.program?.hash === INNER.program.hash ? INNER.preset : null),
    previewGl: () => null,
    fps: () => 30,
    latestHtmlRaster: () => null,
    noteDrawScale: () => {},
  });
}

afterEach(() => {
  installTemplateResolver(() => null, table);
  installGraphicRuntime(null);
});

function green(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, 0, width, height);
  return canvas as unknown as CanvasImageSource;
}

function plan(element: TemplateElementType, cursor: number) {
  return planGraphics({
    elements: { tpl: element } as Timeline,
    timeInMs: cursor,
    fps: 30,
    presetOf: (graphic) => (graphic.program?.hash === INNER.program.hash ? INNER.preset : null),
    expandTemplate: templateCompositionAt,
    scaleOf: () => 1,
    resolvers: { fontFamilyOf: () => "x", imageUrlOf: () => null },
    fontGeneration: 0,
  });
}

function draw(element: TemplateElementType, cursor: number, rasters: Map<string, CanvasImageSource>) {
  const { ctx, canvas } = scene(100, 100);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(0, 0, 100, 100);
  withGraphicScope({ ...createGraphicScope("test", null, 30), rasters }, () =>
    renderElement(ctx, "tpl", element as any, cursor, false, renderTemplate as any, {
      elements: { tpl: element } as Timeline,
    }),
  );
  return { ctx, canvas };
}

describe("an HTML graphic inside a template", () => {
  it("is planned under the id the template renderer draws it under", () => {
    install();
    const element = placed();
    const jobs = plan(element, 1500);
    const composition = templateCompositionAt("tpl", element, 1500);
    expect(jobs).toHaveLength(1);
    expect(Object.keys(composition?.elements ?? {})).toContain(jobs[0].instanceId);
    expect(jobs[0].instanceId).not.toBe("title");
  });

  it("is planned at the template's inner time", () => {
    install();
    expect(plan(placed(), 1500)[0].time.tMs).toBe(500);
  });

  it("draws the raster filed under the planned id", () => {
    install();
    const element = placed();
    const [job] = plan(element, 1500);
    const { canvas } = draw(element, 1500, new Map([[job.instanceId, green(100, 100)]]));
    expect(pixel(canvas, 50, 50)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("draws nothing for a raster filed under the inner key, so the id is what matters", () => {
    install();
    const { canvas } = draw(placed(), 1500, new Map([["title", green(100, 100)]]));
    expect(pixel(canvas, 50, 50)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("plans nothing outside the template's span", () => {
    install();
    expect(plan(placed(), 500)).toEqual([]);
    expect(plan(placed(), 3500)).toEqual([]);
  });
});
