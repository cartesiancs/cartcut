/**
 * The command families added when the MCP surface grew past cut editing.
 *
 * The claim worth pinning hardest is the same one `commands.test.ts` pins for
 * cutting: **one instruction is one undo step, and a declined instruction costs
 * nothing at all.** That is the whole justification for routing agent edits
 * through `commit()` rather than letting them write the store, and it is
 * invisible to every other test in the repo.
 *
 * `add_media` takes its prober by injection so these run under the node
 * environment the rest of the suite uses — the DOM half lives in
 * `features/element/mediaProbe.ts` precisely so it can be left out here.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineStore } from "../../../states/timelineStore";
import {
  SCHEMA_VERSION,
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  paintOrder,
} from "../../timeline/tracks";
import { spanOf, speedOf } from "../../timeline/geometry";
import {
  videoElement,
  imageElement,
  textElement,
  audioElement,
  shapeElement,
  effectElement,
} from "../../renderer/testing";
import { getCommand } from "../registry";
import type { MediaProber } from "../../element/mediaProbe";

import "./read";
import "./edit";
import "./clip";
import "./text";
import "./meta";
import "./media";
import "./tracks";
import "./appearance";
import "./animation";
import "./groups";
import "./fx";
import "./plan";

/** Invoke a command the way the bridge does. */
async function run(name: string, params: any = {}) {
  const command = getCommand(name);
  if (command == null) {
    throw new Error(`no such command: ${name}`);
  }
  return (await command(params)) as any;
}

function seed(elements: Record<string, any>, tracks = [["v1", "video"]] as any) {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: tracks.map(([id, kind]: any, index: number) =>
        createTrack(id, kind, index),
      ),
      elements,
    }),
  );
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
 * The snapshot has to be content-sensitive, not just a list of ids: half these
 * commands change a property rather than adding or removing a clip, and an
 * id-only comparison would report every one of them as costing zero steps —
 * which is exactly the bug this test exists to catch.
 *
 * Baked keyframe samples are dropped from it. They are derived from the
 * authored lanes, they run to tens of thousands of numbers, and including them
 * would make this helper the slowest thing in the suite.
 */
async function stepsToUndo(operation: () => Promise<unknown>) {
  const snapshot = () =>
    JSON.stringify(doc(), (key, value) =>
      key === "ax" || key === "ay" ? undefined : value,
    );

  const before = snapshot();
  await operation();

  let steps = 0;
  while (steps < 10) {
    if (snapshot() === before) {
      return steps;
    }
    const result: any = await run("undo");
    if (!result.ok) {
      return Infinity;
    }
    steps++;
  }
  return Infinity;
}

function clip(over: any = {}) {
  return videoElement({
    trackId: "v1",
    startTime: 0,
    duration: 4_000,
    sourceDuration: 4_000,
    trim: { startTime: 0, endTime: 4_000 },
    speed: 1,
    ...over,
  });
}

/** A prober that answers instantly, so no DOM is needed. */
const fakeProber: MediaProber = {
  image: async () => ({ width: 800, height: 600 }),
  gif: async () => ({ width: 320, height: 240 }),
  video: async () => ({
    width: 1920,
    height: 1080,
    durationMs: 5_000,
    hasAudio: true,
  }),
  audio: async () => ({ durationMs: 3_000 }),
};

const failingProber: MediaProber = {
  image: async () => {
    throw new Error("unreadable");
  },
  gif: fakeProber.gif,
  video: fakeProber.video,
  audio: fakeProber.audio,
};

beforeEach(() => {
  useTimelineStore.getState().clearTimeline();
});

// ------------------------------------------------------------------- add_media

describe("add_media", () => {
  it("places a batch of files as one undo step", async () => {
    seed({});

    const steps = await stepsToUndo(() =>
      run("add_media", {
        items: [
          { path: "/a.mp4" },
          { path: "/b.mp4" },
          { path: "/c.png" },
          { path: "/d.mp3" },
          { path: "/e.gif" },
        ],
        startMs: 0,
        prober: fakeProber,
      }),
    );

    expect(steps).toBe(1);
  });

  it("lays a sequential run end to end", async () => {
    seed({});

    const result = await run("add_media", {
      items: [{ path: "/a.mp4" }, { path: "/b.mp4" }],
      startMs: 0,
      prober: fakeProber,
    });

    expect(result.ok).toBe(true);
    expect(result.created).toHaveLength(2);

    const spans = result.created
      .map((id: string) => spanOf(doc().elements[id]))
      .sort((a: any, b: any) => a.start - b.start);

    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(5_000);
    // The second begins where the first ended.
    expect(spans[1].start).toBe(5_000);
  });

  it("stacks everything at one time when sequential is off", async () => {
    seed({});

    const result = await run("add_media", {
      items: [{ path: "/a.mp4" }, { path: "/b.mp4" }],
      startMs: 1_000,
      sequential: false,
      prober: fakeProber,
    });

    for (const id of result.created) {
      expect(doc().elements[id].startTime).toBe(1_000);
    }
  });

  it("honours an item's own startMs", async () => {
    seed({});

    const result = await run("add_media", {
      items: [{ path: "/a.mp4", startMs: 8_000 }],
      prober: fakeProber,
    });

    expect(doc().elements[result.created[0]].startTime).toBe(8_000);
  });

  it("gives a still the duration asked for", async () => {
    seed({});

    const result = await run("add_media", {
      items: [{ path: "/a.png", durationMs: 2_500 }],
      startMs: 0,
      prober: fakeProber,
    });

    expect(doc().elements[result.created[0]].duration).toBe(2_500);
  });

  it("reports an unreadable file in `skipped` without losing the good ones", async () => {
    seed({});

    const result = await run("add_media", {
      items: [{ path: "/good.mp4" }, { path: "/bad.png" }],
      startMs: 0,
      prober: failingProber,
    });

    expect(result.ok).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe("/bad.png");
  });

  it("skips a file type the editor has no renderer for", async () => {
    seed({});

    const result = await run("add_media", {
      items: [{ path: "/notes.pdf" }],
      prober: fakeProber,
    });

    expect(result.ok).toBe(false);
    expect(result.skipped[0].reason).toMatch(/no renderer/);
  });

  it("declines without costing a history entry when nothing can be read", async () => {
    seed({ a: clip() });
    const before = historyLength();

    const result = await run("add_media", {
      items: [{ path: "/nope.pdf" }],
      prober: fakeProber,
    });

    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("refuses an empty batch", async () => {
    seed({});
    await expect(run("add_media", { items: [] })).rejects.toThrow(/at least one/);
  });
});

// ------------------------------------------------------------------ add_shape

describe("add_shape", () => {
  it("places a shape in one undo step", async () => {
    seed({});
    expect(await stepsToUndo(() => run("add_shape", { startMs: 0 }))).toBe(1);
  });

  it("takes a kind", async () => {
    seed({});
    const result = await run("add_shape", { kind: "triangle", startMs: 0 });

    expect(result.ok).toBe(true);
    expect((doc().elements[result.created[0]] as any).shape).toHaveLength(3);
  });

  it("refuses a polygon that cannot enclose anything", async () => {
    seed({});
    await expect(
      run("add_shape", { points: [[0, 0], [1, 1]], startMs: 0 }),
    ).rejects.toThrow(/three points/);
  });

  it("keeps the point list out of the response", async () => {
    seed({});
    const result = await run("add_shape", { kind: "ellipse", startMs: 0 });
    expect(JSON.stringify(result)).not.toMatch(/"shape":/);
  });
});

// --------------------------------------------------------------------- tracks

describe("track commands", () => {
  it("adds a track in one undo step", async () => {
    seed({ a: clip() });
    expect(await stepsToUndo(() => run("add_track", { kind: "video" }))).toBe(1);
  });

  it("refuses to remove a track that still holds clips, and says how many", async () => {
    seed({ a: clip(), b: clip({ startTime: 5_000 }) });
    const before = historyLength();

    const result = await run("remove_track", { trackId: "v1" });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/2 clips/);
    // A refusal costs the user nothing.
    expect(historyLength()).toBe(before);
    expect(doc().tracks).toHaveLength(1);
  });

  it("removes a track with its clips when told to", async () => {
    seed({ a: clip() });
    const result = await run("remove_track", {
      trackId: "v1",
      deleteClips: true,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toContain("a");
  });

  it("reorders tracks, which is how layer order changes", async () => {
    seed(
      { a: clip(), b: clip({ trackId: "v2" }) },
      [
        ["v1", "video"],
        ["v2", "video"],
      ],
    );

    // v1 is the top row, so `a` paints in front of `b`.
    const before = paintOrder(doc());
    expect(before.indexOf("a")).toBeGreaterThan(before.indexOf("b"));

    const result = await run("move_track", { trackId: "v1", toIndex: 1 });
    expect(result.ok).toBe(true);

    // Moving v1 to the bottom flips which one is in front.
    const after = paintOrder(doc());
    expect(after.indexOf("a")).toBeLessThan(after.indexOf("b"));
  });

  it("reports the track order back, since the diff is otherwise empty", async () => {
    seed(
      { a: clip(), b: clip({ trackId: "v2" }) },
      [
        ["v1", "video"],
        ["v2", "video"],
      ],
    );

    const result = await run("move_track", { trackId: "v1", toIndex: 1 });
    expect(result.tracks.order).toEqual(["v2", "v1"]);
  });

  it("names an unknown track rather than failing silently", async () => {
    seed({ a: clip() });
    await expect(run("move_track", { trackId: "nope", toIndex: 0 })).rejects.toThrow(
      /No track with id/,
    );
  });
});

// ----------------------------------------------------------- duplicate & speed

describe("duplicate_clips", () => {
  it("duplicates in one undo step", async () => {
    seed({ a: clip() });
    expect(
      await stepsToUndo(() => run("duplicate_clips", { elementIds: ["a"] })),
    ).toBe(1);
  });

  it("places the copy after the original by default", async () => {
    seed({ a: clip() });
    const result = await run("duplicate_clips", { elementIds: ["a"] });

    expect(result.ok).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(spanOf(doc().elements[result.created[0]]).start).toBe(4_000);
  });

  it("makes a run of copies in one step", async () => {
    seed({ a: clip() });
    const steps = await stepsToUndo(() =>
      run("duplicate_clips", { elementIds: ["a"], repeat: 3 }),
    );

    expect(steps).toBe(1);
  });

  it("keeps the shape of a multi-clip selection", async () => {
    seed({ a: clip(), b: clip({ startTime: 6_000 }) });
    const result = await run("duplicate_clips", {
      elementIds: ["a", "b"],
      toMs: 20_000,
    });

    const starts = result.created
      .map((id: string) => doc().elements[id].startTime)
      .sort((x: number, y: number) => x - y);

    // The 6000ms gap between them survives the move.
    expect(starts[1] - starts[0]).toBe(6_000);
  });
});

describe("set_clip_speed", () => {
  it("changes speed in one undo step", async () => {
    seed({ a: clip() });
    expect(
      await stepsToUndo(() =>
        run("set_clip_speed", { elementIds: ["a"], speed: 2 }),
      ),
    ).toBe(1);
  });

  it("halves the span at 2x", async () => {
    seed({ a: clip() });
    await run("set_clip_speed", { elementIds: ["a"], speed: 2 });

    expect(speedOf(doc().elements.a)).toBe(2);
    expect(spanOf(doc().elements.a).length).toBe(2_000);
  });

  it("refuses a clip type that has no playback rate", async () => {
    seed({ a: imageElement({ trackId: "v1" }) });
    await expect(
      run("set_clip_speed", { elementIds: ["a"], speed: 2 }),
    ).rejects.toThrow(/Only video and audio/);
  });

  /**
   * The guard is `isSpeedAdjustable`, which is `isDynamicElement` — and that
   * counts `mp4`/`mov`/`mp3` as dynamic. The open-coded `filetype !== "video"`
   * check this replaced turned those away *before* `setClipSpeed`, which would
   * have accepted them, so the command refused an edit the op could do.
   */
  it("accepts the legacy dynamic filetype aliases", async () => {
    seed({ a: clip({ filetype: "mp4" } as any) });
    const result = await run("set_clip_speed", { elementIds: ["a"], speed: 2 });

    expect(result.ok).toBe(true);
    expect(speedOf(doc().elements.a)).toBe(2);
  });

  it("refuses a speed outside the supported range", async () => {
    seed({ a: clip() });
    await expect(
      run("set_clip_speed", { elementIds: ["a"], speed: 100 }),
    ).rejects.toThrow(/between/);
  });

  it("declines without a history entry when the speed is unchanged", async () => {
    seed({ a: clip() });
    const before = historyLength();

    const result = await run("set_clip_speed", { elementIds: ["a"], speed: 1 });

    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });
});

// ------------------------------------------------------------------ appearance

describe("set_blend_mode", () => {
  function threeClips() {
    seed({
      a: clip(),
      b: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      c: textElement({ trackId: "v1", startTime: 1000, duration: 1000 }),
    });
  }

  it("applies one mode across video, image and text clips", async () => {
    threeClips();
    await run("set_blend_mode", {
      elementIds: ["a", "b", "c"],
      blend: "multiply",
    });

    expect((doc().elements.a as any).blend).toBe("multiply");
    expect((doc().elements.b as any).blend).toBe("multiply");
    expect((doc().elements.c as any).blend).toBe("multiply");
  });

  it("costs a single undo step for the whole batch", async () => {
    threeClips();

    const steps = await stepsToUndo(() =>
      run("set_blend_mode", { elementIds: ["a", "b", "c"], blend: "multiply" }),
    );

    expect(steps).toBe(1);
  });

  it("removes the field when set back to source-over", async () => {
    seed({ a: clip() });
    await run("set_blend_mode", { elementIds: ["a"], blend: "screen" });
    await run("set_blend_mode", { elementIds: ["a"], blend: "source-over" });

    expect("blend" in doc().elements.a).toBe(false);
  });

  it("records nothing when the clips already have that mode", async () => {
    seed({ a: clip() });
    await run("set_blend_mode", { elementIds: ["a"], blend: "screen" });

    const before = historyLength();
    const result = await run("set_blend_mode", {
      elementIds: ["a"],
      blend: "screen",
    });

    expect(historyLength()).toBe(before);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already/i);
  });

  it("does not mutate the element in place", async () => {
    seed({ a: clip() });
    const before = doc().elements.a;

    await run("set_blend_mode", { elementIds: ["a"], blend: "multiply" });

    expect("blend" in before).toBe(false);
  });

  it("rejects a mode the compositor does not know, and names the set", async () => {
    seed({ a: clip() });
    await expect(
      run("set_blend_mode", { elementIds: ["a"], blend: "vivid-light" }),
    ).rejects.toThrow(/Unknown blend mode.*multiply/s);
  });

  it("rejects a canvas operation that would erase what is beneath", async () => {
    seed({ a: clip() });
    await expect(
      run("set_blend_mode", { elementIds: ["a"], blend: "destination-out" }),
    ).rejects.toThrow(/Unknown blend mode/);
  });

  it("refuses a clip type that paints no layer", async () => {
    seed(
      {
        a: clip(),
        s: audioElement({ trackId: "a1", startTime: 0, duration: 1000 }),
      },
      [
        ["v1", "video"],
        ["a1", "audio"],
      ],
    );

    await expect(
      run("set_blend_mode", { elementIds: ["a", "s"], blend: "multiply" }),
    ).rejects.toThrow(/audio/);
  });

  it("writes nothing when one id in the batch is the wrong type", async () => {
    seed(
      {
        a: clip(),
        s: audioElement({ trackId: "a1", startTime: 0, duration: 1000 }),
      },
      [
        ["v1", "video"],
        ["a1", "audio"],
      ],
    );

    await expect(
      run("set_blend_mode", { elementIds: ["a", "s"], blend: "multiply" }),
    ).rejects.toThrow();
    // The whole call is refused, not applied to the half that could take it.
    expect("blend" in doc().elements.a).toBe(false);
  });

  it("needs at least one id", async () => {
    seed({ a: clip() });
    await expect(
      run("set_blend_mode", { elementIds: [], blend: "multiply" }),
    ).rejects.toThrow(/at least one id/);
  });

  it("undo restores the previous mode rather than clearing it", async () => {
    seed({ a: clip() });
    await run("set_blend_mode", { elementIds: ["a"], blend: "screen" });
    await run("set_blend_mode", { elementIds: ["a"], blend: "multiply" });
    await run("undo");

    expect((doc().elements.a as any).blend).toBe("screen");
  });
});

describe("set_video_filters", () => {
  it("applies a chromakey in one undo step, structured", async () => {
    seed({ a: clip() });

    const steps = await stepsToUndo(() =>
      run("set_video_filters", {
        elementIds: ["a"],
        filter: { name: "chromakey", color: "#00ff00", threshold: 0.4 },
      }),
    );

    expect(steps).toBe(1);
  });

  it("writes the encoded value the shaders read", async () => {
    seed({ a: clip() });
    await run("set_video_filters", {
      elementIds: ["a"],
      filter: { name: "chromakey", color: "#00ff00", threshold: 0.4 },
    });

    const filter = (doc().elements.a as any).filter;
    expect(filter.enable).toBe(true);
    expect(filter.list).toEqual([
      { name: "chromakey", value: "r=0:g=255:b=0:f=0.4" },
    ]);
  });

  it("does not mutate the element in place", async () => {
    seed({ a: clip() });
    const before = doc().elements.a;

    await run("set_video_filters", {
      elementIds: ["a"],
      filter: { name: "blur", strength: 5 },
    });

    // The UI's own handlers mutate `filter.list[i]` on the live object, which
    // reaches back into every history entry sharing it. This must not.
    expect((before as any).filter.enable).toBe(false);
    expect((before as any).filter.list).toEqual([]);
  });

  it("clears with a null filter", async () => {
    seed({ a: clip() });
    await run("set_video_filters", {
      elementIds: ["a"],
      filter: { name: "blur", strength: 5 },
    });
    await run("set_video_filters", { elementIds: ["a"], filter: null });

    expect((doc().elements.a as any).filter).toEqual({ enable: false, list: [] });
  });

  it("refuses a bad colour before writing anything", async () => {
    seed({ a: clip() });
    const before = doc().elements.a;

    await expect(
      run("set_video_filters", {
        elementIds: ["a"],
        filter: { name: "chromakey", color: "green" },
      }),
    ).rejects.toThrow(/not a hex colour/);

    expect(doc().elements.a).toBe(before);
  });

  it("refuses a non-video clip", async () => {
    seed({ a: textElement({ trackId: "t1" }) }, [["t1", "text"]]);
    await expect(
      run("set_video_filters", { elementIds: ["a"], filter: { name: "blur" } }),
    ).rejects.toThrow(/Only video clips/);
  });
});

describe("set_text_font", () => {
  it("writes path, name and type together in one step", async () => {
    seed({ a: textElement({ trackId: "t1" }) }, [["t1", "text"]]);

    const result = await run("set_text_font", {
      elementIds: ["a"],
      fontPath: "/Library/Fonts/Helvetica.ttf",
    });

    expect(result.ok).toBe(true);
    const element = doc().elements.a as any;
    expect(element.fontpath).toBe("/Library/Fonts/Helvetica.ttf");
    expect(element.fontname).toBe("Helvetica");
    expect(element.fonttype).toBe("ttf");
  });

  it("refuses a non-text clip", async () => {
    seed({ a: clip() });
    await expect(
      run("set_text_font", { elementIds: ["a"], fontPath: "default" }),
    ).rejects.toThrow(/Only text clips/);
  });
});

// ------------------------------------------------------------------- animation

describe("animation commands", () => {
  it("applies a preset in one undo step", async () => {
    seed({ a: clip() });
    expect(
      await stepsToUndo(() =>
        run("apply_animation_preset", { elementIds: ["a"], preset: "fade_in" }),
      ),
    ).toBe(1);
  });

  it("takes absolute timeline times and stores them element-local", async () => {
    // The clip starts at 10s, so an absolute 10.5s keyframe is stored at 500.
    seed({ a: clip({ startTime: 10_000 }) });

    await run("add_keyframes", {
      elementId: "a",
      property: "opacity",
      keyframes: [{ atMs: 10_500, value: 50 }],
    });

    const lane = (doc().elements.a as any).animation.opacity.x;
    expect(lane.some((k: any) => Math.abs(k.p[0] - 500) < 2)).toBe(true);
  });

  it("hands times back absolute again through get_keyframes", async () => {
    seed({ a: clip({ startTime: 10_000 }) });
    await run("add_keyframes", {
      elementId: "a",
      property: "opacity",
      keyframes: [{ atMs: 10_500, value: 50 }],
    });

    const result = await run("get_keyframes", {
      elementId: "a",
      property: "opacity",
    });

    const times = result.lanes.x.keyframes.map((k: any) => k.atMs);
    expect(times).toContain(10_500);
  });

  it("refuses a keyframe outside the clip rather than clamping it", async () => {
    seed({ a: clip({ startTime: 10_000 }) });

    await expect(
      run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [{ atMs: 99_000, value: 50 }],
      }),
    ).rejects.toThrow(/outside the clip/);
  });

  it("writes a whole batch of keyframes as one undo step", async () => {
    seed({ a: clip() });

    const steps = await stepsToUndo(() =>
      run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [
          { atMs: 0, value: 0 },
          { atMs: 1_000, value: 100 },
          { atMs: 2_000, value: 50 },
          { atMs: 3_000, value: 100 },
        ],
      }),
    );

    expect(steps).toBe(1);
  });

  it("activates the track, so the keyframes actually drive the property", async () => {
    seed({ a: clip() });
    await run("add_keyframes", {
      elementId: "a",
      property: "opacity",
      keyframes: [{ atMs: 0, value: 0 }],
    });

    expect((doc().elements.a as any).animation.opacity.isActivate).toBe(true);
  });

  describe("presets", () => {
    it("uses the preset's own length when none is given", async () => {
      // A punch is 180ms and a drift is 4s. There is no shared default that is
      // right for both, so an omitted duration means "the intended one".
      seed({ a: clip({ duration: 10_000, trim: { startTime: 0, endTime: 10_000 } }) });

      await run("apply_animation_preset", {
        elementIds: ["a"],
        preset: "punch_in",
      });
      const punch = (doc().elements.a as any).animation.scale.x;
      expect(punch[punch.length - 1].p[0]).toBe(180);

      await run("apply_animation_preset", { elementIds: ["a"], preset: "drift" });
      const drift = (doc().elements.a as any).animation.scale.x;
      expect(drift[drift.length - 1].p[0]).toBe(4_000);
    });

    it("counter-animates position when a focus is given", async () => {
      seed({ a: clip({ width: 1920, height: 1080, location: { x: 0, y: 0 } }) });

      await run("apply_animation_preset", {
        elementIds: ["a"],
        preset: "punch_in",
        focus: { x: 100, y: 50 },
      });

      const xs = (doc().elements.a as any).animation.position.x.map(
        (k: any) => k.p[1],
      );
      // Zooming towards the right edge pushes the picture left as it grows.
      expect(xs[0]).toBe(0);
      expect(xs[1]).toBeLessThan(0);
    });

    it("says so rather than silently ignoring a focus it cannot use", async () => {
      seed({ a: clip() });
      await expect(
        run("apply_animation_preset", {
          elementIds: ["a"],
          preset: "shake",
          focus: { x: 10, y: 10 },
        }),
      ).rejects.toThrow(/does not take a focus/);
    });

    it("is one undo step even when the preset drives two properties", async () => {
      seed({ a: clip() });
      const steps = await stepsToUndo(() =>
        run("apply_animation_preset", { elementIds: ["a"], preset: "pop" }),
      );
      expect(steps).toBe(1);
    });

    it("is one undo step across several clips", async () => {
      seed({
        a: clip({ startTime: 0, duration: 2_000 }),
        b: clip({ startTime: 3_000, duration: 2_000 }),
      });
      const steps = await stepsToUndo(() =>
        run("apply_animation_preset", {
          elementIds: ["a", "b"],
          preset: "slam",
        }),
      );
      expect(steps).toBe(1);
    });

    it("declines by identity for a clip that cannot animate scale", async () => {
      // An effect animates opacity and nothing else, so `punch_in` has nothing
      // to drive and must cost no undo step at all. This used to be asserted of
      // a shape, which now animates all four properties.
      seed({ s: effectElement({ trackId: "v1" }) });
      const before = historyLength();

      const result = await run("apply_animation_preset", {
        elementIds: ["s"],
        preset: "punch_in",
      });

      expect(result.ok).toBe(false);
      expect(historyLength()).toBe(before);
    });

    it("drives a shape's scale, now that its type carries the track", async () => {
      seed({ s: shapeElement({ trackId: "v1" }) });

      const result = await run("apply_animation_preset", {
        elementIds: ["s"],
        preset: "punch_in",
      });

      expect(result.ok).toBe(true);
      expect((doc().elements.s as any).animation.scale.isActivate).toBe(true);
    });
  });

  describe("easing", () => {
    const lane = (property: string, which = "x") =>
      (doc().elements.a as any).animation[property][which];

    it("leaves the default soft handles alone when none is asked for", async () => {
      seed({ a: clip() });
      await run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [
          { atMs: 0, value: 0 },
          { atMs: 1_000, value: 100 },
        ],
      });

      // The default handle sits at the anchor's own value, which is what makes
      // the curve leave and arrive at zero velocity.
      expect(lane("opacity")[0].ce[1]).toBe(0);
    });

    it("shapes the segment leaving the keyframe it is written on", async () => {
      seed({ a: clip() });
      await run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1_000, value: 100 },
        ],
      });

      const list = lane("opacity");
      // Linear puts both control points on the straight line between anchors.
      expect(list[0].ce).toEqual([0, 0]);
      expect(list[1].cs).toEqual([1_000, 100]);
    });

    it("carries overshoot past the target value", async () => {
      seed({ a: clip() });
      await run("add_keyframes", {
        elementId: "a",
        property: "scale",
        keyframes: [
          { atMs: 0, value: 10, easing: "overshoot" },
          { atMs: 500, value: 14 },
        ],
      });

      // 10 -> 14 with y1 = 1.56 puts the handle past 14.
      expect(lane("scale")[0].ce[1]).toBeGreaterThan(14);
    });

    it("carries anticipation below the starting value", async () => {
      seed({ a: clip() });
      await run("add_keyframes", {
        elementId: "a",
        property: "scale",
        keyframes: [
          { atMs: 0, value: 10, easing: "anticipate" },
          { atMs: 500, value: 14 },
        ],
      });

      expect(lane("scale")[0].ce[1]).toBeLessThan(10);
    });

    it("takes raw control points", async () => {
      seed({ a: clip() });
      await run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [
          { atMs: 0, value: 0, easing: [0.25, 0.5, 0.75, 0.5] },
          { atMs: 1_000, value: 100 },
        ],
      });

      const list = lane("opacity");
      expect(list[0].ce).toEqual([250, 50]);
      expect(list[1].cs).toEqual([750, 50]);
    });

    it("puts the same curve on both lanes of a position move", async () => {
      // One easing describes how the move feels; different shapes per axis
      // would bend the path the clip travels.
      seed({ a: clip() });
      await run("add_keyframes", {
        elementId: "a",
        property: "position",
        keyframes: [
          { atMs: 0, x: 0, y: 0, easing: "linear" },
          { atMs: 1_000, x: 100, y: 200 },
        ],
      });

      expect(lane("position", "x")[0].ce).toEqual([0, 0]);
      expect(lane("position", "y")[0].ce).toEqual([0, 0]);
    });

    it("ignores an easing on the last keyframe rather than erroring", async () => {
      // There is no segment after it. A caller applying one curve to a whole
      // list should not have to special-case the end.
      seed({ a: clip() });
      await expect(
        run("add_keyframes", {
          elementId: "a",
          property: "opacity",
          keyframes: [
            { atMs: 0, value: 0 },
            { atMs: 1_000, value: 100, easing: "snap" },
          ],
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it("refuses an easing it does not know instead of quietly softening", async () => {
      seed({ a: clip() });
      await expect(
        run("add_keyframes", {
          elementId: "a",
          property: "opacity",
          keyframes: [{ atMs: 0, value: 0, easing: "bounce" }],
        }),
      ).rejects.toThrow(/is not an easing/);
    });

    it("reads back handles in the same time base as their anchors", async () => {
      // The anchor was rebased onto the timeline and the handles were not, so a
      // clip starting at 5s reported a keyframe at 5200ms whose control point
      // sat at 200ms — a handle apparently before the clip began.
      seed({ a: clip({ startTime: 5_000 }) });
      await run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [
          { atMs: 5_000, value: 0, easing: "linear" },
          { atMs: 6_000, value: 100 },
        ],
      });

      const read = await run("get_keyframes", {
        elementId: "a",
        property: "opacity",
      });
      const [first, second] = read.lanes.x.keyframes;

      expect(first.atMs).toBe(5_000);
      expect(first.ce[0]).toBe(5_000);
      expect(second.cs[0]).toBe(6_000);
    });

    it("stays one undo step with easing applied", async () => {
      seed({ a: clip() });
      const steps = await stepsToUndo(() =>
        run("add_keyframes", {
          elementId: "a",
          property: "scale",
          keyframes: [
            { atMs: 0, value: 10, easing: "snap" },
            { atMs: 300, value: 13, easing: "ease_out" },
            { atMs: 800, value: 10 },
          ],
        }),
      );

      expect(steps).toBe(1);
    });
  });

  it("needs both lanes for position", async () => {
    seed({ a: clip() });
    await expect(
      run("add_keyframes", {
        elementId: "a",
        property: "position",
        keyframes: [{ atMs: 0, value: 5 }],
      }),
    ).rejects.toThrow(/both `x` and `y`/);
  });

  it("writes both lanes at the same instant for position", async () => {
    seed({ a: clip() });
    await run("add_keyframes", {
      elementId: "a",
      property: "position",
      keyframes: [{ atMs: 0, x: 10, y: 20 }],
    });

    const track = (doc().elements.a as any).animation.position;
    expect(track.x).toHaveLength(track.y.length);
    expect(track.x[0].p[0]).toBe(track.y[0].p[0]);
  });

  it("mentions the tenths convention when scale is given a bad value", async () => {
    seed({ a: clip() });
    await expect(
      run("add_keyframes", {
        elementId: "a",
        property: "scale",
        keyframes: [{ atMs: 0 }],
      }),
    ).rejects.toThrow(/tenths/);
  });

  it("says what a clip can animate when asked for something it cannot", async () => {
    seed({ a: audioElement({ trackId: "a1" }) }, [["a1", "audio"]]);
    await expect(
      run("add_keyframes", {
        elementId: "a",
        property: "opacity",
        keyframes: [{ atMs: 0, value: 1 }],
      }),
    ).rejects.toThrow(/carries no animation/);
  });

  it("removes keyframes by time", async () => {
    seed({ a: clip() });
    await run("add_keyframes", {
      elementId: "a",
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 1_000, value: 100 },
      ],
    });

    const result = await run("remove_keyframes", {
      elementId: "a",
      property: "opacity",
      atMs: [1_000],
    });

    expect(result.ok).toBe(true);
    const lane = (doc().elements.a as any).animation.opacity.x;
    expect(lane.some((k: any) => Math.abs(k.p[0] - 1_000) < 2)).toBe(false);
  });

  it("declines without a history entry when there is no keyframe there", async () => {
    seed({ a: clip() });
    const before = historyLength();

    const result = await run("remove_keyframes", {
      elementId: "a",
      property: "opacity",
      atMs: [1_234],
    });

    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("never returns baked samples", async () => {
    seed({ a: clip() });
    await run("add_keyframes", {
      elementId: "a",
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 3_000, value: 100 },
      ],
    });

    const result = await run("get_keyframes", {
      elementId: "a",
      property: "opacity",
    });

    expect(JSON.stringify(result)).not.toMatch(/"ax"|"ay"/);
    // A 3s bake at 60Hz is ~180 samples; the response must be far smaller.
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------- groups

describe("group commands", () => {
  it("groups clips in one undo step", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });

    const steps = await stepsToUndo(() =>
      run("group_clips", { elementIds: ["a", "b"] }),
    );

    expect(steps).toBe(1);
  });

  it("returns the new group's id", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    const result = await run("group_clips", { elementIds: ["a", "b"] });

    expect(result.ok).toBe(true);
    expect(doc().elements[result.groupId].filetype).toBe("group");
    expect(doc().elements.a.parentId).toBe(result.groupId);
  });

  it("refuses audio, and says why", async () => {
    seed(
      { a: clip(), b: audioElement({ trackId: "a1" }) },
      [
        ["v1", "video"],
        ["a1", "audio"],
      ],
    );

    await expect(run("group_clips", { elementIds: ["a", "b"] })).rejects.toThrow(
      /Audio clips cannot be grouped/,
    );
  });

  it("needs at least two clips", async () => {
    seed({ a: clip() });
    await expect(run("group_clips", { elementIds: ["a"] })).rejects.toThrow(
      /at least two/,
    );
  });

  it("refuses to ungroup an animated group without force, costing no history", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    const grouped = await run("group_clips", { elementIds: ["a", "b"] });

    await run("add_keyframes", {
      elementId: grouped.groupId,
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 1_000, value: 100 },
      ],
    });

    const before = historyLength();
    const result = await run("ungroup", { groupIds: [grouped.groupId] });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/animated/);
    expect(result.lossy).toEqual([grouped.groupId]);
    expect(historyLength()).toBe(before);
  });

  it("ungroups an animated group when forced", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    const grouped = await run("group_clips", { elementIds: ["a", "b"] });

    await run("add_keyframes", {
      elementId: grouped.groupId,
      property: "opacity",
      keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 1_000, value: 100 },
      ],
    });

    const result = await run("ungroup", {
      groupIds: [grouped.groupId],
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(doc().elements[grouped.groupId]).toBeUndefined();
    expect(doc().elements.a.parentId ?? null).toBeNull();
  });

  it("ungroups a plain group without needing force", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    const grouped = await run("group_clips", { elementIds: ["a", "b"] });

    const result = await run("ungroup", { groupIds: [grouped.groupId] });
    expect(result.ok).toBe(true);
  });

  it("says so when asked to ungroup something that is not a group", async () => {
    seed({ a: clip() });
    await expect(run("ungroup", { groupIds: ["a"] })).rejects.toThrow(
      /not a group/,
    );
  });

  it("refuses a parent that is not a group", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    await expect(
      run("set_clip_parent", { elementIds: ["a"], parentId: "b" }),
    ).rejects.toThrow(/not a group/);
  });
});

// --------------------------------------------------------------- serialization

describe("responses stay small", () => {
  it("reports a clip's parent so group membership is discoverable", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    const grouped = await run("group_clips", { elementIds: ["a", "b"] });

    const list = await run("list_clips", {});
    const row = list.clips.find((c: any) => c.id === "a");

    expect(row.parentId).toBe(grouped.groupId);
  });

  it("can filter for groups, which list_clips could not before", async () => {
    seed({ a: clip(), b: imageElement({ trackId: "v1", startTime: 5_000 }) });
    await run("group_clips", { elementIds: ["a", "b"] });

    const list = await run("list_clips", { filetype: "group" });
    expect(list.clips).toHaveLength(1);
  });

  it("caps the keyframe times get_clip lists, and says it did", async () => {
    seed({ a: clip() });

    // One keyframe every 20ms across a 4s clip: 200 of them, past the cap.
    const keyframes = [];
    for (let at = 0; at < 4_000; at += 20) {
      keyframes.push({ atMs: at, value: at % 100 });
    }
    await run("add_keyframes", {
      elementId: "a",
      property: "opacity",
      keyframes,
    });

    const detail = await run("get_clip", { elementId: "a" });
    const opacity = detail.animation.find((a: any) => a.property === "opacity");

    expect(opacity.lanes.x.count).toBeGreaterThan(100);
    expect(opacity.lanes.x.times).toHaveLength(100);
    expect(opacity.lanes.x.truncated).toBe(true);
  });

  it("keeps get_clip small even for a heavily animated clip", async () => {
    seed({ a: clip() });

    const keyframes = [];
    for (let at = 0; at < 4_000; at += 20) {
      keyframes.push({ atMs: at, value: at % 100 });
    }
    await run("add_keyframes", { elementId: "a", property: "opacity", keyframes });

    const detail = await run("get_clip", { elementId: "a" });
    // Well under the 10k-token warning line. Without the cap the baked lane
    // alone would run to tens of thousands of values.
    expect(JSON.stringify(detail).length).toBeLessThan(4_000);
  });

  it("describes a filter structurally rather than as an encoded string", async () => {
    seed({ a: clip() });
    await run("set_video_filters", {
      elementIds: ["a"],
      filter: { name: "chromakey", color: "#00ff00", threshold: 0.4 },
    });

    const detail = await run("get_clip", { elementId: "a" });
    expect(detail.filters).toEqual([
      { name: "chromakey", color: "#00ff00", threshold: 0.4 },
    ]);
  });
});

/**
 * Transitions and effects.
 *
 * Both were complete in the renderer and unreachable from here. What these pin
 * is the seam: that the thin command layer declines the way everything else
 * does, and that a transition's odd addressing — by its two clips, not by a
 * time — is what actually reaches the ops.
 */
describe("transitions", () => {
  /** Two clips meeting at 2000ms, each with handles either side of the trim. */
  function adjacent() {
    return {
      a: clip({
        startTime: 0,
        duration: 2_000,
        sourceDuration: 10_000,
        trim: { startTime: 2_000, endTime: 4_000 },
      }),
      b: clip({
        startTime: 2_000,
        duration: 2_000,
        sourceDuration: 10_000,
        trim: { startTime: 2_000, endTime: 4_000 },
      }),
    };
  }

  it("finds the cut between two adjacent clips", async () => {
    seed(adjacent());
    const result = await run("list_cuts", {});

    expect(result.count).toBe(1);
    expect(result.cuts[0]).toMatchObject({
      fromId: "a",
      toId: "b",
      atMs: 2_000,
      transitionId: null,
    });
    // The handles either side of the trim are what set the ceiling.
    expect(result.cuts[0].maxDurationMs).toBeGreaterThan(0);
  });

  it("reports no cut between clips that do not meet", async () => {
    seed({
      a: clip({ startTime: 0, duration: 1_000 }),
      b: clip({ startTime: 5_000, duration: 1_000 }),
    });
    expect((await run("list_cuts", {})).count).toBe(0);
  });

  it("places one on the cut in a single undo step", async () => {
    seed(adjacent());
    const steps = await stepsToUndo(() =>
      run("add_transition", {
        fromId: "a",
        toId: "b",
        presetId: "com.cartcut.cross-dissolve",
        durationMs: 400,
      }),
    );
    expect(steps).toBe(1);
  });

  it("neither moves nor trims the clips it sits between", async () => {
    // The frames it needs are already in the files, outside each trim. A
    // transition that had to shorten its neighbours would change the edit.
    seed(adjacent());
    const before = JSON.stringify([spanOf(doc().elements.a), spanOf(doc().elements.b)]);

    await run("add_transition", {
      fromId: "a",
      toId: "b",
      presetId: "com.cartcut.cross-dissolve",
    });

    expect(
      JSON.stringify([spanOf(doc().elements.a), spanOf(doc().elements.b)]),
    ).toBe(before);
  });

  it("refuses a second transition on the same cut, and says which is there", async () => {
    seed(adjacent());
    await run("add_transition", {
      fromId: "a",
      toId: "b",
      presetId: "com.cartcut.cross-dissolve",
    });

    await expect(
      run("add_transition", {
        fromId: "a",
        toId: "b",
        presetId: "com.cartcut.whip-pan",
      }),
    ).rejects.toThrow(/already has a transition/);
  });

  it("declines without a history entry when the clips are not adjacent", async () => {
    seed({
      a: clip({ startTime: 0, duration: 1_000 }),
      b: clip({ startTime: 5_000, duration: 1_000 }),
    });
    const before = historyLength();

    const result = await run("add_transition", {
      fromId: "a",
      toId: "b",
      presetId: "com.cartcut.cross-dissolve",
    });

    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("refuses to treat an ordinary clip as a transition", async () => {
    seed(adjacent());
    await expect(run("set_transition", { elementId: "a" })).rejects.toThrow(
      /not a transition/,
    );
    await expect(run("get_fx", { elementId: "a" })).rejects.toThrow(/get_clip/);
  });

  it("reads one back with the window it actually occupies", async () => {
    seed(adjacent());
    const added = await run("add_transition", {
      fromId: "a",
      toId: "b",
      presetId: "com.cartcut.cross-dissolve",
      durationMs: 400,
      alignment: "center",
    });

    const detail = await run("get_fx", { elementId: added.created[0] });
    expect(detail).toMatchObject({
      type: "transition",
      presetId: "com.cartcut.cross-dissolve",
      fromId: "a",
      toId: "b",
      alignment: "center",
    });
    // Centred on the cut at 2000ms.
    expect(detail.startMs).toBeLessThan(2_000);
    expect(detail.endMs).toBeGreaterThan(2_000);
  });

  it("leaves the clips alone when it is removed", async () => {
    seed(adjacent());
    const added = await run("add_transition", {
      fromId: "a",
      toId: "b",
      presetId: "com.cartcut.cross-dissolve",
    });
    const spans = JSON.stringify([
      spanOf(doc().elements.a),
      spanOf(doc().elements.b),
    ]);

    await run("remove_transition", { elementId: added.created[0] });

    expect(doc().elements[added.created[0]]).toBeUndefined();
    expect(
      JSON.stringify([spanOf(doc().elements.a), spanOf(doc().elements.b)]),
    ).toBe(spans);
  });

  it("lists a transition with the preset that identifies it", async () => {
    seed(adjacent());
    await run("add_transition", {
      fromId: "a",
      toId: "b",
      presetId: "com.cartcut.whip-pan",
    });

    const rows = await run("list_clips", { filetype: "transition" });
    // Before, this came back as a clip with no content at all.
    expect(rows.clips[0]).toMatchObject({
      type: "transition",
      presetId: "com.cartcut.whip-pan",
      fromId: "a",
      toId: "b",
    });
  });
});

describe("effects", () => {
  it("makes the first effect track at the very top", async () => {
    // An effect applies to what is painted beneath it, so one at the bottom of
    // the stack would composite under every clip and touch nothing.
    seed({ a: clip() });

    const result = await run("add_effect", {
      presetId: "com.cartcut.film-grain",
      startMs: 0,
      durationMs: 2_000,
    });

    expect(result.ok).toBe(true);
    const element = doc().elements[result.created[0]] as any;
    const track = doc().tracks.find((t) => t.id === element.trackId);
    expect(track?.kind).toBe("effect");
    expect(track?.index).toBe(0);
  });

  it("is one undo step, track and all", async () => {
    seed({ a: clip() });
    const steps = await stepsToUndo(() =>
      run("add_effect", {
        presetId: "com.cartcut.film-grain",
        startMs: 0,
        durationMs: 2_000,
      }),
    );
    expect(steps).toBe(1);
  });

  it("carries its intensity and reads back", async () => {
    seed({ a: clip() });
    const added = await run("add_effect", {
      presetId: "com.cartcut.vignette",
      startMs: 0,
      durationMs: 1_000,
      intensity: 40,
    });

    const detail = await run("get_fx", { elementId: added.created[0] });
    expect(detail).toMatchObject({
      type: "effect",
      presetId: "com.cartcut.vignette",
      intensity: 40,
    });
  });

  it("changes intensity in place", async () => {
    seed({ a: clip() });
    const added = await run("add_effect", {
      presetId: "com.cartcut.vignette",
      startMs: 0,
      durationMs: 1_000,
      intensity: 40,
    });

    await run("set_effect", { elementId: added.created[0], intensity: 90 });
    expect((await run("get_fx", { elementId: added.created[0] })).intensity).toBe(
      90,
    );
  });

  it("declines a change that changes nothing", async () => {
    seed({ a: clip() });
    const added = await run("add_effect", {
      presetId: "com.cartcut.vignette",
      startMs: 0,
      durationMs: 1_000,
      intensity: 40,
    });
    const before = historyLength();

    const result = await run("set_effect", {
      elementId: added.created[0],
      intensity: 40,
    });

    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("refuses a non-effect track", async () => {
    seed({ a: clip() });
    await expect(
      run("add_effect", {
        presetId: "com.cartcut.film-grain",
        startMs: 0,
        durationMs: 1_000,
        trackId: "v1",
      }),
    ).rejects.toThrow(/holds video clips, not effects/);
  });

  it("needs a positive duration", async () => {
    seed({ a: clip() });
    await expect(
      run("add_effect", {
        presetId: "com.cartcut.film-grain",
        startMs: 0,
        durationMs: 0,
      }),
    ).rejects.toThrow(/positive `durationMs`/);
  });
});

/**
 * `apply_edit_plan` — a whole edit as one undo step.
 *
 * The claim this pins is the reason the command exists. Running the same steps
 * through the individual commands produces the same timeline and a history
 * entry each, and an agent whose work takes sixty undos to reject may as well
 * not have undo.
 */
describe("apply_edit_plan", () => {
  function longClip(over: any = {}) {
    return clip({
      duration: 20_000,
      sourceDuration: 20_000,
      trim: { startTime: 0, endTime: 20_000 },
      ...over,
    });
  }

  it("is one undo step however much the plan does", async () => {
    seed({ a: longClip() });

    const steps = await stepsToUndo(() =>
      run("apply_edit_plan", {
        plan: {
          cuts: [
            {
              elementId: "a",
              ranges: [
                { startMs: 1_000, endMs: 1_500 },
                { startMs: 4_000, endMs: 4_800 },
                { startMs: 9_000, endMs: 9_400 },
              ],
            },
          ],
          motion: [{ elementIds: ["a"], preset: "punch_in" }],
          captions: [
            { text: "one", startMs: 0, durationMs: 900 },
            { text: "two", startMs: 1_000, durationMs: 900 },
            { text: "three", startMs: 2_000, durationMs: 900 },
          ],
          titles: [{ text: "Chapter one", startMs: 0, durationMs: 2_000 }],
        },
      }),
    );

    expect(steps).toBe(1);
  });

  it("actually applies every part of the plan", async () => {
    seed({ a: longClip() });

    const result = await run("apply_edit_plan", {
      plan: {
        cuts: [{ elementId: "a", ranges: [{ startMs: 2_000, endMs: 3_000 }] }],
        motion: [{ elementIds: ["a"], preset: "punch_in" }],
        captions: [{ text: "hello", startMs: 0, durationMs: 800 }],
      },
    });

    expect(result.ok).toBe(true);
    const document = doc();
    // The cut shortened the clip.
    expect(spanOf(document.elements.a).end).toBeLessThan(20_000);
    // The preset activated a scale track on it.
    expect((document.elements.a as any).animation.scale.isActivate).toBe(true);
    // The caption landed.
    expect(
      Object.values(document.elements).some((e: any) => e.text === "hello"),
    ).toBe(true);
  });

  it("cuts before it places, so captions land where the plan meant", async () => {
    // A ripple delete moves everything after it. If captions were placed first
    // the cut would drag them, and every timing in the plan would be wrong by
    // the length of the cuts before it.
    seed({ a: longClip() });

    await run("apply_edit_plan", {
      plan: {
        cuts: [{ elementId: "a", ranges: [{ startMs: 1_000, endMs: 3_000 }] }],
        captions: [{ text: "after", startMs: 5_000, durationMs: 500 }],
      },
    });

    const caption: any = Object.values(doc().elements).find(
      (e: any) => e.text === "after",
    );
    expect(caption.startTime).toBe(5_000);
  });

  it("skips a clip the cuts removed rather than failing the whole edit", async () => {
    seed({
      a: longClip(),
      b: clip({ startTime: 30_000, duration: 1_000 }),
    });

    const result = await run("apply_edit_plan", {
      plan: {
        // Removing all of `b` leaves the motion step with a stale id.
        cuts: [{ elementId: "b", ranges: [{ startMs: 30_000, endMs: 31_000 }] }],
        motion: [{ elementIds: ["b", "a"], preset: "punch_in" }],
      },
    });

    expect(result.ok).toBe(true);
    // The surviving clip still got its move.
    expect((doc().elements.a as any).animation.scale.isActivate).toBe(true);
  });

  it("refuses a plan with nothing in it", async () => {
    seed({ a: longClip() });
    await expect(run("apply_edit_plan", { plan: {} })).rejects.toThrow(
      /needs a plan with something in it/,
    );
  });

  it("refuses an unknown clip id before applying anything", async () => {
    // Half an edit is worse than none: the caller cannot tell which half.
    seed({ a: longClip() });
    const before = historyLength();

    await expect(
      run("apply_edit_plan", {
        plan: {
          cuts: [{ elementId: "nope", ranges: [{ startMs: 0, endMs: 100 }] }],
          captions: [{ text: "x", startMs: 0, durationMs: 100 }],
        },
      }),
    ).rejects.toThrow(/No clip with id "nope"/);

    expect(historyLength()).toBe(before);
    expect(Object.keys(doc().elements)).toEqual(["a"]);
  });

  it("reports the ids it created, and they are the ones in the document", async () => {
    // `commit` runs the transform twice — once to probe. Ids minted inside it
    // would differ between the runs, and the ones reported would not exist.
    seed({ a: longClip() });

    const result = await run("apply_edit_plan", {
      plan: {
        captions: [
          { text: "one", startMs: 0, durationMs: 500 },
          { text: "two", startMs: 1_000, durationMs: 500 },
        ],
      },
    });

    expect(result.created).toHaveLength(2);
    for (const id of result.created) {
      expect(doc().elements[id]).toBeDefined();
    }
  });

  it("collapses a whole transcript onto one caption track", async () => {
    seed({ a: longClip() });

    const captions = Array.from({ length: 12 }, (_, i) => ({
      text: `line ${i}`,
      startMs: i * 1_000,
      durationMs: 800,
    }));
    await run("apply_edit_plan", { plan: { captions } });

    const document = doc();
    const textTracks = document.tracks.filter((t) => t.kind === "text");
    expect(textTracks).toHaveLength(1);
  });

  it("declines by identity when nothing in the plan bites", async () => {
    seed({ a: longClip() });
    const before = historyLength();

    const result = await run("apply_edit_plan", {
      plan: {
        // Ranges entirely outside the clip change nothing.
        cuts: [{ elementId: "a", ranges: [{ startMs: 90_000, endMs: 95_000 }] }],
      },
    });

    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });
});

describe("map_transcript", () => {
  it("shifts times by the trim and the clip's place on the timeline", async () => {
    seed({
      a: clip({
        startTime: 10_000,
        duration: 2_000,
        trim: { startTime: 2_000, endTime: 4_000 },
      }),
    });

    const result = await run("map_transcript", {
      elementId: "a",
      items: [{ text: "hello", startMs: 3_000, endMs: 3_500 }],
    });

    expect(result.items[0]).toMatchObject({ startMs: 11_000, endMs: 11_500 });
  });

  it("carries confidence and speaker through untouched", async () => {
    // The seam where they would silently vanish: this function rebuilt each
    // item field by field, so anything a back end reported past the three it
    // named was dropped between the recogniser and the agent.
    seed({ a: clip() });

    const result = await run("map_transcript", {
      elementId: "a",
      items: [
        { text: "yes", startMs: 0, endMs: 400, confidence: 0.93, speaker: "SPEAKER_00" },
      ],
    });

    expect(result.items[0]).toMatchObject({
      text: "yes",
      confidence: 0.93,
      speaker: "SPEAKER_00",
    });
  });

  it("drops entries the trim cut away", async () => {
    seed({ a: clip({ trim: { startTime: 1_000, endTime: 3_000 } }) });

    const result = await run("map_transcript", {
      elementId: "a",
      items: [
        { text: "gone", startMs: 0, endMs: 500 },
        { text: "kept", startMs: 1_500, endMs: 2_000 },
        { text: "also gone", startMs: 3_500, endMs: 4_000 },
      ],
    });

    expect(result.items.map((i: any) => i.text)).toEqual(["kept"]);
  });
});

/**
 * `map_analysis` — source-file measurements onto the timeline.
 *
 * `analyze.ts` measures the file; the timeline is a trimmed, possibly retimed
 * window onto it. Everything here is a way for that conversion to be silently
 * wrong, which is the worst kind: the cuts land *nearly* right.
 */
describe("map_analysis", () => {
  it("passes times through untouched for an untrimmed clip at 1x", async () => {
    seed({ a: clip() });

    const result = await run("map_analysis", {
      elementId: "a",
      silences: [{ startMs: 1_000, endMs: 1_500 }],
      onsets: [500, 2_000],
      tempo: { bpm: 120, confidence: 0.9, firstBeatMs: 0 },
    });

    expect(result.silences).toEqual([{ startMs: 1_000, endMs: 1_500 }]);
    expect(result.onsets).toEqual([500, 2_000]);
    expect(result.tempo.bpm).toBe(120);
  });

  it("shifts by the trim and the clip's place on the timeline", async () => {
    // 2s into the source, sitting at timeline 10s: source 3s is timeline 11s.
    seed({
      a: clip({
        startTime: 10_000,
        duration: 2_000,
        trim: { startTime: 2_000, endTime: 4_000 },
      }),
    });

    const result = await run("map_analysis", {
      elementId: "a",
      onsets: [3_000],
    });

    expect(result.onsets).toEqual([11_000]);
  });

  it("drops events the trim cut away rather than clamping them", async () => {
    // Clamping would pile every discarded onset onto the clip's first frame,
    // which reads as a flurry of hits that are not there.
    seed({ a: clip({ trim: { startTime: 1_000, endTime: 3_000 } }) });

    const result = await run("map_analysis", {
      elementId: "a",
      onsets: [200, 2_000, 3_500],
    });

    expect(result.onsets).toHaveLength(1);
  });

  it("scales bpm by the clip's speed", async () => {
    // Music in the file at 120bpm, played at 2x, is 240bpm on the timeline.
    seed({ a: clip({ speed: 2 }) });

    const result = await run("map_analysis", {
      elementId: "a",
      tempo: { bpm: 120, confidence: 0.8, firstBeatMs: 0 },
    });

    expect(result.tempo.bpm).toBe(240);
    expect(result.tempo.confidence).toBe(0.8);
  });

  it("compresses a silence by the clip's speed", async () => {
    seed({ a: clip({ speed: 2 }) });

    const result = await run("map_analysis", {
      elementId: "a",
      silences: [{ startMs: 1_000, endMs: 2_000 }],
    });

    // A second of file is half a second of timeline at 2x.
    expect(result.silences[0].endMs - result.silences[0].startMs).toBe(500);
  });

  it("clamps a silence that runs off the end of the trim", async () => {
    // The part that plays is still silent, so the range survives, shortened.
    seed({ a: clip({ trim: { startTime: 0, endTime: 2_000 } }) });

    const result = await run("map_analysis", {
      elementId: "a",
      silences: [{ startMs: 1_500, endMs: 9_000 }],
    });

    expect(result.silences).toEqual([{ startMs: 1_500, endMs: 2_000 }]);
  });

  it("keeps only the beats the trim left in, and puts them where they play", async () => {
    // Beats every 500ms in the file; the clip is the window 1200..3200ms. The
    // beats at 0, 500 and 1000 were cut away and must not be reported — a beat
    // the viewer never hears is a cut point that lands on nothing.
    seed({
      a: clip({
        startTime: 0,
        duration: 2_000,
        trim: { startTime: 1_200, endTime: 3_200 },
      }),
    });

    const result = await run("map_analysis", {
      elementId: "a",
      beats: [0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500],
      tempo: { bpm: 120, confidence: 0.9 },
    });

    // 1500, 2000, 2500 and 3000 survive, landing 300ms apart from the clip's
    // own start; 3500 is past the out-point.
    expect(result.beats).toEqual([300, 800, 1_300, 1_800]);
  });

  it("refuses a clip with no source window", async () => {
    seed({ t: textElement({ trackId: "t1" }) }, [["t1", "text"]]);
    await expect(run("map_analysis", { elementId: "t" })).rejects.toThrow(
      /no source window/,
    );
  });
});
