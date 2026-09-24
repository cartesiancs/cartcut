/**
 * The link commands, end to end.
 *
 * The scenario these are written against is the one that motivated the
 * feature: a card wheel where twelve cards' opacity and scale follow a turning
 * null. Through `add_keyframes` that is twenty-four calls, twenty-four undo
 * steps and several hundred keyframes computed outside the editor. The claim
 * here is that it is two calls, two steps, and nothing computed.
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

import "./read";
import "./clip";
import "./meta";
import "./animation";
import "./link";
import "./groups";

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

const CARDS = ["c0", "c1", "c2", "c3"];

/** The link every test below writes: full at centre, gone at either edge. */
const WHEEL = {
  property: "opacity",
  fromElementId: "spin",
  fromProperty: "rotation",
  in: [-90, 0, 90],
  out: [0, 100, 0],
};

beforeEach(() => {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  const elements: Record<string, any> = {
    spin: {
      ...imageElement({ trackId: "v1", startTime: 0, duration: 8000 }),
      filetype: "group",
      name: "wheel",
      rotation: 0,
    },
    sound: audioElement({ trackId: "a1", startTime: 0, duration: 8000 }),
  };
  for (const id of CARDS) {
    elements[id] = imageElement({ trackId: "v1", startTime: 0, duration: 8000 });
  }
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
      elements,
    }),
  );
});

describe("set_property_link", () => {
  it("links a row of clips with one phase each, in one undo step", async () => {
    const steps = await stepsToUndo(() =>
      run("set_property_link", {
        elementIds: CARDS,
        ...WHEEL,
        offsets: CARDS.map((_, index) => index * -45),
      }),
    );
    expect(steps).toBe(1);

    await run("set_property_link", {
      elementIds: CARDS,
      ...WHEEL,
      offsets: CARDS.map((_, index) => index * -45),
    });

    // One description, four phases.
    const offsets = CARDS.map(
      (id) => (doc().elements[id] as any).link.opacity.offset,
    );
    expect(offsets).toEqual([undefined, -45, -90, -135]);
  });

  it("reports what each clip ends up driven by", async () => {
    const result = await run("set_property_link", {
      elementIds: ["c0"],
      ...WHEEL,
    });
    expect(result.links[0]).toMatchObject({
      elementId: "c0",
      property: "opacity",
      link: { from: { elementId: "spin", property: "rotation" } },
    });
  });

  it("refuses a source that is not in the document", async () => {
    // A link to a clip that is not there resolves to nothing, which to the
    // caller looks exactly like the feature not working.
    await expect(
      run("set_property_link", {
        elementIds: ["c0"],
        ...WHEEL,
        fromElementId: "ghost",
      }),
    ).rejects.toThrow(/ghost/);
  });

  it("refuses stops that are not strictly ascending", async () => {
    await expect(
      run("set_property_link", { elementIds: ["c0"], ...WHEEL, in: [90, 0, -90] }),
    ).rejects.toThrow(/strictly ascending/);
  });

  it("refuses mismatched offsets", async () => {
    await expect(
      run("set_property_link", { elementIds: CARDS, ...WHEEL, offsets: [0, 10] }),
    ).rejects.toThrow(/One offset per clip/);
  });

  it("refuses a property a link cannot drive, and says why", async () => {
    await expect(
      run("set_property_link", { elementIds: ["c0"], ...WHEEL, property: "size" }),
    ).rejects.toThrow(/hit test and the grips/);
    await expect(
      run("set_property_link", {
        elementIds: ["c0"],
        ...WHEEL,
        property: "volumeDb",
      }),
    ).rejects.toThrow(/built by the exporter/);
  });

  it("refuses a clip that cannot carry a link", async () => {
    await expect(
      run("set_property_link", { elementIds: ["sound"], ...WHEEL }),
    ).rejects.toThrow(/can carry a link/);
  });

  it("refuses a cycle rather than storing one the renderer would ignore", async () => {
    await run("set_property_link", {
      elementIds: ["c0"],
      property: "opacity",
      fromElementId: "c1",
      fromProperty: "opacity",
      in: [0, 100],
      out: [0, 100],
    });

    await expect(
      run("set_property_link", {
        elementIds: ["c1"],
        property: "opacity",
        fromElementId: "c0",
        fromProperty: "opacity",
        in: [0, 100],
        out: [0, 100],
      }),
    ).rejects.toThrow(/close a cycle/);
  });

  it("declines a link already in force, at no cost in history", async () => {
    await run("set_property_link", { elementIds: ["c0"], ...WHEEL });
    const result = await run("set_property_link", { elementIds: ["c0"], ...WHEEL });
    expect(result.ok).toBe(false);
  });
});

describe("a driven property is read-only", () => {
  beforeEach(async () => {
    await run("set_property_link", { elementIds: ["c0"], ...WHEEL });
  });

  it("refuses keyframes on it, and says how to get them back", async () => {
    await expect(
      run("add_keyframes", {
        elementId: "c0",
        property: "opacity",
        keyframes: [{ atMs: 0, value: 50 }],
      }),
    ).rejects.toThrow(/driven by a link.*clear_property_link/s);
  });

  it("refuses an update_clip patch on it", async () => {
    await expect(
      run("update_clip", { elementId: "c0", patch: { opacity: 50 } }),
    ).rejects.toThrow(/driven by a link/);
  });

  it("still allows every other property", async () => {
    await expect(
      run("update_clip", { elementId: "c0", patch: { rotation: 30 } }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a position patch when position is what is driven", async () => {
    await run("set_property_link", {
      elementIds: ["c1"],
      ...WHEEL,
      property: "position",
    });
    // `location.x` is how a position is written, so the refusal has to know
    // that the two are the same property under different names.
    await expect(
      run("update_clip", { elementId: "c1", patch: { location: { x: 10 } } }),
    ).rejects.toThrow(/driven by a link on `position`/);
  });
});

describe("clear_property_link", () => {
  it("lets the property be keyframed again, with its old keyframes intact", async () => {
    await run("add_keyframes", {
      elementId: "c0",
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 1000, value: 100 },
      ],
    });
    await run("set_property_link", { elementIds: ["c0"], ...WHEEL });

    // Kept the whole time it was driven, which is what makes the link
    // reversible rather than destructive.
    expect((doc().elements.c0 as any).animation.opacity.x).toHaveLength(2);

    await run("clear_property_link", { elementIds: ["c0"], property: "opacity" });
    expect((doc().elements.c0 as any).link).toBeUndefined();
    await expect(
      run("add_keyframes", {
        elementId: "c0",
        property: "opacity",
        keyframes: [{ atMs: 500, value: 50 }],
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("removes every link when no property is named", async () => {
    await run("set_property_link", { elementIds: ["c0"], ...WHEEL });
    await run("set_property_link", {
      elementIds: ["c0"],
      ...WHEEL,
      property: "scale",
      out: [8, 12, 8],
    });

    const result = await run("clear_property_link", { elementIds: ["c0"] });
    expect(result.remaining[0].linked).toEqual([]);
    // The key is deleted rather than left as an empty object, so a project
    // linked and then unlinked saves byte-identically to one nobody touched.
    expect("link" in (doc().elements.c0 as any)).toBe(false);
  });

  it("declines when there is nothing to clear", async () => {
    const result = await run("clear_property_link", { elementIds: ["c0"] });
    expect(result.ok).toBe(false);
  });
});

describe("get_clip reports the link", () => {
  it("names what drives a property, and flags its keyframes as not driving", async () => {
    await run("add_keyframes", {
      elementId: "c0",
      property: "opacity",
      keyframes: [{ atMs: 0, value: 0 }],
    });
    await run("set_property_link", { elementIds: ["c0"], ...WHEEL, offsets: [-45] });

    const clip = await run("get_clip", { elementId: "c0" });
    expect(clip.links).toEqual([
      {
        property: "opacity",
        from: { elementId: "spin", property: "rotation" },
        in: [-90, 0, 90],
        out: [0, 100, 0],
        offset: -45,
      },
    ]);

    const track = clip.animation.find((one: any) => one.property === "opacity");
    expect(track.drivenByLink).toBe(true);
  });
});
