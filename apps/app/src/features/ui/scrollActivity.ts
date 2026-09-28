/**
 * Vertical scrollbars that show only while their list is moving, or has just
 * grown.
 *
 * `style.scss` draws every vertical thumb at the opacity `--scrollbar-alpha`
 * gives it, which is 1 on an element carrying `SCROLLING_CLASS` and 0
 * elsewhere, and draws it outright under the pointer so a hidden bar can still
 * be found and grabbed. This module puts the class on and takes it off after
 * `SCROLL_IDLE_MS` of quiet, and fades between the two.
 *
 * A list that grows flashes its bar the same way, so the user sees there is
 * more of it and roughly how much, without scrolling to find out.
 * `scrollerWatch.ts` is what notices the growth.
 *
 * One capture-phase listener on the document covers every list in the app:
 * `scroll` does not bubble, but it does pass through the document's capture
 * phase, and a listener per list is a listener a new list can forget.
 *
 * Only a change of `scrollTop` counts. An element that scrolls both ways would
 * otherwise flash its vertical bar on a sideways scroll that never moved it.
 *
 * The DOM is reached only through `ScrollTargetLike`, `FadeTarget` and
 * `ScrollEventSource`, so this runs under `environment: "node"` against a fake.
 */

/** The class `style.scss` keys the visible vertical thumb on. */
export const SCROLLING_CLASS = "is-scrolling";

/** The registered custom property the thumb reads its opacity from. */
export const SCROLLBAR_ALPHA = "--scrollbar-alpha";

/**
 * How long a bar stays after the last movement. Long enough that a flick
 * followed by a second one keeps one bar on screen rather than blinking it.
 */
export const SCROLL_IDLE_MS = 800;

/**
 * The least growth, in px, that flashes a bar: about one line of text. Less is
 * layout noise (a border on selection, a rounding) rather than content. It is
 * not thrown away: a list that grows a pixel at a time flashes once it has
 * grown this much in all.
 */
export const GROWTH_MIN_PX = 16;

/**
 * The fades, in ms, for a full 0 to 1 swing. Arriving is quick, so the bar
 * answers the wheel on the first frames of a scroll; leaving is slower, so a
 * bar the eye was following does not vanish mid-glance.
 */
export const FADE_IN_MS = 150;
export const FADE_OUT_MS = 300;

/** The part of a scrolled `Element` this needs. */
export type ScrollTargetLike = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly classList: {
    add(token: string): void;
    remove(token: string): void;
  };
};

/** The part of `Element.animate` a fade needs. Absent means no fade. */
export type FadeTarget = ScrollTargetLike & {
  animate?(
    keyframes: Record<string, number[]>,
    options: { duration: number; easing: string },
  ): { cancel(): void };
};

/** The opacity the thumb is drawn at right now, mid-fade included. */
export type AlphaReader = (target: FadeTarget) => number;

/** Called just before the class changes, with the state it changes to. */
export type ScrollbarFade<T> = (target: T, visible: boolean) => void;

/** The part of `document` this needs. */
export type ScrollEventSource = {
  addEventListener(
    type: "scroll",
    listener: (event: { readonly target: unknown }) => void,
    options: { capture: boolean; passive: boolean },
  ): void;
};

/** The two things that show a bar. */
export type ScrollActivity<T> = {
  /** A `scroll` event on `target`. Only a change of `scrollTop` counts. */
  scrolled(target: T): void;
  /**
   * `target` or something in it changed size. Growth that leaves it
   * scrollable counts; a shrink only lowers the mark the next growth is
   * measured from.
   */
  resized(target: T): void;
};

type Track = {
  top: number;
  height: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * The per-element rule, apart from how events are found.
 *
 * Both marks start at 0. Every element starts at the top, and every later
 * change of `scrollTop` (a wheel, a drag of the thumb, a script, content
 * shrinking under it) fires a `scroll`. And a list measured for the first time
 * already longer than its box is treated as having grown into it, so a panel
 * that opens onto a long list shows its bar once, exactly as one that fills
 * while open does.
 *
 * `fade` runs before the class changes, because the fader reads the opacity on
 * screen to start from, and the class is what that opacity settles to.
 */
export function createScrollActivity<T extends ScrollTargetLike>(
  idleMs: number = SCROLL_IDLE_MS,
  fade: ScrollbarFade<T> = () => {},
): ScrollActivity<T> {
  // Weak, so a list that leaves the DOM mid-flash is not held alive by it.
  const tracks = new WeakMap<T, Track>();

  const trackOf = (target: T): Track => {
    let track = tracks.get(target);
    if (track == null) {
      track = { top: 0, height: 0, timer: null };
      tracks.set(target, track);
    }
    return track;
  };

  const reveal = (target: T, track: Track): void => {
    if (track.timer == null) {
      fade(target, true);
      target.classList.add(SCROLLING_CLASS);
    } else {
      clearTimeout(track.timer);
    }
    track.timer = setTimeout(() => {
      track.timer = null;
      fade(target, false);
      target.classList.remove(SCROLLING_CLASS);
    }, idleMs);
  };

  return {
    scrolled(target) {
      const track = trackOf(target);
      const top = target.scrollTop;
      if (top === track.top) {
        return;
      }
      track.top = top;
      reveal(target, track);
    },

    resized(target) {
      const track = trackOf(target);
      const height = target.scrollHeight;
      if (height < track.height) {
        track.height = height;
        return;
      }
      // Below the threshold the mark stays put, so small growth adds up.
      if (height - track.height < GROWTH_MIN_PX) {
        return;
      }
      track.height = height;
      if (height > target.clientHeight) {
        reveal(target, track);
      }
    },
  };
}

/**
 * Fade `--scrollbar-alpha` from wherever it is drawn now to where the class
 * change is about to put it.
 *
 * The animation carries no fill: when it ends, the value falls back to what
 * the class says, which is the value it ended on. A new fade on the same
 * element cancels the one running, and starts from the opacity that one had
 * reached, so a scroll that resumes halfway through a fade-out turns the bar
 * round rather than snapping it back. Its duration is the remaining share of a
 * full swing, so the turn takes as long as the distance it covers.
 */
export function createScrollbarFader(
  readAlpha: AlphaReader,
): ScrollbarFade<FadeTarget> {
  const running = new WeakMap<FadeTarget, { cancel(): void }>();

  return (target, visible) => {
    if (target.animate == null) {
      return;
    }
    const to = visible ? 1 : 0;
    const read = readAlpha(target);
    // An unreadable value means the property is not registered, where the
    // class change alone decides; start from the far end so a fade still runs.
    const from = Number.isFinite(read)
      ? Math.min(1, Math.max(0, read))
      : 1 - to;

    running.get(target)?.cancel();
    running.delete(target);

    const distance = Math.abs(to - from);
    if (distance === 0) {
      return;
    }
    const full = visible ? FADE_IN_MS : FADE_OUT_MS;
    running.set(
      target,
      target.animate(
        { [SCROLLBAR_ALPHA]: [from, to] },
        {
          duration: Math.round(full * distance),
          easing: visible ? "ease-out" : "ease-in-out",
        },
      ),
    );
  };
}

function isScrollTarget(target: unknown): target is FadeTarget {
  // The document itself is a `scroll` target and has neither field.
  return (
    typeof target === "object" &&
    target != null &&
    "classList" in target &&
    typeof (target as { scrollTop?: unknown }).scrollTop === "number"
  );
}

/**
 * Watch every vertical scroll in the document, once, at boot. The activity is
 * returned for `installScrollerWatch`, so a growth and a scroll on the same
 * list share one bar and one idle timer.
 */
export function installScrollActivity(
  source: ScrollEventSource,
  readAlpha: AlphaReader,
): ScrollActivity<FadeTarget> {
  const activity = createScrollActivity<FadeTarget>(
    SCROLL_IDLE_MS,
    createScrollbarFader(readAlpha),
  );
  source.addEventListener(
    "scroll",
    (event) => {
      if (isScrollTarget(event.target)) {
        activity.scrolled(event.target);
      }
    },
    { capture: true, passive: true },
  );
  return activity;
}
