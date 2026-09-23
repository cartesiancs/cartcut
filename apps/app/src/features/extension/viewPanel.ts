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
   * Whether the guest has been created yet.
   *
   * A `<webview>` attached inside a hidden Bootstrap pane lays out at 0x0 and
   * stays there until something forces a reflow, so the guest is created on
   * first show rather than on first render. It is kept afterwards: tearing it
   * down on every tab switch would restart the extension's page and lose
   * whatever the user had typed into it.
   */
  @state()
  private mounted = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "block";
    this.style.width = "100%";
    this.style.height = "100%";

    this.unsubscribe = contributionStore.subscribe(() => this.requestUpdate());

    // A `ResizeObserver` and a laid-out check, **not** an
    // `IntersectionObserver`. Intersection sounds like the right question and
    // is the wrong one: it is false for anything an ancestor clips, and the
    // option column clips its own contents, so an inspector section sitting
    // plainly on screen never intersected and its guest was never created. The
    // symptom is a blank rectangle with nothing in any log, which is the one
    // failure this system has already produced twice.
    //
    // What is actually being asked is "does this element have a box the guest
    // can attach into", and `offsetParent` plus a height answers exactly that:
    // null inside a `display: none` pane, real the moment the pane is shown.
    this.observer = new ResizeObserver(() => this.mountIfLaidOut());
    this.observer.observe(this);
  }

  protected firstUpdated(): void {
    // A `ResizeObserver` fires on observation, but only once a layout has
    // happened. For a panel that is already visible when it mounts, this is
    // the earlier of the two.
    this.mountIfLaidOut();
  }

  private mountIfLaidOut(): void {
    if (this.mounted) {
      return;
    }
    // `offsetParent` is null inside a `display: none` subtree and non-null
    // otherwise, which is the whole test. The height is the second half:
    // a pane can be displayed and still have no room yet.
    if (this.offsetParent == null || this.clientHeight <= 0) {
      return;
    }
    this.mounted = true;
    this.observer?.disconnect();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.observer?.disconnect();
  }

  private unsubscribe: (() => void) | null = null;
  private observer: ResizeObserver | null = null;

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
