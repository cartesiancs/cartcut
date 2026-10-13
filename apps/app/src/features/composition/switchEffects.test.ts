import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { imageElement } from "../renderer/testing";
import { createTemplateElement } from "../timeline/templateOps";
import { createTrack } from "../timeline/tracks";
import { parkedMainFrame, setParkedMainFrame } from "./mainFrame";
import { MAIN_TIMELINE, projectTemplateId } from "./project";
import {
  createSwitchEffects,
  type FrameSize,
  type SwitchPort,
  type SwitchSource,
} from "./switchEffects";

/**
 * What follows a change of timeline, from any cause, and nothing when nothing
 * changed. Driven first against a hand-made source, then against the real
 * store, where the change comes from a tab, an undo and a load.
 */

type Call = [string, ...unknown[]];

function fakePort(frame: FrameSize = { w: 1920, h: 1080 }) {
  const calls: Call[] = [];
  let current = { ...frame };
  let viewport: unknown = { zoom: 100, at: "main" };
  const port: SwitchPort = {
    stopPlayback: () => calls.push(["stop"]),
    clearSelection: () => calls.push(["clear"]),
    readFrame: () => ({ ...current }),
    writeFrame: (next) => {
      calls.push(["frame", next]);
      current = { ...next };
    },
    readViewport: () => viewport,
    writeViewport: (next, at) => {
      calls.push(["viewport", next, at]);
      viewport = next ?? { zoom: 100, fittedTo: at };
    },
  };
  return {
    port,
    calls,
    frame: () => current,
    setFrame: (next: FrameSize) => {
      current = { ...next };
    },
    setViewport: (next: unknown) => {
      viewport = next;
    },
  };
}

const compositions = {
  c1: { id: "c1", name: "a", size: { w: 1080, h: 1920 } },
  c2: { id: "c2", name: "b", size: { w: 640, h: 360 } },
};

const at = (activeTimelineId: string, projectEpoch = 0): SwitchSource => ({
  activeTimelineId,
  projectEpoch,
  compositions,
});

beforeEach(() => {
  setParkedMainFrame(null);
});

afterEach(() => {
  setParkedMainFrame(null);
});

describe("createSwitchEffects", () => {
  it("does nothing while the timeline and the project stay the same", () => {
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    effects.observe(at(MAIN_TIMELINE));
    effects.observe(at(MAIN_TIMELINE));
    expect(fake.calls).toEqual([]);
  });

  it("stops playback, clears the selection, then shows the composition's frame, fitted", () => {
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    effects.observe(at("c1"));
    expect(fake.calls).toEqual([
      ["stop"],
      ["clear"],
      ["frame", { w: 1080, h: 1920 }],
      ["viewport", null, { w: 1080, h: 1920 }],
    ]);
    expect(parkedMainFrame()).toEqual({ w: 1920, h: 1080 });
  });

  it("gives main its own frame and pan back", () => {
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    fake.setViewport({ zoom: 250, at: "main, zoomed" });
    effects.observe(at("c1"));
    effects.observe(at(MAIN_TIMELINE));
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });
    expect(parkedMainFrame()).toBeNull();
    expect(fake.calls.at(-1)).toEqual([
      "viewport",
      { zoom: 250, at: "main, zoomed" },
      { w: 1920, h: 1080 },
    ]);
  });

  it("keeps the project's frame parked from one composition to the next", () => {
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    effects.observe(at("c1"));
    effects.observe(at("c2"));
    expect(fake.frame()).toEqual({ w: 640, h: 360 });
    expect(parkedMainFrame()).toEqual({ w: 1920, h: 1080 });
    effects.observe(at(MAIN_TIMELINE));
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });
  });

  it("restores main when the change came from an undo, not a tab", () => {
    // `observe` cannot tell the causes apart, which is the point.
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    effects.observe(at("c1"));
    effects.observe({ ...at(MAIN_TIMELINE), compositions: {} });
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });
  });

  it("lets a load's own frame stand after a clear from a composition", () => {
    // `adoptDocument`: clear first (the old project's frame comes back), then
    // the file's options, then the load. The load must not undo the file.
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    effects.observe(at("c1"));
    effects.observe(at(MAIN_TIMELINE, 1));
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });
    fake.setFrame({ w: 3840, h: 2160 });
    const before = fake.calls.length;
    effects.observe(at(MAIN_TIMELINE, 2));
    expect(fake.calls.length).toBe(before);
    expect(fake.frame()).toEqual({ w: 3840, h: 2160 });
    expect(parkedMainFrame()).toBeNull();
  });

  it("forgets every pan when the project is replaced", () => {
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, at(MAIN_TIMELINE));
    effects.observe(at("c1"));
    fake.setViewport({ zoom: 400, at: "c1" });
    effects.observe(at(MAIN_TIMELINE));
    effects.observe(at(MAIN_TIMELINE, 1));
    effects.observe(at("c1", 1));
    // Fitted, not the 400% pan of the composition that had this id before.
    expect(fake.calls.at(-1)).toEqual(["viewport", null, { w: 1080, h: 1920 }]);
  });
});

describe("against the timeline store", () => {
  const store = () => useTimelineStore.getState();

  function seed() {
    const clip = {
      ...createTemplateElement({
        templateId: projectTemplateId("c1"),
        name: "c",
        durationMs: 1000,
        size: { w: 1080, h: 1920 },
        frame: { w: 1920, h: 1080 },
      }),
      trackId: "v",
    } as TemplateElementType;
    store().clearTimeline();
    store().loadProject({
      main: { tracks: [createTrack("v", "video", 0)], elements: { t: clip } },
      compositions: {
        c1: {
          id: "c1",
          name: "c",
          size: { w: 1080, h: 1920 },
          tracks: [createTrack("cv", "video", 0)],
          elements: { x: imageElement({ trackId: "cv" }) } as Timeline,
        },
      },
    });
  }

  it("follows a tab, an undo that lands on main, and a clear", () => {
    seed();
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, store());
    const off = useTimelineStore.subscribe((state) => effects.observe(state));

    store().checkPointTimeline();
    store().switchTimeline("c1");
    expect(fake.frame()).toEqual({ w: 1080, h: 1920 });

    store().switchTimeline(MAIN_TIMELINE);
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });

    // An edit that will be undone past, from inside the composition.
    store().withProjectCheckpoint((project) => ({
      ...project,
      compositions: {},
      main: { ...project.main, elements: {} },
    }));
    store().rollbackTimelineFromCheckPoint(-1);
    store().switchTimeline("c1");
    expect(fake.frame()).toEqual({ w: 1080, h: 1920 });
    store().rollbackTimelineFromCheckPoint(1);
    expect(store().activeTimelineId).toBe(MAIN_TIMELINE);
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });

    store().switchTimeline("c1");
    store().clearTimeline();
    expect(fake.frame()).toEqual({ w: 1920, h: 1080 });
    expect(parkedMainFrame()).toBeNull();
    off();
  });

  it("never writes the timeline store from inside its listener", () => {
    // The store swaps its own view fields in the switch's `set`; a write from
    // here would reach later listeners with the outer, older state last.
    seed();
    const fake = fakePort();
    const effects = createSwitchEffects(fake.port, store());
    let nested = 0;
    let inside = false;
    const offWatch = useTimelineStore.subscribe(() => {
      if (inside) {
        nested += 1;
      }
    });
    const off = useTimelineStore.subscribe((state) => {
      inside = true;
      effects.observe(state);
      inside = false;
    });
    store().switchTimeline("c1");
    store().switchTimeline(MAIN_TIMELINE);
    expect(nested).toBe(0);
    off();
    offWatch();
  });
});
