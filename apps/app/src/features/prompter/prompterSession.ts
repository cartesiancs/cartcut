/**
 * The prompter while it is scrolling: one frame loop, paused, resumed, nudged
 * and stopped.
 *
 * Everything it touches is a port. The frame clock is `FrameScheduler`, the
 * caption reveal's and the tutorial runner's, and the page is two functions:
 * `measure` reads three numbers off the stage and `apply` writes one transform.
 * So the whole loop runs under `environment: "node"` against a counter and a
 * fake ruler, and the Lit component is left with wiring.
 *
 * The offset never goes through Lit. `apply` writes the text column's transform
 * directly, sixty times a second, and `onState` fires only when something the
 * template shows changes (paused, finished, speed). A `@state` offset would
 * rebuild the whole template every frame, which is the cost
 * `caption/previewLoop.ts#chromeKey` exists to avoid.
 */

import type { FrameScheduler } from "../caption/previewLoop";
import {
  DEFAULT_PROMPTER_SPEED,
  advance,
  clampOffset,
  coerceSpeed,
  maxOffset,
  nudge,
} from "./prompterScroll";

/** What the stage looks like right now, in CSS pixels. */
export type PrompterMeasure = {
  /** The text column's full height, padding included. */
  content: number;
  /** The stage's height. Zero while the window's tab is not on show. */
  viewport: number;
  /** One line of the script. */
  line: number;
};

export type PrompterState = {
  /** Between Next and Exit. */
  running: boolean;
  paused: boolean;
  /** The last line has crossed the reading line and the loop has stopped. */
  finished: boolean;
  speed: number;
};

export type PrompterPorts = {
  scheduler: FrameScheduler;
  now: () => number;
  measure: () => PrompterMeasure;
  apply: (offsetPx: number) => void;
  onState: (state: PrompterState) => void;
};

const IDLE: PrompterState = {
  running: false,
  paused: false,
  finished: false,
  speed: DEFAULT_PROMPTER_SPEED,
};

export class PrompterSession {
  private offset = 0;
  private frame: number | null = null;
  /** The previous frame's time, or `null` when the next frame must not count. */
  private last: number | null = null;
  /** The previous frame's `maxOffset`, to keep the place when the stage resizes. */
  private lastMax = 0;
  private state: PrompterState = IDLE;

  constructor(private readonly ports: PrompterPorts) {}

  get current(): PrompterState {
    return this.state;
  }

  /** Where the text is, in pixels scrolled. */
  get position(): number {
    return this.offset;
  }

  /** Next: from the top, moving at once. */
  start(speed: number): void {
    this.cancelFrame();
    this.offset = 0;
    this.last = null;
    this.lastMax = 0;
    this.ports.apply(0);
    this.setState({
      running: true,
      paused: false,
      finished: false,
      speed: coerceSpeed(speed),
    });
    this.arm();
  }

  /** Exit, and the window closing. Leaves no frame pending. */
  stop(): void {
    this.cancelFrame();
    this.last = null;
    this.setState({ ...IDLE, speed: this.state.speed });
  }

  /**
   * A click on the stage.
   *
   * At the end there is nothing left to pause, so the same click starts the
   * script over, which is what someone wants after a take that went wrong.
   */
  togglePause(): void {
    if (!this.state.running) {
      return;
    }
    if (this.state.finished) {
      this.start(this.state.speed);
      return;
    }
    if (this.state.paused) {
      this.last = null;
      this.setState({ ...this.state, paused: false });
      this.arm();
      return;
    }
    this.cancelFrame();
    this.last = null;
    this.setState({ ...this.state, paused: true });
  }

  /** The wheel. Moves the text without changing whether it is paused. */
  nudge(deltaPx: number): void {
    if (!this.state.running) {
      return;
    }
    const measure = this.ports.measure();
    if (measure.viewport <= 0) {
      return;
    }
    const max = maxOffset(measure.content, measure.viewport);
    const next = nudge(this.offset, deltaPx, max);
    if (next === this.offset) {
      return;
    }
    this.offset = next;
    this.lastMax = max;
    this.ports.apply(next);

    // Scrolled back up from the end: there is reading left, so read it.
    if (this.state.finished && next < max) {
      this.last = null;
      this.setState({ ...this.state, finished: false });
      this.arm();
    }
  }

  /**
   * The stage changed size. Keeps the reader's place, paused or not.
   *
   * Every frame does this too, but a paused or finished script runs no frames,
   * and without this it would sit at a stale pixel offset after a resize and
   * then jump on resume.
   */
  relayout(): void {
    if (!this.state.running) {
      return;
    }
    const measure = this.ports.measure();
    if (measure.viewport <= 0) {
      return;
    }
    const before = this.offset;
    this.rescale(maxOffset(measure.content, measure.viewport));
    if (this.offset !== before) {
      this.ports.apply(this.offset);
    }
  }

  /** Takes effect from the next frame. */
  setSpeed(speed: number): void {
    const next = coerceSpeed(speed);
    if (next !== this.state.speed) {
      this.setState({ ...this.state, speed: next });
    }
  }

  private tick = (): void => {
    this.frame = null;
    if (!this.state.running || this.state.paused || this.state.finished) {
      return;
    }

    const measure = this.ports.measure();
    const now = this.ports.now();

    // `<app-window>` keeps a tab that is not on show mounted and `hidden`, so
    // it measures 0x0 rather than going away. Nothing moves while nobody can
    // see it, and forgetting the timestamp keeps the time spent on another tab
    // from being read as one long frame on the way back.
    if (measure.viewport <= 0) {
      this.last = null;
      this.arm();
      return;
    }

    const max = maxOffset(measure.content, measure.viewport);
    this.rescale(max);

    const dt = this.last == null ? 0 : now - this.last;
    this.last = now;

    this.offset = advance(this.offset, dt, this.state.speed, measure.line, max);
    this.ports.apply(this.offset);

    if (this.offset >= max) {
      this.last = null;
      this.setState({ ...this.state, finished: true });
      return;
    }
    this.arm();
  };

  /**
   * Carry the offset over to a new `max`.
   *
   * The type is sized to the window's width, so dragging the splitter rescales
   * every line and the same pixel offset lands in a different part of the
   * script. The fraction read so far is what the reader's place is.
   */
  private rescale(max: number): void {
    if (this.lastMax > 0 && max !== this.lastMax) {
      this.offset = clampOffset(this.offset * (max / this.lastMax), max);
    }
    this.lastMax = max;
  }

  private arm(): void {
    if (
      this.frame != null ||
      !this.state.running ||
      this.state.paused ||
      this.state.finished
    ) {
      return;
    }
    this.frame = this.ports.scheduler.request(this.tick);
  }

  private cancelFrame(): void {
    if (this.frame != null) {
      this.ports.scheduler.cancel(this.frame);
      this.frame = null;
    }
  }

  private setState(next: PrompterState): void {
    const prev = this.state;
    if (
      prev.running === next.running &&
      prev.paused === next.paused &&
      prev.finished === next.finished &&
      prev.speed === next.speed
    ) {
      return;
    }
    this.state = next;
    this.ports.onState(next);
  }
}
