/**
 * The GIF section's state: one search's pages, and the GIFs already on disk.
 *
 * GIFs are the one cloud kind never held whole. `cloudStore.ts` keeps each
 * other kind's full catalog; here there is only the search on screen, a page
 * at a time (`gifFeed.ts`), and nothing is asked for until the section is
 * shown. A new search, the setting, the connection or the server changing
 * starts the list again from its first page.
 */

import { createStore } from "zustand/vanilla";

import { cloudPort } from "./cloudPort";
import {
  cloudStore,
  cloudUsable,
  onCloudDownloadsCleared,
  onCloudInstalled,
} from "./cloudStore";
import type { CloudItem } from "./cloudTypes";
import {
  canLoadMore,
  emptyFeed,
  failPage,
  markInstalled,
  receivePage,
  requestMore,
  startFeed,
  type GifFeed,
} from "./gifFeed";

/** Tiles per page: a whole number of rows at three, four and six across. */
export const GIF_PAGE = 48;
/** After the server did not answer, the next try waits at least this long. */
const RETRY_MS = 30 * 1000;

export type GifStoreState = {
  feed: GifFeed;
  /** The GIFs on disk, for offline. */
  installed: CloudItem[];
  /** The last request that failed, so a sentinel on screen cannot retry in a loop. */
  failedAt: number;
};

export const cloudGifStore = createStore<GifStoreState>(() => ({
  feed: emptyFeed(),
  installed: [],
  failedAt: 0,
}));

let wired = false;

/**
 * Follow the cloud's switch, connection and server, every install and the
 * clearing of every download. Once, on first use.
 */
function wire(): void {
  if (wired) {
    return;
  }
  wired = true;
  let last = cloudStore.getState();
  cloudStore.subscribe((state) => {
    // A list fetched from one server describes files another may not have.
    const changed = cloudUsable(state) !== cloudUsable(last) || state.url !== last.url;
    last = state;
    if (changed) {
      cloudGifStore.setState({ feed: emptyFeed(), failedAt: 0 });
    }
  });
  onCloudInstalled((kind, id, installedPath) => {
    if (kind !== "gif") {
      return;
    }
    cloudGifStore.setState((state) => {
      const feed = markInstalled(state.feed, id, installedPath);
      return feed === state.feed ? state : { feed };
    });
    void refreshInstalledGifs();
  });
  // Every `installed` flag in the list is now wrong, and a click on one
  // would place a file that is gone.
  onCloudDownloadsCleared(() => {
    cloudGifStore.setState({ feed: emptyFeed(), failedAt: 0 });
    void refreshInstalledGifs();
  });
}

function requestPage(seq: number, cursor: string): void {
  const port = cloudPort();
  const { feed } = cloudGifStore.getState();
  if (port == null) {
    cloudGifStore.setState({ feed: failPage(feed, seq), failedAt: Date.now() });
    return;
  }
  port
    .gifPage({ q: feed.query, cursor, limit: GIF_PAGE })
    .then((page) => {
      const current = cloudGifStore.getState().feed;
      const { feed: next, restart } = receivePage(current, seq, cursor, page);
      if (restart) {
        startSearch(current.query);
        return;
      }
      if (next !== current) {
        cloudGifStore.setState({
          feed: next,
          failedAt: next.status === "error" ? Date.now() : 0,
        });
      }
    })
    .catch(() => {
      const current = cloudGifStore.getState().feed;
      cloudGifStore.setState({ feed: failPage(current, seq), failedAt: Date.now() });
    });
}

function startSearch(query: string): void {
  const feed = startFeed(cloudGifStore.getState().feed, query);
  cloudGifStore.setState({ feed, failedAt: 0 });
  requestPage(feed.seq, "");
}

/**
 * Show `query`'s first page. A no-op when it is already the search on
 * screen, so the panel can call it on every render.
 */
export function showGifs(query: string): void {
  wire();
  if (!cloudUsable()) {
    return;
  }
  const { feed, failedAt } = cloudGifStore.getState();
  if (feed.status !== "idle" && feed.query === query) {
    if (feed.status === "error" && !feed.pending && Date.now() - failedAt > RETRY_MS) {
      startSearch(query);
    }
    return;
  }
  startSearch(query);
}

/** Ask for the next page, if there is one and none is out. */
export function loadMoreGifs(): void {
  const { feed } = cloudGifStore.getState();
  if (!cloudUsable() || !canLoadMore(feed)) {
    return;
  }
  const asked = requestMore(feed);
  cloudGifStore.setState({ feed: asked });
  requestPage(asked.seq, feed.next ?? "");
}

/** The retry button: the same search again, now, whatever the interval. */
export function retryGifs(): void {
  const { feed } = cloudGifStore.getState();
  if (feed.items.length > 0 && feed.next != null) {
    // A later page failed: keep what is shown and ask for that page again.
    cloudGifStore.setState({ feed: { ...feed, status: "ready", pending: false } });
    loadMoreGifs();
    return;
  }
  startSearch(feed.query);
}

/** Re-read the GIFs on disk. Works offline and with the setting off. */
export async function refreshInstalledGifs(): Promise<void> {
  wire();
  const port = cloudPort();
  if (port == null) {
    return;
  }
  try {
    const result = await port.installedGifs();
    cloudGifStore.setState({ installed: Array.isArray(result?.items) ? result.items : [] });
  } catch {
    // Main did not answer; the list on screen stays.
  }
}
