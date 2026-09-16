import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import { isProjectDirty } from "../project/projectDirty";
import { updateBridge, type UpdatePort } from "./updatePort";
import {
  HIDDEN_UPDATE,
  promptOf,
  reduceUpdate,
  shouldInstall,
  type UpdatePrompt as Prompt,
  type UpdateView,
} from "./updateView";

/**
 * The update card, pinned bottom-right.
 *
 * One message, one button, one bar: "Download?" becomes a progress bar, then
 * a restart. Bottom-right because `<background-tasks>` owns bottom-left and
 * the toasts bottom-centre, and a download of a gigabyte should leave the
 * editor usable while it runs.
 *
 * Closing it hides it for this run only. A download already started carries
 * on, and `autoInstallOnAppQuit` installs it at the next quit either way.
 *
 * Draws nothing in the web build, which has no updater.
 */
@customElement("update-prompt")
export class UpdatePromptElement extends LitElement {
  private lc = new LocaleController(this);

  private port: UpdatePort | null = updateBridge();

  private unsubscribe: (() => void) | null = null;

  @state()
  private view: UpdateView = HIDDEN_UPDATE;

  @state()
  private dismissed = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const port = this.port;
    if (port == null) {
      return;
    }
    // Subscribed before asking, so nothing sent in between is missed. Both
    // travel the same IPC pipe in order, so the answer is never older than an
    // event that arrives after it.
    this.unsubscribe = port.onEvent(this.apply);
    port
      .getState()
      .then(this.apply)
      .catch(() => {});
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.disconnectedCallback();
  }

  private apply = (event: unknown) => {
    this.view = reduceUpdate(this.view, event);
  };

  private dismiss = () => {
    this.dismissed = true;
  };

  private act = (event: MouseEvent) => {
    // A mouse click leaves focus on the button, and Enter clicks a focused
    // button again. Once this one reads "Restart to update", an Enter pressed
    // minutes later for anything else would restart the app. Space is safe
    // already (`Timeline.ts` cancels it); a keyboard click (`detail` 0) keeps
    // its focus, because the user put it there.
    if (event.detail > 0) {
      (event.currentTarget as HTMLElement | null)?.blur();
    }
    const port = this.port;
    const action = promptOf(this.view)?.action;
    if (port == null || action == null) {
      return;
    }
    if (action === "download") {
      void port.download();
      return;
    }
    const proceed = shouldInstall(isProjectDirty(), () =>
      window.confirm(this.lc.t("update.unsaved_confirm")),
    );
    if (proceed) {
      void port.install();
    }
  };

  render() {
    const view = this.view;
    const prompt = promptOf(view);
    if (this.dismissed || prompt == null || view.phase === "hidden") {
      return nothing;
    }
    const detail = view.phase === "failed" ? view.message : "";

    return html`
      <div
        class="update-prompt bg-dark text-light border border-secondary rounded shadow p-3"
        role="status"
        aria-live="polite"
        data-keeps-selection
      >
        <div class="d-flex align-items-start gap-2">
          <span class="material-symbols-outlined update-prompt-icon"
            >download</span
          >
          <div class="flex-grow-1 small" title=${detail}>
            <div class="fw-semibold">${this.lc.t(prompt.messageKey)}</div>
            <div class="text-secondary">Cartcut v${view.version}</div>
          </div>
          <button
            type="button"
            class="btn btn-sm btn-link text-light p-0 lh-1"
            title=${this.lc.t("update.close")}
            aria-label=${this.lc.t("update.close")}
            @click=${this.dismiss}
          >
            <span class="material-symbols-outlined update-prompt-icon"
              >close</span
            >
          </button>
        </div>
        ${this.bar(prompt)}
        <div class="d-flex justify-content-end align-items-center gap-2 mt-2">
          ${typeof prompt.progress === "number" && prompt.action == null
            ? html`<span class="small text-secondary"
                >${prompt.progress}%</span
              >`
            : nothing}
          <button
            type="button"
            class="btn btn-sm btn-primary"
            ?disabled=${prompt.action == null}
            @click=${this.act}
          >
            ${this.lc.t(prompt.buttonKey)}
          </button>
        </div>
      </div>
    `;
  }

  private bar(prompt: Prompt) {
    if (prompt.progress == null) {
      return nothing;
    }
    const known = prompt.progress !== "indeterminate";
    const percent = known ? (prompt.progress as number) : 100;
    return html`
      <div class="progress mt-2" style="height: 4px;">
        <div
          class="progress-bar ${known
            ? ""
            : "progress-bar-striped progress-bar-animated"}"
          role="progressbar"
          aria-valuenow=${known ? percent : nothing}
          aria-valuemin="0"
          aria-valuemax="100"
          style="width: ${percent}%;"
        ></div>
      </div>
    `;
  }
}
