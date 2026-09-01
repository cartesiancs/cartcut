/**
 * `set_mask` from the agent surface.
 *
 * The claim pinned hardest here is the one every command family is held to:
 * **one instruction is one undo step, and a declined instruction costs
 * nothing.** Two more matter for this command specifically — that the five
 * keyframe tracks appear and disappear with the mask rather than separately,
 * and that a `pen` mask with no drawn path is *stored* and reported rather than
 * refused, which is the same contract a LUT this machine does not have has.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import { MASK_ANIMATABLE_PROPERTIES } from "../../../@types/timeline";
import { maskOf } from "../../mask/maskShape";
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
import "./mask";

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

describe("set_mask", () => {
  it("masks one clip", async () => {
    const result = await run("set_mask", {
      elementIds: ["clip"],
      shape: "star",
    });
    expect(result.ok).toBe(true);
    expect(maskOf(doc().elements.clip)?.shape).toBe("star");
  });

  it("masks every maskable filetype", async () => {
    await run("set_mask", {
      elementIds: ["clip", "still", "box", "title"],
      shape: "heart",
    });
    for (const id of ["clip", "still", "box", "title"]) {
      expect(maskOf(doc().elements[id])?.shape, id).toBe("heart");
    }
  });

  it("places and shapes in one instruction", async () => {
    await run("set_mask", {
      elementIds: ["clip"],
      shape: "rectangle",
      x: 25,
      y: 40,
      width: 50,
      height: 80,
      rotation: 30,
      feather: 12,
      roundness: 60,
      invert: true,
    });
    expect(maskOf(doc().elements.clip)).toEqual({
      shape: "rectangle",
      location: { x: 25, y: 40 },
      size: { width: 50, height: 80 },
      rotation: 30,
      feather: 12,
      roundness: 60,
      invert: true,
    });
  });

  // The whole justification for routing agent edits through `commit()`.
  //
  // Measured after a first edit has already run, because the first agent edit
  // in a freshly loaded document also lays down the baseline nothing else
  // records — see `features/agent/checkpoint.ts`, and the "known rough edges"
  // note in CLAUDE.md about the first edit after opening a project. The same
  // allowance `lut.test.ts` makes, for the same reason.
  it("is one undo step, for three clips and a shape and a placement", async () => {
    await run("set_mask", { elementIds: ["clip"], shape: "rectangle" });

    const before = historyLength();
    await run("set_mask", {
      elementIds: ["clip", "still", "box"],
      shape: "star",
      feather: 8,
    });
    expect(historyLength()).toBe(before + 1);
  });

  it("records nothing when it declines", async () => {
    await run("set_mask", { elementIds: ["clip"], shape: "star" });
    const before = historyLength();
    await run("set_mask", { elementIds: ["clip"], shape: "star" });
    expect(historyLength()).toBe(before);
  });

  it("clears a mask, and declines on a clip that has none", async () => {
    await run("set_mask", { elementIds: ["clip"], shape: "star" });
    await run("set_mask", { elementIds: ["clip"], shape: null });
    expect(maskOf(doc().elements.clip)).toBeNull();
    expect("mask" in (doc().elements.clip as any)).toBe(false);

    const before = historyLength();
    await run("set_mask", { elementIds: ["clip"], shape: null });
    expect(historyLength()).toBe(before);
  });

  describe("the keyframe tracks follow the mask", () => {
    const tracks = (id: string) =>
      Object.keys((doc().elements[id] as any).animation);

    it("appear with it", async () => {
      await run("set_mask", { elementIds: ["clip"], shape: "rectangle" });
      for (const property of MASK_ANIMATABLE_PROPERTIES) {
        expect(tracks("clip"), property).toContain(property);
      }
    });

    it("go with it", async () => {
      await run("set_mask", { elementIds: ["clip"], shape: "rectangle" });
      await run("set_mask", { elementIds: ["clip"], shape: null });
      expect(tracks("clip").sort()).toEqual(
        ["opacity", "position", "rotation", "scale"].sort(),
      );
    });
  });

  describe("refusing", () => {
    it("refuses a filetype that cannot carry a mask, naming the ones that can", async () => {
      await expect(
        run("set_mask", { elementIds: ["sound"], shape: "star" }),
      ).rejects.toThrow(/video, image, gif, shape, text/);
      await expect(
        run("set_mask", { elementIds: ["layer"], shape: "star" }),
      ).rejects.toThrow(/effect/);
    });

    it("refuses a shape it does not know", async () => {
      await expect(
        run("set_mask", { elementIds: ["clip"], shape: "octagon" }),
      ).rejects.toThrow(/rectangle, star, heart, pen/);
    });

    it("refuses an unreadable number rather than storing it", async () => {
      await expect(
        run("set_mask", { elementIds: ["clip"], shape: "star", feather: NaN }),
      ).rejects.toThrow(/feather/);
      await expect(
        run("set_mask", { elementIds: ["clip"], shape: "star", x: "40" }),
      ).rejects.toThrow(/x/);
    });

    it("refuses an empty id list", async () => {
      await expect(run("set_mask", { elementIds: [] })).rejects.toThrow(
        /at least one/,
      );
    });

    it("leaves the document alone when it throws", async () => {
      const before = historyLength();
      await expect(
        run("set_mask", { elementIds: ["sound"], shape: "star" }),
      ).rejects.toThrow();
      expect(historyLength()).toBe(before);
      expect(maskOf(doc().elements.sound)).toBeNull();
    });
  });

  describe("half a pair", () => {
    // Defaulting the other axis to the centre would move the mask along an axis
    // the caller never named, which is worse than either refusing or ignoring.
    it("keeps the axis the caller did not name", async () => {
      await run("set_mask", {
        elementIds: ["clip"],
        shape: "rectangle",
        x: 20,
        y: 80,
      });
      await run("set_mask", { elementIds: ["clip"], x: 60 });
      expect(maskOf(doc().elements.clip)?.location).toEqual({ x: 60, y: 80 });
    });

    it("patches without being given a shape", async () => {
      await run("set_mask", { elementIds: ["clip"], shape: "heart" });
      await run("set_mask", { elementIds: ["clip"], feather: 20 });
      const mask = maskOf(doc().elements.clip);
      expect(mask?.shape).toBe("heart");
      expect(mask?.feather).toBe(20);
    });
  });

  describe("a pen mask with no path", () => {
    // Stored, not refused — the same contract a LUT that is not installed has.
    // An agent may legitimately be restoring a project whose path it cannot
    // see, and refusing would lose the placement it *can* set.
    it("is stored, and reported", async () => {
      const result = await run("set_mask", {
        elementIds: ["clip"],
        shape: "pen",
      });
      expect(maskOf(doc().elements.clip)?.shape).toBe("pen");
      expect(result.warning).toMatch(/renders as no mask/);
    });

    it("does not warn about a built-in shape", async () => {
      const result = await run("set_mask", {
        elementIds: ["clip"],
        shape: "heart",
      });
      expect(result.warning).toBeUndefined();
    });
  });
});
