/**
 * `apply_typewriter` and `set_text_reveal` from the agent surface.
 *
 * The claim pinned hardest here is the one this change exists for: before it,
 * `revealProgress` was in the MCP `ANIMATABLE` enum and unreachable, because
 * `animatableProperties` gates it on a `reveal` field nothing could write. The
 * "closing the dead end" block is that regression.
 *
 * Two more matter. One instruction is one undo step and a declined instruction
 * costs nothing, as in every command family. And the progress track appears and
 * disappears **with** the reveal rather than separately, which is what keeps a
 * cleared reveal from leaving an orphan lane behind.
 *
 * Times are exact 60fps frame boundaries so `onFrame` does not move them and a
 * failure means what it says.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import { TEXT_ANIMATABLE_PROPERTIES } from "../../../@types/timeline";
import { revealOf } from "../../text/reveal";
import {
  audioElement,
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
import "./animation";
import "./reveal";

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

/** The authored lane behind the reveal, as `[atMs, value]` pairs. */
const lane = (id: string): Array<[number, number]> =>
  ((doc().elements[id] as any)?.animation?.revealProgress?.x ?? []).map(
    (keyframe: any) => [keyframe.p[0], keyframe.p[1]],
  );

const track = (id: string) =>
  (doc().elements[id] as any)?.animation?.revealProgress;

beforeEach(() => {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
      elements: {
        // 11 characters, 2 words, 1 line.
        title: textElement({
          trackId: "v1",
          startTime: 6000,
          duration: 2000,
          text: "hello world",
        }),
        other: textElement({
          trackId: "v1",
          startTime: 9000,
          duration: 2000,
          text: "second one",
        }),
        clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        sound: audioElement({ trackId: "a1", startTime: 0, duration: 4000 }),
      },
    }),
  );
});

describe("apply_typewriter", () => {
  it("writes the reveal, both keyframes and a live track in one instruction", async () => {
    const result = await run("apply_typewriter", {
      elementIds: ["title"],
      durationMs: 900,
    });

    expect(result.ok).toBe(true);
    expect(revealOf(doc().elements.title)?.unit).toBe("character");
    expect(track("title").isActivate).toBe(true);
    expect(lane("title")).toEqual([
      [0, 0],
      [900, 100],
    ]);
  });

  // The conversion the command exists to do. The clip starts at 6000, so an
  // absolute 6300 is element-local 300, and a caller that had just read
  // `list_clips` would have no way to know that on its own.
  it("converts an absolute time to the clip's own", async () => {
    await run("apply_typewriter", {
      elementIds: ["title"],
      atMs: 6300,
      durationMs: 500,
    });

    expect(lane("title")).toEqual([
      [300, 0],
      [800, 100],
    ]);
  });

  it("derives a length from a speed, counting the text's own units", async () => {
    await run("apply_typewriter", {
      elementIds: ["title"],
      unit: "word",
      unitsPerSecond: 2,
    });

    expect(revealOf(doc().elements.title)?.unit).toBe("word");
    // "hello world" is two words at two a second.
    expect(lane("title")).toEqual([
      [0, 0],
      [1000, 100],
    ]);
  });

  // Measured after a first edit has already run, because the first agent edit
  // in a freshly loaded document also lays down the baseline nothing else
  // records. The same allowance `mask.test.ts` and `lut.test.ts` make.
  it("is one undo step for two clips", async () => {
    await run("apply_typewriter", { elementIds: ["title"], durationMs: 300 });

    const before = historyLength();
    await run("apply_typewriter", {
      elementIds: ["title", "other"],
      durationMs: 600,
    });
    expect(historyLength()).toBe(before + 1);
  });

  /*
   * A second call is a second step, not a decline: `applyTypewriter` empties
   * the progress lane before it rewrites it, so the document really does
   * change. That is also what a second click of the panel's Typewriter button
   * does. Pinned so that the day somebody wants it to decline, this test is
   * the record of the current choice rather than a surprise.
   */
  it("replaces rather than stacks, and records a step for doing so", async () => {
    await run("apply_typewriter", { elementIds: ["title"], durationMs: 300 });

    const before = historyLength();
    const again = await run("apply_typewriter", {
      elementIds: ["title"],
      durationMs: 300,
    });

    expect(again.ok).toBe(true);
    expect(lane("title")).toHaveLength(2);
    expect(historyLength()).toBe(before + 1);
  });

  describe("refusing", () => {
    it("refuses a clip that carries no lettering, naming the type", async () => {
      await expect(
        run("apply_typewriter", { elementIds: ["clip"], durationMs: 300 }),
      ).rejects.toThrow(/Only text clips carry a reveal.*got video/);
    });

    // Also pins the `localTime` move into `context.ts`.
    it("refuses a time outside the clip", async () => {
      await expect(
        run("apply_typewriter", { elementIds: ["title"], atMs: 99_000 }),
      ).rejects.toThrow(/outside the clip/);
    });

    it("refuses an easing it does not know", async () => {
      await expect(
        run("apply_typewriter", { elementIds: ["title"], easing: "swoosh" }),
      ).rejects.toThrow(/is not an easing/);
    });

    it("refuses a length or a speed that is not positive", async () => {
      await expect(
        run("apply_typewriter", { elementIds: ["title"], durationMs: 0 }),
      ).rejects.toThrow(/`durationMs` must be greater than 0/);
      await expect(
        run("apply_typewriter", {
          elementIds: ["title"],
          unitsPerSecond: -1,
        }),
      ).rejects.toThrow(/`unitsPerSecond` must be greater than 0/);
    });

    it("refuses a time that is not a number, and an empty id list", async () => {
      await expect(
        run("apply_typewriter", { elementIds: ["title"], atMs: NaN }),
      ).rejects.toThrow(/`atMs` must be a finite number/);
      await expect(
        run("apply_typewriter", { elementIds: [] }),
      ).rejects.toThrow(/at least one id/);
    });

    it("leaves the document and the history alone when it throws", async () => {
      await run("apply_typewriter", { elementIds: ["title"], durationMs: 300 });

      const before = historyLength();
      const written = lane("title");
      await expect(
        run("apply_typewriter", { elementIds: ["title"], atMs: 99_000 }),
      ).rejects.toThrow();

      expect(historyLength()).toBe(before);
      expect(lane("title")).toEqual(written);
    });
  });

  // Compressed rather than started earlier: the anchor is the one thing an
  // anchor is for. Nothing else would tell the caller its number was not used.
  describe("typing that does not fit", () => {
    it("compresses to the clip and says so", async () => {
      const result = await run("apply_typewriter", {
        elementIds: ["title"],
        durationMs: 5000,
      });

      expect(result.ok).toBe(true);
      expect(result.warning).toMatch(/compressed/);
      // The clip runs 2000ms, so that is where the typing has to end.
      expect(lane("title")[1][0]).toBe(2000);
    });

    it("says nothing when it fits", async () => {
      const result = await run("apply_typewriter", {
        elementIds: ["title"],
        durationMs: 900,
      });
      expect(result.warning).toBeUndefined();
    });
  });
});

describe("set_text_reveal", () => {
  it("gives a clip a reveal, and seeds the track empty and switched off", async () => {
    const result = await run("set_text_reveal", {
      elementIds: ["title"],
      unit: "word",
    });

    expect(result.ok).toBe(true);
    expect(revealOf(doc().elements.title)).toEqual({
      unit: "word",
      progress: 100,
    });
    expect(track("title")).toBeDefined();
    expect(track("title").isActivate).toBe(false);
    expect(lane("title")).toEqual([]);
  });

  it("takes a unit, a progress and a fade in one undo step", async () => {
    await run("set_text_reveal", { elementIds: ["title"], unit: "character" });

    const before = historyLength();
    await run("set_text_reveal", {
      elementIds: ["title"],
      unit: "line",
      progress: 40,
      fade: 0.25,
    });

    expect(historyLength()).toBe(before + 1);
    expect(revealOf(doc().elements.title)).toEqual({
      unit: "line",
      progress: 40,
      fade: 0.25,
    });
  });

  // The optional-field rule: the default deletes the key rather than storing
  // it, so a project nobody softened saves byte-identically.
  it("deletes the fade key rather than storing a zero", async () => {
    await run("set_text_reveal", {
      elementIds: ["title"],
      unit: "word",
      fade: 0.5,
    });
    await run("set_text_reveal", { elementIds: ["title"], fade: 0 });

    const reveal = (doc().elements.title as any).reveal;
    expect("fade" in reveal).toBe(false);
  });

  it("carries the progress and the fade across a unit change", async () => {
    await run("set_text_reveal", {
      elementIds: ["title"],
      unit: "character",
      progress: 30,
      fade: 0.4,
    });
    await run("set_text_reveal", { elementIds: ["title"], unit: "line" });

    expect(revealOf(doc().elements.title)).toEqual({
      unit: "line",
      progress: 30,
      fade: 0.4,
    });
  });

  it("removes the reveal and its track together", async () => {
    await run("apply_typewriter", { elementIds: ["title"], durationMs: 300 });
    expect(track("title")).toBeDefined();

    const result = await run("set_text_reveal", {
      elementIds: ["title"],
      unit: null,
    });

    expect(result.ok).toBe(true);
    expect("reveal" in (doc().elements.title as any)).toBe(false);
    for (const property of TEXT_ANIMATABLE_PROPERTIES) {
      expect(
        property in ((doc().elements.title as any).animation ?? {}),
        property,
      ).toBe(false);
    }
  });

  it("applies across several clips in one step", async () => {
    await run("set_text_reveal", { elementIds: ["title"], unit: "word" });

    const before = historyLength();
    await run("set_text_reveal", {
      elementIds: ["title", "other"],
      unit: "line",
    });

    expect(historyLength()).toBe(before + 1);
    expect(revealOf(doc().elements.other)?.unit).toBe("line");
  });

  describe("declining, at no cost to the history", () => {
    it("declines the unit a clip already has", async () => {
      await run("set_text_reveal", { elementIds: ["title"], unit: "word" });

      const before = historyLength();
      const again = await run("set_text_reveal", {
        elementIds: ["title"],
        unit: "word",
      });

      expect(again.ok).toBe(false);
      expect(again.reason).toMatch(/already reveal/);
      expect(historyLength()).toBe(before);
    });

    it("declines removing a reveal that is not there", async () => {
      const result = await run("set_text_reveal", {
        elementIds: ["title"],
        unit: null,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no reveal to remove/);
    });

    /*
     * The three-way reason earning its keep. `setClipTextRevealFields` declines
     * on a clip with no reveal, and an agent told only "already" would retry
     * the identical call. This one names the two ways forward.
     */
    it("tells a caller with no reveal how to get one", async () => {
      const result = await run("set_text_reveal", {
        elementIds: ["title"],
        progress: 50,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no reveal to adjust/);
      expect(result.reason).toMatch(/apply_typewriter/);
    });
  });

  describe("refusing", () => {
    it("refuses a clip that carries no lettering", async () => {
      await expect(
        run("set_text_reveal", { elementIds: ["sound"], unit: "word" }),
      ).rejects.toThrow(/Only text clips carry a reveal.*got audio/);
    });

    it("refuses a unit it cannot count, naming the ones it can", async () => {
      await expect(
        run("set_text_reveal", { elementIds: ["title"], unit: "sentence" }),
      ).rejects.toThrow(/character, word, line/);
    });

    it("refuses a progress that is not a number", async () => {
      await expect(
        run("set_text_reveal", { elementIds: ["title"], progress: NaN }),
      ).rejects.toThrow(/`progress` must be a finite number/);
    });

    it("refuses a call that asks for nothing", async () => {
      await expect(
        run("set_text_reveal", { elementIds: ["title"] }),
      ).rejects.toThrow(/needs a `unit`, a `progress`, a `fade` or an `animate\*` field/);
    });
  });

  // Written, and overridden at every frame. Nothing else would say why the
  // number had no effect on screen.
  describe("a progress the curve overrides", () => {
    it("warns when the track is keyed and live", async () => {
      await run("apply_typewriter", { elementIds: ["title"], durationMs: 300 });

      const result = await run("set_text_reveal", {
        elementIds: ["title"],
        progress: 50,
      });

      expect(result.ok).toBe(true);
      expect(result.warning).toMatch(/keyframed/);
    });

    it("says nothing on a reveal with no curve", async () => {
      await run("set_text_reveal", { elementIds: ["title"], unit: "word" });

      const result = await run("set_text_reveal", {
        elementIds: ["title"],
        progress: 50,
      });

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });
});

/**
 * The defect this change exists to close.
 *
 * `revealProgress` has been in the MCP `ANIMATABLE` enum all along, so the
 * schema accepted it, and `animatableProperties` omits it until the clip has a
 * `reveal`. With nothing able to write that field, every call threw. The first
 * test is the regression; the rest prove the track is genuinely reachable once
 * a reveal exists, rather than merely no longer erroring.
 */
describe("the dead end, closed", () => {
  it("points a caller at the tool that fixes it", async () => {
    await expect(
      run("set_animation", {
        elementId: "title",
        property: "revealProgress",
        active: true,
      }),
    ).rejects.toThrow(/set_text_reveal/);
  });

  it("lets the animation tools reach the track once a reveal exists", async () => {
    await run("set_text_reveal", { elementIds: ["title"], unit: "word" });

    const activated = await run("set_animation", {
      elementId: "title",
      property: "revealProgress",
      active: true,
    });
    expect(activated.ok).toBe(true);

    const keyed = await run("add_keyframes", {
      elementId: "title",
      property: "revealProgress",
      keyframes: [
        { atMs: 6000, value: 0, easing: "linear" },
        { atMs: 7000, value: 100 },
      ],
    });
    expect(keyed.ok).toBe(true);

    // Absolute on the way out, the way they went in.
    const read = await run("get_keyframes", {
      elementId: "title",
      property: "revealProgress",
    });
    expect(read.active).toBe(true);
    expect(read.lanes.x.keyframes.map((k: any) => k.atMs)).toEqual([
      6000, 7000,
    ]);
  });
});

/**
 * The read side needed no change: `serialize.ts` has reported the reveal since
 * the feature landed. Pinned because it is a fail-closed whitelist, so a field
 * dropped from it would go quiet rather than fail.
 */
describe("what the agent reads back", () => {
  it("reports the reveal and its track through get_clip", async () => {
    await run("set_text_reveal", {
      elementIds: ["title"],
      unit: "line",
      fade: 0.5,
    });

    const detail = await run("get_clip", { elementId: "title" });
    expect(detail.reveal).toEqual({ unit: "line", progress: 100, fade: 0.5 });
    expect(
      detail.animation.some((t: any) => t.property === "revealProgress"),
    ).toBe(true);
  });
});
