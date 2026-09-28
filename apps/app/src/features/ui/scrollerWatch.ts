import type { FadeTarget, ScrollActivity } from "./scrollActivity";

/**
 * Finds every vertical scroll container in the document and says when one may
 * have grown, so `scrollActivity.ts` can flash its bar.
 *
 * Nothing fires when an element's `scrollHeight` changes, so this watches the
 * boxes it is made of: one ResizeObserver on each scroller and on each of its
 * children. A child is the right grain. Anything deeper that grows (a row
 * added, a section unfolded, an image arriving, text rewrapping) grows the
 * child it sits in, and a ResizeObserver costs nothing until a box changes
 * size, so playback pays nothing for any of this.
 *
 * Three cases need more than that:
 *
 * - **A child with no box of its own** (`display: inline` or `contents`, which
 *   is every custom element without styles) always measures 0x0, so its
 *   children are watched as well, as far down as it takes to reach a box.
 * - **Children come and go**, and Lit makes scrollers at any time, so one
 *   MutationObserver over the document queues added and removed nodes, and the
 *   queue is settled once per frame. Computed styles are then read where the
 *   frame would compute them anyway, rather than once per Lit update.
 * - **A removed child reports nothing**, and its scroller's own box has not
 *   moved, so that scroller is measured when the queue is settled. Otherwise
 *   the growth mark would stay at the old height and a list that shrank and
 *   grew back would never flash.
 *
 * The DOM is reached only through `WatchNode` and `WatchPorts`, so this runs
 * under `environment: "node"` against a fake tree.
 */

/** The part of an `Element` the tree walk needs. */
export type WatchNode<E> = {
  readonly isConnected: boolean;
  readonly parentElement: E | null;
  readonly children: ArrayLike<E>;
  querySelectorAll(selectors: "*"): ArrayLike<E>;
};

export type WatchPorts<E> = {
  /** Its computed `overflow-y` lets it scroll. */
  isScroller(el: E): boolean;
  /** Its computed `display` gives it no box a ResizeObserver can measure. */
  isBoxless(el: E): boolean;
  observe(el: E): void;
  unobserve(el: E): void;
  /** `scroller`'s `scrollHeight` may have changed. */
  resized(scroller: E): void;
  /** Run `callback` once, before the next paint. */
  frame(callback: () => void): void;
};

export type ScrollerWatch<E> = {
  /** A node entered the document. Settled on the next frame. */
  added(node: E): void;
  /** A node left the document. Settled on the next frame. */
  removed(node: E): void;
  /** A ResizeObserver entry for `el`. */
  sized(el: E): void;
};

export function createScrollerWatch<E extends WatchNode<E>>(
  ports: WatchPorts<E>,
): ScrollerWatch<E> {
  const scrollers = new WeakSet<E>();
  // Every observed element that is not a scroller in its own right, to the
  // scroller whose height it makes up.
  const content = new WeakMap<E, E>();
  // The boxless ones among them, whose children are watched too.
  const wrappers = new WeakMap<E, E>();

  const addedQueue = new Set<E>();
  const removedQueue = new Set<E>();
  let pending = false;

  const subtree = (root: E): E[] => [
    root,
    ...Array.from(root.querySelectorAll("*")),
  ];

  const attach = (scroller: E, el: E): void => {
    content.set(el, scroller);
    ports.observe(el);
    if (ports.isBoxless(el)) {
      wrappers.set(el, scroller);
      for (const child of Array.from(el.children)) {
        attach(scroller, child);
      }
    }
  };

  const register = (scroller: E): void => {
    scrollers.add(scroller);
    ports.observe(scroller);
    for (const child of Array.from(scroller.children)) {
      attach(scroller, child);
    }
  };

  /** Stop watching `root` and everything in it; answer the scroller it left. */
  const forget = (root: E): E | undefined => {
    const owner = content.get(root);
    for (const el of subtree(root)) {
      const wasScroller = scrollers.delete(el);
      const wasContent = content.delete(el);
      wrappers.delete(el);
      if (wasScroller || wasContent) {
        ports.unobserve(el);
      }
    }
    return owner;
  };

  const hasQueuedAncestor = (node: E, roots: Set<E>): boolean => {
    for (let p = node.parentElement; p != null; p = p.parentElement) {
      if (roots.has(p)) {
        return true;
      }
    }
    return false;
  };

  const settle = (): void => {
    pending = false;
    const removed = Array.from(removedQueue);
    const added = Array.from(addedQueue);
    removedQueue.clear();
    addedQueue.clear();

    // Removals first, so a node that moved within the frame is forgotten and
    // then found again under its new parent, rather than kept under its old.
    const shrunk = new Set<E>();
    for (const node of removed) {
      const owner = forget(node);
      if (owner != null) {
        shrunk.add(owner);
      }
    }

    const roots = new Set(added.filter((node) => node.isConnected));
    for (const node of roots) {
      // A subtree already being scanned covers this one.
      if (hasQueuedAncestor(node, roots)) {
        continue;
      }
      const parent = node.parentElement;
      const owner =
        parent == null
          ? undefined
          : scrollers.has(parent)
            ? parent
            : wrappers.get(parent);
      if (owner != null) {
        attach(owner, node);
      }
      for (const el of subtree(node)) {
        if (!scrollers.has(el) && ports.isScroller(el)) {
          register(el);
        }
      }
    }

    for (const scroller of shrunk) {
      if (scrollers.has(scroller) && scroller.isConnected) {
        ports.resized(scroller);
      }
    }
  };

  const schedule = (): void => {
    if (!pending) {
      pending = true;
      ports.frame(settle);
    }
  };

  return {
    added(node) {
      addedQueue.add(node);
      schedule();
    },
    removed(node) {
      removedQueue.add(node);
      schedule();
    },
    sized(el) {
      if (scrollers.has(el)) {
        ports.resized(el);
      }
      // A scroller nested in another is also part of that one's height.
      const owner = content.get(el);
      if (owner != null) {
        ports.resized(owner);
      }
    },
  };
}

const SCROLLING_OVERFLOW = new Set(["auto", "scroll", "overlay"]);
const BOXLESS_DISPLAY = new Set(["inline", "contents"]);

/**
 * Watch the whole document, once, at boot, reporting growth to `activity`.
 * The DOM half of `createScrollerWatch`, and nothing else.
 */
export function installScrollerWatch(
  activity: ScrollActivity<FadeTarget>,
): void {
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      watch.sized(entry.target);
    }
  });

  const watch = createScrollerWatch<Element>({
    isScroller: (el) => SCROLLING_OVERFLOW.has(getComputedStyle(el).overflowY),
    isBoxless: (el) => BOXLESS_DISPLAY.has(getComputedStyle(el).display),
    observe: (el) => sizes.observe(el),
    unobserve: (el) => sizes.unobserve(el),
    resized: (el) => activity.resized(el as unknown as FadeTarget),
    frame: (callback) => requestAnimationFrame(callback),
  });

  const ELEMENT_NODE = 1;
  new MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach((node) => {
        if (node.nodeType === ELEMENT_NODE) {
          watch.removed(node as Element);
        }
      });
      record.addedNodes.forEach((node) => {
        if (node.nodeType === ELEMENT_NODE) {
          watch.added(node as Element);
        }
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  watch.added(document.documentElement);
}
