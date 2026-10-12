import { afterEach, describe, expect, it } from "vitest";
import { __setPresetsForTesting } from "../fx/presetRegistry";
import type { FxPreset } from "../fx/presetTypes";
import { shapeElement } from "../renderer/testing";
import { backdropRow, clipDetail, clipRow } from "./serialize";

/**
 * A shape's backdrop as an agent reads it.
 *
 * The serialiser picks a shape's fields by hand, so a new one is invisible to
 * an agent until it is added here: stored correctly and reported as absent.
 */

const PIXELATE = "com.cartcut.pixelate";

afterEach(() => {
  __setPresetsForTesting([]);
});

function installed(): void {
  __setPresetsForTesting([
    { id: PIXELATE, kind: "effect", render: { type: "shader" }, params: [] } as unknown as FxPreset,
  ]);
}

const mosaic = () =>
  shapeElement({
    backdropFx: { presetId: PIXELATE, params: { size: 16 }, intensity: 80 },
    option: { fillColor: "#000000", fillOpacity: 0 },
  });

describe("a shape's backdrop in the serialiser", () => {
  it("leaves a plain shape's row exactly as it was", () => {
    const row = clipRow("s", shapeElement()) as any;
    expect(row).not.toHaveProperty("backdrop");
    expect(row).not.toHaveProperty("fillOpacity");
    expect(row.fillColor).toBe("#ff0000");
  });

  it("reports the backdrop and the fill in a row", () => {
    installed();
    const row = clipRow("s", mosaic()) as any;
    expect(row.fillOpacity).toBe(0);
    expect(row.backdrop).toEqual({
      presetId: PIXELATE,
      intensity: 80,
      params: { size: 16 },
      draws: true,
    });
  });

  it("says when the backdrop cannot draw, so the shape is filling solid", () => {
    __setPresetsForTesting([]);
    expect(backdropRow(mosaic())?.draws).toBe(false);
  });

  it("reports both in a clip's detail, null for a shape with none", () => {
    installed();
    expect(clipDetail("s", mosaic())).toMatchObject({
      fillOpacity: 0,
      backdrop: { presetId: PIXELATE, draws: true },
    });
    expect(clipDetail("p", shapeElement())).toMatchObject({
      fillOpacity: 100,
      backdrop: null,
    });
  });

  it("reports a program by its facts, never its source", () => {
    const source = "vec4 effect(vec2 uv) { return getSourceColor(uv); }";
    const row = backdropRow(
      shapeElement({
        backdropFx: {
          presetId: "inline.0123456789abcdef",
          params: {},
          intensity: 100,
          program: {
            hash: "0123456789abcdef",
            manifest: { schema: 1, kind: "effect", name: "Smear", category: "blur", render: { type: "shader" } },
            sources: { "main.frag": source },
          },
        },
      }),
    );
    expect(row?.program).toEqual({
      hash: "0123456789abcdef",
      name: "Smear",
      renderType: "shader",
      bytes: source.length,
    });
    expect(JSON.stringify(row)).not.toContain("getSourceColor");
  });
});
