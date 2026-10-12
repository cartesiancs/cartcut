import { afterEach, describe, expect, it } from "vitest";
import { __setPresetsForTesting } from "../fx/presetRegistry";
import type { FxPreset } from "../fx/presetTypes";
import { effectElement, shapeElement } from "../renderer/testing";
import { loadPendingLuts, lutIdsIn } from "./lutRegistry";

/**
 * Which LUTs the export reads before its first frame.
 *
 * A LUT that is missed here is read lazily, and the first frames of the
 * render draw ungraded while it loads: in a shape's backdrop, the inside of the
 * shape exports untouched for those frames.
 */

function preset(id: string, kind: string, type: string): FxPreset {
  return { id, kind, render: { type } } as unknown as FxPreset;
}

afterEach(() => {
  __setPresetsForTesting([]);
});

describe("lutIdsIn", () => {
  it("reads a LUT carried by a shape's backdrop", () => {
    __setPresetsForTesting([
      preset("com.cartcut.lut.albumen", "lut", "lut"),
      preset("com.cartcut.pixelate", "effect", "shader"),
    ]);
    const ids = lutIdsIn({
      graded: shapeElement({
        backdropFx: { presetId: "com.cartcut.lut.albumen", params: {}, intensity: 100 },
      }),
      mosaic: shapeElement({
        key: "mosaic",
        backdropFx: { presetId: "com.cartcut.pixelate", params: {}, intensity: 100 },
      }),
    });
    // The shader backdrop has no table to read.
    expect(ids).toEqual(["com.cartcut.lut.albumen"]);
  });

  it("still reads an adjustment layer's LUT, once however many use it", () => {
    __setPresetsForTesting([preset("com.cartcut.lut.albumen", "lut", "lut")]);
    const ids = lutIdsIn({
      e: effectElement({ presetId: "com.cartcut.lut.albumen" } as any),
      s: shapeElement({
        backdropFx: { presetId: "com.cartcut.lut.albumen", params: {}, intensity: 100 },
      }),
    });
    expect(ids).toEqual(["com.cartcut.lut.albumen"]);
  });

  it("reads nothing for a backdrop whose preset is not installed", () => {
    __setPresetsForTesting([]);
    expect(
      lutIdsIn({
        s: shapeElement({
          backdropFx: { presetId: "com.cartcut.lut.albumen", params: {}, intensity: 100 },
        }),
      }),
    ).toEqual([]);
  });
});

describe("loadPendingLuts", () => {
  it("answers null, allocating nothing, when a document uses no LUT", () => {
    __setPresetsForTesting([preset("com.cartcut.pixelate", "effect", "shader")]);
    expect(
      loadPendingLuts({
        s: shapeElement({
          backdropFx: { presetId: "com.cartcut.pixelate", params: {}, intensity: 100 },
        }),
      }),
    ).toBeNull();
  });

  it("asks for a LUT backdrop's table, and does not ask twice for one that failed", async () => {
    // Installed but with no file behind it: the read fails, and is recorded.
    __setPresetsForTesting([
      {
        id: "com.cartcut.lut.broken",
        kind: "lut",
        render: { type: "lut", source: "lut.cube" },
        assets: {},
      } as unknown as FxPreset,
    ]);
    const doc = {
      s: shapeElement({
        backdropFx: { presetId: "com.cartcut.lut.broken", params: {}, intensity: 100 },
      }),
    };
    const first = loadPendingLuts(doc);
    expect(first).not.toBeNull();
    expect(await first).toBe(false);
    // Failed for good, so the preview stops asking on every paint.
    expect(loadPendingLuts(doc)).toBeNull();
  });
});
