import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { uiStore } from "../../states/uiStore";

/**
 * Filetypes whose panel is not simply `option-${filetype}`.
 *
 * `group` is the one entry, and it has to be: this container element is itself
 * `<option-group>`, so `querySelector("option-group")` from inside it does not
 * find the panel for a group clip — it finds nothing, and the side panel goes
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

  showOption({ filetype, elementId }: { filetype: string; elementId: string }) {
    try {
      this.hideAllOptions();
      const fileTypeOption: any = this.querySelector(panelTagFor(filetype));
      fileTypeOption.show();
      // Marked here rather than at the end, because the panel is on screen the
      // moment `show()` returns. `setElementId` below can still throw — the
      // bare catch is load-bearing and swallows it — and a column reporting
      // itself empty while a panel is visible in it would be worse than one
      // reporting itself full while that panel shows stale values.
      uiStore.getState().setOptionPanelActive(true);
      fileTypeOption.setElementId({
        elementId: elementId,
      });
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

    console.log("ERRRRRRR");

    try {
      this.hideAllOptions();
      const fileTypeOption: any = this.querySelector(panelTagFor(filetype));
      fileTypeOption.show();
      uiStore.getState().setOptionPanelActive(true);
      fileTypeOption.setElementIds({
        elementIds: elementIds,
      });
    } catch (error) {}
  }

  /**
   * Hide every panel, and report the column as empty.
   *
   * The flag goes false first, so a `showOption` that then fails to find its
   * panel — the bare catch above swallows that — leaves the column hidden
   * rather than showing an empty strip.
   */
  hideAllOptions() {
    uiStore.getState().setOptionPanelActive(false);

    for (const key in this.children) {
      if (Object.hasOwnProperty.call(this.children, key)) {
        const element: any = this.children[key];
        element.hide();
      }
    }
  }

  connectedCallback() {
    this.render();
  }
}
