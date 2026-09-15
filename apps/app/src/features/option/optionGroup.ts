import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { uiStore } from "../../states/uiStore";

/**
 * Filetypes whose panel is not simply `option-${filetype}`.
 *
 * `group` is the one entry, and it has to be: this container element is itself
 * `<option-group>`, so `querySelector("option-group")` from inside it does not
 * find the panel for a group clip: it finds nothing, and the side panel goes
 * blank with no error anyone can see, because the lookup below is wrapped in a
 * bare `try`.
 */
const PANEL_TAG: Record<string, string> = {
  group: "option-groupelement",
};

function panelTagFor(filetype: string): string {
  return PANEL_TAG[filetype] ?? `option-${filetype}`;
}

@customElement("option-group")
export class OptionGroup extends LitElement {
  constructor() {
    super();
  }

  render() {
    //this.hideAllOptions()
  }

  /**
   * The panel the column is currently showing, and what it was shown for.
   *
   * `optionGroup` is the only thing that shows or hides a panel, so it is the
   * only thing that can answer "is this already on screen". Nothing else may
   * write it: the panels hide themselves in their own constructors and never
   * again.
   */
  private shown: { tag: string; key: string } | null = null;

  /**
   * Put `tag`'s panel on screen, and report the panel, or null if it is not
   * there to be shown.
   *
   * The early return is the point. Re-requesting the panel already on screen
   * for the selection already on screen used to cost a hide of all nine
   * panels, a show of one, and two `isOptionPanelActive` writes that every one
   * of the store's twelve unfiltered subscribers saw. Two of those subscribers
   * read `clientHeight` in the callback, so it was four forced layouts of the
   * whole document; three more scheduled a canvas repaint; `option-text`
   * rebuilt an `<li>` per installed font family. A right-click on an already
   * selected clip paid all of it before its context menu could paint.
   */
  private swapTo(tag: string, key: string): any | null {
    if (this.shown?.tag === tag && this.shown.key === key) {
      return this.querySelector(tag);
    }

    try {
      this.hidePanels(tag);
      const panel: any = this.querySelector(tag);
      panel.show();
      // Marked here rather than after the caller's setter, because the panel
      // is on screen the moment `show()` returns and that setter can still
      // throw. A column reporting itself full while a panel shows stale values
      // is better than one reporting itself empty with a panel visible in it.
      uiStore.getState().setOptionPanelActive(true);
      this.shown = { tag, key };
      return panel;
    } catch (error) {
      // `hidePanels` has already emptied the column, so it has to say so. The
      // failure this swallows is the missing-panel lookup `PANEL_TAG` exists
      // to explain, and it is invisible by design.
      uiStore.getState().setOptionPanelActive(false);
      this.shown = null;
      return null;
    }
  }

  showOption({ filetype, elementId }: { filetype: string; elementId: string }) {
    const panel = this.swapTo(panelTagFor(filetype), elementId);
    if (panel == null) {
      return;
    }

    // Always, even when the swap was skipped: `setElementId` is where a panel
    // commits pending edits and refreshes its imperative inputs, and it is
    // cheap. Only the visibility swap above is memoized.
    try {
      panel.setElementId({ elementId: elementId });
    } catch (error) {}
  }

  // NOTE: only same filetypes
  showOptions({
    filetype,
    elementIds,
  }: {
    filetype: string;
    elementIds: string[];
  }) {
    if (filetype != "text") {
      return false;
    }

    // Keyed on the whole selection, not on a representative: narrowing three
    // text clips to two has to reach the panel.
    const panel = this.swapTo(panelTagFor(filetype), elementIds.join(","));
    if (panel == null) {
      return;
    }

    try {
      panel.setElementIds({ elementIds: elementIds });
    } catch (error) {}
  }

  /**
   * Hide every panel but `exceptTag`, without touching the store.
   *
   * Skipping the one about to be shown is not just a saved call. Hiding it and
   * showing it back within the same tick still leaves `isShow` in Lit's
   * changed set, so the panel re-renders in full, and for `option-text` that
   * is the font list again.
   */
  private hidePanels(exceptTag?: string) {
    for (const key in this.children) {
      if (Object.hasOwnProperty.call(this.children, key)) {
        const element: any = this.children[key];
        if (
          exceptTag != null &&
          element.tagName?.toLowerCase() === exceptTag
        ) {
          continue;
        }
        element.hide();
      }
    }
  }

  /**
   * Hide every panel, and report the column as empty.
   *
   * The flag goes false first, so a caller that then fails to show anything
   * leaves the column hidden rather than showing an empty strip.
   */
  hideAllOptions() {
    uiStore.getState().setOptionPanelActive(false);
    this.shown = null;
    this.hidePanels();
  }

  connectedCallback() {
    this.render();
  }
}
