/**
 * `set_color_adjustments` from the agent surface.
 *
 * Held to the rule every command family is: one instruction is one undo step,
 * and a declined instruction costs nothing. Plus what is particular to this
 * one — a reset and a patch in the same call are *one* step, and a patch
 * merges rather than replacing.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import { adjustOf } from "../../renderer/adjust";
import {
  audioElement,
  effectElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../../renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../../timeline/tracks";
import { getCommand } from "../registry";

import "./meta";
import "./adjust";

async function run(name: string, params: any = {}) {
  const command = getCommand(name);
  if (command == null) {
    throw new Error(`no such command: ${name}`);
  }
  return (await command(params)) as any;
}

function doc() {
  return useTimelineStore.getState().getDocument();
}

function historyLength() {
  return useTimelineStore.getState().history.timelineHistory.length;
}

beforeEach(() => {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [
        createTrack("v1", "video", 0),
        createTrack("a1", "audio", 1),
        createTrack("e1", "effect", 2),
      ],
      elements: {
        clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        still: imageElement({ trackId: "v1", startTime: 4000, duration: 1000 }),
        box: shapeElement({ trackId: "v1", startTime: 5000, duration: 1000 }),
        title: textElement({ trackId: "v1", startTime: 6000, duration: 1000 }),
        sound: audioElement({ trackId: "a1", startTime: 0, duration: 4000 }),
        layer: effectElement({ trackId: "e1", startTime: 0, duration: 1000 }),
      },
    }),
  );
});

describe("set_color_adjustments", () => {
  it("sets sliders on one clip and reports what it now carries", async () => {
    const result = await run("set_color_adjustments", {
      elementIds: ["clip"],
      adjustments: { exposure: 20, vignette: -15 },
    });
    expect(result.ok).toBe(true);
    expect(adjustOf(doc().elements.clip)).toEqual({ exposure: 20, vignette: -15 });
    expect(result.clips).toEqual([{ id: "clip", adjust: { exposure: 20, vignette: -15 } }]);
  });

  it("merges — a second call leaves the first call's sliders alone", async () => {
    await run("set_color_adjustments", { elementIds: ["clip"], adjustments: { exposure: 20 } });
    await run("set_color_adjustments", { elementIds: ["clip"], adjustments: { contrast: 10 } });
    expect(adjustOf(doc().elements.clip)).toEqual({ exposure: 20, contrast: 10 });
  });

  it("resets a group and applies a patch in the same call", async () => {
    await run("set_color_adjustments", {
      elementIds: ["clip"],
      adjustments: { temperature: 30, exposure: 20, sharpen: 50 },
    });
    await run("set_color_adjustments", {
      elementIds: ["clip"],
      reset: "lightness",
      adjustments: { shadows: 40 },
    });
    expect(adjustOf(doc().elements.clip)).toEqual({ temperature: 30, shadows: 40, sharpen: 50 });
  });

  it("reset: all clears the clip's field entirely", async () => {
    await run("set_color_adjustments", { elementIds: ["clip"], adjustments: { fade: 30 } });
    await run("set_color_adjustments", { elementIds: ["clip"], reset: "all" });
    expect("adjust" in doc().elements.clip).toBe(false);
  });

  it("clamps a value past the end of its slider", async () => {
    await run("set_color_adjustments", {
      elementIds: ["clip"],
      adjustments: { exposure: 400, sharpen: -20 },
    });
    expect(adjustOf(doc().elements.clip)).toEqual({ exposure: 100 });
  });

  it("adjusts every adjustable filetype", async () => {
    await run("set_color_adjustments", {
      elementIds: ["clip", "still", "box", "title"],
      adjustments: { saturation: -40 },
    });
    for (const id of ["clip", "still", "box", "title"]) {
      expect(adjustOf(doc().elements[id]), id).toEqual({ saturation: -40 });
    }
  });

  it("costs one Cmd+Z for four clips, reset and patch together", async () => {
    // The first agent edit also lays down the undo baseline; get it out of the way.
    await run("set_color_adjustments", { elementIds: ["clip"], adjustments: { tint: 1 } });

    const before = historyLength();
    await run("set_color_adjustments", {
      elementIds: ["clip", "still", "box", "title"],
      reset: "all",
      adjustments: { exposure: 10 },
    });
    expect(historyLength()).toBe(before + 1);

    await run("undo");
    expect(adjustOf(doc().elements.clip)).toEqual({ tint: 1 });
    for (const id of ["still", "box", "title"]) {
      expect(adjustOf(doc().elements[id]), id).toBeNull();
    }
  });

  it("records nothing when the clips already have those values", async () => {
    await run("set_color_adjustments", { elementIds: ["clip"], adjustments: { exposure: 10 } });
    const before = historyLength();
    const result = await run("set_color_adjustments", {
      elementIds: ["clip"],
      adjustments: { exposure: 10 },
    });
    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("refuses audio and effect elements, naming what can be adjusted", async () => {
    await expect(
      run("set_color_adjustments", { elementIds: ["sound"], adjustments: { exposure: 10 } }),
    ).rejects.toThrow(/video, image, gif, shape, text/);
    await expect(
      run("set_color_adjustments", { elementIds: ["layer"], adjustments: { exposure: 10 } }),
    ).rejects.toThrow(/effect/);
    expect("adjust" in doc().elements.sound).toBe(false);
  });

  it("refuses an unknown slider, and says which", async () => {
    await expect(
      run("set_color_adjustments", { elementIds: ["clip"], adjustments: { glow: 10 } }),
    ).rejects.toThrow(/"glow"/);
  });

  it("refuses a value that is not a number", async () => {
    await expect(
      run("set_color_adjustments", { elementIds: ["clip"], adjustments: { exposure: "10" } }),
    ).rejects.toThrow(/"exposure"/);
  });

  it("refuses a call with nothing to do", async () => {
    await expect(run("set_color_adjustments", { elementIds: ["clip"] })).rejects.toThrow(
      /adjustments|reset/,
    );
    await expect(
      run("set_color_adjustments", { elementIds: [], adjustments: { exposure: 1 } }),
    ).rejects.toThrow(/elementIds/);
  });

  it("refuses an unknown reset group", async () => {
    await expect(
      run("set_color_adjustments", { elementIds: ["clip"], reset: "tone" }),
    ).rejects.toThrow(/reset/);
  });

  it("refuses an id that does not exist", async () => {
    await expect(
      run("set_color_adjustments", { elementIds: ["ghost"], adjustments: { exposure: 1 } }),
    ).rejects.toThrow();
  });
});
