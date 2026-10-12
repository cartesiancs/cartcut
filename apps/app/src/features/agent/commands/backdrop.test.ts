/**
 * `set_shape_backdrop`, and `add_shape`'s `backdrop`, from the agent surface.
 *
 * The claims pinned here, in order of what goes wrong without them:
 *
 *  - **A preset that cannot run is refused before anything is stored.** Stored,
 *    it would draw the shape solid with nothing to say why, so the agent hears
 *    about a missing preset, a transition, a graphic and an overlay here.
 *  - **The first backdrop switches the fill off**, unless the caller says what
 *    it wants. An opaque fill hides the mosaic, and an agent that saw nothing
 *    change would decide the tool had not worked.
 *  - **One call is one undo step**, however many shapes it names, and a call
 *    that changes nothing costs none.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import { __setPresetsForTesting } from "../../fx/presetRegistry";
import type { FxPreset } from "../../fx/presetTypes";
import {
  shapeElement,
  textElement,
  videoElement,
} from "../../renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../../timeline/tracks";
import { getCommand } from "../registry";

import "./meta";
import "./shape";
import "./media";
import "./clip";

async function run(name: string, params: any = {}) {
  const command = getCommand(name);
  if (command == null) {
    throw new Error(`no such command: ${name}`);
  }
  return (await command(params)) as any;
}

const doc = () => useTimelineStore.getState().getDocument();
const historyLength = () =>
  useTimelineStore.getState().history.timelineHistory.length;

function preset(
  id: string,
  kind: string,
  type: string,
  params: Array<{ key: string; default: unknown }> = [],
): FxPreset {
  return {
    id,
    kind,
    name: id,
    origin: "builtin",
    render: { type },
    params: params.map((param) => ({ ...param, type: "number", uniform: param.key })),
  } as unknown as FxPreset;
}

const PIXELATE = "com.cartcut.pixelate";
const BLUR = "com.cartcut.gaussian-blur";

beforeEach(() => {
  __setPresetsForTesting([
    preset(PIXELATE, "effect", "shader", [
      { key: "size", default: 16 },
      { key: "average", default: true },
    ]),
    preset(BLUR, "effect", "shader", [{ key: "radius", default: 8 }]),
    preset("com.cartcut.lut.albumen", "lut", "lut"),
    preset("com.cartcut.dissolve", "transition", "shader"),
    preset("com.cartcut.leaks", "effect", "overlay"),
  ]);

  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0), createTrack("v1", "video", 1)],
      elements: {
        face: shapeElement({ trackId: "v0", startTime: 0, duration: 4000 }),
        other: shapeElement({ trackId: "v0", startTime: 4000, duration: 1000 }),
        clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        title: textElement({ trackId: "v0", startTime: 5000, duration: 1000 }),
      },
    }),
  );
});

afterEach(() => {
  __setPresetsForTesting([]);
});

describe("set_shape_backdrop", () => {
  it("runs a preset in a shape, seeded with its defaults, and switches the fill off", async () => {
    const result = await run("set_shape_backdrop", {
      elementIds: ["face"],
      presetId: PIXELATE,
      params: { size: 40 },
    });
    expect(result.ok).toBe(true);

    const face = doc().elements.face as any;
    expect(face.backdropFx).toEqual({
      presetId: PIXELATE,
      params: { size: 40, average: true },
      intensity: 100,
    });
    expect(face.option.fillOpacity).toBe(0);
    expect(result.clips[0]).toMatchObject({
      id: "face",
      fillOpacity: 0,
      backdrop: { presetId: PIXELATE, draws: true },
    });
  });

  it("is one undo step for every shape it names", async () => {
    // The first edit after a load also records the baseline it undoes to
    // (`agent/checkpoint.ts`), so the count is taken after one.
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: BLUR });
    const before = historyLength();
    await run("set_shape_backdrop", { elementIds: ["face", "other"], presetId: PIXELATE });
    expect(historyLength()).toBe(before + 1);
    expect((doc().elements.other as any).backdropFx.presetId).toBe(PIXELATE);
  });

  it("leaves the fill alone when the shape already had a backdrop, or when told", async () => {
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE, fillOpacity: 30 });
    expect((doc().elements.face as any).option.fillOpacity).toBe(30);

    // Changing the preset of a shape that has one keeps what the user chose.
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: BLUR });
    expect((doc().elements.face as any).option.fillOpacity).toBe(30);
    expect((doc().elements.face as any).backdropFx.params).toEqual({ radius: 8 });
  });

  it("takes a LUT", async () => {
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: "com.cartcut.lut.albumen" });
    expect((doc().elements.face as any).backdropFx.presetId).toBe("com.cartcut.lut.albumen");
  });

  it("refuses a preset that cannot run as a backdrop, storing nothing", async () => {
    const before = doc().elements;
    await expect(
      run("set_shape_backdrop", { elementIds: ["face"], presetId: "com.cartcut.missing" }),
    ).rejects.toThrow(/No preset "com.cartcut.missing" is installed/);
    await expect(
      run("set_shape_backdrop", { elementIds: ["face"], presetId: "com.cartcut.dissolve" }),
    ).rejects.toThrow(/is a transition preset/);
    await expect(
      run("set_shape_backdrop", { elementIds: ["face"], presetId: "com.cartcut.leaks" }),
    ).rejects.toThrow(/is an overlay/);
    expect(doc().elements).toBe(before);
  });

  it("refuses a clip that is not a shape", async () => {
    await expect(
      run("set_shape_backdrop", { elementIds: ["face", "clip"], presetId: PIXELATE }),
    ).rejects.toThrow(/Only shape clips carry a backdrop; got video/);
  });

  it("refuses a preset and a program together, and remove with either", async () => {
    await expect(
      run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE, program: {} }),
    ).rejects.toThrow(/not both/);
    await expect(
      run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE, remove: true }),
    ).rejects.toThrow(/on its own/);
  });

  it("adjusts a backdrop already there, and says when there is none", async () => {
    await expect(
      run("set_shape_backdrop", { elementIds: ["face"], intensity: 50 }),
    ).rejects.toThrow(/no backdrop to adjust yet/);

    await run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE });
    await run("set_shape_backdrop", { elementIds: ["face"], params: { size: 24 }, intensity: 60 });
    expect((doc().elements.face as any).backdropFx).toEqual({
      presetId: PIXELATE,
      params: { size: 24, average: true },
      intensity: 60,
    });
  });

  it("declines what changes nothing, at no cost", async () => {
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE });
    const before = historyLength();
    const again = await run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE });
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already have that backdrop/);
    expect(historyLength()).toBe(before);
  });

  it("removes a backdrop, deleting the key, and leaves the fill as it is", async () => {
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE });
    await run("set_shape_backdrop", { elementIds: ["face"], remove: true });
    const face = doc().elements.face as any;
    expect("backdropFx" in face).toBe(false);
    expect(face.option.fillOpacity).toBe(0);

    const none = await run("set_shape_backdrop", { elementIds: ["face"], remove: true });
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/no backdrop to remove/);
  });

  it("can restore the fill on its own", async () => {
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: PIXELATE });
    await run("set_shape_backdrop", { elementIds: ["face"], fillOpacity: 100 });
    expect((doc().elements.face as any).option).not.toHaveProperty("fillOpacity");
  });
});

describe("add_shape with a backdrop", () => {
  it("places a mosaic in one call, one undo step, with its fill off", async () => {
    await run("set_shape_backdrop", { elementIds: ["face"], presetId: BLUR });
    const before = historyLength();
    const result = await run("add_shape", {
      kind: "ellipse",
      startMs: 0,
      durationMs: 2000,
      backdrop: { presetId: PIXELATE },
    });
    expect(historyLength()).toBe(before + 1);
    expect(result.backdrop).toMatchObject({ presetId: PIXELATE, draws: true });
    expect(result.fillOpacity).toBe(0);

    const shapes = Object.values(doc().elements).filter(
      (element: any) => element.backdropFx?.presetId === PIXELATE,
    ) as any[];
    expect(shapes).toHaveLength(1);
    expect(shapes[0].geometry.kind).toBe("ellipse");
  });

  it("refuses a backdrop that cannot run before placing anything", async () => {
    const before = doc().elements;
    await expect(
      run("add_shape", { kind: "ellipse", backdrop: { presetId: "com.cartcut.dissolve" } }),
    ).rejects.toThrow(/transition preset/);
    expect(doc().elements).toBe(before);
  });

  it("places a plain shape exactly as before", async () => {
    const result = await run("add_shape", { kind: "rectangle", startMs: 6000 });
    expect(result).not.toHaveProperty("backdrop");
    const added = Object.values(doc().elements).find(
      (element: any) => element.filetype === "shape" && element.startTime === 6000,
    ) as any;
    expect(added.option).not.toHaveProperty("fillOpacity");
  });
});

describe("update_clip and a shape's fill opacity", () => {
  it("writes it through the op, deleting the key at full strength", async () => {
    await run("update_clip", { elementId: "face", patch: { option: { fillOpacity: 40 } } });
    expect((doc().elements.face as any).option.fillOpacity).toBe(40);

    await run("update_clip", { elementId: "face", patch: { option: { fillOpacity: 100 } } });
    expect((doc().elements.face as any).option).not.toHaveProperty("fillOpacity");
  });

  it("refuses a value out of range", async () => {
    await expect(
      run("update_clip", { elementId: "face", patch: { option: { fillOpacity: 140 } } }),
    ).rejects.toThrow(/option.fillOpacity/);
  });
});
