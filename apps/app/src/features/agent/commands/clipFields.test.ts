/**
 * Two things the batch keyframe work turned up, and neither is about batching.
 *
 * **`get_clip` and `get_keyframes` disagreed about when a keyframe is.** Times
 * are stored relative to the clip's start and every time in this surface is
 * absolute; one of the two reported the stored number raw, so on any clip that
 * did not start at zero they answered different times for the same keyframe.
 * The one that looked right was whichever the reader happened to check first.
 *
 * **`scale` was animatable and not writable.** It is in `ANIMATABLE`, so
 * `add_keyframes` would move it, and it was absent from `update_clip`'s
 * whitelist with no tool of its own, so there was no way to set one.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../../timeline/tracks";
import { audioElement, imageElement } from "../../renderer/testing";
import { getCommand } from "../registry";

import "./animation";
import "./clip";
import "./read";

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

beforeEach(() => {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
      elements: {
        a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        b: imageElement({ trackId: "v1", startTime: 4000, duration: 4000 }),
        sound: audioElement({ trackId: "a1", startTime: 0, duration: 4000 }),
      },
    }),
  );
});

describe("update_clip writes scale", () => {
  it("sets it, and deletes the key at neutral", async () => {
    await run("update_clip", { elementId: "a", patch: { scale: 14 } });
    expect((doc().elements.a as any).scale).toBe(14);

    // Back to neutral removes the field rather than storing a 10, so a project
    // scaled and then unscaled saves byte-identically to one nobody touched.
    await run("update_clip", { elementId: "a", patch: { scale: 10 } });
    expect("scale" in (doc().elements.a as any)).toBe(false);
  });

  it("refuses a negative scale, which would mirror rather than shrink", async () => {
    await expect(
      run("update_clip", { elementId: "a", patch: { scale: -2 } }),
    ).rejects.toThrow(/at least 0/);
  });

  it("is not offered on a clip that cannot carry one", async () => {
    await expect(
      run("update_clip", { elementId: "sound", patch: { scale: 12 } }),
    ).rejects.toThrow(/scale/);
  });
});

describe("the two readers agree about when a keyframe is", () => {
  it("reports the same absolute times from get_clip and get_keyframes", async () => {
    // Keyframes are stored relative to the clip's start and every time in this
    // surface is absolute. `get_clip` used to report the stored number raw, so
    // on any clip not starting at zero the two tools disagreed — and the one
    // that looked right was whichever the reader checked first.
    await run("set_keyframes", {
      writes: [
        {
          elementId: "b",
          property: "opacity",
          keyframes: [
            { atMs: 4000, value: 0 },
            { atMs: 6000, value: 100 },
          ],
        },
      ],
    });

    const clip = await run("get_clip", { elementId: "b" });
    const track = clip.animation.find((one: any) => one.property === "opacity");
    const keys = await run("get_keyframes", {
      elementId: "b",
      property: "opacity",
    });

    expect(track.lanes.x.times).toEqual([4000, 6000]);
    expect(keys.lanes.x.keyframes.map((one: any) => one.atMs)).toEqual(
      track.lanes.x.times,
    );
  });
});
