/**
 * Setting a clip's video filter, and switching between filter types.
 *
 * The claim worth pinning is the type switch. A filter's parameters are a
 * positional `k=v:k=v` string whose keys differ per filter, so an edit that
 * changes only the name hands the next shader the previous one's string — and
 * the shaders read it rather than reject it. That is not a cosmetic bug: a
 * chromakey holding a blur's `f=5` keys out every pixel within distance 5,
 * which is all of them, and the clip renders empty. Both directions of that
 * switch are tested here.
 *
 * The decline paths get equal weight. `withCheckpoint` reads identity to decide
 * whether an undo step happened, so an op that returns a *copy* when it
 * declines makes Cmd+Z eat a step the user never took.
 */

import { describe, it, expect } from "vitest";
import {
  filterOf,
  isFilterEnabled,
  setFilterEnabled,
  setVideoFilter,
} from "./filterOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { parseRGBString } from "../renderer/filter/chromaKey";
import { parseBlurString } from "../renderer/filter/blur";
import { textElement, videoElement } from "../renderer/testing";

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  });
}

/** A video clip carrying `filter`, defaulting to none. */
function withFilter(filter = { enable: false, list: [] as any[] }) {
  return doc({
    v: videoElement({ trackId: "v1", startTime: 0, duration: 4000, filter }),
  });
}

const filterOn = (next: TimelineDocument) => (next.elements.v as any).filter;

describe("setVideoFilter", () => {
  it("stores a chromakey as the string the shader parses", () => {
    const next = setVideoFilter(withFilter(), "v", {
      name: "chromakey",
      color: "#00ff00",
      threshold: 0.4,
    });

    expect(filterOn(next).list).toEqual([
      { name: "chromakey", value: "r=0:g=255:b=0:f=0.4" },
    ]);
  });

  it("clears the list when given null", () => {
    const seeded = setVideoFilter(withFilter(), "v", { name: "blur" });
    const cleared = setVideoFilter(seeded, "v", null);

    expect(filterOn(cleared).list).toEqual([]);
  });

  it("leaves `enable` alone", () => {
    const on = withFilter({ enable: true, list: [] });
    const next = setVideoFilter(on, "v", { name: "blur", strength: 8 });

    expect(filterOn(next).enable).toBe(true);
  });

  describe("switching filter type", () => {
    it("re-seeds the parameters going chromakey -> blur", () => {
      const keyed = setVideoFilter(withFilter(), "v", {
        name: "chromakey",
        color: "#00ff00",
        threshold: 0.5,
      });
      const blurred = setVideoFilter(keyed, "v", { name: "blur" });

      const value = filterOn(blurred).list[0].value;
      // Not merely "no r=" — the strength has to survive `parseInt`, which is
      // what turned a leftover `f=0.5` into a blur of zero.
      expect(value).not.toMatch(/r=/);
      expect(parseBlurString(value).f).toBeGreaterThan(0);
    });

    it("re-seeds the parameters going blur -> chromakey", () => {
      const blurred = setVideoFilter(withFilter(), "v", {
        name: "blur",
        strength: 5,
      });
      const keyed = setVideoFilter(blurred, "v", { name: "chromakey" });

      const { r, g, b, f } = parseRGBString(filterOn(keyed).list[0].value);
      expect([r, g, b]).toEqual([0, 0, 0]);
      // A leftover `f=5` keys out every pixel: `distance()` over rgb in 0..1
      // can never reach 5, so the clip would render fully transparent.
      expect(f).toBeLessThanOrEqual(1);
    });

    it("keeps radialblur's own parameters", () => {
      const next = setVideoFilter(withFilter(), "v", {
        name: "radialblur",
        strength: 3,
      });

      expect(filterOn(next).list[0]).toEqual({
        name: "radialblur",
        value: "f=3",
      });
    });
  });

  describe("declines", () => {
    it("by identity when the clip already carries that filter", () => {
      const seeded = setVideoFilter(withFilter(), "v", {
        name: "chromakey",
        color: "#00ff00",
        threshold: 0.4,
      });

      expect(
        setVideoFilter(seeded, "v", {
          name: "chromakey",
          color: "#00ff00",
          threshold: 0.4,
        }),
      ).toBe(seeded);
    });

    it("by identity when clearing an already-empty list", () => {
      const empty = withFilter();
      expect(setVideoFilter(empty, "v", null)).toBe(empty);
    });

    it("by identity on a clip that is not a video", () => {
      const text = doc({ t: textElement({ trackId: "v1" }) });
      expect(setVideoFilter(text, "t", { name: "blur" })).toBe(text);
    });

    it("by identity on an id that is not in the document", () => {
      const base = withFilter();
      expect(setVideoFilter(base, "missing", { name: "blur" })).toBe(base);
    });
  });

  it("does not mutate the document it was given", () => {
    const base = withFilter();
    const before = (base.elements.v as any).filter.list;

    setVideoFilter(base, "v", { name: "blur", strength: 8 });

    // The panel used to write `filter.list[i].name` in place, on an array every
    // undo entry shares — so a filter change rewrote the history behind it.
    expect((base.elements.v as any).filter.list).toBe(before);
    expect(before).toEqual([]);
  });

  it("rejects a colour it cannot parse rather than half-applying", () => {
    expect(() =>
      setVideoFilter(withFilter(), "v", { name: "chromakey", color: "nope" }),
    ).toThrow();
  });
});

describe("setFilterEnabled", () => {
  it("switches the filters on", () => {
    const next = setFilterEnabled(withFilter(), "v", true);
    expect(isFilterEnabled(next.elements.v)).toBe(true);
  });

  it("keeps the parameters underneath when switched off", () => {
    const seeded = setVideoFilter(
      setFilterEnabled(withFilter(), "v", true),
      "v",
      { name: "blur", strength: 8 },
    );
    const off = setFilterEnabled(seeded, "v", false);

    expect(filterOn(off).enable).toBe(false);
    expect(filterOn(off).list).toEqual([{ name: "blur", value: "f=8" }]);
  });

  it("declines by identity when already at that value", () => {
    const base = withFilter();
    expect(setFilterEnabled(base, "v", false)).toBe(base);
  });

  it("declines by identity on a clip that is not a video", () => {
    const text = doc({ t: textElement({ trackId: "v1" }) });
    expect(setFilterEnabled(text, "t", true)).toBe(text);
  });
});

describe("filterOf", () => {
  it("reads a stored chromakey back as the values a panel binds to", () => {
    const next = setVideoFilter(withFilter(), "v", {
      name: "chromakey",
      color: "#00ff00",
      threshold: 0.4,
    });

    expect(filterOf(next.elements.v)).toEqual({
      name: "chromakey",
      color: "#00ff00",
      threshold: 0.4,
    });
  });

  it("round-trips a blur's strength", () => {
    const next = setVideoFilter(withFilter(), "v", {
      name: "blur",
      strength: 8,
    });

    expect(filterOf(next.elements.v)).toEqual({ name: "blur", strength: 8 });
  });

  it("is null for a clip with no filter, and for a clip that cannot have one", () => {
    expect(filterOf(withFilter().elements.v)).toBeNull();
    expect(filterOf(textElement({ trackId: "v1" }))).toBeNull();
    expect(filterOf(undefined)).toBeNull();
  });
});
