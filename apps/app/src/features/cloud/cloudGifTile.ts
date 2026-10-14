/**
 * One GIF's picture in the grid: the GIF itself while it is near the screen,
 * nothing once it is not.
 *
 * A GIF is one file and is its own picture, so there is no smaller preview to
 * fall back on. Scrolled to the end, the section holds every tile, and each
 * one still holding its GIF would keep it decoded for nobody, so a tile
 * registers with `asset/tileVisibility.ts` (one observer for the panel) and
 * lets go of its image outside the observer's band. The bytes stay in the
 * HTTP cache, so scrolling back is not another download.
 *
 * The picture only: the section wraps it in the clickable tile, so the click,
 * the drag and the download stay in one place.
 *
 * A tile that cascaded in is `arriving`: its picture fades in when it has
 * loaded, the first time only. The tiles cascade in before their GIFs have
 * downloaded, so without it each picture still lands in its tile in one
 * frame. A tile reached by scrolling keeps the plain landing.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { observeVisibility, unobserveVisibility } from "../asset/tileVisibility";
import type { CloudItem } from "./cloudTypes";
import "./cloudBadge";

/** A local POSIX path as an `<img>` source, each segment escaped (`#`, `%`, spaces). */
function fileSrc(local: string): string {
  return "file://" + local.split("/").map(encodeURIComponent).join("/");
}

@customElement("cloud-gif-tile")
export class CloudGifTile extends LitElement {
  @property({ attribute: false })
  item: CloudItem | null = null;

  @state()
  private near = false;

  /** Fade the picture in when it first loads. See the file's comment. */
  @property({ type: Boolean, attribute: false })
  arriving = false;

  /** Whether the picture has loaded once, after which it never fades again. */
  @state()
  private landed = false;

  private handleLanded = () => {
    this.landed = true;
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    observeVisibility(this, (visible) => {
      this.near = visible;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    unobserveVisibility(this);
  }

  render() {
    const item = this.item;
    if (item == null) {
      return html``;
    }
    // The copy on disk first, so a downloaded GIF still shows offline.
    const src = item.localThumbnail != null ? fileSrc(item.localThumbnail) : item.thumbnailUrl;
    return html`
      ${this.near && src != null
        ? html`<img
            class="gif-thumb-img ${this.arriving && !this.landed ? "is-waiting" : ""}"
            src=${src}
            alt=""
            decoding="async"
            draggable="false"
            @load=${this.handleLanded}
            @error=${this.handleLanded}
          />`
        : ""}
      ${item.installed
        ? ""
        : html`<cloud-badge class="asset-thumb-cloud" kind="gif" item-id=${item.id}></cloud-badge>`}
    `;
  }
}
