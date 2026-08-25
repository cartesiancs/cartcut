import { describe, it, expect } from "vitest";
import {
  PLAYING_DRIFT_TOLERANCE_SEC,
  applyIntent,
  intentFor,
  syncPlayback,
  type MediaHandle,
} from "./playback";
import { splitAt } from "./clipEdit";
import { moveClip } from "./clipOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { audioElement, imageElement, videoElement } from "../renderer/testing";

/** Stands in for a `<video>`; records everything this layer does to it. */
function fakeVideo(over: Partial<MediaHandle> = {}) {
  return {
    currentTime: 0,
    muted: false,
    volume: 1,
    playbackRate: 1,
    paused: true,
    play() {
      (this as any).paused = false;
    },
    pause() {
      (this as any).paused = true;
    },
    ...over,
  };
}

/** A 10s source, 4s of it used from 2s in, sitting at 5s on the timeline. */
function clip(over = {}) {
  return videoElement({
    startTime: 5000,
    duration: 4000,
    speed: 1,
    trim: { startTime: 2000, endTime: 6000 },
    sourceDuration: 10_000,
    ...over,
  });
}

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  });
}

describe("intentFor", () => {
  it("maps the playhead to the matching source frame", () => {
    const intent = intentFor(clip(), 6000, true);
    expect(intent.sourceTimeSec).toBe(3);
    expect(intent.inWindow).toBe(true);
  });

  it("plays and unmutes only inside the clip's window", () => {
    expect(intentFor(clip(), 6000, true)).toMatchObject({
      muted: false,
      playing: true,
    });
    expect(intentFor(clip(), 1000, true)).toMatchObject({
      muted: true,
      playing: false,
    });
    expect(intentFor(clip(), 20_000, true)).toMatchObject({
      muted: true,
      playing: false,
    });
  });

  it("reports the clip's authored level", () => {
    expect(intentFor(clip(), 6000, true).volume).toBe(1);
    expect(intentFor(clip({ volumeDb: -6 }), 6000, true).volume).toBe(0.501187);
    expect(intentFor(clip({ volumeDb: -60 }), 6000, true).volume).toBe(0);
  });

  it("reports the level independently of the window", () => {
    // Level and mute are orthogonal: `muted` is positional and flips with the
    // playhead, the level is document state and only the user changes it.
    const mixed = clip({ volumeDb: -6 });
    for (const cursor of [1000, 6000, 20_000]) {
      expect(intentFor(mixed, cursor, true).volume).toBe(0.501187);
    }
  });

  it("reports a level for a video whose audio has been detached", () => {
    // Silenced by `muted`, but the level is kept — the clip is still rolling
    // for its picture, and re-attaching later must not have lost it.
    const detached = clip({ volumeDb: -6, audioDetached: true });
    expect(intentFor(detached, 6000, true)).toMatchObject({
      muted: true,
      volume: 0.501187,
      playing: true,
    });
  });

  it("never asks for a negative position for a clip still ahead", () => {
    // Browsers silently pin a negative currentTime to 0, which left the clip
    // playing the wrong footage for the rest of the session.
    const intent = intentFor(clip(), 0, true);
    expect(intent.sourceTimeSec).toBeGreaterThanOrEqual(0);
    expect(intent.sourceTimeSec).toBe(2);
  });

  it("parks a clip that has not started at its trim-in point", () => {
    // So entering the window shows the right frame immediately.
    expect(intentFor(clip(), 0, true).sourceTimeSec).toBe(2);
  });

  it("parks a finished clip at its trim-out point", () => {
    expect(intentFor(clip(), 50_000, true).sourceTimeSec).toBe(6);
  });

  it("is silent everywhere when playback is stopped", () => {
    expect(intentFor(clip(), 6000, false).playing).toBe(false);
  });

  it("carries the clip's rate", () => {
    expect(intentFor(clip({ speed: 2 }), 6000, true).rate).toBe(2);
  });

  it("advances through the source at the clip's rate", () => {
    // 4s of source at 2x occupies 2s of timeline: halfway is 1s in.
    const fast = clip({ speed: 2 });
    expect(intentFor(fast, 6000, true).sourceTimeSec).toBe(4);
  });

  it("treats the window as half-open, like every other span check", () => {
    expect(intentFor(clip(), 5000, true).inWindow).toBe(true);
    expect(intentFor(clip(), 8999, true).inWindow).toBe(true);
    expect(intentFor(clip(), 9000, true).inWindow).toBe(false);
  });

  it("handles an audio clip the same way", () => {
    const song = audioElement({
      startTime: 1000,
      duration: 2000,
      trim: { startTime: 8000, endTime: 10_000 },
      sourceDuration: 30_000,
    });
    expect(intentFor(song, 2000, true).sourceTimeSec).toBe(9);
    expect(intentFor(song, 500, true).muted).toBe(true);
  });
});

describe("a video whose audio has been detached", () => {
  const detached = () => clip({ audioDetached: true });

  it("is silent inside its own window", () => {
    // Without this the preview plays the clip twice — once from the `<video>`
    // handle and once from the audio clip that now owns the sound.
    expect(intentFor(detached(), 6000, true).muted).toBe(true);
  });

  it("keeps rolling, because the picture comes off the same handle", () => {
    // Muting and pausing are different decisions. Pausing here would freeze
    // the frame the moment a user detached the audio.
    const intent = intentFor(detached(), 6000, true);
    expect(intent.playing).toBe(true);
    expect(intent.inWindow).toBe(true);
  });

  it("still seeks to the frame the playhead asks for", () => {
    expect(intentFor(detached(), 6000, true).sourceTimeSec).toBe(
      intentFor(clip(), 6000, true).sourceTimeSec,
    );
  });

  it("plays in sync with the audio clip that took its sound", () => {
    // The twin copies `startTime`, `trim` and `speed`, so both handles are
    // asked for the same source second at every cursor. This is the assertion
    // that would catch a twin built from the wrong fields.
    const video = clip({ speed: 2 });
    const twin = audioElement({
      startTime: video.startTime,
      duration: video.duration,
      trim: { ...video.trim },
      sourceDuration: video.sourceDuration,
      speed: video.speed,
    });

    for (const cursor of [5000, 5500, 6000, 6800]) {
      expect(intentFor(twin, cursor, true).sourceTimeSec).toBe(
        intentFor(video, cursor, true).sourceTimeSec,
      );
    }
  });

  it("silences the handle without silencing the twin", () => {
    const video = detached();
    const twin = audioElement({
      startTime: video.startTime,
      duration: video.duration,
      trim: { ...video.trim },
      sourceDuration: video.sourceDuration,
    });

    expect(intentFor(video, 6000, true).muted).toBe(true);
    expect(intentFor(twin, 6000, true).muted).toBe(false);
  });

  it("stays silent when the flag is absent but the file has no audio", () => {
    expect(intentFor(clip({ isExistAudio: false }), 6000, true).muted).toBe(
      true,
    );
  });

  it("leaves an ordinary video audible", () => {
    expect(intentFor(clip(), 6000, true).muted).toBe(false);
  });
});

describe("the drag-drift bug", () => {
  it("shows the same footage after a clip is moved", () => {
    // The bug: playback used a snapshot of the clip taken when the file
    // loaded, so the error equalled the drag distance. Taking the live element
    // makes that unrepresentable.
    const before = clip();
    const source = intentFor(before, 6000, true).sourceTimeSec;

    const moved = { ...before, startTime: before.startTime + 3000 };
    const after = intentFor(moved, 9000, true).sourceTimeSec;

    expect(after).toBe(source);
  });

  it("stays correct however far the clip is dragged", () => {
    const base = clip();
    for (const shift of [100, 1000, 7500, 60_000]) {
      const moved = { ...base, startTime: base.startTime + shift };
      // The same offset into the clip must always be the same frame.
      expect(intentFor(moved, 6000 + shift, true).sourceTimeSec).toBe(3);
    }
  });

  it("survives a real move through clipOps", () => {
    const base = doc({ a: clip({ trackId: "v1" }) });
    const moved = moveClip(base, "a", 4000);
    expect(intentFor(moved.elements.a, 10_000, true).sourceTimeSec).toBe(3);
  });
});

describe("the audio-overlap bug", () => {
  it("gives each half of a split its own source window", () => {
    const parts = splitAt(clip(), 7000)!;
    // Left half covers source 2..4s, right half 4..6s.
    expect(intentFor(parts.left, 6000, true).sourceTimeSec).toBe(3);
    expect(intentFor(parts.right, 8000, true).sourceTimeSec).toBe(5);
  });

  it("silences the half the playhead has left", () => {
    // This is the actual complaint: after the cut, the first half kept
    // sounding over the second.
    const parts = splitAt(clip(), 7000)!;
    const left = fakeVideo();
    const right = fakeVideo();

    const cut = doc({ a: parts.left, b: { ...parts.right, trackId: "v1" } });
    syncPlayback(cut, 8000, true, { a: left, b: right });

    expect(left.muted).toBe(true);
    expect(left.paused).toBe(true);
    expect(right.muted).toBe(false);
    expect(right.paused).toBe(false);
  });

  it("never lets two handles sound at once", () => {
    // Clips on a track cannot overlap, so at most one can be audible.
    const parts = splitAt(clip(), 7000)!;
    const handles = { a: fakeVideo(), b: fakeVideo() };
    const cut = doc({ a: parts.left, b: { ...parts.right, trackId: "v1" } });

    for (let t = 0; t <= 12_000; t += 250) {
      syncPlayback(cut, t, true, handles);
      const audible = Object.values(handles).filter(
        (h) => !h.muted && !h.paused,
      );
      expect(audible.length).toBeLessThanOrEqual(1);
    }
  });

  it("silences a clip the moment the playhead leaves it", () => {
    const handle = fakeVideo();
    const only = doc({ a: clip() });

    syncPlayback(only, 6000, true, { a: handle });
    expect(handle.muted).toBe(false);

    syncPlayback(only, 9000, true, { a: handle });
    expect(handle.muted).toBe(true);
    expect(handle.paused).toBe(true);
  });

  it("silences a handle whose clip has been deleted", () => {
    const handle = fakeVideo({ muted: false });
    handle.play();

    syncPlayback(doc({}), 1000, true, { a: handle });

    expect(handle.muted).toBe(true);
    expect(handle.paused).toBe(true);
  });

  it("leaves an orphaned handle's volume alone", () => {
    // Muted and paused is already completely silent, and this branch has no
    // change guard — it runs every frame — so a volume write here would cost
    // one pointless assignment per frame per orphan, forever. The level lives
    // in the document, so an undo re-derives it.
    const handle = fakeVideo({ muted: false, volume: 0.5 });
    syncPlayback(doc({}), 1000, true, { a: handle });
    expect(handle.volume).toBe(0.5);
  });
});

describe("applyIntent", () => {
  it("seeks a paused handle exactly, so scrubbing moves the frame", () => {
    const handle = fakeVideo({ currentTime: 3, paused: true });
    applyIntent(handle, intentFor(clip(), 6100, false));
    expect(handle.currentTime).toBeCloseTo(3.1);
  });

  it("leaves a rolling handle alone at the offset healthy playback has", () => {
    // A media element settles a constant ~40ms behind the wall clock because
    // starting playback costs a few frames. Correcting that is what made the
    // picture judder: each seek starved the decoder into falling further
    // behind, so we seeked again — about 23 times a second.
    const handle = fakeVideo({ currentTime: 3 - 0.04, paused: false });
    applyIntent(handle, intentFor(clip(), 6000, true));
    expect(handle.currentTime).toBe(3 - 0.04);
  });

  it("pulls a rolling handle back only on a real desync", () => {
    const handle = fakeVideo({ currentTime: 1.2, paused: false });
    applyIntent(handle, intentFor(clip(), 6000, true));
    expect(handle.currentTime).toBe(3);
  });

  it("takes the rolling tolerance boundary as stated", () => {
    const under = fakeVideo({
      currentTime: 3 + PLAYING_DRIFT_TOLERANCE_SEC * 0.9,
      paused: false,
    });
    applyIntent(under, intentFor(clip(), 6000, true));
    expect(under.currentTime).not.toBe(3);

    const over = fakeVideo({
      currentTime: 3 + PLAYING_DRIFT_TOLERANCE_SEC * 1.1,
      paused: false,
    });
    applyIntent(over, intentFor(clip(), 6000, true));
    expect(over.currentTime).toBe(3);
  });

  it("places a clip exactly when it is entered, not loosely", () => {
    // The generous window is only for a handle already rolling. One starting
    // up must land on its first frame, or the cut shows the wrong footage.
    const handle = fakeVideo({ currentTime: 2, paused: true });
    applyIntent(handle, intentFor(clip(), 6000, true));
    expect(handle.currentTime).toBe(3);
    expect(handle.paused).toBe(false);
  });

  it("does not rewrite rate or mute that already match", () => {
    // These run for every clip on every animation frame, and a media element
    // treats each assignment as a real state change.
    let rateWrites = 0;
    let muteWrites = 0;
    let volumeWrites = 0;
    let rate = 1;
    let muted = false;
    let volume = 1;
    const handle: MediaHandle = {
      currentTime: 3,
      paused: false,
      play() {},
      pause() {},
      get playbackRate() {
        return rate;
      },
      set playbackRate(v: number) {
        rate = v;
        rateWrites++;
      },
      get muted() {
        return muted;
      },
      set muted(v: boolean) {
        muted = v;
        muteWrites++;
      },
      get volume() {
        return volume;
      },
      set volume(v: number) {
        volume = v;
        volumeWrites++;
      },
    };

    for (let i = 0; i < 10; i++) {
      applyIntent(handle, intentFor(clip(), 6000, true));
    }
    expect(rateWrites).toBe(0);
    expect(muteWrites).toBe(0);
    // `gainOf` is rounded precisely so this stays 0: an unrounded value that
    // varied in its last bits would write on every frame, forever.
    expect(volumeWrites).toBe(0);
  });

  it("does not write volume when a clip leaves its window", () => {
    // The reason the intent's volume does not depend on `inWindow`. Crossing a
    // boundary is a `muted` change and nothing else; if the level tracked the
    // window it would be rewritten twice on every crossing.
    let volumeWrites = 0;
    let volume = 0.501187;
    const handle: MediaHandle = {
      currentTime: 3,
      muted: false,
      playbackRate: 1,
      paused: false,
      play() {},
      pause() {},
      get volume() {
        return volume;
      },
      set volume(v: number) {
        volume = v;
        volumeWrites++;
      },
    };

    const mixed = clip({ volumeDb: -6 });
    applyIntent(handle, intentFor(mixed, 6000, true)); // inside
    applyIntent(handle, intentFor(mixed, 20_000, true)); // past the end
    applyIntent(handle, intentFor(mixed, 6000, true)); // back inside
    expect(volumeWrites).toBe(0);
    expect(handle.volume).toBe(0.501187);
  });

  it("seeks before starting playback", () => {
    // Otherwise a handle entering its window emits a burst of audio from
    // wherever it had run on to.
    const seen: string[] = [];
    const handle: MediaHandle = {
      muted: false,
      volume: 1,
      playbackRate: 1,
      paused: true,
      get currentTime() {
        return 0;
      },
      set currentTime(_v: number) {
        seen.push("seek");
      },
      play() {
        seen.push("play");
      },
      pause() {
        seen.push("pause");
      },
    };

    applyIntent(handle, intentFor(clip(), 6000, true));
    expect(seen).toEqual(["seek", "play"]);
  });

  it("does not re-seek a parked handle every frame", () => {
    // An out-of-window handle sits at a fixed point, so repeated syncs must be
    // no-ops rather than a seek per animation frame.
    let seeks = 0;
    let value = 2;
    const handle: MediaHandle = {
      muted: false,
      volume: 1,
      playbackRate: 1,
      paused: true,
      get currentTime() {
        return value;
      },
      set currentTime(v: number) {
        value = v;
        seeks++;
      },
      play() {},
      pause() {},
    };

    for (let i = 0; i < 10; i++) {
      applyIntent(handle, intentFor(clip(), 0, true));
    }
    expect(seeks).toBe(0);
  });

  it("sets the playback rate from the clip", () => {
    const handle = fakeVideo();
    applyIntent(handle, intentFor(clip({ speed: 2 }), 6000, true));
    expect(handle.playbackRate).toBe(2);
  });

  it("sets the volume from the clip's level", () => {
    const handle = fakeVideo();
    applyIntent(handle, intentFor(clip({ volumeDb: -6 }), 6000, true));
    expect(handle.volume).toBe(0.501187);
    expect(handle.muted).toBe(false);
  });

  it("silences a clip at the floor without muting it", () => {
    // Zero gain, not `muted`: mute is where the clip is, level is how loud it
    // was set. Conflating them would leave nowhere to keep the user's choice.
    const handle = fakeVideo();
    applyIntent(handle, intentFor(clip({ volumeDb: -60 }), 6000, true));
    expect(handle.volume).toBe(0);
    expect(handle.muted).toBe(false);
  });

  it("pauses a handle that is playing when it should not be", () => {
    const handle = fakeVideo({ paused: false });
    applyIntent(handle, intentFor(clip(), 6000, false));
    expect(handle.paused).toBe(true);
  });

  it("does not call play on a handle that is already playing", () => {
    let plays = 0;
    const handle: MediaHandle = {
      currentTime: 3,
      muted: false,
      volume: 1,
      playbackRate: 1,
      paused: false,
      play() {
        plays++;
      },
      pause() {},
    };
    applyIntent(handle, intentFor(clip(), 6000, true));
    expect(plays).toBe(0);
  });
});

describe("syncPlayback", () => {
  it("handles a whole document in one pass", () => {
    const a = fakeVideo();
    const b = fakeVideo();
    const two = doc({
      a: clip({ startTime: 0, trackId: "v1" }),
      b: clip({ startTime: 4000, trackId: "v1" }),
    });

    syncPlayback(two, 5000, true, { a, b });

    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
  });

  it("ignores elements with no handle", () => {
    const a = fakeVideo();
    const two = doc({
      a: clip({ startTime: 0, trackId: "v1" }),
      other: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
    });
    expect(() => syncPlayback(two, 500, true, { a })).not.toThrow();
  });
});
