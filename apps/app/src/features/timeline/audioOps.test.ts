/**
 * Detaching audio, and proving the detached clip is a real clip.
 *
 * Two claims carry the whole feature and neither is obvious from reading the
 * op:
 *
 *   - the twin occupies exactly the span the video did, at exactly the same
 *     source frames, for every speed — otherwise a detach silently shifts the
 *     sound and nothing downstream would notice;
 *   - the twin is editable by the ordinary ops, because nothing about it is
 *     special. Splitting, moving and trimming it are tested here rather than
 *     assumed, since "you can drag it and cut it freely" is the requirement.
 *
 * The decline paths get equal weight. `withCheckpoint` reads identity to
 * decide whether an undo step happened, so an op that returns a *copy* when it
 * declines makes Cmd+Z eat a step the user never took.
 */

import { describe, it, expect } from "vitest";
import {
  addLevelKeyframe,
  detachAudio,
  detachAudioFrom,
  moveLevelKeyframe,
  offsetLevelEnvelope,
  removeLevelKeyframe,
  setVolumeDb,
} from "./audioOps";
import {
  AUDIO_CLIP_COLOR,
  audioTwinOf,
  canDetachAudio,
  isAudibleElement,
  volumeDbAt,
  volumeDbOf,
} from "./audio";
import { addKeyframe, setTrackActive } from "../animation/keyframeOps";
import { moveClips, splitClip, trimClipEnd, trimClipStart } from "./clipOps";
import { assertTrimInvariant, spanLength, spanOf } from "./geometry";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  imageElement,
  textElement,
  videoElement,
} from "../renderer/testing";

/** A 10s source, 4s of it used from 2s in, sitting at 5s on the timeline. */
function clip(over = {}) {
  return videoElement({
    trackId: "v1",
    startTime: 5000,
    duration: 4000,
    speed: 1,
    trim: { startTime: 2000, endTime: 6000 },
    sourceDuration: 10_000,
    isExistAudio: true,
    ...over,
  });
}

/** One video row, plus whatever else the test needs. */
function doc(
  elements: Record<string, any>,
  tracks = [createTrack("v1", "video", 0)],
): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks,
    elements,
  });
}

/** The one element the detach added, whichever id it got. */
function twinIn(next: TimelineDocument, exclude: string[]) {
  const entry = Object.entries(next.elements).find(
    ([id, element]) => !exclude.includes(id) && element.filetype === "audio",
  );
  expect(entry).toBeDefined();
  return entry as [string, any];
}

function trackOf(next: TimelineDocument, trackId: string) {
  const track = next.tracks.find((candidate) => candidate.id === trackId);
  expect(track).toBeDefined();
  return track!;
}

describe("audioTwinOf", () => {
  it("occupies exactly the span the video did", () => {
    const video = clip();
    expect(spanOf(audioTwinOf(video))).toEqual(spanOf(video));
  });

  it("holds the span at every speed", () => {
    // `spanLength` divides a dynamic element's duration by its speed, so a twin
    // that dropped `speed` would sit at the source length and run long.
    for (const speed of [0.5, 1, 2, 4]) {
      const video = clip({ speed });
      expect(spanOf(audioTwinOf(video))).toEqual(spanOf(video));
    }
  });

  it("keeps the source window, so the sound starts on the same frame", () => {
    const twin = audioTwinOf(clip());
    expect(twin.trim).toEqual({ startTime: 2000, endTime: 6000 });
    expect(twin.sourceDuration).toBe(10_000);
    expect(() => assertTrimInvariant(twin, "twin")).not.toThrow();
  });

  it("satisfies the trim invariant for an already-trimmed clip", () => {
    const twin = audioTwinOf(
      clip({ duration: 1500, trim: { startTime: 3000, endTime: 4500 } }),
    );
    expect(() => assertTrimInvariant(twin, "twin")).not.toThrow();
  });

  it("points at the same source file", () => {
    const video = clip({ localpath: "/movies/a.mp4", blob: "blob:xyz" });
    const twin = audioTwinOf(video);
    // Both the waveform cache and the FFmpeg audio input key off `localpath`,
    // which is what makes the detach free.
    expect(twin.localpath).toBe("/movies/a.mp4");
    expect(twin.blob).toBe("blob:xyz");
  });

  it("reads as an ordinary audio clip", () => {
    const twin = audioTwinOf(clip());
    expect(twin.filetype).toBe("audio");
    expect(twin.timelineOptions.color).toBe(AUDIO_CLIP_COLOR);
  });

  it("does not inherit the video's transform parent", () => {
    // `parentId` is a spatial parent and audio has no `location` to transform,
    // so carrying it over would name a group that can never mean anything here.
    const twin = audioTwinOf(clip({ parentId: "g1" }) as any);
    expect((twin as any).parentId).toBeUndefined();
  });

  it("does not share the video's trim object", () => {
    const video = clip();
    const twin = audioTwinOf(video);
    twin.trim.startTime = 0;
    expect(video.trim.startTime).toBe(2000);
  });
});

describe("canDetachAudio", () => {
  it("accepts a video whose file carries sound", () => {
    expect(canDetachAudio(clip())).toBe(true);
  });

  it("refuses a video with no audio stream", () => {
    expect(canDetachAudio(clip({ isExistAudio: false }))).toBe(false);
  });

  it("refuses a video already detached", () => {
    expect(canDetachAudio(clip({ audioDetached: true }))).toBe(false);
  });

  it("refuses everything that is not a video", () => {
    expect(canDetachAudio(audioElement())).toBe(false);
    expect(canDetachAudio(imageElement())).toBe(false);
    expect(canDetachAudio(textElement())).toBe(false);
    expect(canDetachAudio(undefined)).toBe(false);
  });
});

describe("isAudibleElement", () => {
  it("silences a video whose audio has been detached", () => {
    expect(isAudibleElement(clip())).toBe(true);
    expect(isAudibleElement(clip({ audioDetached: true }))).toBe(false);
  });

  it("still silences a video with no audio stream", () => {
    expect(isAudibleElement(clip({ isExistAudio: false }))).toBe(false);
  });

  it("leaves audio clips audible and picture-only clips silent", () => {
    expect(isAudibleElement(audioElement())).toBe(true);
    expect(isAudibleElement(imageElement())).toBe(false);
    expect(isAudibleElement(textElement())).toBe(false);
  });
});

describe("detachAudio", () => {
  it("adds an audio clip at the video's own moment", () => {
    const next = detachAudio(doc({ v: clip() }), "v", "a", "t");
    const [, twin] = twinIn(next, ["v"]);
    expect(spanOf(twin)).toEqual(spanOf(clip()));
  });

  it("silences the video it came from", () => {
    // The other half of the same edit. `amix` normalises by input count, so a
    // document where both are audible is not merely loud — it drags down every
    // other clip in the project.
    const next = detachAudio(doc({ v: clip() }), "v", "a", "t");
    expect((next.elements.v as any).audioDetached).toBe(true);
    expect(isAudibleElement(next.elements.v)).toBe(false);
  });

  it("keeps the number of audible clips constant", () => {
    const before = doc({ v: clip() });
    const after = detachAudio(before, "v", "a", "t");
    const count = (d: TimelineDocument) =>
      Object.values(d.elements).filter(isAudibleElement).length;
    expect(count(after)).toBe(count(before));
  });

  it("leaves the video's picture untouched", () => {
    const next = detachAudio(doc({ v: clip() }), "v", "a", "t");
    const video = next.elements.v as any;
    expect(spanOf(video)).toEqual(spanOf(clip()));
    expect(video.trim).toEqual({ startTime: 2000, endTime: 6000 });
    expect(video.isExistAudio).toBe(true);
  });

  it("creates the first audio track at the bottom of the stack", () => {
    const next = detachAudio(doc({ v: clip() }), "v", "a", "t");
    const [, twin] = twinIn(next, ["v"]);
    const track = trackOf(next, twin.trackId);
    expect(track.kind).toBe("audio");
    expect(track.name).toBe("A1");
    // Index 0 is the top row, so the last index is the bottom one.
    expect(track.index).toBe(next.tracks.length - 1);
  });

  it("reuses a free audio track rather than stacking rows", () => {
    // Two clips that do not overlap in time belong on one row. Detaching each
    // onto a row of its own is how forty cuts became forty tracks before the
    // track model existed.
    const start = doc({
      a: clip({ startTime: 0, duration: 2000, trim: { startTime: 0, endTime: 2000 } }),
      b: clip({ startTime: 5000, duration: 2000, trim: { startTime: 0, endTime: 2000 } }),
    });

    const once = detachAudio(start, "a", "a-aud", "t1");
    const twice = detachAudio(once, "b", "b-aud", "t2");

    expect(twice.tracks.filter((track) => track.kind === "audio")).toHaveLength(1);
    expect((twice.elements["a-aud"] as any).trackId).toBe(
      (twice.elements["b-aud"] as any).trackId,
    );
  });

  it("adds a second audio track when the moment is taken", () => {
    const start = doc({
      a: clip({ startTime: 0, duration: 4000, trim: { startTime: 0, endTime: 4000 } }),
      b: clip({
        trackId: "v2",
        startTime: 1000,
        duration: 4000,
        trim: { startTime: 0, endTime: 4000 },
      }),
    }, [createTrack("v1", "video", 0), createTrack("v2", "video", 1)]);

    const twice = detachAudio(
      detachAudio(start, "a", "a-aud", "t1"),
      "b",
      "b-aud",
      "t2",
    );

    expect(twice.tracks.filter((track) => track.kind === "audio")).toHaveLength(2);
    expect((twice.elements["a-aud"] as any).trackId).not.toBe(
      (twice.elements["b-aud"] as any).trackId,
    );
  });

  it("re-derives priorities so the new clip has a paint rank", () => {
    const next = detachAudio(doc({ v: clip() }), "v", "a", "t");
    const ranks = Object.values(next.elements).map((el: any) => el.priority);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks.every((rank) => rank >= 1)).toBe(true);
  });

  // -- decline paths: the input back, by identity ---------------------------

  it("declines a video with no audio stream", () => {
    const before = doc({ v: clip({ isExistAudio: false }) });
    expect(detachAudio(before, "v", "a", "t")).toBe(before);
  });

  it("declines a video whose audio is already detached", () => {
    const before = detachAudio(doc({ v: clip() }), "v", "a", "t");
    expect(detachAudio(before, "v", "a2", "t2")).toBe(before);
  });

  it("declines a clip that is not a video", () => {
    const before = doc({ a: audioElement({ trackId: "v1" }) });
    expect(detachAudio(before, "a", "x", "t")).toBe(before);
  });

  it("declines an id that names nothing", () => {
    const before = doc({ v: clip() });
    expect(detachAudio(before, "missing", "a", "t")).toBe(before);
  });
});

describe("detachAudioFrom", () => {
  it("detaches a whole selection as one edit", () => {
    const before = doc({
      a: clip({ startTime: 0, duration: 2000, trim: { startTime: 0, endTime: 2000 } }),
      b: clip({ startTime: 5000, duration: 2000, trim: { startTime: 0, endTime: 2000 } }),
    });

    let n = 0;
    const next = detachAudioFrom(before, ["a", "b"], () => `id${n++}`);

    const audio = Object.values(next.elements).filter(
      (el) => el.filetype === "audio",
    );
    expect(audio).toHaveLength(2);
    expect((next.elements.a as any).audioDetached).toBe(true);
    expect((next.elements.b as any).audioDetached).toBe(true);
  });

  it("skips what it cannot detach and keeps the rest", () => {
    const before = doc({
      v: clip(),
      silent: clip({ isExistAudio: false, startTime: 20_000 }),
      t: textElement({ trackId: "v1", startTime: 30_000 }),
    });

    let n = 0;
    const next = detachAudioFrom(before, ["v", "silent", "t"], () => `id${n++}`);

    expect(
      Object.values(next.elements).filter((el) => el.filetype === "audio"),
    ).toHaveLength(1);
    expect((next.elements.silent as any).audioDetached).toBeUndefined();
  });

  it("spends no ids on clips it skips", () => {
    const before = doc({ silent: clip({ isExistAudio: false }) });
    let calls = 0;
    detachAudioFrom(before, ["silent"], () => `id${calls++}`);
    expect(calls).toBe(0);
  });

  it("returns the document by identity when nothing can be detached", () => {
    const before = doc({ silent: clip({ isExistAudio: false }) });
    expect(detachAudioFrom(before, ["silent"], () => "x")).toBe(before);
  });

  it("returns the document by identity for an empty selection", () => {
    const before = doc({ v: clip() });
    expect(detachAudioFrom(before, [], () => "x")).toBe(before);
  });
});

describe("a detached clip is an ordinary clip", () => {
  /** Detach and hand back the document plus the twin's id. */
  function detached(over = {}) {
    const next = detachAudio(doc({ v: clip(over) }), "v", "a", "t");
    return { next, twinId: twinIn(next, ["v"])[0] };
  }

  it("splits into two adjacent halves", () => {
    const { next, twinId } = detached();
    const after = splitClip(next, twinId, 7000, "right");

    const left = after.elements[twinId] as any;
    const right = after.elements.right as any;

    expect(spanOf(left)).toMatchObject({ start: 5000, end: 7000 });
    expect(spanOf(right)).toMatchObject({ start: 7000, end: 9000 });
    // The cut is exact in the source too: the halves rejoin without drift.
    expect(left.trim.endTime).toBe(right.trim.startTime);
    expect(() => assertTrimInvariant(left, "left")).not.toThrow();
    expect(() => assertTrimInvariant(right, "right")).not.toThrow();
  });

  it("splits correctly on a sped-up clip", () => {
    // At 2x the 4s source occupies 2s of timeline, so a cut 1s in lands 2s
    // into the source. Getting this wrong is invisible until export.
    const { next, twinId } = detached({ speed: 2 });
    const after = splitClip(next, twinId, 6000, "right");

    expect((after.elements[twinId] as any).trim).toEqual({
      startTime: 2000,
      endTime: 4000,
    });
    expect((after.elements.right as any).trim).toEqual({
      startTime: 4000,
      endTime: 6000,
    });
  });

  it("moves in time", () => {
    const { next, twinId } = detached();
    const after = moveClips(next, [twinId], 1000);
    expect((after.elements[twinId] as any).startTime).toBe(6000);
  });

  it("stays on audio rows", () => {
    // `moveClips` refuses a cross-kind move outright, which is what keeps a
    // detached clip from being dragged onto a video row where it would neither
    // render nor export.
    const { next, twinId } = detached();
    expect(moveClips(next, [twinId], 0, -1)).toBe(next);
  });

  it("trims from either edge", () => {
    const { next, twinId } = detached();

    const fromStart = trimClipStart(next, twinId, 500);
    expect(spanOf(fromStart.elements[twinId])).toMatchObject({ start: 5500 });
    expect(() =>
      assertTrimInvariant(fromStart.elements[twinId], "trimmed"),
    ).not.toThrow();

    const fromEnd = trimClipEnd(next, twinId, -500);
    expect(spanOf(fromEnd.elements[twinId])).toMatchObject({ end: 8500 });
    expect(() =>
      assertTrimInvariant(fromEnd.elements[twinId], "trimmed"),
    ).not.toThrow();
  });

  it("can be trimmed back out to the full source", () => {
    // `sourceDuration` is carried over, so the twin knows how much file is
    // left beyond its window — without it, an inward trim would be permanent.
    const { next, twinId } = detached();
    const after = trimClipEnd(next, twinId, 10_000);
    expect((after.elements[twinId] as any).trim.endTime).toBe(10_000);
  });

  it("does not drag the video along with it", () => {
    // The requirement in one assertion: after the split the two are unrelated.
    const { next, twinId } = detached();
    const after = moveClips(next, [twinId], 500);
    expect((after.elements.v as any).startTime).toBe(5000);
    expect((after.elements[twinId] as any).startTime).toBe(5500);
  });
});

/**
 * Setting a level, and — mostly — refusing to.
 *
 * The decline paths get the bulk of the attention because of how this op is
 * driven. `number-input` dispatches on every mousemove, so one scrub of the
 * fader calls this hundreds of times, and `GestureCommit` decides whether the
 * gesture is worth an undo step purely by whether the document came back by
 * identity. An op that returned a copy when nothing changed would turn "I
 * dragged the fader and put it back" into a step the user never took.
 */
describe("setVolumeDb", () => {
  const base = () =>
    doc({
      v: clip(),
      a: audioElement({ trackId: "a1", startTime: 0, duration: 1000 }),
      t: textElement({ trackId: "v1", startTime: 0, duration: 1000 }),
    }, [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)]);

  it("writes the level onto an audio clip", () => {
    const before = base();
    const after = setVolumeDb(before, "a", -6);
    expect(volumeDbOf(after.elements.a)).toBe(-6);
  });

  it("writes the level onto a video clip", () => {
    const before = base();
    const after = setVolumeDb(before, "v", -12);
    expect(volumeDbOf(after.elements.v)).toBe(-12);
  });

  it("leaves every other clip alone", () => {
    const before = base();
    const after = setVolumeDb(before, "a", -6);
    expect(after.elements.v).toBe(before.elements.v);
    expect(after.elements.t).toBe(before.elements.t);
  });

  it("declines by identity when the clip is already at that level", () => {
    // A scrub that wanders back across a value it already passed.
    const before = setVolumeDb(base(), "a", -6);
    expect(setVolumeDb(before, "a", -6)).toBe(before);
  });

  it("declines by identity when setting 0 on a clip that has no field", () => {
    // The case a raw-field comparison would miss: no `volumeDb` *is* 0 dB, so
    // this must not stamp a redundant `volumeDb: 0` onto every clip the user
    // happens to click on.
    const before = base();
    expect((before.elements.a as any).volumeDb).toBeUndefined();
    expect(setVolumeDb(before, "a", 0)).toBe(before);
  });

  it("clamps a level outside the range", () => {
    // The clamp lives here rather than in the panel because `number-input`
    // ignores `min`/`max` entirely — there is nothing stopping a drag.
    expect(volumeDbOf(setVolumeDb(base(), "a", -200).elements.a)).toBe(-60);
  });

  it("declines when the clamp lands on the level already held", () => {
    // Dragging up past the ceiling from an untouched clip: +40 clamps to +12.
    // Set it there twice and the second call is where nothing happened.
    const before = setVolumeDb(base(), "a", 40);
    expect(volumeDbOf(before.elements.a)).toBe(12);
    expect(setVolumeDb(before, "a", 99)).toBe(before);
  });

  it("declines a second drag past the floor", () => {
    // Dragging below -60 and continuing to drag is one step, not one per event.
    const atFloor = setVolumeDb(base(), "a", -60);
    expect(setVolumeDb(atFloor, "a", -80)).toBe(atFloor);
    expect(setVolumeDb(atFloor, "a", -1000)).toBe(atFloor);
  });

  it("declines a clip type that makes no sound", () => {
    // A text clip with a level would be a field nothing ever reads.
    const before = base();
    expect(setVolumeDb(before, "t", -6)).toBe(before);
  });

  it("declines an id that is not in the document", () => {
    const before = base();
    expect(setVolumeDb(before, "nope", -6)).toBe(before);
  });

  it("declines a level that is not a number", () => {
    // `parseFloat` on an empty spinner yields NaN, and clamping it would
    // silently jump the clip to 0 dB.
    const before = base();
    expect(setVolumeDb(before, "a", NaN)).toBe(before);
    expect(setVolumeDb(before, "a", Infinity)).toBe(before);
  });

  it("does not disturb the level when the sound is detached", () => {
    // The video keeps its (now inert) level, and the twin gets a copy — so
    // re-attaching later would not have lost what the user chose.
    const before = setVolumeDb(base(), "v", -9);
    const { next } = { next: detachAudio(before, "v", "tw", "t1") };
    expect(volumeDbOf(next.elements.v)).toBe(-9);
    expect(volumeDbOf(next.elements.tw)).toBe(-9);
  });
});

describe("the level envelope", () => {
  const bakeHz = 60;

  const base = () =>
    doc(
      {
        a: audioElement({
          trackId: "a1",
          startTime: 0,
          duration: 1000,
          trim: { startTime: 0, endTime: 1000 },
          sourceDuration: 1000,
        }),
      },
      [createTrack("a1", "audio", 0)],
    );

  function keyed(stops: Array<[number, number]>): TimelineDocument {
    let doc = setTrackActive(base(), "a", "volumeDb", true, { atMs: 0 }, bakeHz);
    for (const [tMs, db] of stops) {
      doc = addKeyframe(doc, "a", "volumeDb", "x", tMs, db, 0, bakeHz);
    }
    return doc;
  }

  const lane = (doc: TimelineDocument) =>
    (doc.elements.a as any).animation?.volumeDb;

  it("mints the block on an audio clip that had none", () => {
    // The case the effect families never had to handle: an audio clip carries
    // no `animation` at all until its level is keyed.
    expect((base().elements.a as any).animation).toBeUndefined();
    expect(lane(keyed([]))?.isActivate).toBe(true);
  });

  it("deletes the block again when an empty track is switched off", () => {
    // The whole persistence contract. A clip keyed and then unkeyed has to
    // save exactly the way one that was never keyed does, which is what keeps
    // `SCHEMA_VERSION` where it is.
    //
    // Armed with no seed, so the track really is empty. Arming *with* one
    // plants a keyframe, and switching a track off deliberately keeps its
    // curve; the path that empties a real envelope is removing its last point,
    // which the `removeLevelKeyframe` case below covers.
    const armed = setTrackActive(base(), "a", "volumeDb", true, undefined, bakeHz);
    expect((armed.elements.a as any).animation?.volumeDb).toBeDefined();
    const bare = setTrackActive(armed, "a", "volumeDb", false, undefined, bakeHz);
    expect((bare.elements.a as any).animation).toBeUndefined();
  });

  it("keeps the curve when a non-empty track is switched off", () => {
    // A stopwatch turned off is not a delete: the static level wins while it
    // is off, and turning it back on brings the envelope back.
    const doc = keyed([[0, 0], [1000, -30]]);
    const off = setTrackActive(doc, "a", "volumeDb", false, undefined, bakeHz);
    expect(lane(off).x).toHaveLength(2);
    expect(volumeDbAt(off.elements.a, 1000)).toBe(volumeDbOf(off.elements.a));
  });

  describe("offsetLevelEnvelope", () => {
    it("shifts every keyframe, keeping the shape the user drew", () => {
      const doc = keyed([[0, 0], [1000, -20]]);
      const moved = offsetLevelEnvelope(doc, "a", -6, bakeHz);
      expect(volumeDbAt(moved.elements.a, 0)).toBeCloseTo(-6, 4);
      expect(volumeDbAt(moved.elements.a, 1000)).toBeCloseTo(-26, 4);
    });

    it("declines by identity on a clip with no envelope", () => {
      // The caller wants `setVolumeDb` there. Arming a track instead would
      // turn a drag on an ordinary clip into a keyframe nobody asked for.
      const doc = base();
      expect(offsetLevelEnvelope(doc, "a", -6, bakeHz)).toBe(doc);
      expect(offsetLevelEnvelope(keyed([[0, 0]]), "a", 0, bakeHz)).toBeDefined();
    });

    it("flattens against the ceiling rather than refusing", () => {
      // What a fader does. Recoverable, too: dragging back down restores the
      // shape of everything that did not hit the stop.
      const doc = keyed([[0, 0], [1000, -40]]);
      const moved = offsetLevelEnvelope(doc, "a", 60, bakeHz);
      expect(volumeDbAt(moved.elements.a, 0)).toBeCloseTo(12, 4);
      expect(volumeDbAt(moved.elements.a, 1000)).toBeCloseTo(12, 4);
    });
  });

  describe("moveLevelKeyframe", () => {
    it("moves a point in time and level", () => {
      const doc = keyed([[0, 0], [1000, -20]]);
      const moved = moveLevelKeyframe(doc, "a", 1, 600, -30, bakeHz);
      expect(volumeDbAt(moved.elements.a, 600)).toBeCloseTo(-30, 4);
    });

    it("keeps a point inside the clip", () => {
      // A keyframe past the end never plays, so letting a drag put one there
      // would report success for an edit with no audible effect.
      const doc = keyed([[0, 0], [1000, -20]]);
      const moved = moveLevelKeyframe(doc, "a", 1, 999_999, -20, bakeHz);
      const times = lane(moved).x.map((k: any) => k.p[0]);
      expect(Math.max(...times)).toBeLessThanOrEqual(spanLength(doc.elements.a));
    });

    it("does not quantize the time to the frame grid", () => {
      // `isFrameLocked` exempts audio: frame alignment is a picture
      // constraint, and a gain change is heard when it happens.
      const doc = keyed([[0, 0], [1000, -20]]);
      const moved = moveLevelKeyframe(doc, "a", 1, 617.5, -20, bakeHz);
      const times = lane(moved).x.map((k: any) => k.p[0]);
      expect(times).toContain(617.5);
    });
  });

  describe("addLevelKeyframe", () => {
    it("arms the track from the static level on the first point", () => {
      const doc = setVolumeDb(base(), "a", -9);
      const armed = addLevelKeyframe(doc, "a", 500, bakeHz);
      expect(lane(armed).isActivate).toBe(true);
      expect(volumeDbAt(armed.elements.a, 500)).toBeCloseTo(-9, 4);
    });

    it("plants on the curve, leaving the shape either side untouched", () => {
      // The difference between planting and adding: `addKeyframe` seats fresh
      // handles and re-shapes both neighbouring segments, which is not what
      // adding a point to a rubber band means.
      const doc = keyed([[0, 0], [1000, -40]]);
      const before = [200, 500, 800].map((t) => volumeDbAt(doc.elements.a, t));
      const planted = addLevelKeyframe(doc, "a", 500, bakeHz);
      expect(lane(planted).x).toHaveLength(3);
      const after = [200, 500, 800].map((t) =>
        volumeDbAt(planted.elements.a, t),
      );
      after.forEach((db, i) => expect(db).toBeCloseTo(before[i], 3));
    });

    it("declines on a clip with no level to animate", () => {
      const doc = base();
      expect(addLevelKeyframe(doc, "missing", 500, bakeHz)).toBe(doc);
    });
  });

  describe("removeLevelKeyframe", () => {
    it("takes one point away", () => {
      const doc = keyed([[0, 0], [500, -10], [1000, -20]]);
      const fewer = removeLevelKeyframe(doc, "a", 1, bakeHz);
      expect(lane(fewer).x).toHaveLength(2);
    });

    it("settles the level it held when the last point goes", () => {
      // Without this the clip jumps to whatever `volumeDb` happened to hold,
      // which for a clip that was only ever keyframed is 0 dB, so deleting
      // the last point of a fade-out would make it suddenly loud.
      let doc = keyed([[0, -24]]);
      doc = removeLevelKeyframe(doc, "a", 0, bakeHz);
      expect(volumeDbOf(doc.elements.a)).toBeCloseTo(-24, 4);
      expect((doc.elements.a as any).animation).toBeUndefined();
    });

    it("declines by identity on an index that is not there", () => {
      const doc = keyed([[0, 0]]);
      expect(removeLevelKeyframe(doc, "a", 7, bakeHz)).toBe(doc);
      expect(removeLevelKeyframe(base(), "a", 0, bakeHz)).toBeDefined();
    });
  });

  describe("detach", () => {
    it("carries the envelope to the clip that now owns the sound", () => {
      // Required rather than tidy: after the detach the video fails
      // `isAudibleElement`, so its `volumeDb` track is an orphan and the next
      // ingress deletes it.
      let doc = normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v1", "video", 0)],
        elements: {
          v: videoElement({
            trackId: "v1",
            startTime: 0,
            duration: 1000,
            trim: { startTime: 0, endTime: 1000 },
            sourceDuration: 1000,
            isExistAudio: true,
          }),
        },
      });
      doc = setTrackActive(doc, "v", "volumeDb", true, { atMs: 0 }, bakeHz);
      doc = addKeyframe(doc, "v", "volumeDb", "x", 0, 0, 0, bakeHz);
      doc = addKeyframe(doc, "v", "volumeDb", "x", 900, -40, 0, bakeHz);

      const detached = detachAudio(doc, "v", "twin", "a9");
      expect((detached.elements.v as any).animation?.volumeDb).toBeUndefined();
      expect(volumeDbAt(detached.elements.twin, 900)).toBeCloseTo(-40, 3);
    });
  });
});
