import { describe, it, expect } from "vitest";
import {
  BLENDABLE_FILETYPES,
  isBlendable,
  setClipBlend,
  setClipBlendMany,
} from "./blendOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { addEffect } from "./effectOps";
import { addTransition } from "./transitionOps";
import { blendOf, DEFAULT_BLEND } from "../renderer/blend";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { BLEND_MODES } from "../../@types/timeline";

/**
 * One clip of every type, on rows that can hold them.
 *
 * Built through `normalizeDocument` so `priority` and the track links are the
 * ones the renderer would actually see — a hand-built map would let an op pass
 * here and fail against a real document.
 */
function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v0", "video", 0),
      createTrack("a0", "audio", 1),
      createTrack("g0", "video", 2),
    ],
    elements: {
      video: videoElement({ trackId: "v0", startTime: 0, duration: 4000 }),
      image: imageElement({ trackId: "v0", startTime: 4000, duration: 1000 }),
      gif: gifElement({ trackId: "v0", startTime: 5000, duration: 1000 }),
      shape: shapeElement({ trackId: "v0", startTime: 6000, duration: 1000 }),
      text: textElement({ trackId: "v0", startTime: 7000, duration: 1000 }),
      sound: audioElement({ trackId: "a0", startTime: 0, duration: 4000 }),
      group: groupElement({ trackId: "g0", startTime: 0, duration: 4000 }),
    },
  });
}

describe("BLENDABLE_FILETYPES", () => {
  it("is exactly the types that paint themselves as a layer", () => {
    expect([...BLENDABLE_FILETYPES].sort()).toEqual([
      "gif",
      "image",
      "shape",
      "text",
      "video",
    ]);
  });

  it("recognises each of them, and nothing else", () => {
    const d = doc();
    for (const id of ["video", "image", "gif", "shape", "text"]) {
      expect(isBlendable(d.elements[id])).toBe(true);
    }
    for (const id of ["sound", "group"]) {
      expect(isBlendable(d.elements[id])).toBe(false);
    }
    expect(isBlendable(undefined)).toBe(false);
    expect(isBlendable(null)).toBe(false);
  });
});

describe("setClipBlend", () => {
  it.each(["video", "image", "gif", "shape", "text"])(
    "sets the mode on a %s clip",
    (id) => {
      const next = setClipBlend(doc(), id, "multiply");
      expect(blendOf(next.elements[id])).toBe("multiply");
      expect((next.elements[id] as { blend?: string }).blend).toBe("multiply");
    },
  );

  it("stores every mode in the vocabulary", () => {
    for (const mode of BLEND_MODES.filter((m) => m !== DEFAULT_BLEND)) {
      const next = setClipBlend(doc(), "video", mode);
      expect(blendOf(next.elements.video)).toBe(mode);
    }
  });

  it("replaces a mode the clip already carries", () => {
    const once = setClipBlend(doc(), "video", "multiply");
    const twice = setClipBlend(once, "video", "screen");
    expect(blendOf(twice.elements.video)).toBe("screen");
  });

  // `JSON.stringify` drops an undefined value, so storing the default would
  // make a project saved before the feature differ from the same project saved
  // after it, for no visible change.
  it("removes the field entirely when set back to the default", () => {
    const blended = setClipBlend(doc(), "video", "multiply");
    const cleared = setClipBlend(blended, "video", DEFAULT_BLEND);

    expect("blend" in cleared.elements.video).toBe(false);
    expect(blendOf(cleared.elements.video)).toBe(DEFAULT_BLEND);
    expect(JSON.parse(JSON.stringify(cleared.elements.video))).not.toHaveProperty(
      "blend",
    );
  });

  it("leaves every other field exactly as it was", () => {
    const before = doc();
    const after = setClipBlend(before, "video", "multiply");

    const { blend, ...rest } = after.elements.video as Record<string, unknown>;
    expect(blend).toBe("multiply");
    expect(rest).toEqual(before.elements.video);
  });

  it("touches no other element", () => {
    const before = doc();
    const after = setClipBlend(before, "video", "multiply");

    for (const id of Object.keys(before.elements)) {
      if (id === "video") continue;
      expect(after.elements[id]).toBe(before.elements[id]);
    }
    expect(after.tracks).toBe(before.tracks);
  });
});

/**
 * The contract every op in `clipOps` holds: return the document **by identity**
 * when nothing changed. `withCheckpoint` reads identity to mean "nothing
 * happened" and records no undo step, so a no-op costs the user nothing.
 */
describe("setClipBlend — declines by identity", () => {
  it("when the clip already carries that mode", () => {
    const blended = setClipBlend(doc(), "video", "multiply");
    expect(setClipBlend(blended, "video", "multiply")).toBe(blended);
  });

  it("when clearing a clip that never had one", () => {
    const before = doc();
    expect(setClipBlend(before, "video", DEFAULT_BLEND)).toBe(before);
  });

  it("for an id that is not in the document", () => {
    const before = doc();
    expect(setClipBlend(before, "nope", "multiply")).toBe(before);
  });

  it.each(["sound", "group"])("for a %s, which paints no layer", (id) => {
    const before = doc();
    expect(setClipBlend(before, id, "multiply")).toBe(before);
  });

  it("for an effect", () => {
    // An effect has its own `blend`, applied by the FX compositor against the
    // whole frame. This op must not reach for it.
    const before = addEffect(doc(), "v0", "vhs", 0, 2000, "fx");
    expect(setClipBlend(before, "fx", "multiply")).toBe(before);
  });

  it("for a transition", () => {
    const base = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: videoElement({ trackId: "v0", startTime: 0, duration: 2000 }),
        b: videoElement({ trackId: "v0", startTime: 2000, duration: 2000 }),
      },
    });
    const before = addTransition(base, "tr", "a", "b", "crossfade", 1000, "center");
    // Guard the fixture: if `addTransition` declined, the assertion below would
    // pass for the wrong reason.
    expect(before.elements.tr?.filetype).toBe("transition");
    expect(setClipBlend(before, "tr", "multiply")).toBe(before);
  });
});

describe("setClipBlendMany", () => {
  it("sets one mode across many clips in one document", () => {
    const next = setClipBlendMany(doc(), ["video", "image", "text"], "screen");
    expect(blendOf(next.elements.video)).toBe("screen");
    expect(blendOf(next.elements.image)).toBe("screen");
    expect(blendOf(next.elements.text)).toBe("screen");
    expect(blendOf(next.elements.shape)).toBe(DEFAULT_BLEND);
  });

  it("applies the ids it can and skips the ones it cannot", () => {
    const next = setClipBlendMany(
      doc(),
      ["video", "sound", "group", "nope", "shape"],
      "darken",
    );
    expect(blendOf(next.elements.video)).toBe("darken");
    expect(blendOf(next.elements.shape)).toBe("darken");
    expect("blend" in next.elements.sound).toBe(false);
    expect("blend" in next.elements.group).toBe(false);
  });

  it("declines by identity when no id could take the mode", () => {
    const before = doc();
    expect(setClipBlendMany(before, ["sound", "group", "nope"], "multiply")).toBe(
      before,
    );
  });

  it("declines by identity for an empty list", () => {
    const before = doc();
    expect(setClipBlendMany(before, [], "multiply")).toBe(before);
  });

  it("declines by identity when every clip already has that mode", () => {
    const blended = setClipBlendMany(doc(), ["video", "image"], "multiply");
    expect(setClipBlendMany(blended, ["video", "image"], "multiply")).toBe(
      blended,
    );
  });

  it("ignores a repeated id rather than double-applying", () => {
    const next = setClipBlendMany(doc(), ["video", "video"], "multiply");
    expect(blendOf(next.elements.video)).toBe("multiply");
  });
});
