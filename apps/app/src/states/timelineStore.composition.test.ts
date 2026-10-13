import { beforeEach, describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../@types/timeline";
import {
  MAIN_TIMELINE,
  compositionIdOf,
  projectTemplateId,
  type ProjectTimelines,
} from "../features/composition/project";
import { forkTemplate } from "../features/composition/fork";
import { imageElement, mulberry32, textElement } from "../features/renderer/testing";
import type { TemplateData } from "../features/template/compose";
import { slotsOf } from "../features/template/slots";
import { createTemplateElement } from "../features/timeline/templateOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../features/timeline/tracks";
import { useTimelineStore } from "./timelineStore";
import { visibleTimelineTabs } from "./timelineWorkspace";

/**
 * The store holding a project of several timelines.
 *
 * What has to hold, whatever happens:
 *  - the active timeline lives in `timeline`/`tracks` and nowhere else, and
 *    every other one in `parked`, once;
 *  - switching is never an undo step, and never loses what was on screen;
 *  - one undo history covers the whole project, and an undo keeps the tab
 *    the user is looking at whenever the restored project still has it.
 */

const store = () => useTimelineStore.getState();

function ids() {
  let n = 0;
  return () => `g${n++}`;
}
let idGen = ids();

function template(): TemplateData {
  const doc = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("tv", "video", 0)],
    elements: {
      bg: imageElement({ key: "bg", trackId: "tv", startTime: 0, duration: 3000 }),
      title: textElement({
        key: "title",
        trackId: "tv",
        startTime: 3000,
        duration: 1000,
        replaceable: { slotId: "name" },
      }),
    } as unknown as Timeline,
  });
  return {
    id: "neon",
    name: "Neon",
    size: { w: 640, h: 360 },
    durationMs: 4000,
    elements: doc.elements,
    tracks: doc.tracks,
    slots: slotsOf(doc.elements),
  };
}

function placed(over: Partial<TemplateElementType> = {}): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: "neon",
      name: "Intro",
      durationMs: 4000,
      size: { w: 640, h: 360 },
      frame: { w: 1920, h: 1080 },
    }),
    trackId: "v1",
    startTime: 1000,
    ...over,
  } as TemplateElementType;
}

/** A project of main alone, holding one template clip and one image. */
function seed(extra: Record<string, unknown> = {}) {
  idGen = ids();
  store().clearTimeline();
  store().patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("v2", "video", 1)],
      elements: {
        tpl: placed(),
        pic: imageElement({ trackId: "v2", startTime: 0, duration: 2000 }),
        ...extra,
      } as unknown as Timeline,
    }),
  );
}

/** Expand `tpl` into composition `c1`, as `expandTemplate.ts` does. */
function expand(elementId = "tpl", compositionId = "c1") {
  store().withProjectCheckpoint((project) =>
    forkTemplate(project, elementId, template(), { compositionId, idGen }),
  );
}

const historyLength = () => store().history.timelineHistory.length;
const mainElements = () =>
  store().activeTimelineId === MAIN_TIMELINE
    ? store().timeline
    : store().parked[MAIN_TIMELINE].elements;

/** An element appended to the active timeline at `[start, start + duration)`. */
function addClip(id: string, start: number, duration: number, trackId?: string) {
  store().withCheckpoint((doc) => ({
    ...doc,
    elements: {
      ...doc.elements,
      [id]: imageElement({
        key: id,
        trackId: trackId ?? doc.tracks[0].id,
        startTime: start,
        duration,
      }),
    },
  }));
}

/** The structural rule, asserted after every step of every case. */
function assertWorkspace() {
  const state = store();
  expect(state.parked[state.activeTimelineId]).toBeUndefined();
  const compIds = Object.keys(state.compositions);
  if (state.activeTimelineId !== MAIN_TIMELINE) {
    expect(compIds).toContain(state.activeTimelineId);
    expect(state.parked[MAIN_TIMELINE]).toBeDefined();
  }
  for (const id of compIds) {
    const live = id === state.activeTimelineId;
    expect(live || state.parked[id] != null).toBe(true);
  }
  for (const id of Object.keys(state.parked)) {
    expect(id === MAIN_TIMELINE || compIds.includes(id)).toBe(true);
  }
  // Every timeline holds only clips on rows of its own.
  const check = (tracks: { id: string }[], elements: Timeline) => {
    const rows = new Set(tracks.map((t) => t.id));
    for (const e of Object.values(elements)) {
      expect(rows.has(e.trackId)).toBe(true);
    }
  };
  check(state.tracks, state.timeline);
  for (const id of Object.keys(state.parked)) {
    check(state.parked[id].tracks, state.parked[id].elements);
  }
}

beforeEach(() => {
  seed();
});

describe("a project of main alone", () => {
  it("records the two fields an undo step always had", () => {
    addClip("a", 5000, 1000);
    const entry = store().history.timelineHistory[0];
    expect(Object.keys(entry).sort()).toEqual(["elements", "tracks"]);
  });

  it("does nothing on a switch to a timeline that does not exist", () => {
    const before = store();
    store().switchTimeline("nope");
    expect(store()).toBe(before);
  });
});

describe("expanding", () => {
  it("is one undo step that adds a composition and points the clip at it", () => {
    expand();
    expect(historyLength()).toBe(1);
    expect(Object.keys(store().compositions)).toEqual(["c1"]);
    expect((mainElements().tpl as TemplateElementType).templateId).toBe(
      projectTemplateId("c1"),
    );
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(store().parked.c1).toBeDefined();
    assertWorkspace();
  });

  it("can be undone straight after a load, once a baseline is recorded", () => {
    // What `agent/checkpoint.ts#ensureUndoBaseline` does before the first
    // edit of a freshly opened project, and what `expandTemplate.ts` calls.
    store().checkPointTimeline();
    expand();
    store().rollbackTimelineFromCheckPoint(-1);
    expect(Object.keys(store().compositions)).toEqual([]);
    expect((mainElements().tpl as TemplateElementType).templateId).toBe("neon");
    assertWorkspace();
  });

  it("declines by identity, recording nothing", () => {
    const before = store();
    store().withProjectCheckpoint((project) => project);
    expect(store()).toBe(before);
  });
});

describe("switching", () => {
  beforeEach(() => {
    expand();
  });

  it("is not an undo step", () => {
    const length = historyLength();
    const epoch = store().switchEpoch;
    store().switchTimeline("c1");
    expect(historyLength()).toBe(length);
    expect(store().activeTimelineId).toBe("c1");
    expect(store().switchEpoch).toBe(epoch + 1);
    expect(store().openCompositionIds).toEqual(["c1"]);
    expect(Object.values(store().timeline).map((e) => e.filetype).sort()).toEqual(
      ["image", "text"],
    );
    assertWorkspace();
  });

  it("round-trips with no edit, keeping the redo branch", () => {
    addClip("a", 6000, 500);
    store().rollbackTimelineFromCheckPoint(-1);
    const head = store().history;
    const main = store().timeline;

    store().switchTimeline("c1");
    store().switchTimeline(MAIN_TIMELINE);

    expect(store().history).toBe(head);
    expect(store().timeline).toBe(main);
    store().rollbackTimelineFromCheckPoint(1);
    expect(mainElements().a).toBeDefined();
    assertWorkspace();
  });

  it("records what was on screen and never committed, once", () => {
    const length = historyLength();
    const doc = store().getDocument();
    store().previewDocument({
      ...doc,
      elements: {
        ...doc.elements,
        pic: { ...doc.elements.pic, opacity: 40 } as any,
      },
    });
    store().switchTimeline("c1");
    expect(historyLength()).toBe(length + 1);
    store().switchTimeline(MAIN_TIMELINE);
    expect(historyLength()).toBe(length + 1);
    expect((store().timeline.pic as any).opacity).toBe(40);

    // And the recorded step is a real one: undoing it takes the preview away.
    store().rollbackTimelineFromCheckPoint(-1);
    expect((store().timeline.pic as any).opacity).not.toBe(40);
  });

  it("closes a tab, going back to main first when it is the active one", () => {
    store().switchTimeline("c1");
    store().closeTimelineTab("c1");
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(store().openCompositionIds).toEqual([]);
    expect(store().compositions.c1).toBeDefined();
    assertWorkspace();
  });
});

describe("each timeline's view", () => {
  beforeEach(() => {
    expand();
  });

  it("is parked on a switch and comes back as it was left", () => {
    store().setCursor(2500);
    store().setRange(3);
    store().setScroll(120);
    store().switchTimeline("c1", { cursor: 800 });
    expect(store().cursor).toBe(800);
    expect(store().range).toBe(3);
    expect(store().scroll).toBe(0);

    store().setCursor(300);
    store().switchTimeline(MAIN_TIMELINE);
    expect(store().cursor).toBe(2500);
    expect(store().range).toBe(3);
    expect(store().scroll).toBe(120);

    // The first view only applies the first time.
    store().switchTimeline("c1", { cursor: 999 });
    expect(store().cursor).toBe(300);
  });

  it("stops playback and drops the modal tool, in the same set", () => {
    store().setPlay(true);
    store().setCursorType("shape");
    const seen: Array<[boolean, string, string]> = [];
    const off = useTimelineStore.subscribe((state) =>
      seen.push([state.control.isPlay, state.control.cursorType, state.activeTimelineId]),
    );
    store().switchTimeline("c1");
    off();
    expect(seen).toEqual([[false, "pointer", "c1"]]);
  });

  it("comes back to main's view when an undo lands on main", () => {
    seed();
    store().checkPointTimeline();
    store().setCursor(1234);
    expand();
    store().switchTimeline("c1");
    store().setCursor(10);
    // Back to before the Expand: main again, at main's playhead.
    store().rollbackTimelineFromCheckPoint(-1);
    expect(store().compositions.c1).toBeUndefined();
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(store().cursor).toBe(1234);
  });

  it("re-clamps parked views on request, and only those", () => {
    store().setCursor(1000);
    store().switchTimeline("c1");
    store().setCursor(77);
    store().reframeParkedViews((view) => ({ ...view, cursor: view.cursor + 1 }));
    expect(store().cursor).toBe(77);
    expect(store().views[MAIN_TIMELINE].cursor).toBe(1001);
  });
});

describe("editing a composition", () => {
  beforeEach(() => {
    store().checkPointTimeline();
    expand();
    store().switchTimeline("c1");
  });

  it("grows the clips that name it, in the same undo step", () => {
    const length = historyLength();
    addClip("late", 5000, 2000);
    expect(historyLength()).toBe(length + 1);
    expect(mainElements().tpl.duration).toBe(7000);
    assertWorkspace();

    store().rollbackTimelineFromCheckPoint(-1);
    expect(store().activeTimelineId).toBe("c1");
    expect(store().timeline.late).toBeUndefined();
    expect(mainElements().tpl.duration).toBe(4000);
    assertWorkspace();
  });

  it("does not grow a clip past its neighbour on the row", () => {
    store().switchTimeline(MAIN_TIMELINE);
    addClip("wall", 6000, 1000, "v1");
    store().switchTimeline("c1");
    addClip("late", 5000, 5000);
    expect(mainElements().tpl.duration).toBe(5000);
    expect(mainElements().wall.startTime).toBe(6000);
  });

  it("leaves main's parked content alone when the extent did not change", () => {
    const main = store().parked[MAIN_TIMELINE];
    store().withCheckpoint((doc) => ({
      ...doc,
      elements: Object.fromEntries(
        Object.entries(doc.elements).map(([id, e]) => [id, { ...e, opacity: 50 }]),
      ) as Timeline,
    }));
    expect(store().parked[MAIN_TIMELINE]).toBe(main);
  });

  it("keeps the composition table by identity across an edit inside it", () => {
    const table = store().compositions;
    addClip("x", 0, 100);
    expect(store().compositions).toBe(table);
  });

  it("lands on main when an undo goes past the Expand", () => {
    store().rollbackTimelineFromCheckPoint(-1);
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(store().compositions.c1).toBeUndefined();
    assertWorkspace();

    // And comes back, edits and all, on redo, without leaving main.
    store().rollbackTimelineFromCheckPoint(1);
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(store().compositions.c1).toBeDefined();
    assertWorkspace();
  });
});

describe("withCheckpointOn", () => {
  beforeEach(() => {
    expand();
    store().switchTimeline("c1");
  });

  it("lands a late result in the timeline it started in", () => {
    const live = store().timeline;
    const length = historyLength();
    store().withCheckpointOn(MAIN_TIMELINE, (doc) => ({
      ...doc,
      elements: {
        ...doc.elements,
        late: imageElement({ trackId: "v2", startTime: 9000, duration: 100 }),
      },
    }));
    expect(store().timeline).toBe(live);
    expect(store().parked[MAIN_TIMELINE].elements.late).toBeDefined();
    expect(historyLength()).toBe(length + 1);
    assertWorkspace();
  });

  it("is withCheckpoint when the timeline is the active one", () => {
    store().withCheckpointOn("c1", (doc) => ({
      ...doc,
      elements: {
        ...doc.elements,
        here: imageElement({ trackId: doc.tracks[0].id, startTime: 0, duration: 10 }),
      },
    }));
    expect(store().timeline.here).toBeDefined();
  });

  it("declines for a timeline that is gone, and for an op that declines", () => {
    const before = store();
    store().withCheckpointOn("ghost", (doc) => ({ ...doc }));
    store().withCheckpointOn(MAIN_TIMELINE, (doc) => doc);
    expect(store()).toBe(before);
  });
});

describe("tabs", () => {
  it("drop a composition nothing names any more, and bring it back on undo", () => {
    expand();
    store().switchTimeline("c1");
    store().switchTimeline(MAIN_TIMELINE);
    expect(visibleTimelineTabs(store())).toEqual([MAIN_TIMELINE, "c1"]);

    store().withCheckpoint((doc) => {
      const { tpl: _gone, ...rest } = doc.elements;
      return { ...doc, elements: rest };
    });
    expect(visibleTimelineTabs(store())).toEqual([MAIN_TIMELINE]);

    store().rollbackTimelineFromCheckPoint(-1);
    expect(visibleTimelineTabs(store())).toEqual([MAIN_TIMELINE, "c1"]);
  });
});

describe("loading and clearing", () => {
  function project(): ProjectTimelines {
    return {
      main: {
        tracks: [createTrack("m", "video", 0)],
        elements: {
          t: placed({ trackId: "m", templateId: projectTemplateId("k") }),
        } as Timeline,
      },
      compositions: {
        k: {
          id: "k",
          name: "Kept",
          size: { w: 10, h: 10 },
          tracks: [createTrack("kt", "video", 0)],
          elements: {
            a: imageElement({ trackId: "kt", animation: { ax: [[], []] } as never }),
          } as Timeline,
        },
      },
    };
  }

  it("loads every timeline through ingress, with main active", () => {
    expand();
    store().switchTimeline("c1");
    const epoch = store().projectEpoch;
    store().loadProject(project());
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(Object.keys(store().compositions)).toEqual(["k"]);
    expect(store().openCompositionIds).toEqual([]);
    expect(store().projectEpoch).toBe(epoch + 1);
    // Ingress names the rows and derives priorities in a parked timeline too.
    expect(store().parked.k.tracks[0].name).toBe("V1");
    expect(store().parked.k.elements.a.priority).toBe(1);
    assertWorkspace();
  });

  it("clears every timeline", () => {
    expand();
    store().switchTimeline("c1");
    const epoch = store().projectEpoch;
    store().clearTimeline();
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(store().compositions).toEqual({});
    expect(store().parked).toEqual({});
    expect(store().projectEpoch).toBe(epoch + 1);
    assertWorkspace();
  });

  it("answers the whole project, live timeline included", () => {
    expand();
    store().switchTimeline("c1");
    addClip("x", 0, 100);
    const project = store().getProject();
    expect(project.compositions.c1.elements.x).toBeDefined();
    expect(project.main.elements.tpl).toBeDefined();
  });
});

describe("any sequence of edits, switches, undos and redos", () => {
  /**
   * The invariant under pressure. A seeded walk through every action the
   * store has, checking the structural rule after each step, and finally that
   * undoing to the start and redoing to the end lands on the same project.
   */
  function walk(seed: number) {
    const random = mulberry32(seed);
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
    seed0();
    let clips = 0;
    const seen = { inComposition: 0, forks: 0, undos: 0, late: 0 };

    for (let step = 0; step < 120; step++) {
      const state = store();
      const timelines = [MAIN_TIMELINE, ...Object.keys(state.compositions)];
      const roll = random();
      if (roll < 0.15) {
        store().switchTimeline(pick(timelines));
        if (store().activeTimelineId !== MAIN_TIMELINE) {
          seen.inComposition += 1;
        }
      } else if (roll < 0.4) {
        const doc = store().getDocument();
        const start = Math.floor(random() * 20) * 1000 + 20_000;
        addClip(`c${clips++}`, start, 500, doc.tracks[0]?.id);
      } else if (roll < 0.5) {
        const doc = store().getDocument();
        store().previewDocument({
          ...doc,
          elements: Object.fromEntries(
            Object.entries(doc.elements).map(([id, e]) => [
              id,
              { ...e, opacity: Math.floor(random() * 100) },
            ]),
          ) as Timeline,
        });
      } else if (roll < 0.62) {
        store().rollbackTimelineFromCheckPoint(-1);
        seen.undos += 1;
      } else if (roll < 0.72) {
        store().rollbackTimelineFromCheckPoint(1);
      } else if (roll < 0.84) {
        const target = pick(timelines);
        if (target !== store().activeTimelineId) {
          seen.late += 1;
        }
        store().withCheckpointOn(target, (doc: TimelineDocument) => {
          const first = Object.keys(doc.elements)[0];
          if (first == null) {
            return doc;
          }
          return {
            ...doc,
            elements: {
              ...doc.elements,
              [first]: { ...doc.elements[first], opacity: Math.floor(random() * 100) },
            },
          };
        });
      } else {
        // Expand whichever template clip in main is still installed.
        const unforked = Object.entries(mainElements()).find(
          ([, e]) =>
            e.filetype === "template" &&
            compositionIdOf((e as TemplateElementType).templateId) == null,
        );
        if (unforked != null) {
          expand(unforked[0], `k${step}`);
          seen.forks += 1;
        } else if (store().activeTimelineId === MAIN_TIMELINE) {
          store().withCheckpoint((doc) => ({
            ...doc,
            elements: {
              ...doc.elements,
              [`t${step}`]: placed({ startTime: 40_000 + step * 10_000 }),
            },
          }));
        }
      }
      assertWorkspace();
    }
    return seen;
  }

  function seed0() {
    seed();
    store().checkPointTimeline();
  }

  for (const seedValue of [1, 2, 3, 7, 42, 1234]) {
    it(`holds the rule (seed ${seedValue})`, () => {
      const seen = walk(seedValue);
      // The walk has to reach the cases the rule is about, or it proves
      // nothing: a composition made, entered, written to from elsewhere, and
      // undone through.
      expect(seen.forks).toBeGreaterThan(0);
      expect(seen.inComposition).toBeGreaterThan(0);
      expect(seen.late).toBeGreaterThan(0);
      expect(seen.undos).toBeGreaterThan(0);
    });
  }

  it("undoes to the start and redoes to the same end", () => {
    walk(99);
    // Settle anything previewed so the end state is a recorded one.
    store().checkPointTimeline();
    const end = JSON.stringify(store().getProject());
    while (store().history.historyNow > 0) {
      store().rollbackTimelineFromCheckPoint(-1);
      assertWorkspace();
    }
    while (store().history.historyNow < historyLength() - 1) {
      store().rollbackTimelineFromCheckPoint(1);
      assertWorkspace();
    }
    expect(JSON.stringify(store().getProject())).toBe(end);
  });
});
