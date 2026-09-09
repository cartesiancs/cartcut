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
    );

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
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
   * One tile.
   *
   * The `asset` class and this column shape are the ones `fxPresetBrowser` and
   * the asset panel already use, so a template tile sits the same way in the
   * same grid rather than bringing a stylesheet of its own.
   *
   * The thumbnail is a `file://` image when the archive shipped one and an
   * icon when it did not — deliberately *not* a live render of the template.
   * That is the argument `lut/sampleImage.ts` makes about its own fixed
   * picture: a grid is a comparison, and one that moved under the user every
   * time the playhead did would have them judging two templates against two
   * different frames with nothing on screen saying so.
   */
  private tile(listing: TemplateListing) {
    return html`
      <div
        class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
        draggable="true"
        aria-event="template-tile"
        data-template=${listing.id}
        title=${listing.name}
        @click=${() => this.handleAdd(listing)}
        @dragstart=${(e: DragEvent) => this.handleDragStart(e, listing)}
      >
        ${listing.thumbnailPath == null
          ? html`<div
              style="width: 100%; aspect-ratio: 16/9; border-radius: 4px;
                     background: #2b2c33; display: flex; align-items: center;
                     justify-content: center; pointer-events: none;"
            >
              <span class="material-symbols-outlined" style="color: #5a6473;"
                >dashboard_customize</span
              >
            </div>`
          : html`<img
              src=${`file://${listing.thumbnailPath}`}
              alt=""
              style="width: 100%; aspect-ratio: 16/9; border-radius: 4px;
                     object-fit: cover; background: #2b2c33; display: block;
                     pointer-events: none;"
            />`}
        <div class="d-flex align-items-center" style="margin-top: 2px;">
          <span
            class="text-light"
            style="font-size: 11px; flex: 1 1 auto; white-space: nowrap;
                   overflow: hidden; text-overflow: ellipsis;"
            >${listing.name}</span
          >
          ${listing.origin === "user"
            ? html`<span
                class="material-symbols-outlined icon-xs text-secondary"
                aria-event="template-remove"
                data-template=${listing.id}
                style="cursor: pointer;"
                @click=${(e: Event) => this.handleRemove(e, listing)}
                >delete</span
              >`
            : ""}
        </div>
      </div>
    `;
  }

  private section(title: string, rows: TemplateListing[]) {
    if (rows.length === 0) {
      return "";
    }
    return html`
      <div class="text-secondary px-2 mt-2 text-uppercase">${title}</div>
      <div class="row px-2">${rows.map((row) => this.tile(row))}</div>
    `;
  }

  render() {
    const visible = this.templates.filter((row) => this.matchesQuery(row));
    const builtin = visible.filter((row) => row.origin === "builtin");
    const mine = visible.filter((row) => row.origin === "user");

    return html`
      <div class="d-flex gap-1 px-2">
        <input
          type="text"
          class="form-control form-control-sm bg-default text-light"
          aria-event="template-search"
          .value=${this.query}
          @input=${(e: Event) =>
            (this.query = (e.target as HTMLInputElement).value)}
        />
        <button
          class="btn btn-sm btn-default text-light"
          aria-event="template-import"
          @click=${() => this.handleImport()}
        >
          <span class="material-symbols-outlined icon-sm">upload</span>
        </button>
        <button
          class="btn btn-sm btn-default text-light"
          aria-event="template-folder"
          @click=${() => this.handleOpenFolder()}
        >
          <span class="material-symbols-outlined icon-sm">folder</span>
        </button>
      </div>

      ${this.templates.length === 0
        ? html`<div
            class="d-flex align-items-center gap-2 px-2 mt-3 text-secondary"
          >
            <span class="material-symbols-outlined icon-sm">upload</span>
            <span>.cttpl</span>
          </div>`
        : ""}
      ${this.section("Templates", builtin)}
      ${this.section("My Templates", mine)}
    `;
  }
}
