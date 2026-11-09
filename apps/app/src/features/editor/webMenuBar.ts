/**
 * The menu bar a browser build draws at the left of its top bar: File, Edit,
 * Clip, Playback, Utilities, View, About and Help, the desktop app's menus
 * (`webMenuModel.ts`), each item running the command the desktop menu runs
 * (`menuCommands.ts#runMenuCommand`).
 *
 * Behaves like a desktop menu bar, because that is what it stands in for:
 *
 *  - **It never takes focus, nor the selection.** Its `mousedown` is
 *    cancelled, so a caption being typed keeps the caret and Edit ▸ Copy
 *    copies the text rather than the clips (`menuCommands.ts#typingNow`); and
 *    it carries `data-keeps-selection`, so the timeline does not read a press
 *    on it as a click on empty space and drop the clips Edit ▸ Copy is for.
 *  - A click opens a menu; while one is open, moving over another opens that
 *    one; a click outside, Escape, or the window losing focus closes it.
 *  - The arrow keys move through items and across menus, Enter or Space runs
 *    one, and Right opens the Auto Save list.
 *  - The command runs inside the click that chose it, so a picker or a save
 *    dialog it opens has the user activation it needs.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LEARN_MORE_URL } from "../../../../../electron/lib/menuLayout";
import { entryLabel } from "../../../../../electron/lib/autosaveMenu";
import { IS_MAC } from "../../utils/platform";
import { runMenuCommand } from "./menuCommands";
import { nextItem, webMenus, type WebMenu, type WebMenuItem } from "./webMenuModel";
import { browserAutosaveApi } from "../project/web/webAutosave";
import { openSettings } from "../settings/settingsDialog";

type AutosaveRow = { key: string; file: string; title: string; when: string };

/** What `getAppInfo` answers, as the about card words it. */
function buildLabel(version: string): string {
  if (/^\d/.test(version)) {
    return `Version ${version}`;
  }
  if (version === "Demo") {
    return "Web demo";
  }
  if (version === "SelfHosted") {
    return "Self-hosted";
  }
  return version;
}

@customElement("web-menu-bar")
export class WebMenuBar extends LitElement {
  private readonly menus: WebMenu[] = webMenus(IS_MAC);

  /** The menu showing, or -1. */
  @state() private open = -1;
  /** The highlighted item in it, or -1. */
  @state() private active = -1;
  /** Whether the Auto Save list is showing beside the File menu. */
  @state() private submenu = false;
  @state() private subActive = -1;
  /** `null` while the list is being read. */
  @state() private autosaveRows: AutosaveRow[] | null = null;
  @state() private about: { version: string } | null = null;
  @state() private fullscreen = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // A press here is not a click on empty space: the timeline would drop the
    // selection before Edit ▸ Copy or Clip ▸ Split could act on it.
    this.setAttribute("data-keeps-selection", "");
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    this.unlisten();
  }

  private onFullscreenChange = () => {
    this.fullscreen = document.fullscreenElement != null;
  };

  // ------------------------------------------------------------- open/close

  private listening = false;

  private listen(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    // Capture, so a handler deeper in the page cannot keep the menu open by
    // stopping the event, and the keys reach the menu before the editor's
    // own shortcuts while it is open, as a desktop menu's do.
    window.addEventListener("mousedown", this.onWindowMouseDown, true);
    window.addEventListener("keydown", this.onWindowKeydown, true);
    window.addEventListener("blur", this.close);
    window.addEventListener("resize", this.close);
  }

  private unlisten(): void {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    window.removeEventListener("mousedown", this.onWindowMouseDown, true);
    window.removeEventListener("keydown", this.onWindowKeydown, true);
    window.removeEventListener("blur", this.close);
    window.removeEventListener("resize", this.close);
  }

  private show(index: number, active = -1): void {
    this.open = index;
    this.active = active;
    this.submenu = false;
    this.subActive = -1;
    this.listen();
  }

  private close = () => {
    this.open = -1;
    this.active = -1;
    this.submenu = false;
    this.subActive = -1;
    this.unlisten();
  };

  private onWindowMouseDown = (event: MouseEvent) => {
    if (!this.contains(event.target as Node)) {
      this.close();
    }
  };

  /** Keep the caret where it is: the bar never takes focus. */
  private holdFocus = (event: MouseEvent) => {
    event.preventDefault();
  };

  private toggle(index: number): void {
    if (this.open === index) {
      this.close();
    } else {
      this.show(index);
    }
  }

  private hoverTop(index: number): void {
    if (this.open !== -1 && this.open !== index) {
      this.show(index);
    }
  }

  // ---------------------------------------------------------------- keys

  private onWindowKeydown = (event: KeyboardEvent) => {
    if (this.open === -1) {
      return;
    }
    const items = this.menus[this.open].items;
    let handled = true;
    switch (event.key) {
      case "Escape":
        if (this.submenu) {
          this.submenu = false;
          this.subActive = -1;
        } else {
          this.close();
        }
        break;
      case "ArrowDown":
        if (this.submenu) {
          this.moveSub(1);
        } else {
          this.active = nextItem(items, this.active, 1);
        }
        break;
      case "ArrowUp":
        if (this.submenu) {
          this.moveSub(-1);
        } else {
          this.active = nextItem(items, this.active, -1);
        }
        break;
      case "ArrowRight": {
        const item = items[this.active];
        if (!this.submenu && item?.kind === "action" && item.action === "autosave") {
          this.openAutosave(0);
        } else {
          const next = (this.open + 1) % this.menus.length;
          this.show(next, nextItem(this.menus[next].items, -1, 1));
        }
        break;
      }
      case "ArrowLeft":
        if (this.submenu) {
          this.submenu = false;
          this.subActive = -1;
        } else {
          const previous = (this.open - 1 + this.menus.length) % this.menus.length;
          this.show(previous, nextItem(this.menus[previous].items, -1, 1));
        }
        break;
      case "Enter":
      case " ":
        if (this.submenu) {
          const row = this.autosaveRows?.[this.subActive];
          if (row != null) {
            this.recover(row);
          }
        } else if (this.active >= 0) {
          this.activate(items[this.active]);
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private moveSub(step: 1 | -1): void {
    const count = this.autosaveRows?.length ?? 0;
    if (count === 0) {
      return;
    }
    this.subActive = (this.subActive + step + count) % count;
  }

  // ------------------------------------------------------------- actions

  private activate(item: WebMenuItem): void {
    if (item.kind === "separator") {
      return;
    }
    if (item.kind === "command") {
      this.close();
      runMenuCommand(item.id);
      return;
    }
    switch (item.action) {
      case "autosave":
        this.openAutosave(-1);
        return;
      case "fullscreen":
        this.close();
        void this.toggleFullscreen();
        return;
      case "credit":
        this.close();
        void this.showAbout();
        return;
      case "setting":
        this.close();
        openSettings();
        return;
      case "learnMore":
        this.close();
        window.open(LEARN_MORE_URL, "_blank", "noopener");
        return;
    }
  }

  private openAutosave(active: number): void {
    this.submenu = true;
    this.subActive = active;
    this.autosaveRows = null;
    void browserAutosaveApi()
      .list()
      .then((rings) => {
        const now = Date.now();
        const zone = -new Date().getTimezoneOffset();
        const rows = rings
          .flatMap((ring) =>
            ring.entries.map((entry) => ({
              key: ring.key,
              file: entry.file,
              title: ring.label,
              when: entryLabel(entry.writtenAtMs, now, zone),
              at: entry.writtenAtMs,
            })),
          )
          .sort((a, b) => b.at - a.at)
          .map(({ at: _at, ...row }) => row);
        this.autosaveRows = rows;
        if (active >= 0 && rows.length === 0) {
          this.subActive = -1;
        }
      });
  }

  private recover(row: AutosaveRow): void {
    this.close();
    runMenuCommand("file.autoSaveRecover", { key: row.key, file: row.file });
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement != null) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.warn("[menu] full screen was refused", error);
    }
  }

  private async showAbout(): Promise<void> {
    let version = "";
    try {
      const info = (await window.electronAPI?.req?.app?.getAppInfo?.()) as { data?: { version?: string } } | undefined;
      version = info?.data?.version ?? "";
    } catch {
      version = "";
    }
    this.about = { version };
    await this.updateComplete;
    this.querySelector<HTMLButtonElement>(".wmb-about-close")?.focus();
  }

  // ------------------------------------------------------------- drawing

  private labelOf(item: Exclude<WebMenuItem, { kind: "separator" }>): string {
    if (item.kind === "action" && item.action === "fullscreen") {
      return this.fullscreen ? "Exit Full Screen" : "Enter Full Screen";
    }
    return item.label;
  }

  private renderAutosave() {
    const rows = this.autosaveRows;
    return html`<div class="wmb-panel wmb-sub" role="menu" aria-label="Auto Save">
      ${rows == null
        ? html`<div class="wmb-note">Reading…</div>`
        : rows.length === 0
          ? html`<div class="wmb-note" title="Auto Save keeps a copy of unsaved work here; an empty list means everything is saved.">
              No recovery points
            </div>`
          : rows.map(
              (row, index) => html`<button
                type="button"
                class="wmb-item ${this.subActive === index ? "is-active" : ""}"
                role="menuitem"
                @mouseenter=${() => (this.subActive = index)}
                @click=${() => this.recover(row)}
              >
                <span class="wmb-label">${row.title}</span>
                <span class="wmb-shortcut">${row.when}</span>
              </button>`,
            )}
    </div>`;
  }

  private renderPanel(menu: WebMenu) {
    return html`<div class="wmb-panel" role="menu" aria-label=${menu.label}>
      ${menu.items.map((item, index) => {
        if (item.kind === "separator") {
          return html`<div class="wmb-sep" role="separator"></div>`;
        }
        const autosave = item.kind === "action" && item.action === "autosave";
        return html`<div class="wmb-row">
          <button
            type="button"
            class="wmb-item ${this.active === index ? "is-active" : ""}"
            role="menuitem"
            aria-haspopup=${autosave ? "menu" : nothing}
            aria-expanded=${autosave ? String(this.submenu) : nothing}
            @mouseenter=${() => {
              this.active = index;
              if (autosave && !this.submenu) {
                this.openAutosave(-1);
              } else if (!autosave && this.submenu) {
                this.submenu = false;
                this.subActive = -1;
              }
            }}
            @click=${() => this.activate(item)}
          >
            <span class="wmb-label">${this.labelOf(item)}</span>
            ${item.kind === "command" && item.shortcut != null
              ? html`<span class="wmb-shortcut">${item.shortcut}</span>`
              : nothing}
            ${autosave ? html`<span class="wmb-shortcut">›</span>` : nothing}
          </button>
          ${autosave && this.submenu ? this.renderAutosave() : nothing}
        </div>`;
      })}
    </div>`;
  }

  private renderAbout() {
    return html`<div class="wmb-scrim" @mousedown=${(e: MouseEvent) => e.target === e.currentTarget && (this.about = null)}>
      <div class="wmb-about" role="dialog" aria-modal="true" aria-label="About CartCut"
        @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (this.about = null)}>
        <img
          src="https://cdn.cartesiancs.com/i.png"
          alt=""
          class="wmb-about-logo"
          @error=${(e: Event) => ((e.target as HTMLElement).hidden = true)}
        />
        <b class="wmb-about-title">CartCut</b>
        <span class="wmb-about-text">CartCut is an open-source video editing software.</span>
        ${this.about?.version ? html`<span class="wmb-about-text">${buildLabel(this.about.version)}</span>` : nothing}
        <button type="button" class="wmb-about-close" @click=${() => (this.about = null)}>Close</button>
      </div>
    </div>`;
  }

  private styles() {
    return html`<style>
      web-menu-bar {
        display: flex;
        align-items: stretch;
        height: 100%;
        flex: none;
        margin-right: auto;
        -webkit-app-region: no-drag;
      }
      .wmb {
        display: flex;
        align-items: center;
        height: 100%;
        gap: 2px;
      }
      .wmb-root {
        position: relative;
        height: 100%;
        display: flex;
        align-items: center;
      }
      .wmb-top {
        border: 0;
        background: transparent;
        color: #adb5bd;
        font-size: 12px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 5px;
        line-height: 18px;
        cursor: default;
      }
      .wmb-top:hover,
      .wmb-top.is-open {
        background: #24272b;
        color: #f1f3f5;
      }
      .wmb-panel {
        position: absolute;
        top: calc(100% - 2px);
        left: 0;
        z-index: 10000;
        min-width: 230px;
        padding: 4px;
        border-radius: 8px;
        background: #1b1d20;
        border: 1px solid #2f3337;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
        display: flex;
        flex-direction: column;
      }
      .wmb-row {
        position: relative;
      }
      .wmb-sub {
        top: -5px;
        left: calc(100% + 2px);
        min-width: 260px;
      }
      .wmb-item {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 24px;
        border: 0;
        background: transparent;
        color: #e9ecef;
        font-size: 12px;
        font-weight: 500;
        text-align: left;
        padding: 5px 10px;
        border-radius: 5px;
        cursor: default;
        white-space: nowrap;
      }
      .wmb-item.is-active {
        background: #2f6fea;
        color: #fff;
      }
      .wmb-shortcut {
        color: #8b939b;
        font-weight: 500;
      }
      .wmb-item.is-active .wmb-shortcut {
        color: #dce6ff;
      }
      .wmb-sep {
        height: 1px;
        margin: 4px 6px;
        background: #2f3337;
      }
      .wmb-note {
        padding: 5px 10px;
        color: #8b939b;
        font-size: 12px;
        white-space: nowrap;
      }
      .wmb-scrim {
        position: fixed;
        inset: 0;
        z-index: 10050;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .wmb-about {
        width: min(340px, calc(100vw - 32px));
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 24px;
        border-radius: 12px;
        background: #17191c;
        border: 1px solid #2b2f34;
        color: #e9ecef;
      }
      .wmb-about-logo {
        width: 64px;
        height: 64px;
      }
      .wmb-about-title {
        font-size: 15px;
      }
      .wmb-about-text {
        color: #9aa1a9;
        font-size: 12px;
        text-align: center;
      }
      .wmb-about-close {
        margin-top: 8px;
        border: 1px solid #3a3f44;
        background: #23262a;
        color: #e9ecef;
        border-radius: 6px;
        padding: 5px 14px;
        font-size: 12px;
      }
    </style>`;
  }

  render() {
    return html`${this.styles()}
      <nav class="wmb" role="menubar" aria-label="Menu" @mousedown=${this.holdFocus}>
        ${this.menus.map(
          (menu, index) => html`<div class="wmb-root">
            <button
              type="button"
              class="wmb-top ${this.open === index ? "is-open" : ""}"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded=${String(this.open === index)}
              @click=${() => this.toggle(index)}
              @mouseenter=${() => this.hoverTop(index)}
            >
              ${menu.label}
            </button>
            ${this.open === index ? this.renderPanel(menu) : nothing}
          </div>`,
        )}
      </nav>
      ${this.about != null ? this.renderAbout() : nothing}`;
  }
}
