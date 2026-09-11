import { describe, it, expect } from "vitest";
import {
  MIRRORABLE_FILETYPES,
  isMirrorable,
  mirrorOf,
  mirrorToggleTarget,
  setClipMirror,
  toggleMirror,
} from "./mirrorOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";

/** One clip of every type, built through `normalizeDocument` like the app. */
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

describe("MIRRORABLE_FILETYPES", () => {
  it("is exactly video and image", () => {
    expect([...MIRRORABLE_FILETYPES].sort()).toEqual(["image", "video"]);
  });

  it("isMirrorable agrees with the list", () => {
    const d = doc();
    for (const [id, element] of Object.entries(d.elements)) {
      expect(isMirrorable(element), id).toBe(
        (MIRRORABLE_FILETYPES as readonly string[]).includes(element.filetype),
      );
    }
  });
});

describe("mirrorOf", () => {
  it("reads absent as not mirrored", () => {
    expect(mirrorOf(doc().elements.video)).toEqual({ h: false, v: false });
  });

  it("reads only a literal true", () => {
    const element = { ...videoElement(), flipH: "yes" } as any;
    expect(mirrorOf(element).h).toBe(false);
  });
});

describe("setClipMirror", () => {
  it("sets each axis independently", () => {
    let d = doc();
    d = setClipMirror(d, "video", "h", true);
    expect(mirrorOf(d.elements.video)).toEqual({ h: true, v: false });
    d = setClipMirror(d, "video", "v", true);
    expect(mirrorOf(d.elements.video)).toEqual({ h: true, v: true });
  });

  it("deletes the key when switched off, surviving a JSON round-trip", () => {
    const on = setClipMirror(doc(), "image", "h", true);
    const off = setClipMirror(on, "image", "h", false);
    expect("flipH" in off.elements.image).toBe(false);
    const saved = JSON.parse(JSON.stringify(off.elements.image));
    expect(saved).toEqual(doc().elements.image);
  });

  it("leaves other fields and other elements untouched", () => {
    const before = doc();
    const after = setClipMirror(before, "video", "v", true);
    expect({ ...after.elements.video, flipV: undefined }).toEqual({
      ...before.elements.video,
      flipV: undefined,
    });
    expect(after.elements.image).toBe(before.elements.image);
    expect(after.tracks).toBe(before.tracks);
  });

  describe("declines by identity", () => {
    it("for a state the clip already has", () => {
      const d = doc();
      expect(setClipMirror(d, "video", "h", false)).toBe(d);
      const on = setClipMirror(d, "video", "h", true);
      expect(setClipMirror(on, "video", "h", true)).toBe(on);
    });

    it("for a missing id", () => {
      const d = doc();
      expect(setClipMirror(d, "nope", "h", true)).toBe(d);
    });

    it.each(["gif", "shape", "text", "sound", "group"])(
      "for a %s",
      (id) => {
        const d = doc();
        expect(setClipMirror(d, id, "h", true)).toBe(d);
      },
    );
  });
});

describe("toggleMirror", () => {
  it("turns everything on when anything is off", () => {
    const partly = setClipMirror(doc(), "video", "h", true);
    expect(mirrorToggleTarget(partly, ["video", "image"], "h")).toBe(true);
    const after = toggleMirror(partly, ["video", "image"], "h");
    expect(mirrorOf(after.elements.video).h).toBe(true);
    expect(mirrorOf(after.elements.image).h).toBe(true);
  });

  it("turns everything off when everything is on", () => {
    const on = toggleMirror(doc(), ["video", "image"], "h");
    const off = toggleMirror(on, ["video", "image"], "h");
    expect(mirrorOf(off.elements.video).h).toBe(false);
    expect(mirrorOf(off.elements.image).h).toBe(false);
  });

  it("ignores what cannot be mirrored in a mixed selection", () => {
    const after = toggleMirror(doc(), ["video", "text", "sound"], "v");
    expect(mirrorOf(after.elements.video).v).toBe(true);
    expect("flipV" in after.elements.text).toBe(false);
  });

  it("declines by identity when nothing is mirrorable", () => {
    const d = doc();
    expect(mirrorToggleTarget(d, ["text", "sound"], "h")).toBeNull();
    expect(toggleMirror(d, ["text", "sound"], "h")).toBe(d);
    expect(toggleMirror(d, [], "h")).toBe(d);
  });
});
