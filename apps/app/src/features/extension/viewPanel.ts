/**
 * One extension view, as a `<webview>` guest.
 *
 * A guest rather than an iframe, and that choice is the reason the extension
 * system can claim what it claims. An iframe runs on the editor's own thread:
 * one `while (true)` in a panel and the preview stops compositing, the
 * timeline stops scrolling, and the only way out is force quit. A guest is its
 * own process, so the same loop costs that panel and nothing else.
 *
 * Nothing here decides what the guest may do. `webviewGuard.ts` forces its
 * preferences at attach time and `scheme.ts` decides which files it can read,
 * both in main, because a decision made here would be a decision an extension
 * could reach.
 *
 * Two Lit specifics this depends on. The component renders into the light DOM
 * like the other seventy, so the global stylesheet reaches it. And a custom
 * element with no styles is `display: inline`, where width and height do
 * nothing, so the host rule below is not decoration: without it the guest
 * measures 0x0 and shows nothing, with no error anywhere.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { contributionStore, type ContributedView } from "./contributions";

@customElement("ext-webview-panel")
export class ExtWebviewPanel extends LitElement {
  createRenderRoot() {
    return this;
  }

  /** `<extId>/<viewId>`, as `contributions.ts` keys them. */
  @property()
  viewKey = "";

  /**
   * Whether the panel is on screen.
   *
   * A `<webview>` inside a hidden Bootstrap pane attaches into a box of no
   * size, so the guest lays out at 0x0 and stays there until something forces
   * a reflow. Mounting on first show avoids that, and the guest is kept
   * afterwards: tearing it down on every tab switch would restart the
   * extension's page and lose whatever the user had typed into it.
   */
  @state()
  private mounted = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
    this.style.width = "100%";
    this.style.height = "100%";

    this.unsubscribe = contributionStore.subscribe(() => this.requestUpdate());

    // An `IntersectionObserver` rather than a `shown.bs.tab` listener, because
    // the same component serves a sidebar pane, a docked window and an
    // inspector section, and only one of those is a Bootstrap tab.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !this.mounted) {
        this.mounted = true;
        this.observer?.disconnect();
      }
    });
    this.observer.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.observer?.disconnect();
  }

  private unsubscribe: (() => void) | null = null;
  private observer: IntersectionObserver | null = null;

  private get view(): ContributedView | null {
    return contributionStore.getState().views.find((entry) => entry.key === this.viewKey) ?? null;
  }

  render() {
    const view = this.view;
    if (view == null) {
      // The extension was disabled or its host stopped. A panel that keeps
      // showing a dead page is worse than one that says what happened.
      return html`<div class="p-3 text-secondary">This panel's extension is not running.</div>`;
    }

    if (!this.mounted) {
      return html`<div style="width:100%;height:100%"></div>`;
    }

    // The view id rides in the query string because that is the only part of
    // the URL main can read back from `webContents.getURL()` when it maps a
    // guest to the extension that owns it.
    const src =
      "cartcut-ext://" + view.extId + "/" + view.page + "?view=" + encodeURIComponent(view.viewId);

    return html`<webview
      src=${src}
      partition=${"persist:ext:" + view.extId}
      style="width:100%;height:100%;display:flex;border:0"
    ></webview>`;
  }
}
