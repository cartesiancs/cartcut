/**
 * The extension that lets a transition read past a clip's edges.
 *
 * The property worth protecting here is not "the compositor draws the clip" but
 * that **three subsystems give the same answer**: the compositor deciding what
 * to paint, `loadedAssetStore.seek` deciding which `<video>` to position, and
 * `playback.ts` deciding which handle should roll. They all route through
 * `isElementVisibleAtTime`, so a test on one is a test on all three — and a
 * disagreement would blend a frame that was never seeked.
 */

import { describe, it, expect } from "vitest";
import {
  activeTransitionsAt,
  isVisibleThroughTransition,
  transitionIndex,
} from "./transitionWindow";
import { isElementVisibleAtTime } from "../element/time";
import { intentFor } from "./playback";
import { addTransition } from "./transitionOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { videoElement } from "../renderer/testing";
import type { VisualTimelineElement } from "../../@types/timeline";

function clip(over: { startTime: number; trimIn: number; trimOut: number }) {
  const { startTime, trimIn, trimOut } = over;
  return videoElement({
    trackId: "v0",
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration: 10_000,
  });
}

/** Cut at 4000, 2000ms of handle either side, transition 3600..4400. */
function docWithTransition(): TimelineDocument {
  const base = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: clip({ startTime: 0, trimIn: 2000, trimOut: 6000 }),
      b: clip({ startTime: 4000, trimIn: 2000, trimOut: 6000 }),
    },
  });
  return addTransition(base, "t1", "a", "b", "cross", 800, "center");
}

describe("isElementVisibleAtTime", () => {
  it("is unchanged for a document with no transitions", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: { a: clip({ startTime: 0, trimIn: 0, trimOut: 2000 }) },
    });
    const a = doc.elements.a as VisualTimelineElement;

    expect(isElementVisibleAtTime(1000, doc.elements, a)).toBe(true);
    expect(isElementVisibleAtTime(2500, doc.elements, a)).toBe(false);
  });

  it("holds the outgoing clip on screen past its out-point", () => {
    const doc = docWithTransition();
    const a = doc.elements.a as VisualTimelineElement;

    // `a` ends at 4000, but the transition runs to 4400.
    expect(isElementVisibleAtTime(4200, doc.elements, a)).toBe(true);
    // ...and not one millisecond further.
    expect(isElementVisibleAtTime(4400, doc.elements, a)).toBe(false);
    expect(isElementVisibleAtTime(5000, doc.elements, a)).toBe(false);
  });

  it("brings the incoming clip on screen before its in-point", () => {
    const doc = docWithTransition();
    const b = doc.elements.b as VisualTimelineElement;

    // `b` starts at 4000; the transition starts at 3600.
    expect(isElementVisibleAtTime(3700, doc.elements, b)).toBe(true);
    expect(isElementVisibleAtTime(3599, doc.elements, b)).toBe(false);
  });

  it("leaves an unrelated clip alone", () => {
    const doc = normalizeDocument({
      ...docWithTransition(),
      elements: {
        ...docWithTransition().elements,
        other: videoElement({
          trackId: "v0",
          startTime: 20_000,
          duration: 1000,
        }),
      },
    });
    const other = doc.elements.other as VisualTimelineElement;
    expect(isElementVisibleAtTime(4000, doc.elements, other)).toBe(false);
  });
});

describe("intentFor", () => {
  it("keeps the outgoing clip rolling through the transition", () => {
    const doc = docWithTransition();

    // Without the document it only knows its own span, and would park.
    expect(intentFor(doc.elements.a, 4200, true).inWindow).toBe(false);
    // With it, the handle keeps running — which is what the blend needs.
    expect(intentFor(doc.elements.a, 4200, true, doc.elements).inWindow).toBe(
      true,
    );
  });

  it("seeks past the out-point rather than freezing at the trim boundary", () => {
    const doc = docWithTransition();
    // `a` is trimmed to 2000..6000 source. At timeline 4200 it wants source
    // 6200 — 200ms *past* its out-point, which is the entire mechanism.
    const intent = intentFor(doc.elements.a, 4200, true, doc.elements);
    expect(intent.sourceTimeSec).toBeCloseTo(6.2, 3);
  });

  it("seeks before the in-point for the incoming clip", () => {
    const doc = docWithTransition();
    // `b` starts at timeline 4000 with source in-point 2000. At 3700 it wants
    // source 1700 — before its in-point.
    const intent = intentFor(doc.elements.b, 3700, true, doc.elements);
    expect(intent.sourceTimeSec).toBeCloseTo(1.7, 3);
  });

  it("still clamps to the source file's real extent", () => {
    // A .ngt whose media was replaced with a shorter file. The clamp is the
    // backstop; `maxTransitionMs` means a well-formed document never hits it.
    const doc = docWithTransition();
    const shortened = {
      ...doc.elements,
      a: { ...(doc.elements.a as any), sourceDuration: 4100 },
    };
    const intent = intentFor(shortened.a, 4200, true, shortened);
    expect(intent.sourceTimeSec).toBeCloseTo(4.1, 3);
  });

  it("parks a clip that no transition is holding", () => {
    const doc = docWithTransition();
    const intent = intentFor(doc.elements.a, 5000, true, doc.elements);
    expect(intent.inWindow).toBe(false);
    // Parked at its out-point, not run past it.
    expect(intent.sourceTimeSec).toBeCloseTo(6.0, 3);
  });
});

describe("transitionIndex", () => {
  it("is empty for a document with no transitions", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: { a: clip({ startTime: 0, trimIn: 0, trimOut: 2000 }) },
    });
    expect(transitionIndex(doc.elements).size).toBe(0);
  });

  it("maps both clips of a transition", () => {
    const doc = docWithTransition();
    const index = transitionIndex(doc.elements);
    expect(index.get(doc.elements.a)).toHaveLength(1);
    expect(index.get(doc.elements.b)).toHaveLength(1);
  });

  it("is memoised on the document, so a frame builds it once", () => {
    const doc = docWithTransition();
    expect(transitionIndex(doc.elements)).toBe(transitionIndex(doc.elements));
  });

  it("does not survive an edit", () => {
    // Every edit produces a new element map, so a stale index is unreachable
    // rather than merely unlikely.
    const before = docWithTransition();
    const after = { ...before, elements: { ...before.elements } };
    expect(transitionIndex(after.elements)).not.toBe(
      transitionIndex(before.elements),
    );
  });

  it("skips a transition whose clip has gone", () => {
    const doc = docWithTransition();
    const orphaned = Object.fromEntries(
      Object.entries(doc.elements).filter(([id]) => id !== "b"),
    );
    const index = transitionIndex(orphaned);
    expect(index.get(orphaned.a)).toHaveLength(1);
  });
});

describe("activeTransitionsAt", () => {
  it("finds the transition inside its window and not outside", () => {
    const doc = docWithTransition();
    expect(activeTransitionsAt(doc.elements, 4000)).toHaveLength(1);
    expect(activeTransitionsAt(doc.elements, 1000)).toHaveLength(0);
  });

  it("treats the window as half-open", () => {
    const doc = docWithTransition();
    expect(activeTransitionsAt(doc.elements, 3600)).toHaveLength(1);
    expect(activeTransitionsAt(doc.elements, 4400)).toHaveLength(0);
  });
});

describe("isVisibleThroughTransition", () => {
  it("returns false fast when there are no transitions at all", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: { a: clip({ startTime: 0, trimIn: 0, trimOut: 2000 }) },
    });
    expect(isVisibleThroughTransition(1000, doc.elements, doc.elements.a)).toBe(
      false,
    );
  });
});
