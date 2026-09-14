/**
 * A window's chrome: a title bar, a close button, and a body.
 *
 * Deliberately knows nothing about layout, the store, or which host it is in.
 * It is handed a position by `<window-host>` as an inline style and a body as a
 * Lit template, and it reports a close by event. That makes it usable for a
 * plain dialog later without dragging a docking model in behind it.
 *
 * ## Why the body arrives as a template rather than through a `<slot>`
 *
 * A light-DOM Lit component's `render()` **replaces its children**, so the
 * usual way to wrap arbitrary content is a shadow root with a slot. This app
 * does not do that, and the reason is written at
 * `features/option/controlAudioVolume.ts:53`: the global stylesheet does not
 * cross a shadow boundary, so rendering chrome into a shadow root leaves it
 * unstyled, and it fails in a way that looks like a CSS problem rather than an
 * architectural one. 70 of the app's 70 components that override
 * `createRenderRoot` return `this`.
 *
 * A `TemplateResult` property is the light-DOM equivalent of a slot. Lit keeps
 * the element instances inside it stable across re-renders, so the
 * `<automatic-caption>` in the body is created once and not rebuilt every time
 * the host re-lays out.
 *
 * ## The contract with whatever is in the body
 *
 * The body is `overflow: hidden` and establishes a container named
 * `appwindow`. A panel inside it gets a definite box (see `_window.scss`) and
 * owns its own scrolling and its own footer, which is what `autoTrackPanel`
 * already does. Scrolling here instead would put a panel's footer at the bottom
 * of its content rather than at the bottom of the window.
 */

import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-window")
export class AppWindow extends LitElement {
  /** The id this window is known by in `windowStore`. Sent back on close. */
  @property()
  windowId = "";

  /**
   * The name on the title bar.
   *
   * Called `label` and not `title`: `title` is a global HTML property, and a
   * Lit `@property` of that name shadows it, so the window would grow a native
   * tooltip carrying its own name.
   */
  @property()
  label = "";

  /** A material-symbols ligature, or empty for no icon. */
  @property()
  icon = "";

  @property({ type: Boolean })
  closable = true;

  @property({ attribute: false })
  content: TemplateResult | typeof nothing = nothing;

  createRenderRoot() {
    return this;
  }

  private _close(event: Event) {
    // The close button lives inside the title bar, and the title bar raises the
    // window on mousedown. Without this the click both closes the window and
    // focuses it on the way past, which is the trap `previewTopBar`'s own tab
    // close already documents.
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("windowClose", {
        detail: { id: this.windowId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="app-window-titlebar">
        <span class="app-window-title btn btn-xxs btn-active text-light m-0">
          ${this.icon === ""
            ? nothing
            : html`<span class="material-symbols-outlined icon-xs">${this.icon}</span>`}
          ${this.label}
        </span>
        ${this.closable
          ? html`<button
              class="app-window-close"
              type="button"
              title="Close ${this.label}"
              aria-label="Close ${this.label}"
              @click=${this._close}
            >
              <span class="material-symbols-outlined icon-xs">close</span>
            </button>`
          : nothing}
      </div>
      <div class="app-window-body">${this.content}</div>
    `;
  }
}
