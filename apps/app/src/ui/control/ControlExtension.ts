import { LitElement, html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

import { contributionStore } from "../../features/extension/contributions";
import { hostStateMessage, hostStateStore } from "../../features/extension/hostState";
import { runContributedCommand } from "../../features/extension/bridge";

type Listing = {
  id: string;
  dir: string;
  origin: "installed" | "unpacked";
  displayName: string;
  version: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  phase: string;
  errors: string[];
  configuration: { title?: string; properties?: Record<string, ConfigProperty> } | null;
};

type ConfigProperty = {
  type: "string" | "number" | "integer" | "boolean";
  default?: string | number | boolean;
  description?: string;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
};

type LogLine = { at: number; level: string; text: string };

/**
 * The Extensions panel.
 *
 * What replaced two dev buttons and a commented-out `<webview>`. The old panel
 * could open a folder as an extension and nothing else: no list, no way to
 * turn one off, no way to see why one had not loaded, and no way to remove it
 * short of finding the temp directory it had been unzipped into.
 *
 * Everything it can do goes through `electronAPI.req.ext`, and every call
 * names an extension by **id**. Main owns `userData/extensions`, so there is
 * no call shape in which this panel chooses a path to delete.
 *
 * The install flow is two steps on purpose. `inspect` reads the archive and
 * reports what it would install, including the permissions in the user's own
 * words; only a confirmed second call writes anything. A user who declines
 * must not already have the extension on disk.
 */
@customElement("control-ui-extension")
export class ControlExtension extends LitElement {
  createRenderRoot() {
    hostStateStore.subscribe(() => this.requestUpdate());
    contributionStore.subscribe(() => this.requestUpdate());
    return this;
  }

  @state() private listings: Listing[] = [];
  @state() private busy = false;
  @state() private expanded: string | null = null;
  @state() private logLines: LogLine[] = [];
  @state() private configValues: Record<string, string | number | boolean> = {};
  @state() private commandFilter = "";

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();

    // The host reports each extension's phase as it changes, and those arrive
    // after the first listing. Without this the panel shows "Idle" for an
    // extension that activated a moment later, until something else happens to
    // re-render it.
    const api = (window as never as { electronAPI?: { res?: { ext?: Record<string, Function> } } })
      .electronAPI?.res?.ext;
    this.stopWatching = api?.onExtensionState?.(() => void this.refresh()) ?? null;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private stopWatching: (() => void) | null = null;

  private get api() {
    return (window as never as { electronAPI?: { req?: { ext?: Record<string, Function> } } })
      .electronAPI?.req?.ext;
  }

  private async refresh(): Promise<void> {
    const answer = (await this.api?.list?.()) as { ok?: boolean; extensions?: Listing[] } | undefined;
    this.listings = answer?.ok === true ? (answer.extensions ?? []) : [];
  }

  private async withBusy(run: () => Promise<unknown>): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await run();
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private notify(message: string): void {
    const box = document.querySelector("toast-box") as
      | { showToast?: (options: unknown) => void }
      | null;
    if (typeof box?.showToast === "function") {
      box.showToast({ message, delay: "4000" });
    }
  }

  private handleInstall = () => {
    void this.withBusy(async () => {
      const picked = (await (
        window as never as { electronAPI: { req: { dialog: { openFile: Function } } } }
      ).electronAPI.req.dialog.openFile(["cartcut-ext", "zip"])) as string | undefined;
      if (picked == null || picked === "") {
        return;
      }

      const inspected = (await this.api?.inspect?.(picked)) as
        | {
            ok?: boolean;
            error?: string;
            displayName?: string;
            version?: string;
            permissions?: Array<{ id: string; description: string }>;
            replaces?: boolean;
          }
        | undefined;

      if (inspected?.ok !== true) {
        this.notify("That file is not an extension: " + (inspected?.error ?? "unknown reason"));
        return;
      }

      const lines = [
        (inspected.replaces === true ? "Replace " : "Install ") +
          inspected.displayName +
          " " +
          inspected.version +
          "?",
        "",
        ...(inspected.permissions ?? []).map((permission) => "• " + permission.description),
        "",
        "Extensions run with the same access to your computer that this app has.",
      ];

      // `confirm` rather than a Bootstrap modal: this is the one place in the
      // app where a dialog must be impossible to click past by accident, and a
      // native modal is the only one that cannot be dismissed by a stray
      // keystroke reaching the page behind it.
      if (!window.confirm(lines.join("\n"))) {
        return;
      }

      const outcome = (await this.api?.install?.(picked)) as
        | { ok?: boolean; error?: string }
        | undefined;
      this.notify(
        outcome?.ok === true
          ? inspected.displayName + " installed."
          : "Could not install: " + (outcome?.error ?? "unknown reason"),
      );
    });
  };

  private handleLoadUnpacked = () => {
    void this.withBusy(async () => {
      const outcome = (await this.api?.loadUnpacked?.()) as
        | { ok?: boolean; cancelled?: boolean; error?: string }
        | undefined;
      if (outcome?.ok !== true) {
        this.notify("Could not load that folder: " + (outcome?.error ?? "unknown reason"));
      }
    });
  };

  private handleOpenFolder = () => {
    void this.api?.openFolder?.();
  };

  private handleRestart = () => {
    void this.withBusy(async () => {
      await this.api?.restart?.();
    });
  };

  private toggleEnabled(listing: Listing): void {
    void this.withBusy(async () => {
      await this.api?.setEnabled?.(listing.id, !listing.enabled);
    });
  }

  private uninstall(listing: Listing): void {
    const question =
      listing.origin === "unpacked"
        ? "Stop loading " + listing.displayName + " from " + listing.dir + "?"
        : "Remove " + listing.displayName + " and everything it installed?";
    if (!window.confirm(question)) {
      return;
    }
    void this.withBusy(async () => {
      await this.api?.uninstall?.(listing.id);
    });
  }

  private async expand(listing: Listing): Promise<void> {
    if (this.expanded === listing.id) {
      this.expanded = null;
      return;
    }
    this.expanded = listing.id;
    const log = (await this.api?.log?.(listing.id)) as { ok?: boolean; lines?: LogLine[] } | undefined;
    this.logLines = log?.ok === true ? (log.lines ?? []) : [];
    const config = (await this.api?.getConfig?.(listing.id)) as
      | { ok?: boolean; values?: Record<string, string | number | boolean> }
      | undefined;
    this.configValues = config?.ok === true ? (config.values ?? {}) : {};
  }

  private async writeConfig(id: string, key: string, value: string | number | boolean): Promise<void> {
    const answer = (await this.api?.setConfig?.(id, key, value)) as
      | { ok?: boolean; error?: string; values?: Record<string, string | number | boolean> }
      | undefined;
    if (answer?.ok === true) {
      this.configValues = answer.values ?? this.configValues;
      return;
    }
    this.notify("That setting was refused: " + (answer?.error ?? "unknown reason"));
  }

  private badge(listing: Listing): TemplateResult {
    if (!listing.enabled) {
      return html`<span class="badge bg-secondary">Disabled</span>`;
    }
    if (listing.phase === "failed") {
      return html`<span class="badge bg-danger">Failed</span>`;
    }
    if (listing.phase === "active") {
      return html`<span class="badge bg-success">Active</span>`;
    }
    return html`<span class="badge bg-secondary">Idle</span>`;
  }

  private configField(listing: Listing, key: string, property: ConfigProperty): TemplateResult {
    const value = this.configValues[key];

    if (property.type === "boolean") {
      return html`<div class="form-check form-switch">
        <input
          class="form-check-input"
          type="checkbox"
          .checked=${value === true}
          @change=${(event: Event) =>
            void this.writeConfig(listing.id, key, (event.target as HTMLInputElement).checked)}
        />
        <label class="form-check-label text-light">${property.description ?? key}</label>
      </div>`;
    }

    if (property.enum != null) {
      return html`<label class="w-100 mb-2">
        <span class="text-secondary" style="font-size: 0.7rem">${property.description ?? key}</span>
        <select
          class="form-select form-select-sm"
          @change=${(event: Event) =>
            void this.writeConfig(listing.id, key, (event.target as HTMLSelectElement).value)}
        >
          ${property.enum.map(
            (option) =>
              html`<option value=${String(option)} ?selected=${String(option) === String(value)}>
                ${String(option)}
              </option>`,
          )}
        </select>
      </label>`;
    }

    const numeric = property.type === "number" || property.type === "integer";
    return html`<label class="w-100 mb-2">
      <span class="text-secondary" style="font-size: 0.7rem">${property.description ?? key}</span>
      <input
        class="form-control form-control-sm"
        type=${numeric ? "number" : "text"}
        .value=${String(value ?? "")}
        min=${property.minimum ?? ""}
        max=${property.maximum ?? ""}
        step=${property.type === "integer" ? "1" : "any"}
        @change=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value;
          void this.writeConfig(listing.id, key, numeric ? Number(raw) : raw);
        }}
      />
    </label>`;
  }

  private details(listing: Listing): TemplateResult {
    const properties = listing.configuration?.properties ?? {};

    return html`<div class="mt-2 ps-2 border-start border-secondary">
      ${listing.permissions.length === 0
        ? html`<p class="text-secondary mb-1" style="font-size: 0.75rem">
            Asks for nothing beyond reading your timeline.
          </p>`
        : html`<p class="text-secondary mb-1" style="font-size: 0.75rem">
            Permissions: ${listing.permissions.join(", ")}
          </p>`}

      <p class="text-secondary mb-2" style="font-size: 0.7rem">${listing.dir}</p>

      ${Object.keys(properties).length === 0
        ? html``
        : html`<div class="mb-2">
            <b class="text-light" style="font-size: 0.8rem">Settings</b>
            ${Object.entries(properties).map(([key, property]) =>
              this.configField(listing, key, property as ConfigProperty),
            )}
          </div>`}

      <b class="text-light" style="font-size: 0.8rem">Log</b>
      <pre
        class="bg-black text-secondary p-2 mt-1"
        style="max-height: 12rem; overflow: auto; font-size: 0.7rem; white-space: pre-wrap"
      >
${this.logLines.length === 0 ? "Nothing logged yet." : this.logLines.map((line) => line.text).join("\n")}</pre
      >
    </div>`;
  }

  private row(listing: Listing): TemplateResult {
    return html`<div class="p-2 mb-2 rounded" style="background-color: #1a1b1e">
      <div class="d-flex align-items-center gap-2">
        <b class="text-light">${listing.displayName}</b>
        <span class="text-secondary" style="font-size: 0.75rem">${listing.version}</span>
        ${this.badge(listing)}
        ${listing.origin === "unpacked"
          ? html`<span class="badge bg-info text-dark">Unpacked</span>`
          : html``}
      </div>

      ${listing.description === ""
        ? html``
        : html`<p class="text-secondary mb-1" style="font-size: 0.75rem">${listing.description}</p>`}

      ${listing.errors.length === 0
        ? html``
        : html`<p class="text-danger mb-1" style="font-size: 0.75rem">
            ${listing.errors.join(" ")}
          </p>`}

      <div class="d-flex gap-1 mt-1">
        <button
          class="btn btn-sm btn-default text-light"
          ?disabled=${this.busy}
          @click=${() => this.toggleEnabled(listing)}
        >
          ${listing.enabled ? "Disable" : "Enable"}
        </button>
        <button
          class="btn btn-sm btn-default text-light"
          ?disabled=${this.busy}
          @click=${() => this.uninstall(listing)}
        >
          ${listing.origin === "unpacked" ? "Forget" : "Remove"}
        </button>
        <button class="btn btn-sm btn-default text-light" @click=${() => void this.expand(listing)}>
          ${this.expanded === listing.id ? "Hide details" : "Details"}
        </button>
      </div>

      ${this.expanded === listing.id ? this.details(listing) : html``}
    </div>`;
  }

  /**
   * The command list, which doubles as this release's command palette.
   *
   * Contributed commands are reachable from a keybinding, the Extensions menu
   * and here. This is the one that always works: a command with no keybinding
   * and no menu entry would otherwise be unreachable, and an extension author
   * testing one should not have to add a menu item first.
   */
  private commandList(): TemplateResult {
    const filter = this.commandFilter.trim().toLowerCase();
    const commands = contributionStore
      .getState()
      .commands.filter(
        (command) => filter === "" || command.title.toLowerCase().includes(filter),
      );

    if (contributionStore.getState().commands.length === 0) {
      return html``;
    }

    return html`<div class="mt-3">
      <b class="text-light" style="font-size: 0.8rem">Commands</b>
      <input
        class="form-control form-control-sm mt-1"
        type="search"
        placeholder="Filter commands"
        .value=${this.commandFilter}
        @input=${(event: Event) => {
          this.commandFilter = (event.target as HTMLInputElement).value;
        }}
      />
      <div class="mt-1">
        ${commands.map(
          (command) => html`<button
            class="btn btn-sm btn-default text-light w-100 text-start mb-1"
            @click=${() => void runContributedCommand(command.extId, command.commandId)}
          >
            ${command.title}
          </button>`,
        )}
      </div>
    </div>`;
  }

  render() {
    const host = hostStateStore.getState();
    const message = hostStateMessage(host);

    return html`<div class="h-100">
      <div class="d-flex flex-wrap gap-1">
        <button
          class="btn btn-sm btn-default text-light"
          ?disabled=${this.busy}
          @click=${this.handleInstall}
        >
          Install from file
        </button>
        <button
          class="btn btn-sm btn-default text-light"
          ?disabled=${this.busy}
          @click=${this.handleLoadUnpacked}
        >
          Load unpacked
        </button>
        <button class="btn btn-sm btn-default text-light" @click=${this.handleOpenFolder}>
          Open folder
        </button>
        <button
          class="btn btn-sm btn-default text-light"
          ?disabled=${this.busy}
          @click=${this.handleRestart}
        >
          Restart host
        </button>
      </div>

      ${message == null
        ? html``
        : html`<div class="alert alert-warning py-2 px-2 mt-2 mb-0" style="font-size: 0.75rem">
            ${message}
          </div>`}

      <div class="mt-3">
        ${this.listings.length === 0
          ? html`<p class="text-secondary" style="font-size: 0.8rem">
              No extensions yet. Install one from a file, or load a folder you are working on.
            </p>`
          : this.listings.map((listing) => this.row(listing))}
      </div>

      ${this.commandList()}
    </div>`;
  }
}
