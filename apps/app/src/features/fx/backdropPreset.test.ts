import { describe, it, expect } from "vitest";
import { backdropModeOf } from "./backdropPreset";
import type { FxPreset } from "./presetTypes";

function preset(kind: string, type: string): FxPreset {
  return { kind, render: { type } } as unknown as FxPreset;
}

describe("backdropModeOf", () => {
  it("runs an effect shader and a LUT", () => {
    expect(backdropModeOf(preset("effect", "shader"))).toBe("shader");
    expect(backdropModeOf(preset("lut", "lut"))).toBe("lut");
  });

  it("refuses an overlay, which has nothing to read beneath it", () => {
    expect(backdropModeOf(preset("effect", "overlay"))).toBeNull();
  });

  it("refuses a transition and a graphic, which bind other samplers", () => {
    // `modeOfResolved` answers "shader" for both, because it never reads the
    // kind. Stored on a backdrop, a transition would bind `from` and `to` where
    // the effect wrapper reads `source` and `original`.
    expect(backdropModeOf(preset("transition", "shader"))).toBeNull();
    expect(backdropModeOf(preset("graphic", "html"))).toBeNull();
    expect(backdropModeOf(preset("graphic", "shader"))).toBeNull();
  });

  it("refuses nothing installed", () => {
    expect(backdropModeOf(null)).toBeNull();
    expect(backdropModeOf(undefined)).toBeNull();
  });
});
