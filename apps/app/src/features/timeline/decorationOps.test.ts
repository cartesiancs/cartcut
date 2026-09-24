/**
 * A clip's border and drop shadow at the document level.
 *
 * The claims here are the ones the panel and the agent both rest on, and the
 * one that is easy to get wrong is the middle one:
 *
 * - **Only some types can carry a decoration**, and declining returns the
 *   document by identity so `withCheckpoint` records no undo step. Every such
 *   assertion is `toBe`, never `toEqual`, because `toEqual` would pass against
 *   a build that had lost the contract entirely.
 * - **A patch is merged, not replaced.** Dragging the blur slider must not
 *   clear the offset, and switching a border off must not forget its width.
 * - **A clip nobody has decorated saves byte-identically** to one written
 *   before the feature. `SCHEMA_VERSION` did not move, so that is the whole of
 *   the compatibility story.
 */

import { describe, expect, it } from "vitest";

import { shadowOf, strokeOf } from "../renderer/decoration";
import { audioElement, imageElement, shapeElement } from "../renderer/testing";
import {
  clearClipDecoration,
  decorationFieldsOf,
  setClipShadow,
  setClipStroke,
  setClipStrokeMany,
} from "./decorationOps";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "./tracks";

function doc(): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      box: shapeElement({ trackId: "v0", startTime: 0, duration: 1000 }),
      pic: imageElement({ trackId: "v0", startTime: 1000, duration: 1000 }),
      sound: audioElement({ trackId: "v0", startTime: 2000, duration: 1000 }),
    } as any,
  };
}

describe("setClipStroke", () => {
  it("writes a border and reads it back through the guard", () => {
    const next = setClipStroke(doc(), "box", { width: 6, color: "#ffd23f" });
    expect(strokeOf(next.elements.box)).toMatchObject({
      enable: true,
      width: 6,
      color: "#ffd23f",
      align: "center",
    });
  });

  it("merges a patch over what is already there", () => {
    // The rule the panel depends on: one slider writes one field.
    let next = setClipStroke(doc(), "box", { width: 6, color: "#ffd23f" });
    next = setClipStroke(next, "box", { width: 12 });

    expect(strokeOf(next.elements.box)).toMatchObject({
      width: 12,
      color: "#ffd23f",
    });
  });

  it("keeps the values when the border is switched off", () => {
    // Unchecking a box and checking it again has to give back what was there,
    // which is why a disabled decoration is stored rather than deleted.
    let next = setClipStroke(doc(), "box", { width: 9, color: "#00ff88" });
    next = setClipStroke(next, "box", { enable: false });

    expect(strokeOf(next.elements.box)).toBeNull();
    expect((next.elements.box as any).stroke).toMatchObject({
      enable: false,
      width: 9,
      color: "#00ff88",
    });

    next = setClipStroke(next, "box", { enable: true });
    expect(strokeOf(next.elements.box)).toMatchObject({ width: 9 });
  });

  it("declines by identity for a clip that cannot carry one", () => {
    const before = doc();
    expect(setClipStroke(before, "sound", { width: 4 })).toBe(before);
  });

  it("declines by identity for a border already in force", () => {
    const once = setClipStroke(doc(), "box", { width: 6 });
    expect(setClipStroke(once, "box", { width: 6 })).toBe(once);
  });

  it("declines switching off a border the clip never had", () => {
    // A panel that renders an unchecked box and writes on every change would
    // otherwise decorate every clip it showed.
    const before = doc();
    expect(setClipStroke(before, "box", { enable: false })).toBe(before);
  });

  it("clamps a width and a negative blur rather than storing them", () => {
    const next = setClipStroke(doc(), "box", { width: -5 });
    expect((next.elements.box as any).stroke.width).toBe(0);

    const shadowed = setClipShadow(doc(), "box", { blur: -20, offsetY: 10 });
    // Canvas throws on a negative `shadowBlur`, so this bound is not cosmetic.
    expect((shadowed.elements.box as any).shadow.blur).toBe(0);
  });

  it("writes several clips as one step", () => {
    const next = setClipStrokeMany(doc(), ["box", "pic"], { width: 5 });
    expect(strokeOf(next.elements.box)?.width).toBe(5);
    expect(strokeOf(next.elements.pic)?.width).toBe(5);
  });
});

describe("setClipShadow", () => {
  it("writes a shadow and merges over it", () => {
    let next = setClipShadow(doc(), "box", { offsetY: 20, blur: 30 });
    next = setClipShadow(next, "box", { blur: 44 });

    expect(shadowOf(next.elements.box)).toMatchObject({
      offsetY: 20,
      blur: 44,
    });
  });

  it("is independent of the border", () => {
    let next = setClipStroke(doc(), "box", { width: 4 });
    next = setClipShadow(next, "box", { blur: 20 });

    expect(strokeOf(next.elements.box)?.width).toBe(4);
    expect(shadowOf(next.elements.box)?.blur).toBe(20);
  });
});

describe("clearClipDecoration", () => {
  it("deletes both keys rather than emptying them", () => {
    let next = setClipStroke(doc(), "box", { width: 6 });
    next = setClipShadow(next, "box", { blur: 20 });
    const cleared = clearClipDecoration(next, "box");

    // The whole compatibility story: a clip decorated and then cleared has to
    // serialise exactly like one nobody ever decorated.
    expect("stroke" in (cleared.elements.box as any)).toBe(false);
    expect("shadow" in (cleared.elements.box as any)).toBe(false);
    expect(JSON.stringify(cleared.elements.box)).toBe(
      JSON.stringify(doc().elements.box),
    );
  });

  it("declines by identity when there is nothing to clear", () => {
    const before = doc();
    expect(clearClipDecoration(before, "box")).toBe(before);
  });
});

describe("decorationFieldsOf", () => {
  it("gives the panel something to bind to before anything is set", () => {
    const fields = decorationFieldsOf(doc().elements.box);
    expect(fields.stroke.enable).toBe(false);
    expect(fields.shadow.enable).toBe(false);
    // A card shadow is faint and low, not a demonstration of the feature.
    expect(fields.shadow.blur).toBeGreaterThan(0);
    expect(fields.shadow.opacity).toBeLessThan(100);
  });

  it("reports a stored decoration, disabled or not", () => {
    let next = setClipStroke(doc(), "box", { width: 7 });
    next = setClipStroke(next, "box", { enable: false });

    const fields = decorationFieldsOf(next.elements.box);
    expect(fields.stroke.enable).toBe(false);
    expect(fields.stroke.width).toBe(7);
  });
});
