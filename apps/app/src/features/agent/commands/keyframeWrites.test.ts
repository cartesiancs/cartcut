/**
 * The batch keyframe path.
 *
 * Two claims carry it, and both are invisible to every other suite:
 *
 * - **A batch across many clips and properties is one undo step.** That is the
 *   entire reason it exists; the same edit through `add_keyframes` costs one
 *   step per property per clip.
 * - **A batch with one bad entry writes nothing.** Half an edit is worse than
 *   none, because the caller cannot tell which half landed.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../../timeline/tracks";
import { imageElement, audioElement } from "../../renderer/testing";
import { getCommand } from "../registry";

import "./animation";
import "./meta";

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

/**
 * How many times Cmd+Z is needed to get back to where we started.
 *
 * Not the length of the history: `commit` calls `ensureUndoBaseline` first, so
 * the very first edit in a session adds two entries for one step. What the
 * user counts is undos, so that is what this counts.
 *
 * Baked samples are dropped from the snapshot — they are derived from the
 * authored lanes and run to tens of thousands of numbers.
 */
async function stepsToUndo(operation: () => Promise<unknown>) {
  const snapshot = () =>
    JSON.stringify(doc(), (key, value) =>
      key === "ax" || key === "ay" ? undefined : value,
    );

  const before = snapshot();
  await operation();

  for (let steps = 0; steps < 10; steps += 1) {
    if (snapshot() === before) {
      return steps;
    }
    await run("undo");
  }
  return 10;
}

/** The authored keyframes on one lane, as `[timeMs, value]` pairs. */
function lane(elementId: string, property: string, which: "x" | "y" = "x") {
  const list = (doc().elements[elementId] as any)?.animation?.[property]?.[which];
  return Array.isArray(list)
    ? list.map((keyframe: any) => [keyframe.p[0], keyframe.p[1]])
    : null;
}

function isActive(elementId: string, property: string) {
  return (doc().elements[elementId] as any)?.animation?.[property]?.isActivate;
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

describe("set_keyframes", () => {
  it("writes many clips and many properties in one undo step", async () => {
    const batch = {
      writes: [
        {
          elementId: "a",
          property: "opacity",
          keyframes: [
            { atMs: 0, value: 0, easing: "ease_out" },
            { atMs: 1000, value: 100 },
          ],
        },
        {
          elementId: "a",
          property: "scale",
          keyframes: [
            { atMs: 0, value: 12 },
            { atMs: 1000, value: 10 },
          ],
        },
        {
          elementId: "b",
          property: "opacity",
          keyframes: [
            { atMs: 4000, value: 0 },
            { atMs: 5000, value: 100 },
          ],
        },
      ],
    };

    // The same edit through `add_keyframes` is three calls and three steps.
    expect(await stepsToUndo(() => run("set_keyframes", batch))).toBe(1);

    // Undone by the line above, so write it again to assert on the result.
    await run("set_keyframes", batch);

    // Times are stored element-local, so `b`'s absolute 4000/5000 land at 0/1000.
    expect(lane("a", "opacity")).toEqual([
      [0, 0],
      [1000, 100],
    ]);
    expect(lane("a", "scale")).toEqual([
      [0, 12],
      [1000, 10],
    ]);
    expect(lane("b", "opacity")).toEqual([
      [0, 0],
      [1000, 100],
    ]);
  });

  it("activates each track it writes", async () => {
    expect(isActive("a", "opacity")).toBe(false);

    await run("set_keyframes", {
      writes: [
        {
          elementId: "a",
          property: "opacity",
          keyframes: [{ atMs: 0, value: 50 }],
        },
      ],
    });

    // Keyframes on an inactive track exist and drive nothing, which reads to a
    // caller as a silent failure.
    expect(isActive("a", "opacity")).toBe(true);
  });

  it("writes both lanes of a paired property", async () => {
    await run("set_keyframes", {
      writes: [
        {
          elementId: "a",
          property: "position",
          keyframes: [
            { atMs: 0, x: 0, y: 0 },
            { atMs: 2000, x: 300, y: 120 },
          ],
        },
      ],
    });

    expect(lane("a", "position", "x")).toEqual([
      [0, 0],
      [2000, 300],
    ]);
    expect(lane("a", "position", "y")).toEqual([
      [0, 0],
      [2000, 120],
    ]);
  });

  it("writes nothing when one entry names a time outside its clip", async () => {
    const before = historyLength();

    await expect(
      run("set_keyframes", {
        writes: [
          {
            elementId: "a",
            property: "opacity",
            keyframes: [{ atMs: 0, value: 0 }],
          },
          {
            // `b` runs 4000-8000, so this is outside it.
            elementId: "b",
            property: "opacity",
            keyframes: [{ atMs: 100, value: 0 }],
          },
        ],
      }),
    ).rejects.toThrow(/writes\[1\]/);

    expect(historyLength()).toBe(before);
    expect(lane("a", "opacity")).toEqual([]);
  });

  it("names the offending write when a property is not animatable there", async () => {
    await expect(
      run("set_keyframes", {
        writes: [
          {
            elementId: "a",
            property: "opacity",
            keyframes: [{ atMs: 0, value: 0 }],
          },
          {
            elementId: "sound",
            property: "scale",
            keyframes: [{ atMs: 0, value: 10 }],
          },
        ],
      }),
    ).rejects.toThrow(/writes\[1\].*cannot animate "scale"/s);
  });

  it("refuses an unknown easing rather than falling back to the default", async () => {
    // The whole point of the parameter is that the default is too soft, so a
    // silent fallback would give the caller the one thing it asked not to have.
    await expect(
      run("set_keyframes", {
        writes: [
          {
            elementId: "a",
            property: "opacity",
            keyframes: [
              { atMs: 0, value: 0, easing: "swoosh" },
              { atMs: 500, value: 100 },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/is not an easing/);
  });

  it("shapes the segment leaving a keyframe, not the one arriving", async () => {
    await run("set_keyframes", {
      writes: [
        {
          elementId: "a",
          property: "opacity",
          keyframes: [
            { atMs: 0, value: 0, easing: "snap" },
            { atMs: 1000, value: 100 },
          ],
        },
      ],
    });

    const list = (doc().elements.a as any).animation.opacity.x;
    // `snap` is cubic-bezier(0.16, 1, 0.3, 1), projected onto the segment: the
    // outgoing handle of the *first* keyframe and the incoming handle of the
    // second. `linear` would be a poor probe here — [0, 0, 1, 1] projects to
    // exactly the collapsed handles the default already has.
    expect(list[0].ce[0]).toBeCloseTo(160, 3);
    expect(list[0].ce[1]).toBeCloseTo(100, 3);
    expect(list[1].cs[0]).toBeCloseTo(300, 3);
  });

  it("stacks keys on a second run, and does not with `replace`", async () => {
    const write = (replace?: boolean) => ({
      writes: [
        {
          elementId: "a",
          property: "opacity",
          keyframes: [
            { atMs: 0, value: 0 },
            { atMs: 1000, value: 100 },
          ],
          ...(replace == null ? {} : { replace }),
        },
      ],
    });

    await run("set_keyframes", write());
    await run("set_keyframes", {
      writes: [
        {
          elementId: "a",
          property: "opacity",
          keyframes: [{ atMs: 500, value: 30 }],
        },
      ],
    });
    expect(lane("a", "opacity")).toHaveLength(3);

    await run("set_keyframes", write(true));
    // Emptied first, so the track holds exactly what this call asked for.
    expect(lane("a", "opacity")).toEqual([
      [0, 0],
      [1000, 100],
    ]);
  });

  it("declines a batch that changes nothing, at no cost in history", async () => {
    const write = {
      writes: [
        {
          elementId: "a",
          property: "opacity",
          keyframes: [{ atMs: 0, value: 40 }],
        },
      ],
    };

    await run("set_keyframes", write);
    const after = historyLength();

    const result = await run("set_keyframes", write);
    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(after);
  });

  it("refuses an empty batch", async () => {
    await expect(run("set_keyframes", { writes: [] })).rejects.toThrow(
      /at least one/,
    );
  });
});

describe("add_keyframes still behaves as it did", () => {
  it("writes one property and activates it", async () => {
    await run("add_keyframes", {
      elementId: "a",
      property: "rotation",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 2000, value: 90 },
      ],
    });

    expect(isActive("a", "rotation")).toBe(true);
    expect(lane("a", "rotation")).toEqual([
      [0, 0],
      [2000, 90],
    ]);
  });

  it("still refuses a time outside the clip", async () => {
    await expect(
      run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [{ atMs: 9000, value: 0 }],
      }),
    ).rejects.toThrow(/outside the clip/);
  });
});
