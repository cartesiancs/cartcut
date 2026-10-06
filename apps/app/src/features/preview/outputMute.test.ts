import { describe, it, expect } from "vitest";
import {
  syncPlayback,
  writeVolume,
  type GainSink,
  type MediaHandle,
} from "../timeline/playback";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { videoElement } from "../renderer/testing";
import { mutedSink } from "./outputMute";

function fakeVideo(): MediaHandle {
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
  };
}

/** A -6 dB clip covering 0 to 4s, so a cursor at 1s is inside it. */
function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      a: videoElement({
        startTime: 0,
        duration: 4000,
        speed: 1,
        trim: { startTime: 0, endTime: 4000 },
        sourceDuration: 4000,
        volumeDb: -6,
      }),
    },
  });
}

function sync(handle: MediaHandle, sink: GainSink) {
  syncPlayback(doc(), 1000, true, { a: handle }, undefined, new Map(), sink);
}

describe("mutedSink", () => {
  it("hands back the sink itself while unmuted", () => {
    expect(mutedSink(writeVolume, false)).toBe(writeVolume);
  });

  it("silences a playing clip and leaves it rolling and unmuted", () => {
    const handle = fakeVideo();
    sync(handle, mutedSink(writeVolume, true));

    expect(handle.volume).toBe(0);
    // `muted` still answers "is this clip in its window", and the handle keeps
    // rolling because the picture comes off it.
    expect(handle.muted).toBe(false);
    expect(handle.paused).toBe(false);
  });

  it("restores the document's level on the next sync after unmuting", () => {
    const handle = fakeVideo();
    sync(handle, writeVolume);
    const level = handle.volume;

    sync(handle, mutedSink(writeVolume, true));
    expect(handle.volume).toBe(0);
    // The two states have to disagree, or the round trip below proves nothing.
    expect(level).not.toBe(0);

    sync(handle, mutedSink(writeVolume, false));
    expect(handle.volume).toBe(level);
  });

  it("writes the zero through the wrapped sink, never past it", () => {
    // A boosted clip's level lives on a GainNode with `volume` pinned at 1, so
    // a mute that wrote `volume` itself would leave the node playing.
    const written: number[] = [];
    const nodeSink: GainSink = (_handle, gain) => {
      written.push(gain);
    };
    const handle = fakeVideo();

    sync(handle, mutedSink(nodeSink, true));

    expect(written).toEqual([0]);
    expect(handle.volume).toBe(1);
  });
});
