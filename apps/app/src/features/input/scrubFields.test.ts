import { describe, it, expect } from "vitest";
import { SCRUB_FIELDS } from "./scrubFields";

describe("SCRUB_FIELDS", () => {
  it("gives every field a usable grid and direction", () => {
    for (const [id, spec] of Object.entries(SCRUB_FIELDS)) {
      expect(spec.sensitivity, id).toBeGreaterThan(0);
      expect(spec.step, id).toBeGreaterThan(0);
    }
  });

  it("keeps every bound ordered and reachable on the grid", () => {
    for (const [id, spec] of Object.entries(SCRUB_FIELDS)) {
      if (spec.min != null && spec.max != null) {
        expect(spec.min, id).toBeLessThan(spec.max);
      }
      // A floor off the grid would be a value the drag can sit on but never
      // step back to.
      if (spec.min != null) {
        expect(spec.min % spec.step, id).toBe(0);
      }
    }
  });

  it("holds these fields as whole numbers", () => {
    for (const [id, spec] of Object.entries(SCRUB_FIELDS)) {
      expect(spec.decimals, id).toBe(0);
    }
  });

  it("keeps the frame rate inside the band frames.ts allows", () => {
    expect(SCRUB_FIELDS.projectFps.min).toBe(1);
    expect(SCRUB_FIELDS.projectFps.max).toBe(240);
  });

  it("steps the two resolution fields by two, for yuv420p", () => {
    expect(SCRUB_FIELDS.previewSizeW.step).toBe(2);
    expect(SCRUB_FIELDS.previewSizeH.step).toBe(2);
  });
});
