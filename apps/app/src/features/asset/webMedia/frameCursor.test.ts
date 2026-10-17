import { describe, expect, it } from "vitest";
import { FrameCursor, type CursorSample, type SamplePort } from "./frameCursor";

/**
 * A file of frames at `rate` per second with a key frame every `gop`, decoded
 * the way a demuxer would: `open` starts at the key frame before the request
 * and skips forward to the frame on show, and every frame handed out is
 * counted until closed.
 */
function fakeFile(rate: number, frameCount: number, gop = 1_000_000) {
  const timestamps = Array.from({ length: frameCount }, (_, i) => i / rate);
  const alive = new Set<number>();
  const log = { opens: [] as number[], decoded: 0, maxAlive: 0 };

  const sample = (index: number): CursorSample<number> => {
    alive.add(index);
    log.maxAlive = Math.max(log.maxAlive, alive.size);
    return {
      timestamp: timestamps[index],
      frame: index,
      close: () => {
        if (!alive.has(index)) {
          throw new Error(`frame ${index} closed twice`);
        }
        alive.delete(index);
      },
    };
  };

  const shownAt = (sec: number) => {
    let index = 0;
    while (index + 1 < frameCount && timestamps[index + 1] <= sec) {
      index++;
    }
    return index;
  };

  const port: SamplePort<number> = {
    open(fromSec) {
      log.opens.push(fromSec);
      const first = shownAt(fromSec);
      let index = Math.floor(first / gop) * gop;
      let done = false;
      return {
        async next() {
          // Frames before the one on show are decoded and discarded, as a
          // decoder must from the key frame on.
          while (!done && index < first) {
            log.decoded++;
            index++;
          }
          if (done || index >= frameCount) {
            return { done: true, value: undefined };
          }
          log.decoded++;
          return { done: false, value: sample(index++) };
        },
        async return() {
          done = true;
          return { done: true, value: undefined };
        },
      };
    },
    async keyFrameAt(sec) {
      return timestamps[Math.floor(shownAt(sec) / gop) * gop];
    },
  };

  return { port, alive, log, timestamps };
}

/** The frame-centre address of project frame `i`, the way `frameAddress.ts` builds it. */
const centre = (i: number, fps: number) => (i * 1000 / fps + 500 / fps) / 1000;

describe("FrameCursor", () => {
  it("shows the frame whose span holds each address, decoding every frame once", async () => {
    const file = fakeFile(30, 90);
    const cursor = new FrameCursor(file.port);
    for (let i = 0; i < 90; i++) {
      const shown = await cursor.at(centre(i, 30));
      expect(shown?.frame).toBe(i);
    }
    expect(file.log.opens).toHaveLength(1);
    expect(file.log.decoded).toBe(90);
    await cursor.close();
  });

  it("never holds more than two frames, and closes them all", async () => {
    const file = fakeFile(120, 600);
    const cursor = new FrameCursor(file.port);
    for (let i = 0; i < 150; i++) {
      await cursor.at(centre(i, 30));
    }
    expect(file.log.maxAlive).toBeLessThanOrEqual(2);
    await cursor.close();
    expect(file.alive.size).toBe(0);
  });

  it("shows the earlier frame where a 30fps centre lands on a 60fps frame's start", async () => {
    const file = fakeFile(60, 120);
    const cursor = new FrameCursor(file.port);
    for (let i = 0; i < 60; i++) {
      // Centre of project frame i is (2i + 1) / 60: exactly where source
      // frame 2i + 1 starts. The tie goes to 2i.
      expect((await cursor.at(centre(i, 30)))?.frame).toBe(2 * i);
    }
    await cursor.close();
  });

  it("breaks the 24-in-60 tie the same way every fifth frame", async () => {
    const file = fakeFile(24, 48);
    const cursor = new FrameCursor(file.port);
    const shown: number[] = [];
    for (let i = 0; i < 100; i++) {
      shown.push((await cursor.at(centre(i, 60)))!.frame);
    }
    // Project frame 2 has its centre at 2.5/60 = 1/24: source frame 1's start.
    expect(shown[2]).toBe(0);
    expect(shown[7]).toBe(2);
    // And off the ties, the frame whose span holds the centre.
    expect(shown[3]).toBe(1);
    expect(shown[99]).toBe(Math.floor(centre(99, 60) * 24));
    await cursor.close();
  });

  it("reopens when asked to go back, and answers the earlier frame", async () => {
    const file = fakeFile(30, 90);
    const cursor = new FrameCursor(file.port);
    expect((await cursor.at(centre(60, 30)))?.frame).toBe(60);
    expect((await cursor.at(centre(10, 30)))?.frame).toBe(10);
    expect(file.log.opens).toHaveLength(2);
    expect(file.alive.size).toBeLessThanOrEqual(2);
    await cursor.close();
    expect(file.alive.size).toBe(0);
  });

  it("jumps to a nearer key frame rather than walking seconds of frames", async () => {
    const file = fakeFile(30, 900, 60);
    const cursor = new FrameCursor(file.port);
    await cursor.at(centre(0, 30));
    const before = file.log.decoded;
    expect((await cursor.at(centre(600, 30)))?.frame).toBe(600);
    // From the key frame at 600, not from frame 1.
    expect(file.log.decoded - before).toBeLessThan(10);
    expect(file.log.opens).toHaveLength(2);
    await cursor.close();
  });

  it("walks a short gap without reopening, even across a key frame", async () => {
    const file = fakeFile(30, 900, 15);
    const cursor = new FrameCursor(file.port);
    await cursor.at(centre(0, 30));
    expect((await cursor.at(centre(20, 30)))?.frame).toBe(20);
    expect(file.log.opens).toHaveLength(1);
    await cursor.close();
  });

  it("holds the last frame past the end of the file", async () => {
    const file = fakeFile(30, 10);
    const cursor = new FrameCursor(file.port);
    expect((await cursor.at(centre(9, 30)))?.frame).toBe(9);
    expect((await cursor.at(centre(40, 30)))?.frame).toBe(9);
    await cursor.close();
    expect(file.alive.size).toBe(0);
  });

  it("shows the first frame for an address before it, rather than nothing", async () => {
    const file = fakeFile(30, 10);
    const cursor = new FrameCursor(file.port);
    expect((await cursor.at(0))?.frame).toBe(0);
    await cursor.close();
  });

  it("refuses to be used once closed", async () => {
    const cursor = new FrameCursor(fakeFile(30, 10).port);
    await cursor.close();
    await cursor.close();
    await expect(cursor.at(0)).rejects.toThrow(/closed/);
  });
});
