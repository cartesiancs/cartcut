/**
 * The five edits the app could do and the agent surface could not.
 *
 * Each wraps a pure op that already existed, was already tested, and had no
 * caller here. What these tests pin is the adapter layer: that the filetype
 * guard names the types rather than failing vaguely, that a declined edit costs
 * no undo step, and for `set_crop` that the units agree with what `get_clip`
 * reports, since a tool whose output cannot be fed back into its own input is
 * the kind of thing an agent gets wrong consistently.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import { cropOf, isCropped } from "../../timeline/cropOps";
import { mirrorOf } from "../../timeline/mirrorOps";
import {
  audioElement,
  imageElement,
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
import "./read";
import "./edit";
import "./framing";

async function run(name: string, params: any = {}) {
  const command = getCommand(name);
  if (command == null) {
    throw new Error(`no such command: ${name}`);
  }
  return (await command(params)) as any;
}

const doc = () => useTimelineStore.getState().getDocument();
const historyLength = () =>
  useTimelineStore.getState().history.timelineHistory.length;

beforeEach(() => {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
      elements: {
        clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        still: imageElement({ trackId: "v1", startTime: 4000, duration: 1000 }),
        title: textElement({ trackId: "v1", startTime: 6000, duration: 1000 }),
        sound: audioElement({ trackId: "a1", startTime: 0, duration: 4000 }),
      },
    }),
  );
});

describe("set_crop", () => {
  it("crops a clip in the units get_clip reports", async () => {
    const result = await run("set_crop", {
      elementIds: ["clip"],
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });

    expect(result.ok).toBe(true);
    expect(cropOf(doc().elements.clip)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });

    // The round trip the units exist for: what came out goes back in.
    const detail = await run("get_clip", { elementId: "clip" });
    const again = await run("set_crop", {
      elementIds: ["clip"],
      ...detail.crop,
    });
    expect(again.ok).toBe(false);
  });

  // Measured per clip rather than from the first one, so a call naming one
  // field does not snap the rest of the selection to a rect nobody asked for.
  it("keeps each clip's own value for the fields it is not given", async () => {
    await run("set_crop", {
      elementIds: ["clip"],
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.7,
    });
    await run("set_crop", { elementIds: ["clip"], width: 0.5 });

    expect(cropOf(doc().elements.clip)).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.7,
    });
  });

  it("puts the whole frame back", async () => {
    await run("set_crop", { elementIds: ["clip"], width: 0.5 });
    expect(isCropped(cropOf(doc().elements.clip))).toBe(true);

    const result = await run("set_crop", { elementIds: ["clip"], reset: true });
    expect(result.ok).toBe(true);
    expect(isCropped(cropOf(doc().elements.clip))).toBe(false);
  });

  it("is one undo step for two clips", async () => {
    await run("set_crop", { elementIds: ["clip"], width: 0.9 });

    const before = historyLength();
    await run("set_crop", { elementIds: ["clip", "still"], width: 0.5 });
    expect(historyLength()).toBe(before + 1);
  });

  it("declines a framing a clip already has, at no cost", async () => {
    await run("set_crop", { elementIds: ["clip"], width: 0.5 });

    const before = historyLength();
    const again = await run("set_crop", { elementIds: ["clip"], width: 0.5 });

    expect(again.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  describe("refusing", () => {
    it("names the types that can be cropped", async () => {
      await expect(
        run("set_crop", { elementIds: ["title"], width: 0.5 }),
      ).rejects.toThrow(/Only video, image clips can be cropped.*got text/);
    });

    it("refuses a reset and a rect together", async () => {
      await expect(
        run("set_crop", { elementIds: ["clip"], reset: true, width: 0.5 }),
      ).rejects.toThrow(/either `reset: true` or a rect/);
    });

    it("refuses a call that asks for nothing", async () => {
      await expect(run("set_crop", { elementIds: ["clip"] })).rejects.toThrow(
        /needs `x`, `y`, `width` or `height`/,
      );
    });

    it("refuses a rect that is not numbers", async () => {
      await expect(
        run("set_crop", { elementIds: ["clip"], width: NaN }),
      ).rejects.toThrow(/`width` must be a finite number/);
    });
  });
});

describe("set_mirror", () => {
  it("flips on each axis independently", async () => {
    await run("set_mirror", { elementIds: ["clip"], horizontal: true });
    expect(mirrorOf(doc().elements.clip)).toEqual({ h: true, v: false });

    await run("set_mirror", { elementIds: ["clip"], vertical: true });
    expect(mirrorOf(doc().elements.clip)).toEqual({ h: true, v: true });
  });

  /*
   * Absolute rather than a toggle. A person can see which way the clip already
   * faces; an agent often cannot, so "face it left" has to mean that whatever
   * the clip was doing, rather than depending on a state it would have to read
   * first.
   */
  it("is absolute, so setting the same value twice declines", async () => {
    await run("set_mirror", { elementIds: ["clip"], horizontal: true });

    const before = historyLength();
    const again = await run("set_mirror", {
      elementIds: ["clip"],
      horizontal: true,
    });

    expect(again.ok).toBe(false);
    expect(mirrorOf(doc().elements.clip).h).toBe(true);
    expect(historyLength()).toBe(before);
  });

  it("unflips", async () => {
    await run("set_mirror", { elementIds: ["clip"], horizontal: true });
    await run("set_mirror", { elementIds: ["clip"], horizontal: false });
    expect(mirrorOf(doc().elements.clip).h).toBe(false);
  });

  it("takes both axes for several clips in one step", async () => {
    await run("set_mirror", { elementIds: ["clip"], horizontal: true });

    const before = historyLength();
    await run("set_mirror", {
      elementIds: ["clip", "still"],
      horizontal: false,
      vertical: true,
    });

    expect(historyLength()).toBe(before + 1);
    expect(mirrorOf(doc().elements.still)).toEqual({ h: false, v: true });
  });

  describe("refusing", () => {
    it("names the types that can be mirrored", async () => {
      await expect(
        run("set_mirror", { elementIds: ["sound"], horizontal: true }),
      ).rejects.toThrow(/Only video, image clips can be mirrored.*got audio/);
    });

    it("refuses a call that names no axis", async () => {
      await expect(run("set_mirror", { elementIds: ["clip"] })).rejects.toThrow(
        /needs `horizontal` or `vertical`/,
      );
    });
  });
});

describe("rotate_clips", () => {
  it("turns a quarter turn by default", async () => {
    const result = await run("rotate_clips", { elementIds: ["clip"] });

    expect(result.ok).toBe(true);
    expect((doc().elements.clip as any).rotation).toBe(90);
  });

  it("takes a change, not an absolute angle", async () => {
    await run("rotate_clips", { elementIds: ["clip"] });
    await run("rotate_clips", { elementIds: ["clip"], degrees: 90 });
    expect((doc().elements.clip as any).rotation).toBe(180);
  });

  it("is one undo step for two clips", async () => {
    await run("rotate_clips", { elementIds: ["clip"] });

    const before = historyLength();
    await run("rotate_clips", { elementIds: ["clip", "still"] });
    expect(historyLength()).toBe(before + 1);
  });

  // The decline names *which* of the two nothings happened, because an agent
  // told only "nothing changed" cannot tell a bad selection from a no-op turn.
  it("says an audio-only selection has no picture to turn", async () => {
    const result = await run("rotate_clips", { elementIds: ["sound"] });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no picture to rotate/);
  });

  it("refuses ids it cannot find, and a degree that is not a number", async () => {
    await expect(
      run("rotate_clips", { elementIds: ["nope"] }),
    ).rejects.toThrow(/No clip with id/);
    await expect(
      run("rotate_clips", { elementIds: ["clip"], degrees: NaN }),
    ).rejects.toThrow(/`degrees` must be a finite number/);
  });
});

describe("merge_clips", () => {
  it("fuses back what split_clip cut apart", async () => {
    const split = await run("split_clip", { elementId: "clip", atMs: [2000] });
    const halves = ["clip", ...split.created];
    expect(halves).toHaveLength(2);

    const result = await run("merge_clips", { elementIds: halves });

    expect(result.ok).toBe(true);
    // The leftmost survives and keeps its id, so every reference an agent
    // already holds stays valid.
    expect(doc().elements.clip).toBeDefined();
    expect(doc().elements[split.created[0]]).toBeUndefined();
    expect(doc().elements.clip.duration).toBe(4000);
  });

  it("declines clips that are not a run from one source", async () => {
    const result = await run("merge_clips", {
      elementIds: ["clip", "still"],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/adjacent run from the same source/);
  });

  it("needs two ids to have anything to fuse", async () => {
    await expect(
      run("merge_clips", { elementIds: ["clip"] }),
    ).rejects.toThrow(/at least two ids/);
  });
});

describe("detach_audio", () => {
  it("puts the sound on its own track and silences the video", async () => {
    const before = Object.keys(doc().elements).length;
    const result = await run("detach_audio", { elementIds: ["clip"] });

    expect(result.ok).toBe(true);
    expect(Object.keys(doc().elements).length).toBe(before + 1);
    expect((doc().elements.clip as any).audioDetached).toBe(true);
  });

  // Skipped rather than refused, so a mixed selection does the obvious thing.
  it("detaches what it can and ignores what it cannot", async () => {
    const result = await run("detach_audio", {
      elementIds: ["clip", "title", "sound"],
    });

    expect(result.ok).toBe(true);
    expect((doc().elements.clip as any).audioDetached).toBe(true);
  });

  it("declines when nothing in the selection carries sound", async () => {
    const result = await run("detach_audio", { elementIds: ["title"] });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/carry sound to detach/);
  });

  it("declines a clip whose audio is already detached", async () => {
    await run("detach_audio", { elementIds: ["clip"] });

    const before = historyLength();
    const again = await run("detach_audio", { elementIds: ["clip"] });

    expect(again.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });
});
