import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineStore } from "./timelineStore";
import {
  addKeyframe,
  removeKeyframe,
  setTrackActive,
} from "../features/animation/keyframeOps";
import { SCHEMA_VERSION, createTrack } from "../features/timeline/tracks";
import { imageElement, keys, points } from "../features/renderer/testing";

const store = () => useTimelineStore.getState();

function animatedElement() {
  const base = imageElement();
  return imageElement({
    trackId: "v1",
    animation: {
      ...(base.animation as any),
      opacity: {
        isActivate: true,
        x: keys([0, 0], [1000, 100]),
        ax: points([0, 0], [1000, 100]),
      },
    } as any,
  });
}

function reset() {
  useTimelineStore.setState({
    timeline: { a: animatedElement() },
    tracks: [createTrack("v1", "video", 0)],
    history: { timelineHistory: [], historyNow: -1 },
  });
  // One baseline entry, so an undo has somewhere to go.
  store().checkPointTimeline();
}

const opacityOf = (state = store()) =>
  (state.timeline.a as any).animation.opacity;

const deep = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe("keyframe edits and the undo history", () => {
  beforeEach(reset);

  it("records exactly one history entry per edit", () => {
    const before = store().history.timelineHistory.length;
    store().withCheckpoint((doc) =>
      addKeyframe(doc, "a", "opacity", "x", 500, 40),
    );
    expect(store().history.timelineHistory.length).toBe(before + 1);
  });

  it("records nothing for a declined edit", () => {
    const before = store().history.timelineHistory.length;
    store().withCheckpoint((doc) =>
      addKeyframe(doc, "nope", "opacity", "x", 500, 40),
    );
    store().withCheckpoint((doc) =>
      removeKeyframe(doc, "a", "opacity", "x", 99),
    );
    expect(store().history.timelineHistory.length).toBe(before);
  });

  /**
   * The defect this whole refactor exists for.
   *
   * `KeyframeController` mutated `this.timeline[...]` in place — a live
   * reference to the store snapshot — and then called `patchTimeline`, which
   * records no history. Because `derivePriorities` spreads elements shallowly,
   * every `HistoryEntry.elements[id]` shared its `animation` object with the
   * live document. So a keyframe edit did not merely skip the undo stack: it
   * reached backwards and rewrote every step already on it, and undoing
   * "delete this clip" from three edits ago replayed today's keyframes.
   */
  it("leaves earlier history entries untouched", () => {
    const original = deep(
      store().history.timelineHistory[0].elements.a as any,
    ).animation;

    store().withCheckpoint((doc) =>
      addKeyframe(doc, "a", "opacity", "x", 250, 25),
    );
    store().withCheckpoint((doc) =>
      addKeyframe(doc, "a", "opacity", "x", 750, 75),
    );
    store().withCheckpoint((doc) =>
      removeKeyframe(doc, "a", "opacity", "x", 0),
    );

    expect(
      (store().history.timelineHistory[0].elements.a as any).animation,
    ).toEqual(original);
    // And the live document really did change, so this is not passing by
    // nothing having happened.
    expect(opacityOf().x).not.toHaveLength(original.opacity.x.length);
  });

  it("round-trips add, add, undo, undo", () => {
    const start = deep(opacityOf());

    store().withCheckpoint((doc) =>
      addKeyframe(doc, "a", "opacity", "x", 250, 25),
    );
    store().withCheckpoint((doc) =>
      addKeyframe(doc, "a", "opacity", "x", 750, 75),
    );
    expect(opacityOf().x).toHaveLength(4);

    store().rollbackTimelineFromCheckPoint(-1);
    expect(opacityOf().x).toHaveLength(3);
    store().rollbackTimelineFromCheckPoint(-1);
    expect(deep(opacityOf())).toEqual(start);

    // And redo brings both back.
    store().rollbackTimelineFromCheckPoint(1);
    store().rollbackTimelineFromCheckPoint(1);
    expect(opacityOf().x).toHaveLength(4);
  });

  it("round-trips a track toggle", () => {
    store().withCheckpoint((doc) =>
      setTrackActive(doc, "a", "opacity", false),
    );
    expect(opacityOf().isActivate).toBe(false);
    store().rollbackTimelineFromCheckPoint(-1);
    expect(opacityOf().isActivate).toBe(true);
  });

  it("survives a long edit session without corrupting any entry", () => {
    // The "used hard" case. Every entry is snapshotted as it is created, and
    // all of them are re-checked at the end.
    const snapshots: any[] = [];
    for (let i = 0; i < 40; i++) {
      store().withCheckpoint((doc) =>
        addKeyframe(doc, "a", "opacity", "x", (i + 1) * 37, i % 100),
      );
      snapshots.push(
        deep(store().history.timelineHistory.at(-1)!.elements.a as any).animation,
      );
    }

    const entries = store().history.timelineHistory;
    for (let i = 0; i < snapshots.length; i++) {
      // Entry 0 is the baseline, so the i-th edit lands at i + 1.
      expect((entries[i + 1].elements.a as any).animation).toEqual(snapshots[i]);
    }
  });
});

describe("previewDocument", () => {
  beforeEach(reset);

  it("shows a document without recording history", () => {
    // Drag frames arrive at pointer rate; one undo entry per mousemove would
    // make a single drag eat the whole stack.
    const before = store().history.timelineHistory.length;
    const next = addKeyframe(store().getDocument(), "a", "opacity", "x", 500, 40);

    store().previewDocument(next);

    expect(opacityOf().x).toHaveLength(3);
    expect(store().history.timelineHistory.length).toBe(before);
  });

  it("skips the normalisation pass, which is the point of it", () => {
    // `patchDocument` re-walks every keyframe array in the project. At pointer
    // rate that is the cost this method exists to avoid, so it hands the
    // document through untouched — callers must pass a well-formed one.
    const legacy: any = imageElement({
      trackId: "v1",
      animation: {
        ...(imageElement().animation as any),
        position: { isActivate: true, x: [], y: [], ax: [[], []], ay: [[], []] },
      },
    });
    store().previewDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: { a: legacy },
    });
    expect((store().timeline.a as any).animation.position.ax).toEqual([[], []]);
  });

  it("is undone by previewing the original back", () => {
    const original = store().getDocument();
    store().previewDocument(
      addKeyframe(original, "a", "opacity", "x", 500, 40),
    );
    expect(opacityOf().x).toHaveLength(3);

    store().previewDocument(original);
    expect(opacityOf().x).toHaveLength(2);
    expect(store().history.timelineHistory.length).toBe(1);
  });
});

describe("patchDocument normalises on ingress", () => {
  beforeEach(reset);

  it("repairs a legacy [[], []] baked array from a loaded project", () => {
    // What `project.load` hands over. There is no migration step, so a project
    // written by an older build arrives with this shape intact.
    const base = imageElement();
    store().patchDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        a: imageElement({
          trackId: "v1",
          animation: {
            ...(base.animation as any),
            position: {
              isActivate: true,
              x: [],
              y: [],
              ax: [[], []],
              ay: [[], []],
            },
          } as any,
        }),
      },
    });

    const position = (store().timeline.a as any).animation.position;
    expect(position.ax).toEqual([]);
    expect(position.ay).toEqual([]);
  });

  it("sorts authored keyframes that arrive out of order", () => {
    store().patchDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        a: imageElement({
          trackId: "v1",
          animation: {
            ...(imageElement().animation as any),
            opacity: {
              isActivate: true,
              x: keys([900, 9], [100, 1], [500, 5]),
              ax: [],
            },
          } as any,
        }),
      },
    });

    expect(
      (store().timeline.a as any).animation.opacity.x.map((k: any) => k.p[0]),
    ).toEqual([100, 500, 900]);
  });

  it("leaves a clean project's elements alone", () => {
    const element = animatedElement();
    store().patchDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: { a: element },
    });
    // `normalizeDocument` still re-derives `priority`, so identity is not
    // expected — but the animation block must come through untouched.
    expect((store().timeline.a as any).animation).toBe(element.animation);
  });
});
