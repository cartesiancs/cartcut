/**
 * The GIF section's list: which pages have arrived for which search, and
 * whether another may be asked for. Pure; `cloudGifStore.ts` does the asking.
 *
 * Three things it exists to get right:
 *
 * - **An answer for an old search is dropped.** Typing "고양이" sends a
 *   request per pause, and they can come back in any order. Each search gets
 *   a new `seq`, and a page is kept only if it carries the current one.
 * - **One request at a time.** `canLoadMore` is false while a page is out, so
 *   a sentinel that stays on screen asks once and not ten times.
 * - **A catalogue that changed under the scroll starts again.** The cursor is
 *   a position in the server's list, so after the server reloads, page 3 of
 *   the new list would repeat or skip GIFs. The server's `rev` says when that
 *   happened, and the answer is the first page again.
 */

import type { CloudItem, GifPage } from "./cloudTypes";

export type GifFeedStatus = "idle" | "loading" | "ready" | "end" | "error";

export type GifFeed = {
  /** The search, as typed. */
  query: string;
  items: CloudItem[];
  /** The cursor for the next page; `null` once the last one is in. */
  next: string | null;
  total: number;
  rev: string | null;
  status: GifFeedStatus;
  seq: number;
  /** Whether a page is being asked for. */
  pending: boolean;
};

export function emptyFeed(): GifFeed {
  return {
    query: "",
    items: [],
    next: null,
    total: 0,
    rev: null,
    status: "idle",
    seq: 0,
    pending: false,
  };
}

/** A new search from the first page. The caller asks for cursor `""` with the returned `seq`. */
export function startFeed(feed: GifFeed, query: string): GifFeed {
  return { ...emptyFeed(), query, status: "loading", seq: feed.seq + 1, pending: true };
}

export function canLoadMore(feed: GifFeed): boolean {
  return feed.status === "ready" && feed.next != null && !feed.pending;
}

/** Mark the next page asked for. Declines by identity when there is none to ask. */
export function requestMore(feed: GifFeed): GifFeed {
  return canLoadMore(feed) ? { ...feed, pending: true } : feed;
}

/**
 * A page arrived for the request made with `seq` at `cursor`.
 *
 * `restart` is true when the server's list changed since the first page;
 * the caller then starts the same search again.
 */
export function receivePage(
  feed: GifFeed,
  seq: number,
  cursor: string,
  page: GifPage,
): { feed: GifFeed; restart: boolean } {
  if (seq !== feed.seq) {
    return { feed, restart: false };
  }
  if (page.status !== "ok") {
    return { feed: { ...feed, status: "error", pending: false }, restart: false };
  }
  if (cursor !== "" && feed.rev != null && page.rev != null && page.rev !== feed.rev) {
    return { feed, restart: true };
  }

  const known = new Set(feed.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !known.has(item.id));
  return {
    feed: {
      ...feed,
      items: fresh.length === 0 ? feed.items : [...feed.items, ...fresh],
      next: page.next,
      total: page.total,
      rev: page.rev ?? feed.rev,
      status: page.next == null ? "end" : "ready",
      pending: false,
    },
    restart: false,
  };
}

/** The request made with `seq` failed outright. */
export function failPage(feed: GifFeed, seq: number): GifFeed {
  return seq !== feed.seq ? feed : { ...feed, status: "error", pending: false };
}

/** One GIF now on disk, wherever it is in the list. Declines by identity if it is not there. */
export function markInstalled(feed: GifFeed, id: string, installedPath: string): GifFeed {
  const index = feed.items.findIndex((item) => item.id === id);
  if (index < 0) {
    return feed;
  }
  const items = feed.items.slice();
  items[index] = {
    ...items[index],
    installed: true,
    localPath: installedPath,
    // A GIF is its own picture.
    localThumbnail: installedPath.replace(/\\/g, "/"),
  };
  return { ...feed, items };
}
