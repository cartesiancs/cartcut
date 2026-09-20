/**
 * Which asset tiles are on screen.
 *
 * Decision-free on purpose: it reports, and `assetList.ts` decides what a
 * report is worth. Everything that can be wrong without looking wrong lives in
 * `thumbnailPolicy`-shaped pure modules instead.
 *
 * **One observer per scroller, not one per tile.** A folder of four hundred
 * files would otherwise mean four hundred observer objects, each with its own
 * root-geometry computation and its own callback task per scroll frame, all
 * discarded and rebuilt on the next directory change. One observer carrying
 * four hundred entries is what the API is for.
 *
 * **Tiles register themselves** rather than `<asset-list>` observing its
 * children. The grid's `repeat` keys on `entry.name` alone, so navigating to a
 * folder holding a file of the same name reuses the element with no
 * `disconnectedCallback` at all; a parent driving observe/unobserve would have
 * to re-derive the child set on every render, where `connectedCallback` is
 * exactly the lifecycle an observation target wants.
 */

export type VisibilityListener = (visible: boolean) => void;

/**
 * How far outside the scroller a tile still counts as worth preparing.
 *
 * Enough that a normal flick lands on tiles that already have a thumbnail,
 * and not so much that opening a folder prepares the whole of it.
 */
const ROOT_MARGIN = "300px 0px";

type Registration = {
  observer: IntersectionObserver;
  listener: VisibilityListener;
};

const registrations = new WeakMap<Element, Registration>();
const observers = new Map<Element | null, IntersectionObserver>();

function handle(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    registrations.get(entry.target)?.listener(entry.isIntersecting);
  }
}

/**
 * The scroller a tile lives in, which has to be the observer's root.
 *
 * Not a detail. With `root: null` the target's rect is clipped by every
 * intervening scroller *unexpanded*, and only the viewport rect gets the
 * margin, so the prefetch band above would buy nothing at all. The asset
 * panel's scroller is the `.tab-content` container, the same element
 * `assetList`'s hover handling already reasons about. Falling back to `null`
 * costs the band and nothing else.
 */
function rootFor(el: Element): Element | null {
  return el.closest(".tab-content");
}

function observerFor(root: Element | null): IntersectionObserver {
  const existing = observers.get(root);
  if (existing != undefined) {
    return existing;
  }

  const observer = new IntersectionObserver(handle, {
    root: root,
    rootMargin: ROOT_MARGIN,
    threshold: 0,
  });
  observers.set(root, observer);
  return observer;
}

export function observeVisibility(
  el: Element,
  listener: VisibilityListener,
): void {
  // Re-registering the same element would leave the old listener attached to
  // an observer nothing unobserves it from.
  unobserveVisibility(el);

  const observer = observerFor(rootFor(el));
  registrations.set(el, { observer: observer, listener: listener });
  observer.observe(el);
}

export function unobserveVisibility(el: Element): void {
  const registration = registrations.get(el);
  if (registration == undefined) {
    return;
  }

  registration.observer.unobserve(el);
  registrations.delete(el);
}
