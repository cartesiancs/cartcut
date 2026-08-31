import { describe, it, expect } from "vitest";
import { hasFxElements, planFrame, type PresetMode } from "./planFrame";
import { addTransition } from "../../timeline/transitionOps";
import { addEffect } from "../../timeline/effectOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../../timeline/tracks";
import { videoElement } from "../testing";

function clip(over: {
  startTime: number;
  trimIn: number;
  trimOut: number;
  sourceDuration?: number;
}) {
  const { startTime, trimIn, trimOut, sourceDuration = 10_000 } = over;
  return videoElement({
    trackId: "v0",
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration,
  });
}

/** Two abutting clips, cut at 4000, with 2000ms of handle either side. */
function baseDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
      b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
    },
  });
}

const allShaders = (): PresetMode => "shader";
const allOverlays = (): PresetMode => "overlay";
const allLuts = (): PresetMode => "lut";
const noneInstalled = () => null;

function plan(
  doc: TimelineDocument,
  timeInMs: number,
  modeOf: (presetId: string) => PresetMode | null = allShaders,
) {
  return planFrame({ elements: doc.elements, timeInMs, fps: 60, modeOf });
}

describe("hasFxElements", () => {
  it("is false for an ordinary edit", () => {
    expect(hasFxElements(baseDoc().elements)).toBe(false);
  });

  it("is true once an effect or a transition exists", () => {
    const withTransition = addTransition(
      baseDoc(),
      "t1",
      "a",
      "b",
      "x",
      800,
      "center",
    );
    expect(hasFxElements(withTransition.elements)).toBe(true);
    expect(
      hasFxElements(addEffect(baseDoc(), "fx", "p", 0, 1000, "e0").elements),
    ).toBe(true);
  });
});

describe("the empty plan", () => {
  it("is returned for a document with no effects or transitions", () => {
    // This is what keeps the paint loop on its original path, and with it every
    // existing golden pixel test.
    expect(plan(baseDoc(), 4000).empty).toBe(true);
  });

  it("is returned when nothing is active at this instant", () => {
    const doc = addTransition(baseDoc(), "t1", "a", "b", "x", 800, "center");
    // Window is 3600..4400; this is well outside it.
    expect(plan(doc, 1000).empty).toBe(true);
  });

  it("asks for no scratch canvas", () => {
    expect(plan(baseDoc(), 4000).needsScratch).toBe(false);
  });
});

describe("transitions", () => {
  const doc = addTransition(baseDoc(), "t1", "a", "b", "x", 800, "center");

  it("becomes active inside its window", () => {
    const result = plan(doc, 4000);
    expect(result.empty).toBe(false);
    expect(result.transitions.size).toBe(1);
  });

  it("claims both clips so the loop does not draw them twice", () => {
    const result = plan(doc, 4000);
    expect([...result.claimed].sort()).toEqual(["a", "b"]);
  });

  it("draws at whichever clip paints first", () => {
    const result = plan(doc, 4000);
    const active = result.transitions.get("a");
    expect(active).toBeDefined();
    expect(active!.fromId).toBe("a");
    expect(active!.toId).toBe("b");
  });

  it("carries a frame-snapped progress", () => {
    // Window 3600..4400. At the midpoint progress is 0.5.
    expect(plan(doc, 4000).transitions.get("a")!.progress).toBeCloseTo(0.5, 2);
    expect(plan(doc, 3600).transitions.get("a")!.progress).toBe(0);
  });

  it("needs no scratch — it hands back a finished image", () => {
    expect(plan(doc, 4000).needsScratch).toBe(false);
  });

  it("degrades to a plain cut when the preset is not installed", () => {
    // Neither clip is claimed, so both draw through the ordinary path and the
    // user sees the edit they had before anyone added a transition.
    const result = plan(doc, 4000, noneInstalled);
    expect(result.empty).toBe(true);
    expect(result.claimed.size).toBe(0);
  });

  it("is skipped when one of its clips has gone", () => {
    // `repairTransitions` should have removed it; the render path declines to
    // assume that, because a document also arrives from `.ngt` and from IPC.
    const orphaned = {
      ...doc,
      elements: Object.fromEntries(
        Object.entries(doc.elements).filter(([id]) => id !== "b"),
      ),
    };
    const result = plan(orphaned as TimelineDocument, 4000);
    expect(result.transitions.size).toBe(0);
    expect(result.claimed.size).toBe(0);
  });
});

describe("effects", () => {
  const doc = addEffect(baseDoc(), "fx", "p", 0, 2000, "e0");

  it("becomes active inside its span", () => {
    expect(plan(doc, 1000).effects.size).toBe(1);
    expect(plan(doc, 3000).effects.size).toBe(0);
  });

  it("asks for a scratch canvas when it is a shader", () => {
    // A shader reads back what has been drawn, which only works at project
    // resolution under an identity transform.
    expect(plan(doc, 1000).needsScratch).toBe(true);
  });

  it("asks for no scratch when it is an overlay", () => {
    // An overlay is a Canvas2D composite against what is already there — the
    // adjustment-layer semantics come for free, with no GL round trip.
    expect(plan(doc, 1000, allOverlays).needsScratch).toBe(false);
    expect(plan(doc, 1000, allOverlays).effects.get("fx")!.mode).toBe(
      "overlay",
    );
  });

  it("is skipped entirely when the preset is not installed", () => {
    const result = plan(doc, 1000, noneInstalled);
    expect(result.empty).toBe(true);
    expect(result.needsScratch).toBe(false);
  });

  it("asks for a scratch canvas when it is a LUT", () => {
    // A LUT adjustment layer reads the composited frame back, exactly as a
    // shader effect does — it is a colour transform of the stack beneath it,
    // not a composite against it.
    const result = plan(doc, 1000, allLuts);
    expect(result.needsScratch).toBe(true);
    expect(result.effects.get("fx")!.mode).toBe("lut");
  });

  it("takes a scratch canvas if any one active effect is a LUT", () => {
    let mixed = addEffect(baseDoc(), "fx1", "overlay-preset", 0, 2000, "e0");
    mixed = addEffect(mixed, "fx2", "lut-preset", 0, 2000, "e1");

    const result = plan(mixed, 1000, (id) =>
      id === "overlay-preset" ? "overlay" : "lut",
    );
    expect(result.effects.size).toBe(2);
    expect(result.needsScratch).toBe(true);
  });

  it("is skipped when the LUT preset is not installed", () => {
    // The same pass-through a missing shader preset gets: a project that names
    // a LUT the recipient does not have plays, ungraded.
    expect(plan(doc, 1000, noneInstalled).empty).toBe(true);
  });

  it("takes a scratch canvas if any one active effect is a shader", () => {
    let mixed = addEffect(baseDoc(), "fx1", "overlay-preset", 0, 2000, "e0");
    mixed = addEffect(mixed, "fx2", "shader-preset", 0, 2000, "e1");

    const result = plan(mixed, 1000, (id) =>
      id === "overlay-preset" ? "overlay" : "shader",
    );
    expect(result.effects.size).toBe(2);
    expect(result.needsScratch).toBe(true);
  });
});

describe("effects and transitions together", () => {
  it("plans both in one pass", () => {
    let doc = addTransition(baseDoc(), "t1", "a", "b", "x", 800, "center");
    doc = addEffect(doc, "fx", "p", 3000, 2000, "e0");

    const result = plan(doc, 4000);
    expect(result.transitions.size).toBe(1);
    expect(result.effects.size).toBe(1);
    expect(result.needsScratch).toBe(true);
  });
});
