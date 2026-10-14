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
        ? html`<img class="gif-thumb-img" src=${src} alt="" decoding="async" draggable="false" />`
        : ""}
      ${item.installed
        ? ""
        : html`<cloud-badge class="asset-thumb-cloud" kind="gif" item-id=${item.id}></cloud-badge>`}
    `;
  }
}
