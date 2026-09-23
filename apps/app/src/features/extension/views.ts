/**
 * Extension views, as the things `Control.ts` already knows how to render.
 *
 * The app's surfaces each take a specific shape: `window-host` wants a
 * `WindowPanel` with a `TemplateResult`, the sidebar wants a pill and a pane.
 * Turning a contribution into each of those happens here rather than in
 * `Control.ts`, so the seam in that file stays one spread and one `repeat`.
 */

import { html, type TemplateResult } from "lit";

import {
  contributionStore,
  inspectorViews,
  panelViews,
  sidebarViews,
  type ContributedView,
} from "./contributions";
import type { WindowPanel } from "../window/windowHost";

import "./viewPanel";

/** The `<ext-webview-panel>` for one view. */
export function viewContent(view: ContributedView): TemplateResult {
  return html`<ext-webview-panel .viewKey=${view.key}></ext-webview-panel>`;
}

export type SidebarTab = {
  key: string;
  paneId: string;
  title: string;
  icon: string;
  content: TemplateResult;
};

/**
 * Sidebar tabs, as a pill and a pane.
 *
 * The pane id is derived from the key rather than chosen, because Bootstrap
 * matches the pill's `data-bs-target` to the pane by selector: any character
 * that is not valid in one would silently stop the tab from opening. Dots and
 * slashes are both legal in an extension key and neither is legal here.
 */
export function extensionSidebarTabs(): SidebarTab[] {
  return sidebarViews(contributionStore.getState()).map((view) => ({
    key: view.key,
    paneId: "nav-ext-" + view.key.replace(/[^a-zA-Z0-9]/g, "-"),
    title: view.title,
    icon: view.icon ?? "extension",
    content: viewContent(view),
  }));
}

/** Docked and floating panels, for `Control.ts#_windowPanels`. */
export function extensionWindowPanels(): WindowPanel[] {
  return panelViews(contributionStore.getState()).map((view) => ({
    id: "ext:" + view.key,
    label: view.title,
    content: viewContent(view),
  }));
}

/** Inspector sections for the selected clip's type. */
export function extensionInspectorViews(filetype: string | null): ContributedView[] {
  return inspectorViews(contributionStore.getState(), filetype);
}
