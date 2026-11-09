/**
 * The two questions a browser build asks about files that the desktop app's
 * native dialogs answer: what to call a project saved as a download, and
 * where a reopened project's media went.
 *
 * Its own small overlay rather than a Bootstrap modal: the vendored Bootstrap
 * 5.0.2 is the editor's, and a second modal stacked on one of its own (a load
 * failure) would fight it for the backdrop. One element, made on first use and
 * reused, in the light DOM like every other component here.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

export type RelinkItem = {
  name: string;
  state: "found" | "missing" | "permission";
};

/** What the reconnect dialog drives. Every action re-reads `items` after it. */
export type RelinkSession = {
  items(): RelinkItem[];
  /** Ask for the remembered files' permission again. A click is the user activation it needs. */
  allow(): Promise<void>;
  /** Let the user pick files to match against what is missing. */
  locate(): Promise<void>;
};

export type NameRequest = {
  title: string;
  note: string;
  /** Accepted extensions, lower case with the dot; a name with none of them gets the first. */
  extensions: readonly string[];
};

const PROJECT_NAME: NameRequest = {
  title: "Save Project",
  note: "This browser saves the project as a download.",
  extensions: [".ngt"],
};

type Mode =
  | { kind: "idle" }
  | { kind: "name"; value: string; request: NameRequest; resolve: (name: string | null) => void }
  | { kind: "relink"; session: RelinkSession; resolve: () => void; busy: boolean };

@customElement("web-file-dialog")
export class WebFileDialog extends LitElement {
  @state() private mode: Mode = { kind: "idle" };

  createRenderRoot() {
    return this;
  }

  /** Ask for a file name, a project's by default. `null` when cancelled. */
  askName(suggested: string, request: NameRequest = PROJECT_NAME): Promise<string | null> {
    this.finish();
    return new Promise((resolve) => {
      this.mode = { kind: "name", value: suggested, request, resolve };
      void this.updateComplete.then(() => {
        const input = this.querySelector<HTMLInputElement>(".wfd-input");
        input?.focus();
        // The name without its extension selected, as a desktop save dialog does.
        const dot = suggested.lastIndexOf(".");
        input?.setSelectionRange(0, dot > 0 ? dot : suggested.length);
      });
    });
  }

  /** Show the media a reopened project could not find, until the user moves on. */
  relink(session: RelinkSession): Promise<void> {
    this.finish();
    return new Promise((resolve) => {
      this.mode = { kind: "relink", session, resolve, busy: false };
      void this.updateComplete.then(() =>
        this.querySelector<HTMLButtonElement>(".wfd-button.is-primary")?.focus(),
      );
    });
  }

  /** Settle whatever is open, as if cancelled. */
  private finish(): void {
    const mode = this.mode;
    this.mode = { kind: "idle" };
    if (mode.kind === "name") {
      mode.resolve(null);
    } else if (mode.kind === "relink") {
      mode.resolve();
    }
  }

  private submitName = (event?: Event) => {
    event?.preventDefault();
    const mode = this.mode;
    if (mode.kind !== "name") {
      return;
    }
    const raw = (this.querySelector<HTMLInputElement>(".wfd-input")?.value ?? "").trim();
    if (raw === "") {
      return;
    }
    const lower = raw.toLowerCase();
    const extensions = mode.request.extensions;
    const name = extensions.some((ext) => lower.endsWith(ext)) ? raw : `${raw}${extensions[0] ?? ""}`;
    this.mode = { kind: "idle" };
    mode.resolve(name.replace(/[\\/:*?"<>|]/g, "-"));
  };

  private act = async (action: "allow" | "locate") => {
    const mode = this.mode;
    if (mode.kind !== "relink" || mode.busy) {
      return;
    }
    this.mode = { ...mode, busy: true };
    try {
      await (action === "allow" ? mode.session.allow() : mode.session.locate());
    } finally {
      if (this.mode.kind === "relink") {
        this.mode = { ...this.mode, busy: false };
      }
    }
  };

  private done = () => {
    const mode = this.mode;
    if (mode.kind === "relink") {
      this.mode = { kind: "idle" };
      mode.resolve();
    }
  };

  private onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.mode.kind === "relink") {
        this.done();
      } else {
        this.finish();
      }
    }
  };

  private styles() {
    return html`<style>
      .wfd-scrim {
        position: fixed;
        inset: 0;
        z-index: 10050;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .wfd-card {
        width: min(440px, calc(100vw - 32px));
        max-height: calc(100vh - 64px);
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 18px;
        border-radius: 12px;
        background: #17191c;
        border: 1px solid #2b2f34;
        color: #e9ecef;
        font-size: 13px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      }
      .wfd-title {
        font-size: 14px;
        font-weight: 700;
        margin: 0;
      }
      .wfd-text {
        color: #9aa1a9;
        margin: 0;
        line-height: 1.45;
      }
      .wfd-input {
        width: 100%;
        padding: 7px 10px;
        border-radius: 6px;
        border: 1px solid #3a3f44;
        background: #0f1012;
        color: #e9ecef;
        font-size: 13px;
        outline: none;
      }
      .wfd-input:focus {
        border-color: #4c8dff;
      }
      .wfd-list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        border: 1px solid #2b2f34;
        border-radius: 8px;
      }
      .wfd-list li {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 10px;
        border-bottom: 1px solid #22262a;
      }
      .wfd-list li:last-child {
        border-bottom: 0;
      }
      .wfd-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wfd-state {
        flex: none;
        color: #9aa1a9;
      }
      .wfd-state.is-found {
        color: #5cc98a;
      }
      .wfd-state.is-missing {
        color: #f0a35c;
      }
      .wfd-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .wfd-button {
        border: 1px solid #3a3f44;
        background: #23262a;
        color: #e9ecef;
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .wfd-button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .wfd-button.is-primary {
        background: #2f6fea;
        border-color: #2f6fea;
      }
    </style>`;
  }

  private renderName(mode: Extract<Mode, { kind: "name" }>) {
    return html`
      <form class="wfd-card" role="dialog" aria-modal="true" aria-label=${mode.request.title} @submit=${this.submitName}>
        <p class="wfd-title">${mode.request.title}</p>
        <p class="wfd-text">${mode.request.note}</p>
        <input class="wfd-input" type="text" .value=${mode.value} spellcheck="false" aria-label="File name" />
        <div class="wfd-actions">
          <button type="button" class="wfd-button" @click=${() => this.finish()}>Cancel</button>
          <button type="submit" class="wfd-button is-primary">Save</button>
        </div>
      </form>
    `;
  }

  private renderRelink(mode: Extract<Mode, { kind: "relink" }>) {
    const items = mode.session.items();
    const waiting = items.filter((item) => item.state !== "found").length;
    const needsPermission = items.some((item) => item.state === "permission");
    const label = (item: RelinkItem) =>
      item.state === "found" ? "Found" : item.state === "permission" ? "Needs access" : "Missing";
    return html`
      <div class="wfd-card" role="dialog" aria-modal="true" aria-label="Reconnect Media">
        <p class="wfd-title">Reconnect Media</p>
        <p class="wfd-text">
          ${waiting === 0
            ? "Every media file this project uses is connected."
            : waiting === 1
              ? "1 media file this project uses is not connected in this browser yet."
              : `${waiting} media files this project uses are not connected in this browser yet.`}
          ${needsPermission ? " Files opened here before can be reconnected with your permission." : nothing}
          ${items.some((item) => item.state === "missing")
            ? needsPermission
              ? " Pick the rest again with Locate Files: each is matched by name and size."
              : " Pick them again with Locate Files: each is matched by name and size."
            : nothing}
        </p>
        <ul class="wfd-list">
          ${items.map(
            (item) => html`<li>
              <span class="wfd-name" title=${item.name}>${item.name}</span>
              <span class="wfd-state is-${item.state}">${label(item)}</span>
            </li>`,
          )}
        </ul>
        <div class="wfd-actions">
          ${needsPermission
            ? html`<button type="button" class="wfd-button" ?disabled=${mode.busy} @click=${() => this.act("allow")}>
                Allow Access
              </button>`
            : nothing}
          ${items.some((item) => item.state !== "found")
            ? html`<button type="button" class="wfd-button" ?disabled=${mode.busy} @click=${() => this.act("locate")}>
                Locate Files…
              </button>`
            : nothing}
          <button type="button" class="wfd-button is-primary" ?disabled=${mode.busy} @click=${this.done}>
            ${waiting === 0 ? "Open" : "Open Without Them"}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    const mode = this.mode;
    if (mode.kind === "idle") {
      return nothing;
    }
    return html`${this.styles()}
      <div class="wfd-scrim" @keydown=${this.onKeydown}>
        ${mode.kind === "name" ? this.renderName(mode) : this.renderRelink(mode)}
      </div>`;
  }
}

/** The one dialog, made on first use. */
export function webFileDialog(): WebFileDialog {
  let dialog = document.querySelector("web-file-dialog") as WebFileDialog | null;
  if (dialog == null) {
    dialog = document.createElement("web-file-dialog") as WebFileDialog;
    document.body.appendChild(dialog);
  }
  return dialog;
}
