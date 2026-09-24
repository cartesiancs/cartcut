/**
 * Property links.
 *
 * The claims that matter are all about what happens when the document is
 * *wrong*, because this runs inside the paint loop on whatever is in the
 * project file. A link that throws is a blank frame; a link that resolves to
 * something arbitrary is a picture nobody asked for. Falling back to the
 * clip's own value is the only safe answer, and every guard below checks it.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_LINK_DEPTH,
  coerceLink,
  isLinkableProperty,
  linkOf,
  mapThrough,
  resolveLinks,
} from "./link";

/** A link mapping a source 0-100 onto 0-100, unchanged. */
const IDENTITY = {
  from: { elementId: "null", property: "rotation" },
  in: [0, 100],
  out: [0, 100],
};

function element(over: Record<string, unknown> = {}) {
  return {
    filetype: "image",
    startTime: 0,
    duration: 5000,
    location: { x: 0, y: 0 },
    opacity: 100,
    scale: 10,
    rotation: 0,
    width: 100,
    height: 100,
    ...over,
  };
}

describe("mapThrough", () => {
  it("interpolates between two stops", () => {
    expect(mapThrough(IDENTITY as any, 50)).toBe(50);
    expect(mapThrough({ ...IDENTITY, out: [0, 10] } as any, 50)).toBe(5);
  });

  it("clamps outside the stops by default", () => {
    // What `linear()` does, and what a caller almost always means.
    expect(mapThrough(IDENTITY as any, -40)).toBe(0);
    expect(mapThrough(IDENTITY as any, 300)).toBe(100);
  });

  it("extrapolates when asked", () => {
    const link = { ...IDENTITY, extend: "extrapolate" } as any;
    expect(mapThrough(link, -40)).toBe(-40);
    expect(mapThrough(link, 300)).toBe(300);
  });

  it("walks a piecewise map", () => {
    // The shape a card wheel needs: full at centre, gone at either edge.
    const fade = {
      from: { elementId: "null", property: "rotation" },
      in: [-90, 0, 90],
      out: [0, 100, 0],
    } as any;
    expect(mapThrough(fade, -90)).toBe(0);
    expect(mapThrough(fade, -45)).toBe(50);
    expect(mapThrough(fade, 0)).toBe(100);
    expect(mapThrough(fade, 45)).toBe(50);
    expect(mapThrough(fade, 90)).toBe(0);
  });

  it("shifts the source by the offset before mapping", () => {
    // The field that makes one link shape serve a row of clips.
    const link = { ...IDENTITY, offset: 30 } as any;
    expect(mapThrough(link, 20)).toBe(50);
  });

  it("shapes a segment with an easing", () => {
    const eased = { ...IDENTITY, easing: "ease_out" } as any;
    // Different inputs must disagree, or this suite would pass against a map
    // that ignored `easing`.
    expect(mapThrough(eased, 25)).toBeGreaterThan(mapThrough(IDENTITY as any, 25));
  });

  it("does not ease outside the stops", () => {
    // An easing describes the shape *between* two stops; continuing it past
    // the end is not defined, so extrapolation follows the plain slope.
    const link = { ...IDENTITY, easing: "ease_out", extend: "extrapolate" } as any;
    expect(mapThrough(link, 150)).toBe(150);
  });
});

describe("linkOf and coerceLink", () => {
  it("read a well-formed link", () => {
    expect(linkOf(element({ link: { opacity: IDENTITY } }), "opacity")).toEqual({
      from: { elementId: "null", property: "rotation" },
      in: [0, 100],
      out: [0, 100],
    });
  });

  it("refuse stops that are not strictly ascending", () => {
    // A repeated stop divides by zero and a descending one has two answers
    // inside the fold. Repairing either would be a picture nobody asked for.
    expect(coerceLink({ ...IDENTITY, in: [0, 0] })).toBeNull();
    expect(coerceLink({ ...IDENTITY, in: [100, 0] })).toBeNull();
  });

  it("refuse mismatched stop counts", () => {
    expect(coerceLink({ ...IDENTITY, out: [0, 50, 100] })).toBeNull();
  });

  it("refuse a single stop, and cap the count", () => {
    expect(coerceLink({ ...IDENTITY, in: [0], out: [0] })).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => i);
    expect(coerceLink({ ...IDENTITY, in: many, out: many })).toBeNull();
  });

  it("drop an easing that is not one, keeping the link", () => {
    expect(coerceLink({ ...IDENTITY, easing: "swoosh" })?.easing).toBeUndefined();
    expect(coerceLink({ ...IDENTITY, easing: "snap" })?.easing).toBe("snap");
  });

  it("drop a zero offset rather than storing it", () => {
    // Default-is-absence, the rule `blend`, `lut` and `mask` all follow.
    expect(coerceLink({ ...IDENTITY, offset: 0 })?.offset).toBeUndefined();
    expect(coerceLink({ ...IDENTITY, offset: 15 })?.offset).toBe(15);
  });

  it("never throw on a hand-edited file", () => {
    for (const junk of [null, 7, "yes", [], { from: 3 }, { from: {}, in: "x" }]) {
      expect(() => coerceLink(junk)).not.toThrow();
      expect(coerceLink(junk)).toBeNull();
    }
  });
});

describe("resolveLinks", () => {
  const nullAt = (rotation: number) =>
    element({ filetype: "group", rotation });

  it("answers null for an element with no links", () => {
    expect(resolveLinks({ a: element() } as any, "a", 0)).toBeNull();
  });

  it("drives a property from another element's value", () => {
    const elements = {
      spin: nullAt(45),
      card: element({
        link: {
          opacity: {
            from: { elementId: "spin", property: "rotation" },
            in: [-90, 0, 90],
            out: [0, 100, 0],
          },
        },
      }),
    };
    expect(resolveLinks(elements as any, "card", 0)).toEqual({ opacity: 50 });
  });

  it("gives a row of clips one shape and many phases", () => {
    // The card wheel, which is what this feature exists for: one description,
    // one offset per card.
    const fade = (offset: number) => ({
      from: { elementId: "spin", property: "rotation" },
      in: [-90, 0, 90],
      out: [0, 100, 0],
      offset,
    });
    const elements: Record<string, unknown> = { spin: nullAt(0) };
    for (let i = 0; i < 3; i += 1) {
      elements[`card${i}`] = element({ link: { opacity: fade(i * -45) } });
    }

    expect(resolveLinks(elements as any, "card0", 0)).toEqual({ opacity: 100 });
    expect(resolveLinks(elements as any, "card1", 0)).toEqual({ opacity: 50 });
    expect(resolveLinks(elements as any, "card2", 0)).toEqual({ opacity: 0 });
  });

  it("reads a source's own keyframes, not just its static field", () => {
    const elements = {
      spin: element({
        filetype: "group",
        rotation: 0,
        animation: {
          rotation: {
            isActivate: true,
            x: [],
            ax: [
              [0, 0],
              [1000, 90],
            ],
          },
        },
      }),
      card: element({
        link: {
          opacity: {
            from: { elementId: "spin", property: "rotation" },
            in: [0, 90],
            out: [0, 100],
          },
        },
      }),
    };

    expect(resolveLinks(elements as any, "card", 0)?.opacity).toBe(0);
    expect(resolveLinks(elements as any, "card", 1000)?.opacity).toBe(100);
  });

  it("reads a link no link at all when the source is gone", () => {
    // The rule `hierarchy.ts#parentOf` follows for a dangling `parentId`:
    // consumers need no guard of their own, and the clip still draws.
    const elements = {
      card: element({
        link: { opacity: { ...IDENTITY, from: { elementId: "ghost", property: "rotation" } } },
      }),
    };
    expect(resolveLinks(elements as any, "card", 0)).toBeNull();
  });

  it("falls back rather than looping on a cycle", () => {
    const pair = (other: string) =>
      element({
        link: {
          opacity: { ...IDENTITY, from: { elementId: other, property: "opacity" } },
        },
      });
    const elements = { a: pair("b"), b: pair("a") };

    // Never throws, never hangs, and answers something drawable.
    expect(() => resolveLinks(elements as any, "a", 0)).not.toThrow();
    const resolved = resolveLinks(elements as any, "a", 0);
    expect(resolved == null || typeof resolved.opacity === "number").toBe(true);
  });

  it("falls back rather than looping on a self-link", () => {
    const elements = {
      a: element({
        link: { opacity: { ...IDENTITY, from: { elementId: "a", property: "opacity" } } },
      }),
    };
    expect(() => resolveLinks(elements as any, "a", 0)).not.toThrow();
  });

  it("stops following a chain past the depth cap", () => {
    const elements: Record<string, unknown> = { root: nullAt(60) };
    let previous = "root";
    for (let i = 0; i < MAX_LINK_DEPTH + 3; i += 1) {
      const id = `n${i}`;
      elements[id] = element({
        filetype: "group",
        link: {
          rotation: {
            from: { elementId: previous, property: "rotation" },
            in: [0, 100],
            out: [0, 100],
          },
        },
      });
      previous = id;
    }
    expect(() => resolveLinks(elements as any, previous, 0)).not.toThrow();
  });

  it("drives the lane the source names, on position", () => {
    const elements = {
      spin: nullAt(50),
      card: element({
        link: {
          position: {
            from: { elementId: "spin", property: "rotation" },
            in: [0, 100],
            out: [0, 400],
          },
        },
      }),
    };
    // Reading `rotation` gives one number, so it drives x and leaves y to the
    // clip's own keyframes.
    expect(resolveLinks(elements as any, "card", 0)).toEqual({ positionX: 200 });
  });
});

describe("isLinkableProperty", () => {
  it("admits the four that are wired and nothing else", () => {
    for (const ok of ["position", "opacity", "scale", "rotation"]) {
      expect(isLinkableProperty(ok)).toBe(true);
    }
    // `size` would have to reach `sampledBoxOf`, and `volumeDb` would not
    // reach the exported file. Both are out on purpose.
    for (const no of ["size", "volumeDb", "intensity", "revealProgress", "fx:blur"]) {
      expect(isLinkableProperty(no)).toBe(false);
    }
  });
});
