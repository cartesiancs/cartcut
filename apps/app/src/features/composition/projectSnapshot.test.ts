import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import {
  currentProjectDigest,
  isProjectEmpty,
} from "../project/projectDirty";
import {
  COMPOSITIONS_ENTRY,
  compositionsExtraEntries,
} from "../project/compositionsFile";
import { serializeProjectEntries } from "../project/projectEntries";
import { imageElement } from "../renderer/testing";
import { createTemplateElement } from "../timeline/templateOps";
import { createTrack } from "../timeline/tracks";
import { setParkedMainFrame } from "./mainFrame";
import { MAIN_TIMELINE, projectTemplateId } from "./project";
import { projectRenderOptions, projectSnapshot } from "./projectSnapshot";

/**
 * What a save writes and what the dirty digest hashes are the project, never
 * the timeline showing. Each case is a way an expanded template could leak
 * into, or vanish from, the file.
 */

const store = () => useTimelineStore.getState();

function clip(compositionId: string): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: projectTemplateId(compositionId),
      name: "T",
      durationMs: 1000,
      size: { w: 10, h: 10 },
      frame: { w: 10, h: 10 },
    }),
    trackId: "v",
  } as TemplateElementType;
}

function comp(id: string, elements: Timeline = {}) {
  return {
    id,
    name: id,
    size: { w: 640, h: 360 },
    tracks: [createTrack(`${id}-t`, "video", 0)],
    elements,
  };
}

function load(main: Timeline, compositions: Record<string, ReturnType<typeof comp>> = {}) {
  store().clearTimeline();
  store().loadProject({
    main: { tracks: [createTrack("v", "video", 0)], elements: main },
    compositions,
  });
}

/** What ⌘S writes, without the zip. */
function written(anchor = "/p/proj/p.ngt") {
  const snapshot = projectSnapshot();
  return {
    entries: serializeProjectEntries({
      elements: snapshot.project.main.elements,
      tracks: snapshot.project.main.tracks,
      options: snapshot.options,
      anchor,
      compositionCount: Object.keys(snapshot.project.compositions).length,
    }),
    extras: compositionsExtraEntries(snapshot.project.compositions, anchor),
  };
}

beforeEach(() => {
  renderOptionStore.setState({
    options: JSON.parse(JSON.stringify(renderOptionStore.getInitialState().options)),
  });
  setParkedMainFrame(null);
});

afterEach(() => {
  setParkedMainFrame(null);
});

describe("a project that owns no template", () => {
  it("writes the entries it always wrote, and no compositions entry", () => {
    load({ a: imageElement({ trackId: "v" }) });
    const { entries, extras } = written();
    expect(JSON.parse(entries.project)).toEqual({ schemaVersion: 2 });
    expect(extras).toEqual({});
    // Byte-identical to what serializeProjectEntries gave before the field.
    expect(entries).toEqual(
      serializeProjectEntries({
        elements: store().timeline,
        tracks: store().tracks,
        options: renderOptionStore.getState().options,
        anchor: "/p/proj/p.ngt",
      }),
    );
  });
});

describe("a project that owns one", () => {
  it("writes it, and stamps the version an older build refuses", () => {
    load({ t: clip("c1") }, { c1: comp("c1", { x: imageElement({ trackId: "c1-t" }) }) });
    const { entries, extras } = written();
    expect(JSON.parse(entries.project)).toEqual({ schemaVersion: 4 });
    expect(Object.keys(extras)).toEqual([COMPOSITIONS_ENTRY]);
  });

  it("writes main, not the template showing", () => {
    load({ t: clip("c1") }, { c1: comp("c1", { x: imageElement({ trackId: "c1-t" }) }) });
    store().switchTimeline("c1");
    const { entries } = written();
    expect(Object.keys(JSON.parse(entries.timeline))).toEqual(["t"]);
  });

  it("leaves out a composition nothing names, and drops back a version", () => {
    load({ a: imageElement({ trackId: "v" }) }, { orphan: comp("orphan") });
    const { entries, extras } = written();
    expect(JSON.parse(entries.project)).toEqual({ schemaVersion: 2 });
    expect(extras).toEqual({});
  });

  it("writes the project's frame, not the template's", () => {
    load({ t: clip("c1") }, { c1: comp("c1") });
    // What the switch effect does: keep the project's frame, show the template's.
    setParkedMainFrame({ w: 1920, h: 1080 });
    renderOptionStore.getState().updateOptions({
      ...renderOptionStore.getState().options,
      previewSize: { w: 640, h: 360 },
    });
    expect(projectRenderOptions().previewSize).toEqual({ w: 1920, h: 1080 });
    const { entries } = written();
    expect(JSON.parse(entries.renderOptions).previewSize).toEqual({ w: 1920, h: 1080 });
  });
});

describe("the dirty digest", () => {
  beforeEach(() => {
    load({ t: clip("c1") }, { c1: comp("c1", { x: imageElement({ trackId: "c1-t" }) }) });
  });

  it("does not move when a tab is switched", () => {
    const before = currentProjectDigest();
    store().switchTimeline("c1");
    setParkedMainFrame(renderOptionStore.getState().options.previewSize);
    renderOptionStore.getState().updateOptions({
      ...renderOptionStore.getState().options,
      previewSize: { w: 640, h: 360 },
    });
    expect(currentProjectDigest()).toBe(before);
    store().switchTimeline(MAIN_TIMELINE);
    expect(currentProjectDigest()).toBe(before);
  });

  it("moves for an edit inside a template", () => {
    const before = currentProjectDigest();
    store().switchTimeline("c1");
    store().withCheckpoint((doc) => ({
      ...doc,
      elements: { ...doc.elements, y: imageElement({ trackId: "c1-t", startTime: 9000 }) },
    }));
    expect(currentProjectDigest()).not.toBe(before);
  });

  it("does not move for an edit to a composition nothing names", () => {
    load({ a: imageElement({ trackId: "v" }) }, { orphan: comp("orphan") });
    const before = currentProjectDigest();
    store().withCheckpointOn("orphan", (doc) => ({
      ...doc,
      elements: { y: imageElement({ trackId: "orphan-t" }) },
    }));
    expect(currentProjectDigest()).toBe(before);
  });
});

describe("isProjectEmpty", () => {
  it("is false while any timeline holds anything", () => {
    store().clearTimeline();
    expect(isProjectEmpty()).toBe(true);

    load({ t: clip("c1") }, { c1: comp("c1") });
    store().switchTimeline("c1");
    // The template's own timeline being empty is not the project being empty.
    store().withCheckpoint((doc) => ({ ...doc, elements: {}, tracks: [] }));
    expect(Object.keys(store().timeline)).toEqual([]);
    expect(isProjectEmpty()).toBe(false);
  });
});
