/**
 * One clip's decoder for the browser export: the frame shown at a source
 * instant, walked forwards through the file.
 *
 * The desktop export seeks a `<video>` for every frame and waits for `seeked`.
 * On a long-GOP source (the screen recordings this app is used on carry eight
 * seconds between key frames) a seek can mean decoding from the previous key
 * frame again, every frame. An export asks for instants that only move
 * forwards, so this keeps one decode running and steps it on: each source
 * frame is decoded once.
 *
 * **Which frame.** The one shown at `want` is the last whose timestamp is
 * strictly before it, within `TIE_SEC`. Addresses are frame centres
 * (`frameAddress.ts`), so a source frame starting exactly on one is a tie, and
 * that happens on a whole grid: 60fps footage in a 30fps project, and 24 in 60
 * on every fifth frame. A tie shows the earlier frame, which is what
 * `track/toDisplayedPath` predicts for Stabilize. A `<video>` answers the same
 * tie with the earlier frame two times in three; this answers it the same way
 * every time.
 *
 * **Never more than two frames alive.** The one on show and the one after it,
 * read ahead to know where the shown one ends. A hardware decoder hands out
 * frames from a small pool and stops when they are all held, so every frame
 * stepped past is closed at once.
 *
 * Generic over the frame type and reached through `SamplePort`, so the walking
 * rule runs under `environment: "node"` against a fake. The Mediabunny port is
 * in `webFrameSource.ts`.
 */

/** A decoded frame as the cursor sees it. */
export type CursorSample<F> = {
  /** Presentation time in source seconds. */
  readonly timestamp: number;
  readonly frame: F;
  close(): void;
};

export type SamplePort<F> = {
  /**
   * Decoded frames in presentation order, starting with the one shown at
   * `fromSec` (the last at or before it; the first in the file when there is
   * none).
   */
  open(fromSec: number): AsyncIterator<CursorSample<F>, void>;
  /** Where decoding `atSec` would have to start: its key frame's timestamp. */
  keyFrameAt(atSec: number): Promise<number | null>;
};

/**
 * Two timestamps closer than this are the same instant.
 *
 * One microsecond: `<video>.currentTime` and WebCodecs timestamps are both held
 * in whole microseconds, and the two sides of a tie arrive by different float
 * routes (`ms / 1000` here, `ticks / timescale` in the demuxer) that disagree
 * in the last place.
 */
export const TIE_SEC = 1e-6;

/**
 * How far ahead `want` may be before asking whether a key frame lies between.
 *
 * Under it the cursor walks, which is always right and cheap for a gap of a
 * few frames. Over it, decoding from the nearer key frame can save seconds of
 * decoding pictures nobody draws: a template's inner clip, or a transition
 * that holds a clip from far into its file.
 */
const JUMP_CHECK_SEC = 1;

export class FrameCursor<F> {
  private stream: AsyncIterator<CursorSample<F>, void> | null = null;
  private current: CursorSample<F> | null = null;
  private next: CursorSample<F> | null = null;
  private ended = false;
  private lastWant = -Infinity;
  private closed = false;

  constructor(private readonly port: SamplePort<F>) {}

  /** The frame shown at `want`, or `null` for a file with no frames. */
  async at(want: number): Promise<CursorSample<F> | null> {
    if (this.closed) {
      throw new Error("FrameCursor is closed");
    }

    if (this.stream == null || want < this.lastWant - TIE_SEC) {
      await this.reopen(want);
    } else if (
      this.current != null &&
      want - this.current.timestamp > JUMP_CHECK_SEC
    ) {
      const key = await this.port.keyFrameAt(want);
      if (key != null && key > this.current.timestamp + TIE_SEC) {
        await this.reopen(want);
      }
    }
    this.lastWant = want;

    // The first frame of a stream is taken whatever its timestamp: it is the
    // one `open` says is on show, and a frame before the first is a black
    // frame nobody asked for.
    if (this.current == null) {
      this.current = await this.pull();
    }

    for (;;) {
      if (this.next == null) {
        this.next = await this.pull();
      }
      if (this.next == null || !(this.next.timestamp < want - TIE_SEC)) {
        break;
      }
      this.current?.close();
      this.current = this.next;
      this.next = null;
    }

    return this.current;
  }

  /** Let go of every frame and stop the decoder. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.dropStream();
  }

  private async reopen(want: number): Promise<void> {
    await this.dropStream();
    // Opened a hair early, so a frame starting exactly on `want` is not the
    // first one handed back: a tie shows the earlier frame.
    this.stream = this.port.open(Math.max(0, want - 2 * TIE_SEC));
    this.ended = false;
  }

  private async dropStream(): Promise<void> {
    this.current?.close();
    this.next?.close();
    this.current = null;
    this.next = null;
    const stream = this.stream;
    this.stream = null;
    this.ended = true;
    await stream?.return?.();
  }

  private async pull(): Promise<CursorSample<F> | null> {
    if (this.ended || this.stream == null) {
      return null;
    }
    const step = await this.stream.next();
    if (step.done) {
      this.ended = true;
      return null;
    }
    return step.value;
  }
}
