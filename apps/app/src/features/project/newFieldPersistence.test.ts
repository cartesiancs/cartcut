/**
 * The optional fields added for the agent surface, through a save and a load.
 *
 * Every one of them follows the rule CLAUDE.md states for a new feature: an
 * optional field, `SCHEMA_VERSION` unmoved, and the default deleting the key.
 * The consequence that matters is here rather than in each feature's own
 * suite, because it is a claim about the *file*: a project nobody has used the
 * feature on has to serialise byte-identically to one written before it
 * existed, or every existing `.ngt` silently changes the first time it is
 * opened and saved.
 *
 * `timeline.json` is the element map stringified, so that is what this
 * compares. Project load refuses on a version mismatch rather than migrating,
 * which is exactly why the version must not move.
 */

import { describe, expect, it } from "vitest";

import { imageElement, shapeElement, textElement } from "../renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";

function docWith(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements,
  });
}

/** What `functions/project.ts` writes as `timeline.json`. */
function serialised(doc: TimelineDocument): string {
  return JSON.stringify(doc.elements);
}

/** A round trip through the archive's JSON, as a load would do. */
function reloaded(doc: TimelineDocument): TimelineDocument {
  return normalizeDocument(JSON.parse(JSON.stringify(doc)));
}

describe("the schema version", () => {
  it("has not moved", () => {
    // Load is a compatibility check, not a migrator. Every field added for
    // the agent surface is optional precisely so this can stay put.
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe("a project using none of the new fields", () => {
  it("serialises with no trace of them", () => {
    const written = serialised(
      docWith({
        picture: imageElement({ trackId: "v0", startTime: 0, duration: 1000 }),
        box: shapeElement({ trackId: "v0", startTime: 1000, duration: 1000 }),
        title: textElement({ trackId: "v0", startTime: 2000, duration: 1000 }),
      }),
    );

    for (const key of ["link", "stroke", "shadow", "runs", "animate"]) {
      expect(written).not.toContain(`"${key}"`);
    }
  });
});

describe("a project using them", () => {
  const rich = () =>
    docWith({
      spin: {
        ...imageElement({ trackId: "v0", startTime: 0, duration: 4000 }),
        filetype: "group",
        rotation: 0,
      },
      card: {
        ...imageElement({ trackId: "v0", startTime: 0, duration: 4000 }),
        stroke: {
          enable: true,
          width: 4,
          color: "#1a1a1a",
          opacity: 100,
          align: "inner",
        },
        shadow: {
          enable: true,
          offsetX: 0,
          offsetY: 8,
          blur: 16,
          color: "#000000",
          opacity: 30,
        },
        link: {
          opacity: {
            from: { elementId: "spin", property: "rotation" },
            in: [-90, 0, 90],
            out: [0, 100, 0],
            offset: -45,
          },
        },
      },
      title: {
        ...textElement({ trackId: "v0", startTime: 0, duration: 4000 }),
        text: "Hello world",
        runs: [{ from: 0, to: 5, style: { color: "#ff3355", bold: true } }],
        reveal: {
          unit: "word",
          progress: 0,
          animate: { scale: 140, offsetY: 18, window: 2 },
        },
      },
    });

  it("carries every field through a save and a load", () => {
    const after = reloaded(rich()) as any;

    expect(after.elements.card.stroke).toMatchObject({ width: 4, align: "inner" });
    expect(after.elements.card.shadow).toMatchObject({ blur: 16, opacity: 30 });
    expect(after.elements.card.link.opacity.from.elementId).toBe("spin");
    expect(after.elements.card.link.opacity.offset).toBe(-45);
    expect(after.elements.title.runs).toEqual([
      { from: 0, to: 5, style: { color: "#ff3355", bold: true } },
    ]);
    expect(after.elements.title.reveal.animate).toEqual({
      scale: 140,
      offsetY: 18,
      window: 2,
    });
  });

  it("round-trips to exactly the same bytes", () => {
    // Not merely "the fields are there": a load that reordered or defaulted
    // anything would dirty every project it opened.
    const once = rich();
    expect(serialised(reloaded(once))).toBe(serialised(once));
  });
});
