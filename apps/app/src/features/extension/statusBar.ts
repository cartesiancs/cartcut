/**
 * Status items extensions have set, pinned to the window's bottom-right.
 *
 * Bottom-right because the other three corners are spoken for: the task tray
 * owns bottom-left, the toasts own bottom-centre, and the export button owns
 * the title bar. An extension's row has to be findable without covering any of
 * them.
 *
 * Present only while something has set one, the same rule `background-tasks`
 * follows. An empty strip is chrome the user cannot remove and that tells them
 * nothing.
 *
 * Draws `contributionStore` and nothing else. It knows no extension by name,
 * so the next one needs an entry in the store rather than a change here.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";

import { runContributedCommand } from "./bridge";
import { contributionStore, type ContributedStatusItem } from "./contributions";

@customElement("ext-status-items")
export class ExtStatusItems extends LitElement {
  createRenderRoot() {
    contributionStore.subscribe((store) => {
      this.items = store.statusItems;
    });
    return this;
  }

  @state()
  private items: ContributedStatusItem[] = contributionStore.getState().statusItems;

  private activate(item: ContributedStatusItem): void {
    if (item.commandId == null) {
      return;
    }
    void runContributedCommand(item.extId, item.commandId);
  }

  private row(item: ContributedStatusItem) {
    const clickable = item.commandId != null;

    return html`<button
      class="btn btn-sm btn-default text-light"
      style="font-size: 0.72rem; ${clickable ? "" : "pointer-events: none;"}"
      title=${item.tooltip ?? item.extId}
      ?disabled=${!clickable}
      @click=${() => this.activate(item)}
    >
      ${item.text}
    </button>`;
  }

  render() {
    if (this.items.length === 0) {
      return html``;
    }

    return html`
      <div
        class="position-fixed bottom-0 end-0 m-3 d-flex gap-1 align-items-center"
        style="z-index: 1080; max-width: calc(100vw - 2rem);"
        role="status"
        aria-live="polite"
      >
        ${this.items.map((item) => this.row(item))}
      </div>
    `;
  }
}
