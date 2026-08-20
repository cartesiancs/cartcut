import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

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
      fileTypeOption.setElementIds({
        elementIds: elementIds,
      });
    } catch (error) {}
  }

  hideAllOptions() {
    for (const key in this.children) {
      if (Object.hasOwnProperty.call(this.children, key)) {
        const element: any = this.children[key];
        console.log(element, this.children);
        element.hide();
      }
    }
  }

  connectedCallback() {
    this.render();
  }
}
