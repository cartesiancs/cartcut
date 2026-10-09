import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { TEMPLATE_MIME } from "../asset/dropIntent";
import { addTemplateToTimeline } from "./addTemplate";
import { pickAndInstallTemplate, removeTemplate } from "./templateInstall";
import {
  installedTemplates,
  refreshTemplateLibrary,
  subscribeTemplates,
  type TemplateListing,
} from "./templateRegistry";
import { isReadableSchemaVersion } from "../timeline/tracks";
import { cloudItemsOf, ensureCatalog, subscribeCloudListing } from "../cloud/cloudStore";
import { cloudItemMatches, cloudTemplateTiles, type TemplateTile } from "../cloud/cloudMerge";
import { createClickOrder, downloadThenApply } from "../cloud/cloudApply";
import type { CloudItem } from "../cloud/cloudTypes";
import "../cloud/cloudBadge";

/**
 * The template library: browse, add, import, remove.
 *
 * Modelled on `fx/fxPresetBrowser.ts`, and it inherits three of that panel's
 * decisions for the reasons it states.
 *
 * `data-keeps-selection`, because `elementTimelineCanvas._handleDocumentClick`
 * clears the selection on any document mousedown that has not opted out — a
 * tile without it would act on nothing.
 *
 * An `IntersectionObserver`, because this panel mounts at app startup inside a
 * `display: none` pane and Lit has no reason to re-render when the pane is
 * finally shown; the library is read the first time it is actually visible, so
 * a session that never opens the tab reads no disk.
 *
 * A drag carrying an **id**, not a path — the registry has already resolved the
 * folder, so the drop target looks it up rather than reading the disk again.
 */
@customElement("template-browser")
export class TemplateBrowser extends LitElement {
  @state() private query = "";
  @state() private templates: TemplateListing[] = [];
  @state() private busy = false;

  private teardown: Array<() => void> = [];
  private loaded = false;
  /** Which click is the latest, so a slow download cannot apply over a newer one. */
  private clicks = createClickOrder();
  /** Whether the panel has been on screen; the catalog is asked for only from then. */
  private seen = false;

  createRenderRoot() {
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  connectedCallback() {
    super.connectedCallback();

    this.teardown.push(
      subscribeTemplates(() => {
        this.templates = installedTemplates();
      }),
      subscribeCloudListing(() => this.requestUpdate()),
    );

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.seen = true;
        ensureCatalog("template");
        void this.ensureLoaded();
      }
    });
    observer.observe(this);
    this.teardown.push(() => observer.disconnect());
  }

  disconnectedCallback() {
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
    super.disconnectedCallback();
  }

  updated() {
    // A no-op unless the catalog is missing or stale.
    if (this.seen && this.offsetParent != null) {
      ensureCatalog("template");
    }
  }

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    await refreshTemplateLibrary();
    this.templates = installedTemplates();
  }

  private toast(message: string) {
    (document.querySelector("toast-box") as any)?.showToast({
      message,
      delay: "3000",
    });
  }

  // ---------------------------------------------------------------- actions

  private async handleAdd(listing: TemplateListing) {
    this.clicks.next();
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      // At the playhead, which is where every other "add" gesture puts things.
      const result = await addTemplateToTimeline(listing.id, {
        startMs: useTimelineStore.getState().cursor,
      });
      if (!result.ok) {
        this.toast(result.message);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * A cloud template: download it, then add it at the playhead as a local
   * tile would. Deliberately not behind `busy`, which would leave every other
   * tile dead for as long as the download takes.
   */
  private handleCloudAdd(item: CloudItem) {
    const token = this.clicks.next();
    void downloadThenApply(this.clicks, token, "template", item.id, item.name, {
      reload: () => refreshTemplateLibrary(),
      apply: async () => {
        const result = await addTemplateToTimeline(item.id, {
          startMs: useTimelineStore.getState().cursor,
        });
        if (!result.ok) {
          this.toast(result.message);
        }
      },
    });
  }

  private handleDragStart(event: DragEvent, listing: TemplateListing) {
    event.dataTransfer?.setData(TEMPLATE_MIME, listing.id);
    if (event.dataTransfer != null) {
      event.dataTransfer.effectAllowed = "copy";
    }
  }

  private async handleImport() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const result = await pickAndInstallTemplate();
      // `null` is a cancelled dialog. Reporting it as a failure is the mistake
      // `pickAndImportLut` names explicitly.
      if (result == null) {
        return;
      }
      this.toast(result.ok ? `Imported ${result.name}` : result.message);
    } finally {
      this.busy = false;
    }
  }

  private async handleRemove(event: Event, listing: TemplateListing) {
    event.stopPropagation();
    if (!window.confirm(`Remove ${listing.name}?`)) {
      return;
    }
    const result = await removeTemplate(listing.id);
    if (!result.ok) {
      this.toast(result.reason ?? "Could not remove that template.");
    }
  }

  /** Show where imported templates live, so the user can put one there. */
  private async handleOpenFolder() {
    const api = (window as any).electronAPI?.req?.template;
    const result = await api?.userDirectory?.();
    if (result?.path != null) {
      this.toast(result.path);
    }
  }

  // ------------------------------------------------------------------ tiles

  // Not `matches`: that is `HTMLElement.matches`, and overriding it with a
  // different signature makes the class stop being an Element.
  private matchesQuery(listing: TemplateListing): boolean {
    const query = this.query.trim().toLowerCase();
    if (query === "") {
      return true;
    }
    return (
      listing.name.toLowerCase().includes(query) ||
      listing.id.toLowerCase().includes(query)
    );
  }

  /**
   * One tile, in the file browser's shape (`.asset-thumb` over `.asset-name`),
   * so a template sits in the same grid as a file rather than bringing a
   * stylesheet of its own.
   *
   * The thumbnail is a `file://` image when the archive shipped one and an
   * icon when it did not, deliberately *not* a live render of the template.
   * That is the argument `lut/sampleImage.ts` makes about its own fixed
   * picture: a grid is a comparison, and one that moved under the user every
   * time the playhead did would have them judging two templates against two
   * different frames with nothing on screen saying so.
   *
   * Remove sits over the well and shows on hover. In the caption row it took
   * width from the name on exactly the tiles whose names are longest, the ones
   * a user typed.
   */
  private tile(listing: TemplateListing) {
    return html`
      <div
        class="asset asset-tile"
        draggable="true"
        aria-event="template-tile"
        data-template=${listing.id}
        title=${listing.name}
        @click=${() => this.handleAdd(listing)}
        @dragstart=${(e: DragEvent) => this.handleDragStart(e, listing)}
      >
        <div class="asset-thumb">
          ${listing.thumbnailPath == null
            ? html`<span class="material-symbols-outlined asset-thumb-icon"
                >dashboard_customize</span
              >`
            : html`<img
                class="asset-thumb-img"
                src=${`file://${listing.thumbnailPath}`}
                alt=""
                decoding="async"
              />`}
          ${listing.origin === "user"
            ? html`<button
                type="button"
                class="asset-thumb-action"
                aria-event="template-remove"
                data-template=${listing.id}
                title="Remove ${listing.name}"
                aria-label="Remove ${listing.name}"
                draggable="false"
                @click=${(e: Event) => this.handleRemove(e, listing)}
              >
                <span class="material-symbols-outlined">delete</span>
              </button>`
            : ""}
        </div>
        <span class="asset-name">${listing.name}</span>
      </div>
    `;
  }

  /** A cloud template not yet downloaded: its thumbnail and the cloud badge. */
  private cloudTile(item: CloudItem) {
    return html`
      <div
        class="asset asset-tile"
        draggable="false"
        data-cloud=${item.id}
        title=${item.name}
        @click=${() => this.handleCloudAdd(item)}
      >
        <div class="asset-thumb">
          ${item.thumbnailUrl == null
            ? ""
            : html`<img
                class="asset-thumb-img"
                src=${item.thumbnailUrl}
                alt=""
                decoding="async"
                draggable="false"
              />`}
          <cloud-badge
            class="asset-thumb-cloud"
            kind="template"
            item-id=${item.id}
          ></cloud-badge>
        </div>
        <span class="asset-name">${item.name}</span>
      </div>
    `;
  }

  /**
   * Downloaded and not yet downloaded together, by name, so a tile stays
   * where it was when its download finishes (`cloudMerge.ts`).
   */
  private cloudSection(tiles: TemplateTile[]) {
    if (tiles.length === 0) {
      return "";
    }
    return html`
      <section class="browse-section">
        <div class="browse-section-head">
          <span class="browse-section-title">Cloud</span>
          <span class="browse-section-count">${tiles.length}</span>
        </div>
        <div class="asset-grid browse-grid">
          ${tiles.map((tile) =>
            tile.type === "template" ? this.tile(tile.listing) : this.cloudTile(tile.item),
          )}
        </div>
      </section>
    `;
  }

  private section(title: string, rows: TemplateListing[]) {
    if (rows.length === 0) {
      return "";
    }
    return html`
      <section class="browse-section">
        <div class="browse-section-head">
          <span class="browse-section-title">${title}</span>
          <span class="browse-section-count">${rows.length}</span>
        </div>
        <div class="asset-grid browse-grid">
          ${rows.map((row) => this.tile(row))}
        </div>
      </section>
    `;
  }

  /** Nothing installed, or nothing matching: the two ways the grid is empty. */
  private empty(visible: number, offered: number) {
    if (this.templates.length === 0 && offered === 0) {
      return html`<div class="browse-empty">
        <div class="browse-empty-icon">
          <span class="material-symbols-outlined">dashboard_customize</span>
        </div>
        <div class="browse-empty-title">No templates yet</div>
        <div class="browse-empty-text">
          Import a .cttpl file to reuse a whole edit as one clip.
        </div>
        <button
          type="button"
          class="browse-text-btn is-primary"
          ?disabled=${this.busy}
          @click=${() => this.handleImport()}
        >
          <span class="material-symbols-outlined">upload</span>
          Import template
        </button>
      </div>`;
    }
    if (visible === 0) {
      return html`<div class="browse-empty">
        <div class="browse-empty-icon">
          <span class="material-symbols-outlined">search_off</span>
        </div>
        <div class="browse-empty-title">No matches</div>
        <div class="browse-empty-text">Try another name.</div>
      </div>`;
    }
    return "";
  }

  render() {
    const visible = this.templates.filter((row) => this.matchesQuery(row));
    const builtin = visible.filter((row) => row.origin === "builtin");
    const contributed = visible.filter((row) => row.origin === "extension");
    const mine = visible.filter((row) => row.origin === "user");
    const catalog = cloudItemsOf("template");
    const query = this.query.trim().toLowerCase();
    const cloud = cloudTemplateTiles(
      visible,
      catalog.filter((item) => cloudItemMatches(item, query)),
      isReadableSchemaVersion,
    );
    // Every visible tile, cloud ones included, for the "No matches" state.
    const shown = builtin.length + contributed.length + mine.length + cloud.length;

    return html`
      <div class="browse-bar">
        <label class="browse-field">
          <span class="material-symbols-outlined browse-field-icon"
            >search</span
          >
          <input
            type="search"
            class="browse-input"
            spellcheck="false"
            placeholder="Search templates"
            aria-event="template-search"
            .value=${this.query}
            @input=${(e: Event) =>
              (this.query = (e.target as HTMLInputElement).value)}
          />
        </label>
        <button
          type="button"
          class="browse-btn"
          aria-event="template-import"
          title="Import a .cttpl template"
          aria-label="Import a .cttpl template"
          ?disabled=${this.busy}
          @click=${() => this.handleImport()}
        >
          <span class="material-symbols-outlined">upload</span>
        </button>
        <button
          type="button"
          class="browse-btn"
          aria-event="template-folder"
          title="Show the templates folder"
          aria-label="Show the templates folder"
          @click=${() => this.handleOpenFolder()}
        >
          <span class="material-symbols-outlined">folder</span>
        </button>
      </div>

      ${this.empty(shown, catalog.length)} ${this.section("Templates", builtin)}
      <!--
        A section of its own, so a user who wonders where a template came from
        can see it, and so the delete glyph stays off rows this panel does not
        own. Removing one means disabling its extension.
      -->
      ${this.section("From Extensions", contributed)}
      ${this.section("My Templates", mine)}
      <!--
        Last, after everything already on this machine. Downloaded templates
        stay here rather than joining My Templates: they are the cloud's, and
        only a template the user imported carries the delete glyph.
      -->
      ${this.cloudSection(cloud)}
    `;
  }
}
