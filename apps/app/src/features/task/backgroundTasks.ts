/**
 * The tray of long-running work, pinned to the window's bottom-left.
 *
 * Present only while something is running. Bottom-left because the toasts own
 * bottom-centre and the export button owns the title bar; a job the user
 * started and walked away from should be findable without covering either.
 *
 * Draws `backgroundTaskStore` and nothing else — it knows no job by name, so
 * the next long job needs a row in the store, not a change here.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  backgroundTaskStore,
  type BackgroundTask,
} from "../../states/backgroundTaskStore";

@customElement("background-tasks")
export class BackgroundTasks extends LitElement {
  @property({ attribute: false })
  tasks: BackgroundTask[] = backgroundTaskStore.getState().tasks;

  createRenderRoot() {
    // Light DOM: the Bootstrap classes below come from a global stylesheet.
    backgroundTaskStore.subscribe((state) => {
      this.tasks = state.tasks;
    });
    return this;
  }

  render() {
    if (this.tasks.length === 0) {
      return html``;
    }
    return html`
      <div
        class="position-fixed bottom-0 start-0 m-3"
        style="z-index: 1080; width: 300px; max-width: calc(100vw - 2rem);"
        role="status"
        aria-live="polite"
      >
        ${this.tasks.map((task) => this.row(task))}
      </div>
    `;
  }

  private row(task: BackgroundTask) {
    const queued = task.stage === "queued";
    const known = task.fraction != null && !queued;
    const percent = known ? Math.floor((task.fraction as number) * 100) : 0;

    return html`
      <div
        class="bg-dark text-light border border-secondary rounded p-2 mb-2 shadow"
        data-keeps-selection
      >
        <div class="d-flex align-items-center gap-2 small">
          <span class="material-symbols-outlined" style="font-size: 16px;"
            >${task.icon ?? "hourglass_top"}</span
          >
          <span class="text-truncate flex-grow-1" title=${task.label}
            >${task.label}</span
          >
          <span class="text-secondary"
            >${queued ? "Waiting" : known ? `${percent}%` : ""}</span
          >
          ${task.cancel == null
            ? ""
            : html`<button
                type="button"
                class="btn btn-sm btn-link text-light p-0 lh-1"
                title="Cancel"
                aria-label="Cancel ${task.label}"
                @click=${() => task.cancel?.()}
              >
                <span class="material-symbols-outlined" style="font-size: 16px;"
                  >close</span
                >
              </button>`}
        </div>
        <div class="progress mt-1" style="height: 4px;">
          <div
            class="progress-bar ${known
              ? ""
              : "progress-bar-striped progress-bar-animated"}"
            style="width: ${known ? percent : 100}%;"
          ></div>
        </div>
      </div>
    `;
  }
}
