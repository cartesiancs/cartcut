/**
 * Regression suite for "an added clip does not appear until you scrub".
 *
 * Assigning `currentTime` only *requests* a frame; the decoded picture lands
 * later, on `seeked`. The preview used to repaint only when an asset finished
 * *decoding*, and `syncPlayback` issues a fresh seek during that very repaint —
 * so it painted the frame from before the seek, which for a clip that had just
 * been added was no frame at all. Nothing listened for the seek landing, so the
 * canvas stayed stale until an unrelated store change forced another paint,
 * i.e. until the user moved the playhead or hit play.
 *
 * These tests pin the two halves of the contract that fix it:
 *   1. `applyIntent` / `syncPlayback` report which handles they seeked.
 *   2. `whenSeeksLand` calls back once those frames have actually arrived.
 */

import { describe, it, expect, vi } from "vitest";
import {
  applyIntent,
  intentFor,
  syncPlayback,
  whenSeeksLand,
  type MediaHandle,
} from "./playback";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { videoElement } from "../renderer/testing";

/**
 * A `<video>` stand-in that models the part the bug lives in: the frame the
 * element would paint lags `currentTime` until the seek is flushed.
 */
function seekableVideo(over: Partial<MediaHandle> = {}) {
  const listeners: Record<string, (() => void)[]> = {};

  const handle = {
    currentTime: 0,
    muted: false,
    playbackRate: 1,
    paused: true,
    /** What `drawImage` would actually sample right now. */
    decodedFrameTime: 0,
    play() {
      (this as any).paused = false;
    },
    pause() {
      (this as any).paused = true;
    },
    addEventListener(
      type: string,
      listener: () => void,
      options?: { once?: boolean },
    ) {
      listeners[type] ??= [];
      listeners[type].push(
        options?.once
          ? () => {
              listener();
            }
          : listener,
      );
    },
    /** The decoder catching up, some frames after the seek was requested. */
    flushSeek() {
      this.decodedFrameTime = this.currentTime;
      const seeked = listeners["seeked"] ?? [];
      listeners["seeked"] = [];
      for (const listener of seeked) {
        listener();
      }
    },
    listenerCount(type: string) {
      return (listeners[type] ?? []).length;
    },
    ...over,
  };

  return handle;
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

describe("applyIntent reports whether it seeked", () => {
  it("reports a seek when it moves the handle", () => {
    const handle = seekableVideo();
    const seeked = applyIntent(handle, intentFor(clip(), 6000, false));

    expect(seeked).toBe(true);
    expect(handle.currentTime).toBe(3);
  });

  it("reports nothing when the handle is already there", () => {
    const handle = seekableVideo({ currentTime: 3 });
    const seeked = applyIntent(handle, intentFor(clip(), 6000, false));

    expect(seeked).toBe(false);
  });

  it("reports nothing for drift inside the playing tolerance", () => {
    const handle = seekableVideo({ currentTime: 3.02, paused: false });
    const seeked = applyIntent(handle, intentFor(clip(), 6000, true));

    expect(seeked).toBe(false);
  });
});

describe("syncPlayback reports the seeked ids", () => {
  it("names a handle it moved", () => {
    const handle = seekableVideo();
    const seeked = syncPlayback(doc({ a: clip() }), 6000, false, { a: handle });

    expect(seeked).toEqual([{ elementId: "a", sourceTimeSec: 3 }]);
  });

  it("stays quiet when nothing moved", () => {
    const handle = seekableVideo({ currentTime: 3 });
    const seeked = syncPlayback(doc({ a: clip() }), 6000, false, { a: handle });

    expect(seeked).toEqual([]);
  });

  it("names only the handles that actually moved", () => {
    const moved = seekableVideo();
    const settled = seekableVideo({ currentTime: 3 });
    const seeked = syncPlayback(doc({ a: clip(), b: clip() }), 6000, false, {
      a: moved,
      b: settled,
    });

    expect(seeked.map((s) => s.elementId)).toEqual(["a"]);
  });

  it("does not name a handle whose element is gone", () => {
    const orphan = seekableVideo({ currentTime: 99, paused: false });
    const seeked = syncPlayback(doc({ a: clip() }), 6000, false, {
      gone: orphan,
    });

    expect(seeked).toEqual([]);
    expect(orphan.muted).toBe(true);
  });
});

describe("whenSeeksLand", () => {
  it("calls back only once the frame has arrived", () => {
    const handle = seekableVideo();
    const repaint = vi.fn();

    const seeks = syncPlayback(doc({ a: clip() }), 6000, false, { a: handle });
    whenSeeksLand({ a: handle }, seeks, repaint);

    // The seek is requested but the decoder has not caught up yet — this is
    // exactly the moment the old code painted, and got the stale frame.
    expect(repaint).not.toHaveBeenCalled();

    handle.flushSeek();

    expect(repaint).toHaveBeenCalledTimes(1);
    expect(handle.decodedFrameTime).toBe(3);
  });

  it("does not leave a listener behind per repaint", () => {
    const handle = seekableVideo();
    const repaint = vi.fn();

    // The preview repaints many times while a seek is outstanding.
    const seek = [{ elementId: "a", sourceTimeSec: 3 }];
    whenSeeksLand({ a: handle }, seek, repaint);
    whenSeeksLand({ a: handle }, seek, repaint);
    whenSeeksLand({ a: handle }, seek, repaint);

    handle.flushSeek();
    expect(handle.listenerCount("seeked")).toBe(0);
  });

  it("does not wait twice on the same target", () => {
    // The loop this prevents: a browser may land a seek slightly off the
    // request, and the paused tolerance is zero, so the next reconcile re-issues
    // the identical seek. Repainting on every one of those landings would spin
    // at frame rate forever.
    const handle = seekableVideo();
    const repaint = vi.fn();
    const awaited = new Map<string, number>();
    const seek = [{ elementId: "a", sourceTimeSec: 3 }];

    whenSeeksLand({ a: handle }, seek, repaint, awaited);
    expect(handle.listenerCount("seeked")).toBe(1);

    whenSeeksLand({ a: handle }, seek, repaint, awaited);
    whenSeeksLand({ a: handle }, seek, repaint, awaited);
    expect(handle.listenerCount("seeked")).toBe(1);

    handle.flushSeek();
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it("waits again once the target actually moves", () => {
    const handle = seekableVideo();
    const repaint = vi.fn();
    const awaited = new Map<string, number>();

    whenSeeksLand(
      { a: handle },
      [{ elementId: "a", sourceTimeSec: 3 }],
      repaint,
      awaited,
    );
    handle.flushSeek();
    expect(repaint).toHaveBeenCalledTimes(1);

    // The user scrubbed somewhere else: a genuinely new frame to wait for.
    whenSeeksLand(
      { a: handle },
      [{ elementId: "a", sourceTimeSec: 4 }],
      repaint,
      awaited,
    );
    handle.flushSeek();
    expect(repaint).toHaveBeenCalledTimes(2);
  });

  it("tracks targets per element", () => {
    const a = seekableVideo();
    const b = seekableVideo();
    const repaint = vi.fn();
    const awaited = new Map<string, number>();

    // Same target value, different elements — both must be waited on.
    whenSeeksLand(
      { a, b },
      [
        { elementId: "a", sourceTimeSec: 3 },
        { elementId: "b", sourceTimeSec: 3 },
      ],
      repaint,
      awaited,
    );

    expect(a.listenerCount("seeked")).toBe(1);
    expect(b.listenerCount("seeked")).toBe(1);
  });

  it("ignores ids with no handle", () => {
    const repaint = vi.fn();
    expect(() =>
      whenSeeksLand({}, [{ elementId: "missing", sourceTimeSec: 1 }], repaint),
    ).not.toThrow();
    expect(repaint).not.toHaveBeenCalled();
  });

  it("ignores a handle that cannot report seeks", () => {
    // A plain `MediaHandle` has no `addEventListener`. It must be skipped
    // rather than fired early — an early call is the bug we are fixing.
    const plain: MediaHandle = {
      currentTime: 0,
      muted: false,
      playbackRate: 1,
      paused: true,
      play() {},
      pause() {},
    };
    const repaint = vi.fn();

    expect(() =>
      whenSeeksLand(
        { a: plain },
        [{ elementId: "a", sourceTimeSec: 1 }],
        repaint,
      ),
    ).not.toThrow();
    expect(repaint).not.toHaveBeenCalled();
  });
});

describe("the reported symptom: a clip added under the playhead", () => {
  /**
   * Adding an asset places it at the cursor, so the playhead lands *inside* the
   * new clip. The handle is fresh at `currentTime` 0 while the clip's trim
   * starts at 2s, so reconciling it always seeks — and the frame is therefore
   * never ready on the paint that follows the decode.
   */
  it("seeks, and the frame is only right after the seek lands", () => {
    const cursor = 5000;
    const added = clip({ startTime: cursor });
    const handle = seekableVideo();
    const repaint = vi.fn();

    const seeks = syncPlayback(doc({ added }), cursor, false, {
      added: handle,
    });
    whenSeeksLand({ added: handle }, seeks, repaint);

    expect(seeks).toEqual([{ elementId: "added", sourceTimeSec: 2 }]);

    // Painting here — all the old code did — samples the frame from before the
    // seek, which on a brand new handle is the wrong one.
    expect(handle.decodedFrameTime).toBe(0);
    expect(handle.currentTime).toBe(2);

    handle.flushSeek();

    expect(repaint).toHaveBeenCalledTimes(1);
    expect(handle.decodedFrameTime).toBe(2);
  });

  it("keeps reporting the seek until the frame lands, not just once", () => {
    // Repaints triggered by unrelated store changes must not clear the debt.
    const cursor = 5000;
    const added = clip({ startTime: cursor });
    const handle = seekableVideo();

    const first = syncPlayback(doc({ added }), cursor, false, {
      added: handle,
    });
    expect(first.map((s) => s.elementId)).toEqual(["added"]);

    // Same cursor, handle now parked where it was asked to be: no new seek, so
    // nothing new to wait for.
    const second = syncPlayback(doc({ added }), cursor, false, {
      added: handle,
    });
    expect(second).toEqual([]);
  });
});
