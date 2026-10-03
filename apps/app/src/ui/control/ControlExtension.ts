import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

import { contributionStore, type ContributedCommand } from "../../features/extension/contributions";
import { hostNotice, hostStateStore } from "../../features/extension/hostState";
import { runContributedCommand } from "../../features/extension/bridge";
import {
  listingStatus,
  matchesQuery,
  permissionChip,
  settingLabel,
  STATUS_LABELS,
  type ConfigProperty,
  type Listing,
} from "../../features/extension/listing";
import { iconButton } from "../../features/option/optionKit";

type LogLine = { at: number; level: string; text: string };

/**
 * The Extensions panel, in the sidebar's own vocabulary: the browse bar of the
 * file and template panels on top, one inspector card per extension under it,
 * and the contributed commands last. The look is `_extension.scss`.
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
  @state() private query = "";

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();

    // The host reports each extension's phase as it changes, and those arrive
    // after the first listing. Without this the panel shows an extension as
    // idle that activated a moment later, until something else re-renders it.
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
        this.notify("Not an extension: " + (inspected?.error ?? "unknown reason"));
        return;
      }

      const lines = [
        (inspected.replaces === true ? "Replace " : "Install ") +
          inspected.displayName +
          " " +
          inspected.version +
          "?",
        "",
        ...(inspected.permissions ?? []).map((permission) => "- " + permission.description),
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
          ? inspected.displayName + " installed"
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
        this.notify("Could not load: " + (outcome?.error ?? "unknown reason"));
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
    // Cleared first, so the card does not open on the previous one's log.
    this.logLines = [];
    this.configValues = {};
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
    this.notify("Setting refused: " + (answer?.error ?? "unknown reason"));
  }

  // -------------------------------------------------------------------- bar

  private bar(): TemplateResult {
    return html`<div class="browse-bar is-floating">
      <label class="browse-field">
        <span class="material-symbols-outlined browse-field-icon">search</span>
        <input
          type="search"
          class="browse-input"
          spellcheck="false"
          placeholder="Search"
          .value=${this.query}
          @input=${(event: Event) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
        />
      </label>
      <button
        type="button"
        class="browse-btn"
        title="Install from file"
        aria-label="Install from file"
        ?disabled=${this.busy}
        @click=${this.handleInstall}
      >
        <span class="material-symbols-outlined">upload</span>
      </button>
      <button
        type="button"
        class="browse-btn"
        title="Load unpacked"
        aria-label="Load unpacked"
        ?disabled=${this.busy}
        @click=${this.handleLoadUnpacked}
      >
        <span class="material-symbols-outlined">folder_code</span>
      </button>
    </div>`;
  }

  private notice(): TemplateResult | typeof nothing {
    const notice = hostNotice(hostStateStore.getState());
    if (notice == null) {
      return nothing;
    }
    return html`<div class="browse-alert ext-alert" role="status">
      <span class="material-symbols-outlined">warning</span>
      <div class="ext-alert-text">
        <b>${notice.label}</b>
        ${notice.detail == null
          ? nothing
          : html`<span title=${notice.detail}>${notice.detail}</span>`}
      </div>
      ${notice.restartable
        ? iconButton({
            icon: "restart_alt",
            title: "Restart",
            disabled: this.busy,
            onClick: this.handleRestart,
          })
        : nothing}
    </div>`;
  }

  // ------------------------------------------------------------------- cards

  private card(listing: Listing): TemplateResult {
    const status = listingStatus(listing);
    const open = this.expanded === listing.id;

    return html`<div
      class="opt-section ext-card ${status === "off" ? "is-off" : ""}"
      data-extension=${listing.id}
    >
      <div class="opt-head ext-head">
        <button
          type="button"
          class="ext-title"
          aria-expanded=${open ? "true" : "false"}
          title=${listing.description === "" ? listing.displayName : listing.description}
          @click=${() => void this.expand(listing)}
        >
          <span class="ext-dot is-${status}" title=${STATUS_LABELS[status]}></span>
          <span class="ext-name">${listing.displayName}</span>
          ${listing.origin === "unpacked"
            ? html`<span class="material-symbols-outlined ext-tag" title="Unpacked">code</span>`
            : nothing}
          <span class="material-symbols-outlined ext-chevron">keyboard_arrow_down</span>
        </button>
        <button
          type="button"
          class="ext-switch"
          role="switch"
          aria-checked=${listing.enabled ? "true" : "false"}
          title=${listing.enabled ? "On" : "Off"}
          aria-label=${listing.displayName}
          ?disabled=${this.busy}
          @click=${() => this.toggleEnabled(listing)}
        ></button>
      </div>

      ${listing.errors.length === 0
        ? nothing
        : html`<div class="ext-error">
            <span class="material-symbols-outlined">error</span>
            <span>${listing.errors.join(" ")}</span>
          </div>`}
      ${open ? this.details(listing) : nothing}
    </div>`;
  }

  private details(listing: Listing): TemplateResult {
    const properties = Object.entries(listing.configuration?.properties ?? {});

    return html`<div class="opt-body ext-body">
      ${listing.permissions.length === 0
        ? nothing
        : html`<div class="ext-chips">
            ${listing.permissions.map((permission) => {
              const chip = permissionChip(permission);
              return html`<span class="ext-chip" title=${permission}>
                <span class="material-symbols-outlined">${chip.icon}</span>${chip.label}
              </span>`;
            })}
          </div>`}
      ${properties.length === 0
        ? nothing
        : html`<div>
            <div class="ext-sub">Settings</div>
            ${properties.map(([key, property]) => this.configField(listing, key, property))}
          </div>`}
      ${this.logLines.length === 0
        ? nothing
        : html`<div>
            <div class="ext-sub">
              <span>Log</span>
              <span class="browse-section-count">${this.logLines.length}</span>
            </div>
            <pre class="ext-log">${this.logLines.map((line) => line.text).join("\n")}</pre>
          </div>`}
      ${this.foot(listing)}
    </div>`;
  }

  /** The version and the folder at one end, Remove at the other. */
  private foot(listing: Listing): TemplateResult {
    const trimmed = listing.dir.replace(/[\\/]+$/, "");
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const parent = cut < 0 ? "" : trimmed.slice(0, cut + 1);
    const leaf = cut < 0 ? listing.dir : trimmed.slice(cut + 1);
    const unpacked = listing.origin === "unpacked";

    return html`<div class="ext-foot">
      <span class="ext-version">${/^\d/.test(listing.version) ? "v" : ""}${listing.version}</span>
      <span class="browse-path" title=${listing.dir}
        ><bdi dir="ltr">${parent}<span class="browse-path-leaf">${leaf}</span></bdi></span
      >
      <button
        type="button"
        class="opt-text-btn"
        title=${unpacked ? "Stop loading this folder" : "Remove"}
        ?disabled=${this.busy}
        @click=${() => this.uninstall(listing)}
      >
        <span class="material-symbols-outlined">${unpacked ? "link_off" : "delete"}</span>
        ${unpacked ? "Unlink" : "Remove"}
      </button>
    </div>`;
  }

  private configField(listing: Listing, key: string, property: ConfigProperty): TemplateResult {
    const value = this.configValues[key];
    const label = settingLabel(key);

    let control: TemplateResult;
    if (property.type === "boolean") {
      control = html`<button
        type="button"
        class="ext-switch"
        role="switch"
        aria-checked=${value === true ? "true" : "false"}
        aria-label=${label}
        @click=${() => void this.writeConfig(listing.id, key, value !== true)}
      ></button>`;
    } else if (property.enum != null) {
      control = html`<select
        class="opt-select"
        aria-label=${label}
        @change=${(event: Event) =>
          void this.writeConfig(listing.id, key, (event.target as HTMLSelectElement).value)}
      >
        ${property.enum.map(
          (option) =>
            html`<option value=${String(option)} ?selected=${String(option) === String(value)}>
              ${String(option)}
            </option>`,
        )}
      </select>`;
    } else {
      const numeric = property.type === "number" || property.type === "integer";
      control = html`<input
        class=${numeric ? "opt-num" : "opt-text-input"}
        type=${numeric ? "number" : "text"}
        aria-label=${label}
        .value=${String(value ?? "")}
        min=${property.minimum ?? ""}
        max=${property.maximum ?? ""}
        step=${property.type === "integer" ? "1" : "any"}
        @change=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value;
          void this.writeConfig(listing.id, key, numeric ? Number(raw) : raw);
        }}
      />`;
    }

    return html`<div class="opt-field" title=${property.description ?? key}>
      <div class="opt-row">
        <span class="opt-label">${label}</span>
        ${control}
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- commands

  /**
   * The command list, which doubles as this release's command palette.
   *
   * Contributed commands are reachable from a keybinding, the Extensions menu
   * and here. This is the one that always works: a command with no keybinding
   * and no menu entry would otherwise be unreachable, and an extension author
   * testing one should not have to add a menu item first.
   */
  private commandList(commands: ContributedCommand[]): TemplateResult | typeof nothing {
    if (commands.length === 0) {
      return nothing;
    }
    return html`<section>
      <div class="browse-section-head ext-group-head">
        <span class="browse-section-title">Commands</span>
        <span class="browse-section-count">${commands.length}</span>
      </div>
      <div class="opt-section ext-commands">
        ${commands.map(
          (command) => html`<button
            type="button"
            class="ext-command"
            title=${command.title}
            @click=${() => void runContributedCommand(command.extId, command.commandId)}
          >
            <span class="material-symbols-outlined">${command.icon ?? "play_arrow"}</span>
            <span class="ext-command-name">${command.title}</span>
          </button>`,
        )}
      </div>
    </section>`;
  }

  // ------------------------------------------------------------------ render

  private empty(): TemplateResult {
    return html`<div class="browse-empty">
      <div class="browse-empty-icon">
        <span class="material-symbols-outlined">extension</span>
      </div>
      <div class="browse-empty-title">No extensions</div>
      <div class="ext-empty-actions">
        <button
          type="button"
          class="browse-text-btn is-primary"
          ?disabled=${this.busy}
          @click=${this.handleInstall}
        >
          <span class="material-symbols-outlined">upload</span>
          Install
        </button>
        <button
          type="button"
          class="browse-text-btn"
          ?disabled=${this.busy}
          @click=${this.handleLoadUnpacked}
        >
          <span class="material-symbols-outlined">folder_code</span>
          Load unpacked
        </button>
      </div>
    </div>`;
  }

  private noMatches(): TemplateResult {
    return html`<div class="browse-empty">
      <div class="browse-empty-icon">
        <span class="material-symbols-outlined">search_off</span>
      </div>
      <div class="browse-empty-title">No matches</div>
    </div>`;
  }

  render() {
    const allCommands = contributionStore.getState().commands;
    const listings = this.listings.filter((listing) =>
      matchesQuery(this.query, listing.displayName, listing.id, listing.description),
    );
    const commands = allCommands.filter((command) => matchesQuery(this.query, command.title));

    let body: TemplateResult;
    if (this.listings.length === 0 && allCommands.length === 0) {
      body = this.empty();
    } else if (listings.length === 0 && commands.length === 0) {
      body = this.noMatches();
    } else {
      body = html`${listings.length === 0
          ? nothing
          : html`<section>
              <div class="browse-section-head ext-group-head">
                <span class="browse-section-title">Installed</span>
                <span class="browse-section-count">${listings.length}</span>
                <span class="ext-group-actions">
                  ${iconButton({
                    icon: "folder",
                    title: "Open extensions folder",
                    onClick: this.handleOpenFolder,
                  })}
                  ${iconButton({
                    icon: "restart_alt",
                    title: "Restart extensions",
                    disabled: this.busy,
                    onClick: this.handleRestart,
                  })}
                </span>
              </div>
              ${listings.map((listing) => this.card(listing))}
            </section>`}
        ${this.commandList(commands)}`;
    }

    return html`${this.bar()} ${this.notice()} ${body}`;
  }
}
