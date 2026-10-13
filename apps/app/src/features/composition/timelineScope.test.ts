import { beforeEach, describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { getCommand } from "../agent/registry";
import "../agent/commands/read";
import "../agent/commands/media";
import type { MediaProber } from "../element/mediaProbe";
import { pasteFromClipboard } from "../editor/actions";
import { imageElement } from "../renderer/testing";
import { addTemplateToTimeline } from "../template/addTemplate";
import { createTemplateElement } from "../timeline/templateOps";
import { createTrack } from "../timeline/tracks";
import { NESTED_TEMPLATE_MESSAGE, withoutTemplateClips } from "./nesting";
import { MAIN_TIMELINE, projectTemplateId } from "./project";

/**
 * Which timeline an edit lands in.
 *
 *  - Work that awaits lands where it was asked for, not wherever the user is
 *    looking when it finishes.
 *  - Nothing places a template inside a template.
 *  - The agent is told which timeline it is reading.
 */

const store = () => useTimelineStore.getState();

function clip(): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: projectTemplateId("c1"),
      name: "Intro",
      durationMs: 2000,
      size: { w: 640, h: 360 },
      frame: { w: 1920, h: 1080 },
    }),
    trackId: "v",
  } as TemplateElementType;
}

function seed() {
  store().clearTimeline();
  store().loadProject({
    main: { tracks: [createTrack("v", "video", 0)], elements: { t: clip() } },
    compositions: {
      c1: {
        id: "c1",
        name: "Intro",
        size: { w: 640, h: 360 },
        tracks: [createTrack("cv", "video", 0)],
        elements: { x: imageElement({ trackId: "cv", duration: 2000 }) } as Timeline,
      },
    },
  });
}

async function run(name: string, params: unknown = {}) {
  return (await getCommand(name)!(params)) as any;
}

beforeEach(() => {
  seed();
});

describe("an agent edit that awaits first", () => {
  it("lands in the timeline it was asked in, after a switch", async () => {
    store().switchTimeline("c1");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowProber: MediaProber = {
      image: async () => {
        await gate;
        return { width: 100, height: 100 };
      },
      gif: async () => ({ width: 1, height: 1 }),
      video: async () => ({ width: 1, height: 1, durationMs: 1000, hasAudio: false }),
      audio: async () => ({ durationMs: 1000 }),
    };

    const pending = run("add_media", {
      items: [{ path: "/still.png" }],
      startMs: 0,
      prober: slowProber,
    });
    // The user goes back to main while the file is being read.
    store().switchTimeline(MAIN_TIMELINE);
    release();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(Object.keys(store().timeline)).toEqual(["t"]);
    const parked = store().parked.c1.elements;
    expect(result.created.every((id: string) => parked[id] != null)).toBe(true);
  });
});

describe("placing a template", () => {
  it("is refused inside a template, with the reason", async () => {
    store().switchTimeline("c1");
    const result = await addTemplateToTimeline("anything", { startMs: 0 });
    expect(result).toEqual({ ok: false, message: NESTED_TEMPLATE_MESSAGE });
  });

  it("leaves template clips out of a paste into a template", () => {
    const copied = {
      t: clip(),
      pic: imageElement({ trackId: "v", startTime: 0, duration: 500 }),
    };
    selectionStore.getState().setClipboard(structuredClone(copied));
    store().switchTimeline("c1");
    pasteFromClipboard();
    const pasted = Object.values(store().timeline);
    expect(pasted.some((e) => e.filetype === "template")).toBe(false);
    expect(pasted.filter((e) => e.filetype === "image")).toHaveLength(2);
  });

  it("pastes template clips into main as before", () => {
    selectionStore.getState().setClipboard({ t: structuredClone(clip()) });
    pasteFromClipboard();
    expect(
      Object.values(store().timeline).filter((e) => e.filetype === "template"),
    ).toHaveLength(2);
  });
});

describe("withoutTemplateClips", () => {
  it("returns its input by identity when there is no template", () => {
    const clips = { a: imageElement() };
    expect(withoutTemplateClips(clips).clips).toBe(clips);
    expect(withoutTemplateClips(clips).dropped).toBe(0);
  });
});

describe("the agent's overview", () => {
  it("names the timeline it describes", async () => {
    expect((await run("get_project_overview")).activeTimeline).toEqual({
      id: MAIN_TIMELINE,
      kind: "main",
      name: "Main",
    });
    store().switchTimeline("c1");
    const inside = await run("get_project_overview");
    expect(inside.activeTimeline).toEqual({ id: "c1", kind: "template", name: "Intro" });
    expect(inside.clipCount).toBe(1);
  });
});
