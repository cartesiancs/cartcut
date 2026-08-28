/**
 * Changing the frame rate is three writes and one non-write, and the non-write
 * is the one worth defending: a settings change that quietly records an undo
 * step is a settings change the user can undo by accident.
 *
 * These drive the real stores, because the sequencing between them *is* the
 * behaviour — the pure pieces each have their own suite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { projectBakeHz, projectFps, setProjectFps } from "./frameRate";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { BAKE_HZ, bakeTrack } from "../animation/keyframes";
import { DEFAULT_FPS, frameToMs, isFrameAligned } from "../timeline/frames";
import { MAX_RANGE, maxRangeForFps } from "../timeline/zoom";
import { createTrack } from "../timeline/tracks";
import { imageElement, keys, points } from "../renderer/testing";

const initialOptions = renderOptionStore.getInitialState().options;

/** An image carrying one animated opacity track. */
function animated() {
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

function loadDocument(elements: Record<string, any>) {
  useTimelineStore.getState().clearTimeline();
  useTimelineStore.getState().patchDocument(
    {
      schemaVersion: 2,
      tracks: [createTrack("v1", "video", 0)],
      elements,
    },
    { bakeHz: projectBakeHz() },
  );
}

const historyLength = () =>
  useTimelineStore.getState().history.timelineHistory.length;
const opacityOf = (id: string) =>
  (useTimelineStore.getState().timeline[id] as any).animation.opacity;

beforeEach(() => {
  renderOptionStore.setState({
    options: JSON.parse(JSON.stringify(initialOptions)),
  });
  useTimelineStore.getState().clearTimeline();
  useTimelineStore.getState().setRange(MAX_RANGE);
  useTimelineStore.getState().setCursor(0);
});

describe("projectFps", () => {
  it("reads the store", () => {
    expect(projectFps()).toBe(DEFAULT_FPS);
    setProjectFps(30);
    expect(projectFps()).toBe(30);
  });

  it("reports the bake rate the project's curves belong at", () => {
    expect(projectBakeHz()).toBe(BAKE_HZ);
    setProjectFps(24);
    expect(projectBakeHz()).toBe(BAKE_HZ);
    setProjectFps(120);
    expect(projectBakeHz()).toBe(120);
  });
});

describe("setProjectFps", () => {
  it("stores the rate and hands back what it stored", () => {
    expect(setProjectFps(30)).toBe(30);
    expect(projectFps()).toBe(30);
  });

  it("hands back the coerced value, which the settings field writes back", () => {
    expect(setProjectFps(29.97)).toBe(30);
    expect(setProjectFps(0)).toBe(DEFAULT_FPS);
    expect(setProjectFps(100_000)).toBe(240);
    expect(projectFps()).toBe(240);
  });

  it("is a complete no-op when the rate is already that", () => {
    loadDocument({ a: animated() });
    const before = {
      history: historyLength(),
      range: useTimelineStore.getState().range,
      cursor: useTimelineStore.getState().cursor,
      options: renderOptionStore.getState().options,
    };

    expect(setProjectFps(DEFAULT_FPS)).toBe(DEFAULT_FPS);

    expect(historyLength()).toBe(before.history);
    expect(useTimelineStore.getState().range).toBe(before.range);
    expect(useTimelineStore.getState().cursor).toBe(before.cursor);
    expect(renderOptionStore.getState().options).toBe(before.options);
  });

  it("pulls the zoom back under a lowered ceiling", () => {
    setProjectFps(120);
    useTimelineStore.getState().setRange(maxRangeForFps(120));

    setProjectFps(30);
    expect(useTimelineStore.getState().range).toBe(maxRangeForFps(30));
  });

  it("leaves a zoom that is still in bounds alone", () => {
    useTimelineStore.getState().setRange(12);
    setProjectFps(30);
    expect(useTimelineStore.getState().range).toBe(12);
  });

  it("raises no ceiling problem going the other way", () => {
    useTimelineStore.getState().setRange(MAX_RANGE);
    setProjectFps(120);
    expect(useTimelineStore.getState().range).toBe(MAX_RANGE);
  });

  it("puts the playhead back on a frame of the new grid", () => {
    // 1016.6…ms is frame 61 at 60fps and lands mid-frame at 30.
    useTimelineStore.getState().setCursor(frameToMs(61, 60));
    expect(isFrameAligned(useTimelineStore.getState().cursor, 30)).toBe(false);

    setProjectFps(30);
    expect(isFrameAligned(useTimelineStore.getState().cursor, 30)).toBe(true);
  });

  it("leaves a playhead that is already on the new grid alone", () => {
    // Every 60fps frame is a 120fps frame, so nothing should move.
    const at60 = frameToMs(61, 60);
    useTimelineStore.getState().setCursor(at60);
    setProjectFps(120);
    expect(useTimelineStore.getState().cursor).toBe(at60);
  });

  it("re-bakes animation when the rate passes the bake floor", () => {
    loadDocument({ a: animated() });
    const before = opacityOf("a").ax.length;

    setProjectFps(120);

    expect(opacityOf("a").ax).toEqual(bakeTrack(opacityOf("a").x, 120));
    expect(opacityOf("a").ax.length).toBeGreaterThan(before);
  });

  it("records exactly one undo step for a rebake", () => {
    loadDocument({ a: animated() });
    const before = historyLength();

    setProjectFps(120);

    expect(historyLength()).toBe(before + 1);
  });

  it("records no undo step when there is nothing to re-bake", () => {
    // The case that matters, because it is the common one: a project with no
    // animation, or a rate change that both sides of the bake floor agree on.
    loadDocument({ a: imageElement({ trackId: "v1" }) });
    const before = historyLength();

    setProjectFps(30);
    setProjectFps(120);
    setProjectFps(24);

    expect(historyLength()).toBe(before);
  });

  it("records no undo step for a change under the bake floor", () => {
    loadDocument({ a: animated() });
    const before = historyLength();

    setProjectFps(30);
    setProjectFps(24);
    setProjectFps(50);

    expect(projectFps()).toBe(50);
    expect(historyLength()).toBe(before);
  });

  it("does not move a clip", () => {
    // The non-destructive guarantee, driven end to end.
    loadDocument({
      a: imageElement({ trackId: "v1", startTime: 1000, duration: 2000 }),
      b: imageElement({
        trackId: "v1",
        startTime: frameToMs(61, 60),
        duration: 1500,
      }),
    });
    const before = JSON.parse(
      JSON.stringify(useTimelineStore.getState().timeline),
    );

    for (const fps of [24, 30, 120, 240, 60]) {
      setProjectFps(fps);
    }

    expect(useTimelineStore.getState().timeline).toEqual(before);
  });
});
