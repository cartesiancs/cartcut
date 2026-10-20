/**
 * The tour's pictures, fetched and decoded before the card that shows them.
 *
 * The overlay keeps one `<img>` and changes its `src` per card. In a browser
 * build that `src` is a network request started by the card's own arrival,
 * so on a slow connection the entrance played over an empty box and the
 * picture landed after it in one jump: 700ms of blank on every card at a
 * 700ms round trip. Now every picture is requested together when the tour is
 * about to show, and a card waits for its own before it arrives. A picture
 * already decoded is painted on the frame its `src` is set.
 *
 * A wait is bounded and a failure counts as ready. The art decides when a
 * card arrives, never whether it does.
 */

/** Fetches and decodes one picture. May reject; may never settle. */
export type DecodePort = (src: string) => Promise<unknown>;

/** Resolves after `ms`. A port so the bound is testable without real time. */
export type DelayPort = (ms: number) => Promise<void>;

/**
 * How long the tour holds its first card back for the wordmark before showing
 * without it. Measured from the moment the tour decides to show.
 */
export const FIRST_ART_WAIT_MS = 1500;

/**
 * How long a later card waits for its picture, counted from the click that
 * asked for it. The fade-out spends part of this anyway, so a picture that is
 * already in costs nothing.
 */
export const NEXT_ART_WAIT_MS = 1200;

export type ArtPreloader = {
  /** Starts every fetch that has not started yet, and returns at once. */
  warm(srcs: readonly string[]): void;
  /**
   * Settles once `src` is decoded, has failed, or `capMs` has passed,
   * whichever is first. Never rejects. Starts the fetch if `warm` did not.
   */
  ready(src: string, capMs: number): Promise<void>;
};

export function createArtPreloader(
  decode: DecodePort,
  delay: DelayPort,
): ArtPreloader {
  // One request per picture for the life of the page: a restarted tour, or a
  // card visited twice, waits on the decode it already has.
  const settled = new Map<string, Promise<void>>();
  const done = () => undefined;

  const start = (src: string): Promise<void> => {
    let promise = settled.get(src);
    if (!promise) {
      try {
        promise = decode(src).then(done, done);
      } catch {
        promise = Promise.resolve();
      }
      settled.set(src, promise);
    }
    return promise;
  };

  return {
    warm(srcs) {
      for (const src of srcs) start(src);
    },
    ready(src, capMs) {
      return Promise.race([start(src), delay(capMs)]);
    },
  };
}

/**
 * Every picture asked for, held for the life of the page. An `Image` nobody
 * references can lose its decoded bitmap, and the card's own `<img>` would
 * then decode it again on the frame it is first painted.
 */
const held: HTMLImageElement[] = [];

export const browserArtPreloader: ArtPreloader = createArtPreloader(
  (src) => {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    held.push(img);
    return img.decode();
  },
  (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
);
