/**
 * The "LUT" sidebar tab: colour lookup tables.
 *
 * Its own tab next to Fx rather than a third toggle inside it. A LUT is not a
 * preset of the same kind: it attaches to a *clip* as well as to a layer, it is
 * the thing a user reaches for first when they open a project rather than last,
 * and eighty of them behind a toggle would be eighty things nobody finds. Fx
 * and Transitions share a tab because they are both "add an element"; this is
 * "change how the picture looks", which is a different question.
 *
 * The grid itself is `<lut-browser>`; this is the chrome around it.
 */

import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "../../features/lut/lutBrowser";

@customElement("control-ui-lut")
export class ControlUiLut extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="px-2 pt-1">
        <span class="text-light" style="font-size: 12px;">LUTs</span>
      </div>
      <lut-browser></lut-browser>
    `;
  }
}
