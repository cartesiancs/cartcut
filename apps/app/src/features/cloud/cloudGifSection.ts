/**
 * The cloud view's GIF section: a search the server answers a page at a time.
 *
 * Below the media sections of `<cloud-asset-grid>`, sharing their search box.
 * Unlike them it never holds the whole catalogue: the first 48 GIFs arrive
 * when the section is shown, and a sentinel under the grid asks for the next
 * page as it comes within reach of the scroll (`cloudGifStore.ts`). The
 * search box's text is debounced here, since every pause is a request.
 *
 * Offline, with the setting off or the server unreachable, it shows the GIFs
 * already on disk, searched by the same rule (`gifSearch.ts`).
 *
 * A new list cascades in (`motion/cascade.ts`), and the pictures of the tiles
 * that cascaded fade in as each one loads; a page the scroll asked for, and a
 * tile first scrolled to, appear as they land. What counts as a new list is
 * `listKeyOf`: the placeholders, then each search's first page.
 */

import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { LocaleController } from "../../controllers/locale";
import { ASSET_MIME } from "../asset/dropIntent";
import { revealStep } from "../motion/browseMotion";
import { cascade, prefersReducedMotion, viewOf } from "../motion/cascade";
import { atPlayhead, importPathsAt } from "../asset/importDrop";
import { createClickOrder, downloadThenApply } from "./cloudApply";
import {
  cloudGifStore,
  loadMoreGifs,
  refreshInstalledGifs,
  retryGifs,
  showGifs,
} from "./cloudGifStore";
import { cloudStore, cloudUsable, subscribeCloudListing } from "./cloudStore";
import type { CloudItem } from "./cloudTypes";
import { searchGifs } from "./gifSearch";
import "./cloudGifTile";

/** A pause in typing this long is a search. */
const SEARCH_DEBOUNCE_MS = 300;
/** How far below the scroll the next page is asked for: about eight rows. */
const REACH_PX = 600;
/** Placeholder tiles while the first page is out. */
const SKELETONS = 12;

/**
 * Where the catalogue's GIFs come from, credited where they are offered: CC
 * BY 4.0 asks for it, and the MIT licence travels with the files
 * (`server/content/gifs/CREDITS.md`, written by `scripts/cloud/gifs/`).
 */
const CREDITS = [
  {
    label: "Noto Emoji Animation, Google",
    url: "https://googlefonts.github.io/noto-emoji-animation/",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  {
    label: "Fluent Emoji, Microsoft",
    url: "https://github.com/microsoft/fluentui-emoji-animated",
    license: "MIT",
    licenseUrl: "https://github.com/microsoft/fluentui-emoji-animated/blob/main/LICENSE",
  },
  {
    label: "Meteocons, Bas Milius",
    url: "https://meteocons.com",
    license: "MIT",
    licenseUrl: "https://github.com/basmilius/meteocons/blob/main/LICENSE",
  },
];

function openUrl(url: string) {
  (window as any).electronAPI?.req?.url?.openUrl?.(url);
}

/**
 * Which list the tiles on screen belong to; a new one cascades in.
 *
 * Nothing to show is one list whatever the search, so the placeholders are
 * shown once and not again when the request for them goes out. A search's
 * pages share its `seq`, so the second page does not count as new, and the
 * offline list is new with each search typed into it.
 */
function listKeyOf(local: boolean, items: readonly CloudItem[], seq: number, query: string): string {
  if (items.length === 0) {
    return "empty";
  }
  return local ? `local:${query}` : `feed:${seq}`;
}

@customElement("cloud-gif-section")
export class CloudGifSection extends LitElement {
  /** The search box's text, lower-cased by `<asset-browser>`. */
  @property({ type: String })
  query = "";

  /** See `<cloud-asset-grid>`'s. */
  @property({ attribute: false })
  revealFrom = 0;

  /** `query` once the typing has paused; what the server is asked. */
  private settledQuery = "";

  /** The list on screen, and the last one that cascaded in. */
  private listKey = "";
  private revealedKey: string | null = null;
  /** The heading cascades in with the first list only, and then stays. */
  private headRevealed = false;
  /**
   * The GIFs that cascaded in, whose pictures fade in as they load. Only
   * those on screen at the time: a tile further down is reached by scrolling,
   * and keeps the plain landing every scrolled-to tile has.
   */
  private batch: ReadonlySet<string> = new Set();
  private debounce: ReturnType<typeof setTimeout> | null = null;

  private lc = new LocaleController(this);
  private clicks = createClickOrder();
  private teardown: Array<() => void> = [];
  private observer: IntersectionObserver | null = null;

  createRenderRoot() {
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.settledQuery = this.query;
    this.teardown.push(cloudGifStore.subscribe(() => this.requestUpdate()));
    this.teardown.push(subscribeCloudListing(() => this.requestUpdate()));
    void refreshInstalledGifs();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounce != null) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
  }

  protected willUpdate(changed: PropertyValues) {
    const { local, items, feed } = this.listing();
    this.listKey = listKeyOf(local, items, feed.seq, this.settledQuery);

    if (changed.has("query") && changed.get("query") !== undefined) {
      if (this.debounce != null) {
        clearTimeout(this.debounce);
      }
      this.debounce = setTimeout(() => {
        this.debounce = null;
        this.settledQuery = this.query;
        this.requestUpdate();
      }, SEARCH_DEBOUNCE_MS);
    }
  }

  protected updated() {
    // A no-op unless the search changed or nothing has been asked yet.
    showGifs(this.settledQuery.trim());
    this.watchSentinel();
    // The observer reports a change of state only, so a page that arrives
    // and still leaves the sentinel within reach would get no report, and
    // the list would stop short of the panel's bottom. Each arrival measures
    // for itself. Not the observer's last answer: that is from before the
    // page was laid out, and trusting it asked for two pages too many.
    if (this.sentinelInReach()) {
      loadMoreGifs();
    }
    this.revealList();
  }

  private revealList() {
    if (this.revealedKey === this.listKey) {
      return;
    }
    this.revealedKey = this.listKey;
    const blocks = Array.from(this.querySelectorAll<HTMLElement>("[data-cascade]")).filter(
      (block) => !this.headRevealed || block.dataset.cascade !== "once",
    );
    this.headRevealed = true;
    const run = cascade(
      blocks,
      viewOf(this.scroller()),
      revealStep(prefersReducedMotion(), this.revealFrom - performance.now()),
    );
    // A microtask from here, so `arriving` is set before the tiles' own
    // visibility reports put an `<img>` in them.
    this.batch = new Set(
      run.animated.flatMap((block) => (block.dataset.cloud ? [block.dataset.cloud] : [])),
    );
    this.requestUpdate();
  }

  private scroller(): Element | null {
    return this.closest(".tab-content");
  }

  private sentinelInReach(): boolean {
    const sentinel = this.querySelector(".gif-sentinel");
    const scroller = this.scroller();
    if (sentinel == null || scroller == null) {
      return false;
    }
    // In a pane that is not showing, the sentinel has no box at all, and a
    // zero rect at the origin would read as "in reach" and page through the
    // whole list for nobody.
    if (sentinel.getClientRects().length === 0) {
      return false;
    }
    const at = sentinel.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return at.top <= view.bottom + REACH_PX && at.bottom >= view.top - REACH_PX;
  }

  private watchSentinel() {
    const sentinel = this.querySelector(".gif-sentinel");
    if (sentinel == null || this.observer != null) {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreGifs();
        }
      },
      { root: this.scroller(), rootMargin: `${REACH_PX}px 0px`, threshold: 0 },
    );
    this.observer.observe(sentinel);
  }

  private open = (item: CloudItem) => {
    const token = this.clicks.next();
    if (item.installed && item.localPath != null) {
      void importPathsAt([item.localPath], atPlayhead());
      return;
    }
    void downloadThenApply(this.clicks, token, "gif", item.id, item.name, {
      reload: () => refreshInstalledGifs(),
      apply: async (installedPath) => {
        await importPathsAt([installedPath], atPlayhead());
      },
    });
  };

  /** A downloaded GIF drags exactly as a local file does; the rest do not drag. */
  private dragStart = (event: DragEvent, item: CloudItem) => {
    if (!item.installed || item.localPath == null || event.dataTransfer == null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(ASSET_MIME, item.localPath);
    event.dataTransfer.effectAllowed = "copy";
  };

  private tile(item: CloudItem) {
    return html`<div
      class="asset gif-tile"
      data-cascade
      draggable=${item.installed && item.localPath != null ? "true" : "false"}
      data-cloud=${item.id}
      title=${item.name}
      aria-label=${item.name}
      @click=${() => this.open(item)}
      @dragstart=${(event: DragEvent) => this.dragStart(event, item)}
    >
      <cloud-gif-tile
        class="asset-thumb gif-thumb"
        .item=${item}
        .arriving=${this.batch.has(item.id)}
      ></cloud-gif-tile>
    </div>`;
  }

  private status(text: string, retry = false) {
    return html`<div class="gif-status" data-cascade>
      <span>${text}</span>
      ${retry
        ? html`<button type="button" class="gif-retry" @click=${() => retryGifs()}>
            ${this.lc.t("setting.cloud_gif_retry")}
          </button>`
        : ""}
    </div>`;
  }

  private credit() {
    const link = (url: string, text: string) =>
      html`<a
        href="#"
        @click=${(event: Event) => {
          event.preventDefault();
          openUrl(url);
        }}
        >${text}</a
      >`;
    return html`<div class="gif-credit" data-cascade>
      ${CREDITS.map(
        (credit) =>
          html`<div>${link(credit.url, credit.label)}, ${link(credit.licenseUrl, credit.license)}</div>`,
      )}
    </div>`;
  }

  /** What the section shows, from the stores, for `willUpdate` and `render` alike. */
  private listing() {
    const state = cloudGifStore.getState();
    const online = cloudUsable(cloudStore.getState());
    const { feed } = state;

    // Offline, or the server never answered: what is on disk, searched here.
    const local = !online || (feed.status === "error" && feed.items.length === 0);
    const items = local ? searchGifs(state.installed, this.settledQuery) : feed.items;
    return { state, online, feed, local, items };
  }

  render() {
    const { state, online, feed, local, items } = this.listing();
    const total = local ? items.length : feed.total;

    let footer;
    if (local) {
      footer =
        items.length === 0
          ? this.status(
              this.lc.t(
                state.installed.length === 0
                  ? "setting.cloud_gif_none_downloaded"
                  : "setting.cloud_no_matches",
              ),
              online,
            )
          : "";
    } else if (feed.status === "loading" || feed.status === "idle") {
      footer = "";
    } else if (feed.status === "error") {
      footer = this.status(this.lc.t("setting.cloud_gif_failed"), true);
    } else if (feed.items.length === 0) {
      footer = this.status(this.lc.t("setting.cloud_no_matches"));
    } else if (feed.status === "end") {
      footer = this.status(this.lc.t("setting.cloud_gif_end"));
    } else {
      footer = this.status(this.lc.t("setting.cloud_gif_more"));
    }

    const skeletons =
      !local && (feed.status === "loading" || feed.status === "idle")
        ? Array.from(
            { length: SKELETONS },
            () =>
              html`<div class="gif-tile is-skeleton" data-cascade>
                <div class="asset-thumb gif-thumb"></div>
              </div>`,
          )
        : "";

    return html`<section class="browse-section gif-section">
      <div class="browse-section-head" data-cascade="once">
        <span class="browse-section-title">${this.lc.t("setting.cloud_gif")}</span>
        <span class="browse-section-count">${total}</span>
      </div>
      <div class="gif-grid">
        ${repeat(items, (item) => item.id, (item) => this.tile(item))} ${skeletons}
      </div>
      <div class="gif-sentinel" aria-hidden="true"></div>
      ${footer} ${this.credit()}
    </section>`;
  }
}
