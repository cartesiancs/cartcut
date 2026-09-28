import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FADE_IN_MS,
  FADE_OUT_MS,
  GROWTH_MIN_PX,
  SCROLL_IDLE_MS,
  SCROLLBAR_ALPHA,
  SCROLLING_CLASS,
  createScrollActivity,
  createScrollbarFader,
  installScrollActivity,
  type FadeTarget,
  type ScrollEventSource,
} from "./scrollActivity";

/** An element reduced to what the rule reads, recording every class write. */
function fakeList() {
  const classes = new Set<string>();
  const writes: string[] = [];
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientHeight: 300,
    classList: {
      add(token: string) {
        writes.push(`+${token}`);
        classes.add(token);
      },
      remove(token: string) {
        writes.push(`-${token}`);
        classes.delete(token);
      },
    },
    get showing() {
      return classes.has(SCROLLING_CLASS);
    },
    writes,
  };
}

describe("createScrollActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the bar on a vertical scroll and hides it after the idle wait", () => {
    const { scrolled: onScroll } = createScrollActivity();
    const list = fakeList();

    list.scrollTop = 40;
    onScroll(list);
    expect(list.showing).toBe(true);

    vi.advanceTimersByTime(SCROLL_IDLE_MS - 1);
    expect(list.showing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(list.showing).toBe(false);
  });

  it("keeps one bar up for a continuous scroll, measured from the last event", () => {
    const { scrolled: onScroll } = createScrollActivity();
    const list = fakeList();

    for (let i = 1; i <= 10; i++) {
      list.scrollTop = i * 20;
      onScroll(list);
      vi.advanceTimersByTime(SCROLL_IDLE_MS / 2);
    }
    expect(list.showing).toBe(true);
    vi.advanceTimersByTime(SCROLL_IDLE_MS / 2);
    expect(list.showing).toBe(false);

    // One add and one remove across the whole gesture, not one per event.
    expect(list.writes).toEqual([`+${SCROLLING_CLASS}`, `-${SCROLLING_CLASS}`]);
  });

  it("ignores a sideways scroll that leaves scrollTop where it was", () => {
    const { scrolled: onScroll } = createScrollActivity();
    const list = fakeList();

    list.scrollLeft = 120;
    onScroll(list);
    expect(list.showing).toBe(false);
    expect(list.writes).toEqual([]);
  });

  it("does not let a sideways scroll extend a vertical bar", () => {
    const { scrolled: onScroll } = createScrollActivity();
    const list = fakeList();

    list.scrollTop = 40;
    onScroll(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100);

    list.scrollLeft = 120;
    onScroll(list);
    vi.advanceTimersByTime(100);
    expect(list.showing).toBe(false);
  });

  it("shows the bar again when the list scrolls back to the top", () => {
    const { scrolled: onScroll } = createScrollActivity();
    const list = fakeList();

    list.scrollTop = 40;
    onScroll(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);

    list.scrollTop = 0;
    onScroll(list);
    expect(list.showing).toBe(true);
  });

  it("times each list on its own", () => {
    const { scrolled: onScroll } = createScrollActivity();
    const a = fakeList();
    const b = fakeList();

    a.scrollTop = 40;
    onScroll(a);
    vi.advanceTimersByTime(SCROLL_IDLE_MS / 2);
    b.scrollTop = 40;
    onScroll(b);
    vi.advanceTimersByTime(SCROLL_IDLE_MS / 2);

    expect(a.showing).toBe(false);
    expect(b.showing).toBe(true);
  });

  it("fades just before each class change, once per gesture", () => {
    const list = fakeList();
    const { scrolled: onScroll } = createScrollActivity<
      ReturnType<typeof fakeList>
    >(SCROLL_IDLE_MS, (target, visible) =>
      target.writes.push(visible ? "fade-in" : "fade-out"),
    );

    for (let i = 1; i <= 5; i++) {
      list.scrollTop = i * 20;
      onScroll(list);
    }
    vi.advanceTimersByTime(SCROLL_IDLE_MS);

    // Before, because the fader reads the opacity on screen to start from.
    expect(list.writes).toEqual([
      "fade-in",
      `+${SCROLLING_CLASS}`,
      "fade-out",
      `-${SCROLLING_CLASS}`,
    ]);
  });
});

describe("createScrollActivity: growth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flashes the bar when a list grows past its box, then hides it", () => {
    const { resized } = createScrollActivity();
    const list = fakeList();

    list.scrollHeight = 900;
    resized(list);
    expect(list.showing).toBe(true);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);
    expect(list.showing).toBe(false);
  });

  it("does not flash a list that grows but still fits", () => {
    const { resized } = createScrollActivity();
    const list = fakeList();

    list.scrollHeight = 250;
    resized(list);
    expect(list.showing).toBe(false);
  });

  it("does not flash on a shrink, or on a measure that found no change", () => {
    const { resized } = createScrollActivity();
    const list = fakeList();

    list.scrollHeight = 900;
    resized(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);

    resized(list);
    list.scrollHeight = 600;
    resized(list);
    expect(list.writes).toEqual([
      `+${SCROLLING_CLASS}`,
      `-${SCROLLING_CLASS}`,
    ]);
  });

  it("ignores growth under the threshold, but lets it add up", () => {
    const { resized } = createScrollActivity();
    const list = fakeList();

    list.scrollHeight = 900;
    resized(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);

    list.scrollHeight = 901;
    resized(list);
    expect(list.showing).toBe(false);

    for (let px = 902; px < 900 + GROWTH_MIN_PX; px++) {
      list.scrollHeight = px;
      resized(list);
    }
    expect(list.showing).toBe(false);

    list.scrollHeight = 900 + GROWTH_MIN_PX;
    resized(list);
    expect(list.showing).toBe(true);
  });

  it("flashes again when a list that shrank grows back", () => {
    const { resized } = createScrollActivity();
    const list = fakeList();

    list.scrollHeight = 900;
    resized(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);
    list.scrollHeight = 600;
    resized(list);

    list.scrollHeight = 900;
    resized(list);
    expect(list.showing).toBe(true);
  });

  it("keeps one bar up while a list keeps growing", () => {
    const { resized } = createScrollActivity();
    const list = fakeList();

    for (let i = 1; i <= 6; i++) {
      list.scrollHeight = 300 + i * 100;
      resized(list);
      vi.advanceTimersByTime(SCROLL_IDLE_MS / 2);
    }
    expect(list.showing).toBe(true);
    vi.advanceTimersByTime(SCROLL_IDLE_MS / 2);
    expect(list.showing).toBe(false);
    expect(list.writes).toEqual([
      `+${SCROLLING_CLASS}`,
      `-${SCROLLING_CLASS}`,
    ]);
  });

  it("shares one bar and one idle wait between growth and scrolling", () => {
    const { resized, scrolled } = createScrollActivity();
    const list = fakeList();

    list.scrollHeight = 900;
    resized(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100);
    list.scrollTop = 40;
    scrolled(list);
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100);

    expect(list.showing).toBe(true);
    expect(list.writes).toEqual([`+${SCROLLING_CLASS}`]);
  });
});

/** An element that records its fades, drawn at whatever `alpha` says. */
function fakeAnimatedList() {
  const animations: Array<{
    from: number;
    to: number;
    duration: number;
    cancelled: boolean;
  }> = [];
  const target: FadeTarget = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: { add() {}, remove() {} },
    animate(keyframes, options) {
      const [from, to] = keyframes[SCROLLBAR_ALPHA];
      const record = { from, to, duration: options.duration, cancelled: false };
      animations.push(record);
      return {
        cancel() {
          record.cancelled = true;
        },
      };
    },
  };
  return { target, animations };
}

describe("createScrollbarFader", () => {
  it("fades a resting bar in over the full fade-in", () => {
    const { target, animations } = fakeAnimatedList();
    createScrollbarFader(() => 0)(target, true);

    expect(animations).toEqual([
      { from: 0, to: 1, duration: FADE_IN_MS, cancelled: false },
    ]);
  });

  it("fades a shown bar out over the full fade-out", () => {
    const { target, animations } = fakeAnimatedList();
    createScrollbarFader(() => 1)(target, false);

    expect(animations).toEqual([
      { from: 1, to: 0, duration: FADE_OUT_MS, cancelled: false },
    ]);
  });

  it("turns a fade round from where it had reached, for the distance left", () => {
    const { target, animations } = fakeAnimatedList();
    let alpha = 1;
    const fade = createScrollbarFader(() => alpha);

    fade(target, false);
    alpha = 0.4; // the list scrolls again partway through the fade-out
    fade(target, true);

    expect(animations[0].cancelled).toBe(true);
    expect(animations[1]).toEqual({
      from: 0.4,
      to: 1,
      duration: Math.round(FADE_IN_MS * 0.6),
      cancelled: false,
    });
  });

  it("starts nothing when the bar is already where it is going", () => {
    const { target, animations } = fakeAnimatedList();
    const fade = createScrollbarFader(() => 1);

    fade(target, true);
    expect(animations).toEqual([]);
  });

  it("still fades when the property cannot be read", () => {
    const { target, animations } = fakeAnimatedList();
    const fade = createScrollbarFader(() => NaN);

    fade(target, true);
    fade(target, false);
    expect(animations.map(({ from, to }) => [from, to])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("leaves an element without animate to the class change alone", () => {
    const list = fakeList();
    expect(() => createScrollbarFader(() => 0)(list, true)).not.toThrow();
  });
});

describe("installScrollActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeDocument() {
    const listeners: Array<{
      listener: (event: { target: unknown }) => void;
      options: { capture: boolean; passive: boolean };
    }> = [];
    const source: ScrollEventSource = {
      addEventListener(type, listener, options) {
        expect(type).toBe("scroll");
        listeners.push({ listener, options });
      },
    };
    return { source, listeners };
  }

  it("listens in the capture phase, since scroll does not bubble", () => {
    const { source, listeners } = fakeDocument();
    installScrollActivity(source, () => 0);

    expect(listeners).toHaveLength(1);
    expect(listeners[0].options).toEqual({ capture: true, passive: true });
  });

  it("flags the element the event came from", () => {
    const { source, listeners } = fakeDocument();
    installScrollActivity(source, () => 0);
    const list = fakeList();

    list.scrollTop = 40;
    listeners[0].listener({ target: list });
    expect(list.showing).toBe(true);
  });

  it("ignores a scroll whose target is the document itself", () => {
    const { source, listeners } = fakeDocument();
    installScrollActivity(source, () => 0);

    expect(() =>
      listeners[0].listener({ target: { nodeType: 9 } }),
    ).not.toThrow();
    expect(() => listeners[0].listener({ target: null })).not.toThrow();
  });
});
