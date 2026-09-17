/**
 * A frame's chrome: a strip of tabs, and a body showing one of them.
 *
 * Deliberately knows nothing about layout, the store, or which host it is in.
 * It is handed a position by `<window-host>` as an inline style and its tabs as
 * Lit templates, and it reports a tab chosen or closed by event. That makes it
 * usable for a plain dialog later without dragging a docking model in behind it.
 *
 * ## The tabs are `<preview-top-bar>`'s tabs
 *
 * Same chip, same classes, and the close glyph sits inside the tab straight
 * after its label (`previewTopBar.ts#_renderTab`). The frame stands beside the
 * preview column's own top bar at the same 2rem, so the two read as one strip
 * across the column; a title chip with its close pushed to the far edge read as
 * a different kind of thing.
 *
 * ## Every tab stays mounted
 *
 * A tab that is not on show is hidden, not removed. The caption panel holds a
 * running session and Text to Speech holds what was typed into it, and removing
 * either to show the other would throw that away. `repeat` keys each pane by the
 * tab's id so closing one tab never hands its element to another.
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
import { repeat } from "lit/directives/repeat.js";

export type WindowTab = {
  /** The id this tab's window is known by in `windowStore`. */
  id: string;
  /**
   * The name on the tab.
   *
   * Called `label` and not `title`: `title` is a global HTML property, and a
   * Lit `@property` of that name shadows it, so the frame would grow a native
   * tooltip carrying its own name.
   */
  label: string;
  closable: boolean;
  content: TemplateResult;
};

@customElement("app-window")
export class AppWindow extends LitElement {
  @property({ attribute: false })
  tabs: WindowTab[] = [];

  /** The tab on show. */
  @property()
  activeId = "";

  createRenderRoot() {
    return this;
  }

  private _emit(type: "windowSelect" | "windowClose", id: string) {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: { id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _close(event: Event, id: string) {
    // The close glyph lives inside the tab, so without this the click bubbles
    // into the tab's own handler and focuses the window that was just closed,
    // the trap `previewTopBar`'s tab close already documents.
    event.stopPropagation();
    this._emit("windowClose", id);
  }

  private _renderTab(tab: WindowTab) {
    const active = tab.id === this.activeId;
    return html`<button
      type="button"
      data-window=${tab.id}
      class="btn btn-xxs ${active ? "btn-active" : "btn-default"} text-light app-window-tab m-0"
      @click=${() => this._emit("windowSelect", tab.id)}
    >
      ${tab.label}
      ${tab.closable
        ? html`<span
            class="material-symbols-outlined icon-xs app-window-close"
            role="button"
            title="Close ${tab.label}"
            aria-label="Close ${tab.label}"
            @click=${(event: Event) => this._close(event, tab.id)}
          >
            close
          </span>`
        : nothing}
    </button>`;
  }

  render() {
    return html`
      <div class="app-window-titlebar">
        <div class="app-window-tabs">
          ${repeat(
            this.tabs,
            (tab) => tab.id,
            (tab) => this._renderTab(tab),
          )}
        </div>
      </div>
      <div class="app-window-body">
        ${repeat(
          this.tabs,
          (tab) => tab.id,
          (tab) =>
            html`<div
              class="app-window-pane"
              data-window=${tab.id}
              ?hidden=${tab.id !== this.activeId}
            >
              ${tab.content}
            </div>`,
        )}
      </div>
    `;
  }
}
