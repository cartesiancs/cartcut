/**
 * The asset browser's cloud view: free media, one section per media type.
 *
 * Unlike the FX tab, where cloud tiles sit among the local ones, media is a
 * separate place: the local view is a folder on disk and the cloud one is
 * not, so mixing them would put files in a folder that does not hold them.
 * `<asset-browser>` mounts this only while its cloud button is on, which is
 * what makes `connectedCallback` the right moment to ask for the catalog.
 *
 * Offline, or with the server unreachable, it shows what is already
 * downloaded, read from disk (`cloud:installedAssets`), with a line saying so.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import { LocaleController } from "../../controllers/locale";
import { ASSET_MIME } from "../asset/dropIntent";
import { atPlayhead, importPathsAt } from "../asset/importDrop";
import { createClickOrder, downloadThenApply } from "./cloudApply";
import { cloudAssetTiles, cloudItemMatches } from "./cloudMerge";
import {
  catalogStatus,
  cloudItemsOf,
  cloudStore,
  ensureCatalog,
  refreshInstalledAssets,
  subscribeCloudListing,
} from "./cloudStore";
import type { CloudItem } from "./cloudTypes";
import "./cloudBadge";

const SECTIONS = [
  { type: "video", label: "setting.cloud_video", icon: "movie" },
  { type: "image", label: "setting.cloud_image", icon: "image" },
  { type: "audio", label: "setting.cloud_audio", icon: "music_note" },
] as const;

@customElement("cloud-asset-grid")
export class CloudAssetGrid extends LitElement {
  /** Lower-cased by the caller's search field. */
  @property({ type: String })
  query = "";

  private lc = new LocaleController(this);
  private clicks = createClickOrder();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    // Or the timeline canvas's document-level mousedown clears the selection
    // before a tile's click handler runs.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.teardown.push(subscribeCloudListing(() => this.requestUpdate()));
    void refreshInstalledAssets();
    ensureCatalog("asset");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
  }

  updated() {
    // A no-op unless the catalog is missing or stale.
    ensureCatalog("asset");
  }

  /**
   * Put it on the timeline at the playhead, as clicking a local file does,
   * downloading it first when it is not on disk yet.
   */
  private open(item: CloudItem) {
    const token = this.clicks.next();
    if (item.installed && item.localPath != null) {
      void importPathsAt([item.localPath], atPlayhead());
      return;
    }
    void downloadThenApply(this.clicks, token, "asset", item.id, item.name, {
      reload: () => refreshInstalledAssets(),
      apply: async (installedPath) => {
        await importPathsAt([installedPath], atPlayhead());
      },
    });
  }

  /** A downloaded asset drags exactly as a local file does; the rest do not drag. */
  private handleDragStart(event: DragEvent, item: CloudItem) {
    if (!item.installed || item.localPath == null || event.dataTransfer == null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(ASSET_MIME, item.localPath);
    event.dataTransfer.effectAllowed = "copy";
  }

  private tile(item: CloudItem, icon: string) {
    // The copy on disk once there is one, so a downloaded tile still has a
    // picture with the network gone.
    const thumbnail =
      item.localThumbnail != null ? `file://${item.localThumbnail}` : item.thumbnailUrl;
    const draggable = item.installed && item.localPath != null;
    return html`
      <div
        class="asset asset-tile"
        draggable=${draggable ? "true" : "false"}
        data-cloud=${item.id}
        title=${item.name}
        @click=${() => this.open(item)}
        @dragstart=${(event: DragEvent) => this.handleDragStart(event, item)}
      >
        <div class="asset-thumb">
          ${thumbnail == null
            ? html`<span class="material-symbols-outlined asset-thumb-icon">${icon}</span>`
            : html`<img
                class="asset-thumb-img"
                src=${thumbnail}
                alt=""
                decoding="async"
                draggable="false"
              />`}
          ${item.installed
            ? ""
            : html`<cloud-badge
                class="asset-thumb-cloud"
                kind="asset"
                item-id=${item.id}
              ></cloud-badge>`}
        </div>
        <span class="asset-name">${item.name}</span>
      </div>
    `;
  }

  private notice(text: string) {
    return html`<div class="browse-alert">
      <span class="material-symbols-outlined">cloud_off</span>
      <span>${text}</span>
    </div>`;
  }

  private empty(icon: string, title: string) {
    return html`<div class="browse-empty">
      <div class="browse-empty-icon">
        <span class="material-symbols-outlined">${icon}</span>
      </div>
      <div class="browse-empty-title">${title}</div>
    </div>`;
  }

  render() {
    const state = cloudStore.getState();
    const status = catalogStatus("asset", state);
    const all = cloudAssetTiles(state.installedAssets, cloudItemsOf("asset", state));
    const tiles = all.filter((item) => cloudItemMatches(item, this.query));

    const offline = !state.online || status === "offline";
    const unreachable = !offline && status === "unreachable";

    const sections = SECTIONS.map((section) => ({
      ...section,
      items: tiles.filter((item) => item.media?.type === section.type),
    })).filter((section) => section.items.length > 0);

    let body;
    if (all.length === 0) {
      body =
        status === "loading"
          ? this.empty("cloud_download", this.lc.t("setting.cloud_loading"))
          : this.empty("cloud", this.lc.t("setting.cloud_empty"));
    } else if (sections.length === 0) {
      body = this.empty("search_off", this.lc.t("setting.cloud_no_matches"));
    } else {
      body = sections.map(
        (section) => html`
          <section class="browse-section">
            <div class="browse-section-head">
              <span class="browse-section-title">${this.lc.t(section.label)}</span>
              <span class="browse-section-count">${section.items.length}</span>
            </div>
            <div class="asset-grid browse-grid">
              ${section.items.map((item) => this.tile(item, section.icon))}
            </div>
          </section>
        `,
      );
    }

    return html`
      ${offline ? this.notice(this.lc.t("setting.cloud_offline")) : ""}
      ${unreachable ? this.notice(this.lc.t("setting.cloud_unreachable")) : ""}
      ${body}
    `;
  }
}
