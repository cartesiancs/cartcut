/**
 * The workflow that was broken, pinned end to end.
 *
 * Import two clips, drop them side by side, ask for a dissolve. It is the most
 * ordinary thing anyone does with a transition, and it was refused — with a
 * message suggesting an alignment that could not have worked either.
 *
 * The cause was an assumption baked into every other test in this feature:
 * they all built clips that were already trimmed, so they always had spare
 * frames either side of the cut. A freshly imported clip has none. This file
 * builds elements the way `buildMediaElement` actually does, so that gap
 * cannot reopen.
 */

import { describe, it, expect } from "vitest";
import { addTransition, setTransitionAlignment } from "./transitionOps";
import {
  freezeMs,
  headHandleOf,
  maxTransitionMs,
  realFootageMs,
  tailHandleOf,
} from "./transitionGeometry";
import { splitClip } from "./clipOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { videoElement } from "../renderer/testing";

/**
 * Exactly what `features/element/mediaElement.ts#buildMediaElement` produces:
 * `trim` spanning the whole source, so there is no handle on either side.
 */
function freshImport(startTime: number, durationMs: number) {
  return videoElement({
    trackId: "v0",
    startTime,
    duration: durationMs,
    trim: { startTime: 0, endTime: durationMs },
    sourceDuration: durationMs,
  });
}

function twoImports(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: freshImport(0, 5000),
      b: freshImport(5000, 5000),
    },
  });
}

describe("two freshly imported clips, side by side", () => {
  it("really do have no handles", () => {
    const doc = twoImports();
    expect(tailHandleOf(doc.elements.a)).toBe(0);
    expect(headHandleOf(doc.elements.b)).toBe(0);
    expect(realFootageMs(doc.elements.a, doc.elements.b, "center")).toBe(0);
  });

  it("take a transition anyway", () => {
    const doc = twoImports();
    const next = addTransition(doc, "t1", "a", "b", "cross", 500, "center");

    expect(next).not.toBe(doc);
    const t = next.elements.t1;
    expect(t?.filetype).toBe("transition");
    if (t?.filetype !== "transition") return;
    expect(t.duration).toBe(500);
    expect(t.startTime).toBe(4750);
  });

  it("hold frames for the whole of it, and say so", () => {
    const doc = twoImports();
    expect(freezeMs(doc.elements.a, doc.elements.b, "center", 500)).toBe(500);
  });

  it("offer no alignment that avoids it, which is why none is suggested", () => {
    // The old toast told the user to try another alignment. All three need a
    // handle, so none of them could have helped — advice that cannot work is
    // worse than no advice.
    const doc = twoImports();
    for (const alignment of ["center", "end", "start"] as const) {
      expect(realFootageMs(doc.elements.a, doc.elements.b, alignment)).toBe(0);
      expect(
        maxTransitionMs(doc.elements.a, doc.elements.b, alignment),
      ).toBeGreaterThan(0);
    }
  });

  it("still let the alignment be changed", () => {
    const doc = addTransition(twoImports(), "t1", "a", "b", "cross", 500, "center");
    const next = setTransitionAlignment(doc, "t1", "end");
    const t = next.elements.t1;
    if (t?.filetype !== "transition") throw new Error("gone");
    expect(t.alignment).toBe("end");
    expect(t.startTime).toBe(4500);
  });
});

describe("a split of one import, for contrast", () => {
  it("has handles on both sides, so nothing is held", () => {
    // This is what every other test in the feature was built on, and why the
    // gap went unnoticed: splitting gives both halves real footage to spare.
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: { v: freshImport(0, 10_000) },
    });
    const split = splitClip(doc, "v", 4000, "v2");

    expect(tailHandleOf(split.elements.v)).toBe(6000);
    expect(headHandleOf(split.elements.v2)).toBe(4000);
    expect(
      freezeMs(split.elements.v, split.elements.v2, "center", 1000),
    ).toBe(0);
  });
});
